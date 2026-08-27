import { describe, expect, it, vi } from "vitest";
import { decryptField, encryptField, loadEncryptionKey } from "../src/encryption.js";

describe("AES-256-GCM field encryption", () => {
  const key = Buffer.from("a".repeat(64), "hex"); // 32 bytes

  it("round-trips a value", () => {
    const packed = encryptField("4242424242421234", key);
    expect(decryptField(packed, key)).toBe("4242424242421234");
  });

  it("never stores the plaintext as a substring of the ciphertext", () => {
    const packed = encryptField("4242424242421234", key);
    expect(packed).not.toContain("4242");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptField("4242424242421234", key);
    const b = encryptField("4242424242421234", key);
    expect(a).not.toBe(b);
    expect(decryptField(a, key)).toBe(decryptField(b, key));
  });

  it("rejects the wrong key — GCM's auth tag catches it, doesn't silently return garbage", () => {
    const packed = encryptField("4242424242421234", key);
    const wrongKey = Buffer.from("b".repeat(64), "hex");
    expect(() => decryptField(packed, wrongKey)).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const packed = encryptField("4242424242421234", key);
    const buf = Buffer.from(packed, "base64");
    const last = buf.length - 1;
    buf.writeUInt8(buf.readUInt8(last) ^ 0xff, last); // flip the last ciphertext byte
    expect(() => decryptField(buf.toString("base64"), key)).toThrow();
  });
});

describe("loadEncryptionKey", () => {
  it("loads a valid 64-hex-char key from the env", () => {
    const hex = "c".repeat(64);
    const key = loadEncryptionKey({ ACARD_ENCRYPTION_KEY: hex } as NodeJS.ProcessEnv);
    expect(key.toString("hex")).toBe(hex);
    expect(key.length).toBe(32);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => loadEncryptionKey({ ACARD_ENCRYPTION_KEY: "tooshort" } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
  });

  it("falls back to a random per-process key and warns, rather than failing, when unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = loadEncryptionKey({} as NodeJS.ProcessEnv);
    expect(key.length).toBe(32);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ACARD_ENCRYPTION_KEY not set"));
    warn.mockRestore();
  });
});
