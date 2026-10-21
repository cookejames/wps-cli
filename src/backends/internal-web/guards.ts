import { UpstreamError } from "../../errors.ts";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** body.data.result as an array of records. */
export function resultArray(body: unknown, what: string): Rec[] {
  const result = isRec(body) && isRec(body.data) ? body.data.result : undefined;
  if (!Array.isArray(result)) throw new UpstreamError(`${what}: unexpected response shape (no data.result array)`);
  result.forEach((item, i) => {
    if (!isRec(item)) throw new UpstreamError(`${what}: item ${i} is not an object`);
  });
  return result as Rec[];
}

export function requireString(item: Rec, field: string, what: string, i: number): void {
  if (typeof item[field] !== "string" || !item[field]) throw new UpstreamError(`${what}: item ${i} has no string '${field}'`);
}
