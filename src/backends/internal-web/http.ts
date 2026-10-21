import { requireApiConfig, type Config } from "../../config.ts";
import { AuthError, UpstreamError } from "../../errors.ts";
import { redact, type Session } from "../../session.ts";

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly config: Config;
  private readonly session: Session;
  private readonly fetchImpl: typeof fetch;

  private readonly pauseMs: [number, number];
  private tail: Promise<unknown> = Promise.resolve();
  private requests = 0;

  /** pauseMs: random pause range between consecutive requests (default 300-600 ms). */
  constructor(config: Config, session: Session, fetchImpl: typeof fetch = fetch, pauseMs: [number, number] = [300, 600]) {
    requireApiConfig(config);
    this.pauseMs = pauseMs;
    this.config = config;
    this.session = session;
    this.fetchImpl = fetchImpl;
  }

  /** The one shared header builder; every request uses it. */
  headers(): Record<string, string> {
    return {
      cookie: this.session.cookie,
      "csrf-token": this.session.csrf,
      accept: "application/json, text/plain, */*",
      "accept-language": "en-GB,en;q=0.9",
      "user-agent": this.session.userAgent ?? DEFAULT_USER_AGENT,
      origin: this.config.webOrigin,
      referer: this.config.webOrigin + "/",
    };
  }

  /** Requests run one at a time, with a jittered pause between consecutive ones. */
  request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    const run = async () => {
      if (this.requests++ > 0) {
        const [lo, hi] = this.pauseMs;
        const ms = lo + Math.random() * Math.max(0, hi - lo);
        if (ms > 0) await sleep(ms);
      }
      return this.send(method, path, body);
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async send(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    const headers = this.headers();
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new UpstreamError(redact(`${method} ${path.split("?")[0]} failed: ${(e as Error).message}`));
    }
    const text = await res.text();
    const where = `${method} ${path.split("?")[0]}`;
    if (res.status === 401 || res.status === 403) throw new AuthError(`${where} returned HTTP ${res.status}`);
    if (/Invalid csrf|No csrf found in headers/i.test(text.slice(0, 500))) throw new AuthError(`${where}: csrf rejected`);
    if (!res.ok) throw new UpstreamError(`${where} returned HTTP ${res.status}`);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError(`${where} returned a non-JSON body`);
    }
  }
}
