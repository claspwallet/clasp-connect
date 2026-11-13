/**
 * The RainbowKit compatibility pin. The type-only import is erased at
 * runtime — node never loads RainbowKit's React/CSS — but `npm run
 * typecheck` compiles the assignment below against the real
 * @rainbow-me/rainbowkit 2.2.x Wallet type, which is the whole point:
 * claspWallet() must satisfy their shape without depending on their package.
 */
import { describe, expect, it } from "vitest";
import type { Wallet, WalletDetailsParams } from "@rainbow-me/rainbowkit";
import { claspWallet } from "./rainbowkit";

// The compile-time pin: if RainbowKit's Wallet shape drifts away from the
// descriptor, typecheck fails here rather than in an integrator's app.
const rkCompat: Wallet = claspWallet();
void rkCompat;

describe("claspWallet", () => {
  it("is a website wallet: installed, named, waxed", () => {
    const w = claspWallet();
    expect(w.installed).toBe(true);
    expect(w.id).toBe("clasp");
    expect(w.name).toBe("Clasp");
    expect(w.iconBackground).toBe("#CE1A56");
    expect(w.iconUrl).toBe("https://claspwallet.com/icon.svg");
  });

  it("carries RainbowKit's walletDetails through to the connector", () => {
    const w = claspWallet();
    const details = {
      rkDetails: { isRainbowKitConnector: true },
    } as unknown as WalletDetailsParams;
    const create = w.createConnector(details);
    const connector = create({
      chains: [
        {
          id: 1449000,
          name: "XRPL EVM Testnet",
          nativeCurrency: { decimals: 18, name: "XRP", symbol: "XRP" },
          rpcUrls: { default: { http: ["https://rpc.testnet.xrplevm.org"] } },
        },
      ],
      emitter: { uid: "t", emit: () => {} },
      storage: null,
    } as unknown as Parameters<typeof create>[0]);
    expect(connector.id).toBe("clasp");
    expect(
      (connector as unknown as { rkDetails: { isRainbowKitConnector: boolean } })
        .rkDetails,
    ).toEqual({ isRainbowKitConnector: true });
  });
});
