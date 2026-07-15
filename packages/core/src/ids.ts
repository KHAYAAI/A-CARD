import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomId(length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

/** Prefixed, URL-safe identifiers, e.g. `card_x8k2...`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomId()}`;
}
