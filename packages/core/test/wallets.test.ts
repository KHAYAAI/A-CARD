import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../src/platform.js";

let platform: Platform;
let holderId: string;

beforeEach(() => {
  platform = new Platform();
  holderId = platform.signup({ email: "user@example.com", name: "User" }).id;
});

describe("crypto wallets: embedded by default", () => {
  it("records a provider-issued embedded wallet and makes it the default", () => {
    const wallet = platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    expect(wallet.kind).toBe("embedded");
    expect(wallet.isDefault).toBe(true);
    expect(platform.listLinkedWallets(holderId)).toEqual([wallet]);
  });

  it("is idempotent per (holder, chain) — provisioning twice returns the same wallet", () => {
    const first = platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    const second = platform.recordEmbeddedWallet(holderId, "ethereum", "0x2222222222222222222222222222222222222222");
    expect(second.id).toBe(first.id);
    expect(second.address).toBe(first.address);
  });

  it("rejects provisioning for an unknown account holder", () => {
    expect(() => platform.recordEmbeddedWallet("ah_nope", "ethereum", "0x1111111111111111111111111111111111111111")).toThrow();
  });
});

describe("crypto wallets: optional external linking", () => {
  it("links an external wallet alongside the embedded one", () => {
    platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    const external = platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "ethereum",
      address: "0x3333333333333333333333333333333333333333",
      connector: "metamask",
      label: "My MetaMask",
    });
    expect(external.kind).toBe("external");
    expect(external.isDefault).toBe(false); // embedded wallet, created first, stays default
    expect(platform.listLinkedWallets(holderId)).toHaveLength(2);
  });

  it("rejects an invalid address for the chain", () => {
    expect(() =>
      platform.linkExternalWallet({ accountHolderId: holderId, chain: "ethereum", address: "not-an-address", connector: "metamask" }),
    ).toThrow(/valid/);
  });

  it("rejects linking the same address twice", () => {
    const addr = "0x3333333333333333333333333333333333333333";
    platform.linkExternalWallet({ accountHolderId: holderId, chain: "ethereum", address: addr, connector: "metamask" });
    expect(() =>
      platform.linkExternalWallet({ accountHolderId: holderId, chain: "ethereum", address: addr, connector: "metamask" }),
    ).toThrow(/already linked/);
  });

  it("lets the user switch their default wallet", () => {
    platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    const external = platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "ethereum",
      address: "0x3333333333333333333333333333333333333333",
      connector: "metamask",
    });
    platform.setDefaultWallet(holderId, external.id);
    const wallets = platform.listLinkedWallets(holderId);
    expect(wallets.find((w) => w.id === external.id)!.isDefault).toBe(true);
    expect(wallets.find((w) => w.kind === "embedded")!.isDefault).toBe(false);
  });

  it("cannot unlink the embedded wallet, only external ones", () => {
    const embedded = platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    expect(() => platform.unlinkWallet(holderId, embedded.id)).toThrow(/cannot be unlinked/);

    const external = platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "ethereum",
      address: "0x3333333333333333333333333333333333333333",
      connector: "metamask",
    });
    platform.unlinkWallet(holderId, external.id);
    expect(platform.listLinkedWallets(holderId)).toHaveLength(1);
  });

  it("promotes another wallet to default when the default is unlinked", () => {
    const external1 = platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "ethereum",
      address: "0x3333333333333333333333333333333333333333",
      connector: "metamask",
    });
    const external2 = platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "ethereum",
      address: "0x4444444444444444444444444444444444444444",
      connector: "walletconnect",
    });
    expect(external1.isDefault).toBe(true);
    platform.unlinkWallet(holderId, external1.id);
    expect(platform.listLinkedWallets(holderId).find((w) => w.id === external2.id)!.isDefault).toBe(true);
  });
});

describe("crypto wallets: snapshot round-trip", () => {
  it("preserves linked wallets across hydrate", () => {
    platform.recordEmbeddedWallet(holderId, "ethereum", "0x1111111111111111111111111111111111111111");
    platform.linkExternalWallet({
      accountHolderId: holderId,
      chain: "solana",
      address: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      connector: "other",
    });
    const restored = Platform.hydrate(platform.serialize());
    expect(restored.listLinkedWallets(holderId)).toHaveLength(2);
  });
});
