export type Status = "ok" | "auth_failed" | "upstream_error" | "sink_error" | "bad_args" | "error";

export const EXIT_CODES: Record<Status, number> = {
  ok: 0,
  error: 1,
  auth_failed: 2,
  upstream_error: 3,
  sink_error: 4,
  bad_args: 5,
};

export class WpsError extends Error {
  readonly status: Exclude<Status, "ok">;
  constructor(status: Exclude<Status, "ok">, message: string) {
    super(message);
    this.name = "WpsError";
    this.status = status;
  }
  get exitCode(): number {
    return EXIT_CODES[this.status];
  }
}
export class AuthError extends WpsError {
  constructor(message: string) { super("auth_failed", message); }
}
export class UpstreamError extends WpsError {
  constructor(message: string) { super("upstream_error", message); }
}
export class SinkError extends WpsError {
  constructor(message: string) { super("sink_error", message); }
}
export class BadArgsError extends WpsError {
  constructor(message: string) { super("bad_args", message); }
}
