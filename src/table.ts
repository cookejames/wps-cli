function getPath(row: unknown, path: string): unknown {
  let cur: any = row;
  for (const p of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ");
}

/** Aligned plain-text table. Non-array data becomes a key/value listing. */
export function renderTable(data: unknown, columns?: string[]): string {
  if (!Array.isArray(data)) {
    if (data && typeof data === "object") {
      const entries = Object.entries(data as Record<string, unknown>);
      const w = Math.max(0, ...entries.map(([k]) => k.length));
      return entries.map(([k, v]) => `${k.padEnd(w)}  ${cell(v)}`).join("\n") + "\n";
    }
    return cell(data) + "\n";
  }
  if (data.length === 0) return "(no rows)\n";
  const cols = columns ?? [...new Set(data.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
  const rows = data.map((r) => cols.map((c) => cell(getPath(r, c))));
  const widths = cols.map((c, i) => Math.min(60, Math.max(c.length, ...rows.map((r) => r[i].length))));
  const fmt = (r: string[]) =>
    r.map((v, i) => (v.length > widths[i] ? v.slice(0, widths[i] - 1) + "…" : v.padEnd(widths[i]))).join("  ").trimEnd();
  return [fmt(cols), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n") + "\n";
}
