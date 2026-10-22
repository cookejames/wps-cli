// Google Sheets sink: wraps the `gws` CLI (spawned with an args array, never a shell).
import { spawn } from "node:child_process";
import { SinkError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { redact } from "../session.ts";
import { colIndex, colLetter, decodeCell, decodeRows, encodeRows, NUMBER_FORMATS, type Row, type TableDef } from "./tables.ts";

/** Linux caps a single argv string at ~128 KB; stay well under it. */
export const MAX_JSON_BYTES = 100_000;

export interface SheetInfo {
  sheetId: number;
  title: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
}

export interface SinkOptions {
  spreadsheetId: string;
  /** gws executable (env WPS_GWS_BIN, default "gws") */
  bin?: string;
  timezone?: string;
  log?: Logger;
  backoffMs?: number;
  /** wait before retrying a per-minute quota error (429); default 65 s so the minute window resets */
  quotaBackoffMs?: number;
  maxJsonBytes?: number;
}

type Cell = string | number | boolean;
const TRANSIENT = /\b(429|5\d\d)\b|rate.?limit|quota|unavailable|backend error|internal error|timed? ?out|econnreset/i;
const QUOTA = /\b429\b|quota|rate.?limit/i;
const QUOTA_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const quoteSheet = (name: string): string => `'${name.replace(/'/g, "''")}'`;
export const stagingName = (sheet: string): string => `_staging_${sheet}`;

export class SheetsSink {
  readonly spreadsheetId: string;
  private readonly bin: string;
  private readonly tz: string;
  private readonly log?: Logger;
  private readonly backoffMs: number;
  private readonly quotaBackoffMs: number;
  private readonly maxJson: number;

  constructor(o: SinkOptions) {
    this.spreadsheetId = o.spreadsheetId;
    this.bin = o.bin || "gws";
    this.tz = o.timezone ?? "Europe/London";
    this.log = o.log;
    this.backoffMs = o.backoffMs ?? 2000;
    this.quotaBackoffMs = o.quotaBackoffMs ?? 65_000;
    this.maxJson = o.maxJsonBytes ?? MAX_JSON_BYTES;
  }

  private run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e: NodeJS.ErrnoException) =>
        reject(new SinkError(e.code === "ENOENT" ? `gws executable '${this.bin}' not found` : `cannot run gws: ${e.message}`)),
      );
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    });
  }

  /** One gws call: `gws sheets spreadsheets <method...> --params '<json>' [--json '<json>']`. */
  async call(method: string[], params: Record<string, unknown>, body?: unknown): Promise<any> {
    const args = ["sheets", "spreadsheets", ...method, "--params", JSON.stringify({ spreadsheetId: this.spreadsheetId, ...params })];
    if (body !== undefined) {
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json) > this.maxJson) throw new SinkError(`internal error: request body of ${Buffer.byteLength(json)} bytes exceeds the argv limit`);
      args.push("--json", json);
    }
    for (let attempt = 0; ; attempt++) {
      let failure: string | undefined;
      let result: any;
      const r = await this.run(args);
      let parsed: any;
      try { parsed = r.stdout.trim() ? JSON.parse(r.stdout.slice(r.stdout.indexOf("{") >= 0 ? r.stdout.indexOf("{") : 0)) : {}; } catch { parsed = undefined; }
      if (parsed && typeof parsed === "object" && parsed.error) {
        const e = parsed.error;
        failure = `gws ${method.join(" ")} failed: ${typeof e === "object" ? `${e.code ?? ""} ${e.message ?? ""}` : String(e)}`;
      } else if (r.code !== 0) {
        failure = `gws ${method.join(" ")} exited with ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`;
      } else if (parsed === undefined) {
        failure = `gws ${method.join(" ")} returned output that is not JSON`;
      } else {
        result = parsed;
      }
      if (failure === undefined) return result;
      const msg = redact(failure).replace(/\s+/g, " ").slice(0, 300);
      const why = `${failure} ${r.stderr}`;
      if (QUOTA.test(why) && attempt < QUOTA_RETRIES) {
        this.log?.warn(`${msg}; waiting ${Math.round(this.quotaBackoffMs / 1000)}s for the quota to reset (retry ${attempt + 1} of ${QUOTA_RETRIES})`);
        await sleep(this.quotaBackoffMs);
        continue;
      }
      if (attempt === 0 && TRANSIENT.test(why)) {
        this.log?.warn(`${msg}; retrying once`);
        await sleep(this.backoffMs);
        continue;
      }
      throw new SinkError(msg);
    }
  }

  async listSheets(): Promise<SheetInfo[]> {
    const res = await this.call(["get"], { fields: "sheets.properties" });
    return (res.sheets ?? []).map((s: any) => {
      const p = s.properties ?? {};
      const g = p.gridProperties ?? {};
      return {
        sheetId: p.sheetId,
        title: p.title,
        hidden: p.hidden === true,
        rowCount: g.rowCount ?? 1000,
        columnCount: g.columnCount ?? 26,
        frozenRowCount: g.frozenRowCount ?? 0,
      };
    });
  }

  /** Whole used range of a sheet as raw values (dates as serial numbers). */
  async readValues(sheet: string): Promise<unknown[][]> {
    const res = await this.call(["values", "get"], {
      range: quoteSheet(sheet),
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    return res.values ?? [];
  }

  batchUpdate(requests: unknown[]): Promise<any> {
    return this.call(["batchUpdate"], {}, { requests });
  }

  clearValues(range: string): Promise<any> {
    return this.call(["values", "clear"], { range }, {});
  }

  writeValues(range: string, values: unknown[][], valueInputOption: "RAW" | "USER_ENTERED"): Promise<any> {
    return this.call(["values", "update"], { range, valueInputOption }, { values });
  }

  /** Split rows so each serialised `{"values":[...]}` stays under the argv limit. */
  chunkRows<T>(rows: readonly T[]): T[][] {
    const overhead = Buffer.byteLength('{"values":[]}');
    const chunks: T[][] = [];
    let cur: T[] = [];
    let size = overhead;
    for (const row of rows) {
      const n = Buffer.byteLength(JSON.stringify(row)) + 1; // + comma
      if (overhead + n > this.maxJson) throw new SinkError("a single row is too large to send");
      if (cur.length > 0 && size + n > this.maxJson) {
        chunks.push(cur);
        cur = [];
        size = overhead;
      }
      cur.push(row);
      size += n;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /** Write a grid starting at A{startRow} in chunks. */
  async writeChunked(sheet: string, grid: Cell[][], valueInputOption: "RAW" | "USER_ENTERED" = "RAW"): Promise<number> {
    let row = 1;
    let calls = 0;
    for (const chunk of this.chunkRows(grid)) {
      await this.writeValues(`${quoteSheet(sheet)}!A${row}`, chunk, valueInputOption);
      row += chunk.length;
      calls++;
    }
    return calls;
  }

  /** Create any of the named sheets that are missing (never deletes or renames), return fresh info. */
  private async ensureSheets(want: { title: string; hidden?: boolean; rows: number; cols: number }[]): Promise<Map<string, SheetInfo>> {
    let sheets = await this.listSheets();
    const requests: unknown[] = [];
    for (const w of want) {
      const have = sheets.find((s) => s.title === w.title);
      if (!have) {
        requests.push({ addSheet: { properties: { title: w.title, ...(w.hidden ? { hidden: true } : {}), gridProperties: { rowCount: w.rows, columnCount: w.cols } } } });
      } else if (w.hidden) {
        // staging: exactly the size needed, and hidden
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: have.sheetId, hidden: true, gridProperties: { rowCount: w.rows, columnCount: w.cols, frozenRowCount: 0 } },
            fields: "hidden,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
          },
        });
      }
    }
    if (requests.length) {
      await this.batchUpdate(requests);
      sheets = await this.listSheets();
    }
    return new Map(sheets.map((s) => [s.title, s]));
  }

  /** Number formats for the data columns and a bold header row. */
  private formatRequests(def: TableDef, sheetId: number): unknown[] {
    const requests: unknown[] = [];
    def.cols.forEach((col, i) => {
      // Columns without a format are reset to automatic: a grown grid can carry a stale format into new columns.
      const f = NUMBER_FORMATS[col.type];
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
          cell: { userEnteredFormat: f ? { numberFormat: f } : {} },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: def.cols.length },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat.bold",
      },
    });
    return requests;
  }

  /**
   * Append-only table: make sure the sheet exists with the header row (created if missing, never altered if
   * present), then add `rows` after the existing ones. Rows already there are not rewritten. With `replace`,
   * existing rows whose `key` column equals `value` (a re-run on the same day) are dropped first: when they are
   * the trailing rows only they are cleared; otherwise the whole table is rewritten for this run.
   */
  async appendTable(def: TableDef, rows: readonly Row[], replace?: { key: string; value: string }): Promise<{ appended: number; replaced: number; rewrote: boolean }> {
    const header = def.cols.map((c) => c.key);
    const sheets = await this.listSheets();
    let grid: unknown[][] = [];
    const have = sheets.find((s) => s.title === def.sheet);
    if (have) grid = await this.readValues(def.sheet);
    if (grid.length > 0 && JSON.stringify(grid[0]!.map(String)) !== JSON.stringify(header)) {
      const old = grid[0]!.map(String);
      // columns added at the end in a newer version: extend the header, leave earlier rows' new cells blank
      const isPrefix = old.length < header.length && old.every((k, i) => k === header[i]);
      if (!isPrefix) throw new SinkError(`${def.sheet} has an unexpected header row; not touching it`);
      if (have!.columnCount < header.length) {
        await this.batchUpdate([{ appendDimension: { sheetId: have!.sheetId, dimension: "COLUMNS", length: header.length - have!.columnCount } }]);
      }
      await this.writeValues(`${quoteSheet(def.sheet)}!A1`, [header], "RAW");
      this.log?.info(`${def.sheet}: added column(s) ${header.slice(old.length).join(", ")}`);
      grid = [header, ...grid.slice(1)];
    }
    if (grid.length === 0) {
      const info = await this.ensureSheets([{ title: def.sheet, rows: Math.max(rows.length + 1, 2), cols: header.length }]);
      const target = info.get(def.sheet)!;
      await this.writeValues(`${quoteSheet(def.sheet)}!A1`, [header], "RAW");
      await this.batchUpdate([
        { updateSheetProperties: { properties: { sheetId: target.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        ...this.formatRequests(def, target.sheetId),
      ]);
      grid = [header];
    }

    let replaced = 0;
    if (replace) {
      const col = def.cols.find((c) => c.key === replace.key)!;
      const at = header.indexOf(replace.key);
      const hits: number[] = [];
      grid.forEach((line, i) => {
        if (i > 0 && decodeCell(col, line[at], this.tz) === replace.value) hits.push(i);
      });
      replaced = hits.length;
      if (hits.length > 0) {
        const first = hits[0]!;
        const suffix = hits.length === grid.length - first && hits.every((h, k) => h === first + k);
        if (!suffix) {
          const kept = grid.filter((_, i) => i > 0 && !hits.includes(i));
          const decoded = decodeRows(def, [grid[0]!, ...kept], this.tz);
          await this.rewriteTable(def, [...decoded, ...rows]);
          return { appended: rows.length, replaced, rewrote: true };
        }
        await this.clearValues(`${quoteSheet(def.sheet)}!A${first + 1}:${colLetter(header.length - 1)}`);
      }
    }
    const body = encodeRows(def, rows, this.tz).slice(1);
    let calls = 0;
    for (const chunk of this.chunkRows(body)) {
      await this.call(["values", "append"], { range: `${quoteSheet(def.sheet)}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, { values: chunk });
      calls++;
    }
    this.log?.info(`${def.sheet}: appended ${rows.length} rows in ${calls} chunk(s)`);
    return { appended: rows.length, replaced, rewrote: false };
  }

  /**
   * Replace a sheet's contents without ever showing half-written data and without deleting or renaming it:
   * write to a hidden staging sheet, then one batchUpdate copies it over the target.
   * Returns the number of value-write calls used.
   */
  async rewriteTable(def: TableDef, rows: readonly Row[]): Promise<{ writes: number }> {
    const grid = encodeRows(def, rows, this.tz);
    const nRows = grid.length;
    const nCols = def.cols.length;
    const stage = stagingName(def.sheet);

    // 1 + 2: ensure target and staging; staging is resized, cleared, then filled in chunks
    const info = await this.ensureSheets([
      { title: def.sheet, rows: Math.max(nRows, 2), cols: nCols },
      { title: stage, hidden: true, rows: nRows, cols: nCols },
    ]);
    const target = info.get(def.sheet)!;
    const staging = info.get(stage)!;
    await this.clearValues(quoteSheet(stage));
    const writes = await this.writeChunked(stage, grid, "RAW");

    // 3: one atomic batch: grow target, paste values, blank the leftovers, formats, header, freeze
    const newRows = Math.max(target.rowCount, nRows);
    const newCols = Math.max(target.columnCount, nCols);
    const requests: unknown[] = [
      {
        updateSheetProperties: {
          properties: { sheetId: target.sheetId, gridProperties: { rowCount: newRows, columnCount: newCols, frozenRowCount: 1 } },
          fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
        },
      },
      {
        copyPaste: {
          source: { sheetId: staging.sheetId, startRowIndex: 0, endRowIndex: nRows, startColumnIndex: 0, endColumnIndex: nCols },
          destination: { sheetId: target.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
          pasteType: "PASTE_VALUES",
        },
      },
    ];
    if (newRows > nRows) {
      requests.push({
        updateCells: {
          range: { sheetId: target.sheetId, startRowIndex: nRows, endRowIndex: newRows, startColumnIndex: 0, endColumnIndex: nCols },
          fields: "userEnteredValue",
        },
      });
    }
    requests.push(...this.formatRequests(def, target.sheetId));
    await this.batchUpdate(requests);

    // 4: clean up staging (values, then shrink to free cells); it stays hidden
    await this.clearValues(quoteSheet(stage));
    await this.batchUpdate([
      {
        updateSheetProperties: {
          properties: { sheetId: staging.sheetId, gridProperties: { rowCount: 1, columnCount: 1 } },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      },
    ]);
    this.log?.info(`${def.sheet}: wrote ${nRows - 1} rows in ${writes} chunk(s)`);
    return { writes };
  }
}

export { colIndex };
