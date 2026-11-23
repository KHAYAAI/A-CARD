import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A software passkey for tests: produces real WebAuthn registration and
 * assertion responses (ES256, "none" attestation), signed with a real key, so
 * the server's verification runs exactly as it would for a phone.
 */
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

// Minimal CBOR encoder for the few shapes WebAuthn needs.
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (typeof v === "object" && v) { const e = Object.entries(v); return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(x)])]); }
  throw new Error("unsupported");
}

export class SoftAuthenticator {
  private key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credId = randomBytes(16);
  private count = 0;
  constructor(readonly rpId: string, readonly origin: string) {}

  private authData(flags: number, attested?: Buffer) {
    const c = Buffer.alloc(4); c.writeUInt32BE(++this.count);
    return Buffer.concat([createHash("sha256").update(this.rpId).digest(), Buffer.from([flags]), c, attested ?? Buffer.alloc(0)]);
  }

  register(options: { challenge: string }) {
    const jwk = this.key.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), len, this.credId, cose])); // UP | UV | AT
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] },
    };
  }

  /** userVerified=false simulates a device that only checked presence, not Face ID / PIN. */
  assert(options: { challenge: string }, { userVerified = true, origin = this.origin } = {}) {
    const authData = this.authData(userVerified ? 0x05 : 0x01);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), this.key.privateKey);
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}
