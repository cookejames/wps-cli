export type MergeRow = Record<string, unknown>;

export interface MergeOptions {
  /** field holding the unique id (default "uid") */
  key?: string;
  /** field holding the YYYY-MM-DD date used for the window (default "bookingDate") */
  dateField?: string;
}

export interface MergeResult<T extends MergeRow> {
  rows: T[];
  added: number;
  updated: number;
  unchanged: number;
  /** existing in-window rows absent from fresh data (kept, flagged) */
  missing: number;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Merge freshly fetched rows (covering windowStart..windowEnd inclusive) into existing rows.
 * - rows outside the window and not in fresh: untouched
 * - rows in fresh: replaced in place (or appended if new); `missingFromSource` cleared
 * - rows inside the window but not in fresh: KEPT, flagged missingFromSource: true
 * Existing rows are never deleted; `deleted: true` rows from the source stay as flagged rows.
 */
export function mergeByUid<T extends MergeRow>(
  existing: readonly T[],
  fresh: readonly T[],
  windowStart: string,
  windowEnd: string,
  opts: MergeOptions = {},
): MergeResult<T> {
  const key = opts.key ?? "uid";
  const dateField = opts.dateField ?? "bookingDate";
  const freshById = new Map<string, T>();
  for (const r of fresh) freshById.set(String(r[key]), r);

  const seen = new Set<string>();
  const rows: T[] = [];
  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const old of existing) {
    const id = String(old[key]);
    const f = freshById.get(id);
    if (f) {
      seen.add(id);
      const { missingFromSource: _flag, ...oldRest } = old as MergeRow;
      if (stable(oldRest) === stable(f) && old.missingFromSource !== true) {
        rows.push(old);
        unchanged++;
      } else {
        rows.push(f);
        updated++;
      }
      continue;
    }
    const d = String(old[dateField] ?? "");
    if (d >= windowStart && d <= windowEnd) {
      if (old.missingFromSource === true) rows.push(old);
      else rows.push({ ...old, missingFromSource: true });
      missing++;
    } else {
      rows.push(old);
    }
  }

  let added = 0;
  for (const [id, f] of freshById) {
    if (seen.has(id)) continue;
    rows.push(f);
    added++;
  }
  return { rows, added, updated, unchanged, missing };
}
