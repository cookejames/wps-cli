import type { ExtractedCategory } from "../model.ts";

const OBJ_RE = /\{[^{}]*?["']?\buid["']?\s*:\s*\d+[^{}]*\}/g;

const field = (obj: string, name: string, value: string): RegExpMatchArray | null =>
  obj.match(new RegExp(`["']?\\b${name}["']?\\s*:\\s*${value}`));

/**
 * Extract {uid:N,key:"...",categoryGroup:N,externalId:"..."} object literals from JS source.
 * Tolerant of field order and quoting. Dedupes by uid, preferring entries with externalId.
 */
export function extractCategories(source: string): ExtractedCategory[] {
  const byUid = new Map<number, ExtractedCategory>();
  for (const m of source.matchAll(OBJ_RE)) {
    const obj = m[0];
    const uid = field(obj, "uid", "(\\d+)");
    const key = field(obj, "key", `["']([A-Za-z][A-Za-z0-9_]*)["']`);
    const group = field(obj, "categoryGroup", "(\\d+)");
    if (!uid || !key || !group) continue;
    const ext = field(obj, "externalId", `["']([0-9a-fA-F-]{36})["']`);
    const entry: ExtractedCategory = { uid: Number(uid[1]), key: key[1], group: Number(group[1]), externalId: ext ? ext[1].toLowerCase() : null };
    const prev = byUid.get(entry.uid);
    if (!prev || (!prev.externalId && entry.externalId)) byUid.set(entry.uid, entry);
  }
  return [...byUid.values()].sort((a, b) => a.uid - b.uid);
}
