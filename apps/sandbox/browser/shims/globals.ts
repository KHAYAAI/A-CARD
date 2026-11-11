import { Buffer } from "buffer";

// The `buffer` package predates the base64url encoding Node has; add it.
const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, enc?: string, start?: number, end?: number) {
  return enc === "base64url" ? b64url(toString.call(this, "base64", start, end)) : toString.call(this, enc as BufferEncoding, start, end);
} as typeof Buffer.prototype.toString;
const from = Buffer.from.bind(Buffer) as any;
(Buffer as any).from = (v: any, enc?: any, len?: any) => (enc === "base64url" ? from(unb64url(String(v)), "base64") : from(v, enc, len));

(globalThis as any).Buffer ??= Buffer;
(globalThis as any).process ??= { env: {}, argv: [], platform: "browser", versions: {}, nextTick: (f: () => void) => queueMicrotask(f), exitCode: 0, cwd: () => "/", emitWarning() {} };
