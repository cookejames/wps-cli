import { redact } from "./session.ts";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export function createLogger(write: (s: string) => void = (s) => process.stderr.write(s)): Logger {
  return {
    info: (m) => write(redact(`wps: ${m}`) + "\n"),
    warn: (m) => write(redact(`wps: warning: ${m}`) + "\n"),
  };
}
