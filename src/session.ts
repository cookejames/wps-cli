import { AuthError } from "./errors.ts";

export interface Session {
  cookie: string;
  csrf: string;
  /** optional; sent as the user-agent header. Not secret. */
  userAgent?: string;
}

/** Secrets registered for redaction. Held in memory only. */
let secrets: string[] = [];

const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
const MARK = "[redacted]";

export function registerSecrets(session: Session): void {
  const list = new Set<string>();
  if (session.csrf.length >= 4) list.add(session.csrf);
  if (session.cookie.length >= 4) list.add(session.cookie);
  for (const pair of session.cookie.split(";")) {
    const t = pair.trim();
    if (!t) continue;
    list.add(t);
    const eq = t.indexOf("=");
    if (eq >= 0) {
      const name = t.slice(0, eq);
      const value = t.slice(eq + 1);
      if (value.length >= 8) list.add(value);
      // cookie names can themselves carry an identifier
      if (name.length >= 12) list.add(name);
    }
  }
  secrets = [...list].sort((a, b) => b.length - a.length);
}

export function clearSecrets(): void {
  secrets = [];
}

/** Remove registered session secrets and anything JWT-shaped. */
export function redact(text: string, extra: readonly string[] = []): string {
  let out = String(text);
  const all = [...secrets, ...extra.filter((s) => s.length >= 4)].sort((a, b) => b.length - a.length);
  for (const s of all) out = out.split(s).join(MARK);
  return out.replace(JWT_RE, MARK);
}

export function parseSession(raw: string): Session {
  if (!raw.trim()) throw new AuthError("no session on stdin");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new AuthError("session on stdin is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null) throw new AuthError("session must be a JSON object");
  const { cookie, csrf, userAgent } = obj as Record<string, unknown>;
  if (typeof cookie !== "string" || !cookie.trim()) throw new AuthError("session is missing 'cookie'");
  if (typeof csrf !== "string" || !csrf.trim()) throw new AuthError("session is missing 'csrf'");
  const session: Session = { cookie, csrf };
  if (typeof userAgent === "string" && userAgent.trim() && !/[\r\n]/.test(userAgent)) session.userAgent = userAgent.trim();
  registerSecrets(session);
  return session;
}

export async function readSession(stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<Session> {
  if (stdin.isTTY) throw new AuthError("no session: stdin is a terminal (pipe the session JSON in)");
  let raw = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) raw += chunk;
  return parseSession(raw);
}
