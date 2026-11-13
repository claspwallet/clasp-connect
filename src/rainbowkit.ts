/**
 * clasp-connect/rainbowkit — a RainbowKit Wallet descriptor for Clasp.
 *
 * RainbowKit is NOT a dependency of the published package, not even a peer:
 * the descriptor is a plain object matching RainbowKit 2.2.x's `Wallet`
 * shape structurally, and the repo pins compatibility with a type-level
 * test compiled against the real package (sdk/src/rainbowkit.test.ts).
 * Importing their type here would drag wagmi(react) + react-query into
 * every consumer's type graph for zero runtime benefit.
 */
import type { CreateConnectorFn } from "@wagmi/core";
import { claspConnector, type ClaspConnectorOptions } from "./wagmi.js";

export type ClaspWalletOptions = ClaspConnectorOptions;

export function claspWallet(options: ClaspWalletOptions = {}) {
  return {
    id: "clasp",
    name: "Clasp",
    shortName: "Clasp",
    rdns: "com.claspwallet",
    iconUrl: "https://claspwallet.com/icon.svg",
    // The icon tile's own wax (matches app/icon.svg's background).
    iconBackground: "#CE1A56",
    // A website wallet: there is nothing to install, and without this flag
    // RainbowKit routes users into a download/QR flow that dead-ends.
    installed: true,
    // `walletDetails: object` is deliberately wider than RainbowKit's
    // WalletDetailsParams — parameter contravariance makes this assignable
    // to their createConnector without importing their type.
    createConnector: (walletDetails: object): CreateConnectorFn =>
      ((config) => ({
        ...claspConnector(options)(config),
        ...(walletDetails as Record<string, unknown>),
      })) as CreateConnectorFn,
  };
}
