/** The browser build always runs x402 with private-network checks off (the browser is the only network it has), so these only need to exist. */
export const isIP = (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(":") ? 6 : 0);
export class BlockList {
  addSubnet() {}
  check() {
    return true;
  }
}
