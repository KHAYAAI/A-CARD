import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Agents hand A-CARD a URL and A-CARD's server fetches it. Without a guard
 * that's a server-side request forgery hole: an agent (or a prompt that
 * steered one) could point it at the API's own network — a metadata
 * endpoint, a database, an admin port. So every x402 URL must be HTTPS and
 * resolve only to public addresses.
 *
 * Sandbox and test deployments that need to reach a local x402 server opt
 * out explicitly with `allowPrivateNetworks` (which also allows plain HTTP).
 * Redirects are never followed (the payer fetches with `redirect: "manual"`),
 * so a public URL can't bounce the request somewhere private.
 */

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return PRIVATE.check(mapped[1]!, "ipv4");
    return PRIVATE.check(address, "ipv6");
  }
  return true; // not an IP at all: refuse rather than guess
}

export class UnsafeUrlError extends Error {}

export async function assertFetchableUrl(raw: string, options: { allowPrivateNetworks?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (options.allowPrivateNetworks) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("only http(s) URLs can be paid over x402");
    return url;
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("x402 resources must be HTTPS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new UnsafeUrlError(`could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError(`${host} resolves to a private or reserved address`);
  return url;
}
