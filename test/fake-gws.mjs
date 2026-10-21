#!/usr/bin/env node
// TEST ONLY: a fake `gws` that keeps a tiny spreadsheet model in a JSON state file (env FAKE_GWS_STATE)
// and appends every call to <state>.log (JSON lines). Enforces grid bounds like the real API.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GWS_STATE;
const argv = process.argv.slice(2);
if (argv[0] !== "sheets" || argv[1] !== "spreadsheets") { console.error("fake gws: unexpected command"); process.exit(2); }
const rest = argv.slice(2);
let dd = rest.findIndex((t) => t.startsWith("--"));
if (dd < 0) dd = rest.length;
const method = rest.slice(0, dd).join(" ");
const arg = (f) => (rest.indexOf(f) >= 0 ? rest[rest.indexOf(f) + 1] : undefined);
const params = arg("--params") ? JSON.parse(arg("--params")) : {};
const body = arg("--json") !== undefined ? JSON.parse(arg("--json")) : undefined;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { nextId: 1, sheets: [] };
appendFileSync(statePath + ".log", JSON.stringify({ method, params, body, jsonBytes: arg("--json") === undefined ? 0 : Buffer.byteLength(arg("--json")) }) + "\n");

function fail(code, message) {
  process.stdout.write(JSON.stringify({ error: { code, message } }) + "\n");
  console.error(`error[api]: ${message}`);
  process.exit(1);
}
if ((state.failNext ?? 0) > 0) {
  state.failNext--;
  writeFileSync(statePath, JSON.stringify(state));
  fail(state.failCode ?? 503, "The service is unavailable.");
}
const save = () => writeFileSync(statePath, JSON.stringify(state));
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };
const byTitle = (t) => state.sheets.find((s) => s.title === t);
const byId = (id) => state.sheets.find((s) => s.sheetId === id) ?? fail(400, `no sheet ${id}`);
function parseRange(r) {
  const m = /^(?:'((?:[^']|'')*)'|([^!]+))(?:!(.+))?$/.exec(r);
  const title = (m[1] ?? m[2]).replace(/''/g, "'");
  const sh = byTitle(title) ?? fail(400, `Unable to parse range: ${r}`);
  let row = 0;
  if (m[3]) { const c = /^([A-Z]+)(\d+)/.exec(m[3]); row = Number(c[2]) - 1; }
  return { sh, row };
}
const cell = (v) => (v === "" || v === undefined ? null : v);
function ensureGrid(sh) { while (sh.values.length < Math.min(sh.rowCount, sh.values.length)) sh.values.push([]); }
function put(sh, row, matrix) {
  if (row + matrix.length > sh.rowCount) fail(400, `Range exceeds grid limits. Max rows: ${sh.rowCount}`);
  matrix.forEach((line, i) => {
    if (line.length > sh.columnCount) fail(400, `Range exceeds grid limits. Max columns: ${sh.columnCount}`);
    while (sh.values.length <= row + i) sh.values.push([]);
    const dst = sh.values[row + i];
    line.forEach((v, j) => { dst[j] = cell(v); });
  });
}
const newSheet = (p) => ({
  sheetId: 1000 + state.nextId++, title: p.title, hidden: p.hidden === true,
  rowCount: p.gridProperties?.rowCount ?? 1000, columnCount: p.gridProperties?.columnCount ?? 26,
  frozenRowCount: p.gridProperties?.frozenRowCount ?? 0, values: [], formats: [],
});

switch (method) {
  case "get":
    out({ spreadsheetId: params.spreadsheetId, sheets: state.sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title, hidden: s.hidden || undefined, gridProperties: { rowCount: s.rowCount, columnCount: s.columnCount, frozenRowCount: s.frozenRowCount || undefined } } })) });
    break;
  case "values get": {
    const { sh } = parseRange(params.range);
    let rows = sh.values.map((r) => { const o = r.map((v) => v ?? ""); while (o.length && o[o.length - 1] === "") o.pop(); return o; });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    out(rows.length ? { range: params.range, majorDimension: "ROWS", values: rows } : { range: params.range, majorDimension: "ROWS" });
    break;
  }
  case "values update": {
    if (!["RAW", "USER_ENTERED"].includes(params.valueInputOption)) fail(400, "valueInputOption required");
    const { sh, row } = parseRange(params.range);
    sh.inputOptions = [...(sh.inputOptions ?? []), params.valueInputOption];
    put(sh, row, body.values);
    save();
    out({ updatedRows: body.values.length });
    break;
  }
  case "values clear": {
    const { sh } = parseRange(params.range);
    sh.values = [];
    save();
    out({ clearedRange: params.range });
    break;
  }
  case "batchUpdate": {
    const replies = [];
    for (const r of body.requests) {
      if (r.addSheet) {
        if (byTitle(r.addSheet.properties.title)) fail(400, "A sheet with that name already exists");
        const s = newSheet(r.addSheet.properties);
        state.sheets.push(s);
        replies.push({ addSheet: { properties: { sheetId: s.sheetId, title: s.title } } });
      } else if (r.updateSheetProperties) {
        const { properties: p, fields } = r.updateSheetProperties;
        const s = byId(p.sheetId);
        for (const f of fields.split(",")) {
          if (f === "title") s.title = p.title;
          else if (f === "hidden") s.hidden = p.hidden === true;
          else if (f.startsWith("gridProperties.")) {
            const k = f.slice(15);
            s[k] = p.gridProperties[k] ?? 0;
          } else fail(400, `unsupported field ${f}`);
        }
        s.values = s.values.slice(0, s.rowCount).map((row) => row.slice(0, s.columnCount));
        replies.push({});
      } else if (r.copyPaste) {
        if (r.copyPaste.pasteType !== "PASTE_VALUES") fail(400, "only PASTE_VALUES supported by the fake");
        const { source: a, destination: d } = r.copyPaste;
        const src = byId(a.sheetId), dst = byId(d.sheetId);
        const block = [];
        for (let i = a.startRowIndex; i < a.endRowIndex; i++) {
          const line = [];
          for (let j = a.startColumnIndex; j < a.endColumnIndex; j++) line.push(src.values[i]?.[j] ?? null);
          block.push(line);
        }
        put(dst, d.startRowIndex, block);
        replies.push({});
      } else if (r.updateCells) {
        const { range: g, fields } = r.updateCells;
        if (fields !== "userEnteredValue") fail(400, "unsupported");
        const s = byId(g.sheetId);
        for (let i = g.startRowIndex; i < Math.min(g.endRowIndex, s.values.length); i++)
          for (let j = g.startColumnIndex; j < g.endColumnIndex; j++) if (s.values[i]) s.values[i][j] = null;
        replies.push({});
      } else if (r.repeatCell) {
        byId(r.repeatCell.range.sheetId).formats.push(r.repeatCell);
        replies.push({});
      } else fail(400, `unsupported request ${Object.keys(r)[0]}`);
    }
    save();
    out({ spreadsheetId: params.spreadsheetId, replies });
    break;
  }
  default:
    fail(400, `fake gws: unsupported method '${method}'`);
}
