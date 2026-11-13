/**
 * clasp-connect/wagmi — the Clasp connector for wagmi v2 (and the v2/v3
 * shared subset).
 *
 * RUNTIME imports come only from ./protocol.js and ./index.js — everything
 * from @wagmi/core and viem is `import type`, so the published package stays
 * zero-dependency at runtime and the peers are types-only. wagmi's
 * createConnector is an identity function, so this module simply exports a
 * correctly-typed CreateConnectorFn.
 *
 * The four rules that keep this connector honest (docs/INTEROP.md §5):
 *  1. getProvider(), isAuthorized(), getAccounts(), getChainId() and
 *     connect({isReconnecting}) NEVER open a popup — wagmi calls them on
 *     every page load with no user gesture.
 *  2. Interactive connect() has no await before the popup opens — the
 *     browser must see window.open inside the gesture stack.
 *  3. Refusals throw EIP-1193 code 4200, never -32601 (viem silently
 *     retries -32601 as wallet_sendTransaction).
 *  4. Gas, nonce and fee fields are wallet-estimated: the connector discards
 *     them in translation, and the wire refuses them from any other caller.
 */
import type { CreateConnectorFn } from "@wagmi/core";
import type { Address, Chain } from "viem";
import { ClaspConnect, ClaspError } from "./index.js";
import {
  CLASP_EVM_CHAIN_IDS,
  evmNetworkForChainId,
  validateEvmTx,
  validEvmAddressShape,
  validEvmMessageHex,
  validTypedDataJson,
  type ClaspEvmNetwork,
  type EvmHex,
} from "./protocol.js";

/**
 * The production wallet, and the only value a dapp may use. A passkey welds
 * to the rpID (= the hostname), so a different host is not a different
 * deployment of the same wallet — it is a different wallet holding none of
 * the user's money, and it fails silently. This is a constant, not a knob:
 * the options type deliberately has no URL field.
 */
const WALLET_URL = "https://claspwallet.com";

const STORAGE_KEY = "clasp-connect.v1.evm";

/**
 * XRPL EVM chains as plain literals for wagmi configs. Values mirror
 * lib/evm/networks.ts in the Clasp app — a drift test there pins the two.
 * Multicall3 is NOT deployed on XRPL EVM; leaving it undefined makes viem
 * use individual eth_call requests instead of silently failing.
 */
export const xrplevm: Chain = {
  id: 1440000,
  name: "XRPL EVM",
  nativeCurrency: { decimals: 18, name: "XRP", symbol: "XRP" },
  rpcUrls: { default: { http: ["https://rpc.xrplevm.org"] } },
  blockExplorers: {
    default: { name: "XRPL EVM Explorer", url: "https://explorer.xrplevm.org" },
  },
  contracts: { multicall3: undefined },
};

export const xrplevmTestnet: Chain = {
  id: 1449000,
  name: "XRPL EVM Testnet",
  nativeCurrency: { decimals: 18, name: "XRP", symbol: "XRP" },
  rpcUrls: { default: { http: ["https://rpc.testnet.xrplevm.org"] } },
  blockExplorers: {
    default: {
      name: "XRPL EVM Explorer",
      url: "https://explorer.testnet.xrplevm.org",
    },
  },
  contracts: { multicall3: undefined },
};

/** EIP-1193 provider error, thrown for everything the connector refuses. */
export class ClaspProviderError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ClaspProviderError";
  }
}

/**
 * ClaspErrorCode → EIP-1193/JSON-RPC code. Exported so the table is
 * testable as a table. Never returns -32601: viem retries -32601 as
 * wallet_sendTransaction, producing a second popup attempt before the error
 * ever surfaces.
 */
export function toProviderError(err: unknown): ClaspProviderError {
  if (err instanceof ClaspProviderError) return err;
  if (err instanceof ClaspError) {
    switch (err.code) {
      case "user_rejected":
        return new ClaspProviderError(4001, err.message);
      case "unsupported_tx":
      case "unsupported_message":
        return new ClaspProviderError(4200, err.message);
      case "wrong_wallet":
        return new ClaspProviderError(
          4001,
          "The passkey that approved derives a different wallet than the one this dapp is connected to. Reconnect, or approve with the original passkey.",
        );
      case "network_unavailable":
        return new ClaspProviderError(4901, err.message);
      case "bad_request":
        return new ClaspProviderError(-32602, err.message);
      // -32002 (resource unavailable), NOT 4001: viem replaces any 4001's
      // message with its canned "User rejected the request.", so mapping
      // these here made a blocked popup read as the user saying no — which
      // is exactly how it shipped for one evening. None of these three is a
      // user act.
      case "timeout":
        return new ClaspProviderError(-32002, err.message);
      case "busy":
        return new ClaspProviderError(
          -32002,
          "Another Clasp request is already in flight — finish or close it first.",
        );
      case "popup_blocked":
        return new ClaspProviderError(
          -32002,
          "The browser blocked the Clasp window. Allow popups for this site, then try again.",
        );
      case "tx_failed":
        return new ClaspProviderError(-32003, err.message);
      case "not_confirmed":
        return new ClaspProviderError(-32002, err.message);
    }
  }
  return new ClaspProviderError(
    -32603,
    err instanceof Error ? err.message : "Unknown Clasp error.",
  );
}

export type ClaspEip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

export type ClaspConnectorOptions = {
  /** Approval timeout passed to the popup transport. Default 5 minutes. */
  timeoutMs?: number;
};

type StoredSession = { address: Address; chainId: number };

type MinimalStorage = {
  getItem(key: string): Promise<unknown> | unknown;
  setItem(key: string, value: unknown): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
};

/**
 * Read-only JSON-RPC methods forwarded straight to the configured chain's
 * RPC from the dapp's page (the DAPP's CSP governs these fetches). Normal
 * wagmi reads never come this way — they route through config.transports —
 * this is compatibility for dapps that grab the provider directly.
 */
const FORWARDED_METHODS = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);

function refusedMessage(method: string): string {
  switch (method) {
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
      return "Use eth_signTypedData_v4 — Clasp signs typed data only in the v4 shape.";
    case "eth_sign":
      return "eth_sign is blind signing and is never supported. Use personal_sign.";
    case "eth_signTransaction":
      return "Clasp signs and submits in one approval — use eth_sendTransaction.";
    default:
      return `Clasp doesn't support ${method}.`;
  }
}

claspConnector.type = "clasp" as const;

export function claspConnector(
  options: ClaspConnectorOptions = {},
): CreateConnectorFn<ClaspEip1193Provider> {
  // Internal-only escape hatch for this repo's own demo and e2e servers.
  // Deliberately absent from ClaspConnectorOptions: integrators must never
  // point at another host (see WALLET_URL above).
  const walletUrl =
    (options as { __unsafeWalletUrl?: string }).__unsafeWalletUrl ?? WALLET_URL;

  return (config) => {
    const storage = (config.storage ?? null) as MinimalStorage | null;
    let sdk: ClaspConnect | undefined;
    let provider: ClaspEip1193Provider | undefined;
    let session: StoredSession | null = null;

    function getSdk(): ClaspConnect {
      if (!sdk) {
        sdk = new ClaspConnect({
          walletUrl,
          ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
        });
      }
      return sdk;
    }

    function chainFor(chainId: number): Chain | undefined {
      return config.chains.find((c) => c.id === chainId);
    }

    function networkForOrThrow(chainId: number): ClaspEvmNetwork {
      const net = evmNetworkForChainId(chainId);
      if (!net) {
        throw new ClaspProviderError(
          4901,
          `Chain ${chainId} isn't an XRPL EVM chain — Clasp serves ${CLASP_EVM_CHAIN_IDS.mainnet} (mainnet) and ${CLASP_EVM_CHAIN_IDS.testnet} (testnet).`,
        );
      }
      return net;
    }

    async function readStored(): Promise<StoredSession | null> {
      try {
        const raw = (await storage?.getItem(STORAGE_KEY)) ?? null;
        if (!raw || typeof raw !== "object") return null;
        const { address, chainId } = raw as Record<string, unknown>;
        if (!validEvmAddressShape(address)) return null;
        if (typeof chainId !== "number" || !evmNetworkForChainId(chainId)) return null;
        return { address: address as Address, chainId };
      } catch {
        return null;
      }
    }

    async function currentSession(): Promise<StoredSession | null> {
      if (session) return session;
      const stored = await readStored();
      if (stored) session = stored;
      return stored;
    }

    async function requireSession(): Promise<StoredSession> {
      const s = await currentSession();
      if (!s) {
        throw new ClaspProviderError(4100, "Not connected — connect through wagmi first.");
      }
      return s;
    }

    async function clearSession(): Promise<void> {
      session = null;
      try {
        await storage?.removeItem(STORAGE_KEY);
      } catch {
        /* storage is an optimization, never load-bearing */
      }
    }

    async function currentChainId(): Promise<number> {
      const s = await currentSession();
      return s?.chainId ?? config.chains[0].id;
    }

    async function forwardToRpc(method: string, params: unknown): Promise<unknown> {
      const chainId = await currentChainId();
      const url = chainFor(chainId)?.rpcUrls.default.http[0];
      if (!url) {
        throw new ClaspProviderError(4901, `No RPC configured for chain ${chainId}.`);
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      if (!res.ok) {
        throw new ClaspProviderError(-32603, `RPC answered ${res.status}.`);
      }
      const body = (await res.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (body.error) {
        throw new ClaspProviderError(
          body.error.code ?? -32603,
          body.error.message ?? "RPC error.",
          body.error.data,
        );
      }
      return body.result;
    }

    async function handleRequest(method: string, params: unknown): Promise<unknown> {
      switch (method) {
        // Local answers — never a round-trip. viem calls eth_chainId before
        // every signing operation; answering from memory is also what keeps
        // the user-gesture activation alive for the popup that follows.
        case "eth_chainId":
          return `0x${(await currentChainId()).toString(16)}`;
        case "net_version":
          return String(await currentChainId());
        case "eth_accounts": {
          const s = await currentSession();
          return s ? [s.address] : [];
        }
        case "eth_requestAccounts": {
          const s = await requireSession();
          return [s.address];
        }

        case "personal_sign": {
          const s = await requireSession();
          const p = Array.isArray(params) ? (params as unknown[]) : [];
          const [messageHex, address] = p;
          // The classic transposition: eth_sign takes [address, message],
          // personal_sign takes [message, address]. Signing the connected
          // address's own bytes is never what anyone means.
          if (
            typeof messageHex === "string" &&
            messageHex.toLowerCase() === s.address.toLowerCase() &&
            validEvmMessageHex(address)
          ) {
            throw new ClaspProviderError(
              -32602,
              "personal_sign params are [message, address] — message first, hex-encoded (the reverse of eth_sign).",
            );
          }
          if (!validEvmMessageHex(messageHex)) {
            throw new ClaspProviderError(
              -32602,
              "personal_sign params[0] must be the hex-encoded message.",
            );
          }
          if (
            address !== undefined &&
            (typeof address !== "string" ||
              address.toLowerCase() !== s.address.toLowerCase())
          ) {
            throw new ClaspProviderError(
              4100,
              "personal_sign address doesn't match the connected account.",
            );
          }
          const network = networkForOrThrow(s.chainId);
          const r = await getSdk().evmPersonalSign({
            network,
            address: s.address as EvmHex,
            messageHex,
          });
          return r.signature;
        }

        case "eth_sendTransaction": {
          const s = await requireSession();
          const first = Array.isArray(params) ? (params as unknown[])[0] : undefined;
          if (!first || typeof first !== "object") {
            throw new ClaspProviderError(
              -32602,
              "eth_sendTransaction params[0] must be a transaction object.",
            );
          }
          const t = first as Record<string, unknown>;
          if (
            t.from !== undefined &&
            (typeof t.from !== "string" ||
              t.from.toLowerCase() !== s.address.toLowerCase())
          ) {
            throw new ClaspProviderError(
              4100,
              "eth_sendTransaction from doesn't match the connected account.",
            );
          }
          // Pick {to, value, data}. Gas, nonce and fee fields are wallet-
          // estimated: discarded here in translation, refused by the wire
          // from any caller that isn't this connector.
          const tx: Record<string, unknown> = { to: t.to };
          if (t.value !== undefined) tx.value = t.value;
          if (t.data !== undefined) tx.data = t.data;
          // Validation is structural only (open-signing law): what remains
          // refusable here is a malformed request. The code is 4200, NOT
          // -32602 — verified empirically: viem retries a -32602 (like a
          // -32601) from eth_sendTransaction as wallet_sendTransaction, so
          // anything but 4200 costs a ghost retry before the error lands.
          // Fail fast, no popup flash; the popup re-validates regardless.
          const v = validateEvmTx(tx);
          if (!v.ok) {
            throw new ClaspProviderError(4200, `Malformed transaction: ${v.reason}`);
          }
          const network = networkForOrThrow(s.chainId);
          const r = await getSdk().evmSignAndSubmit({
            network,
            address: s.address as EvmHex,
            tx: v.tx,
          });
          return r.hash;
        }

        case "eth_signTypedData_v4": {
          const s = await requireSession();
          const p = Array.isArray(params) ? (params as unknown[]) : [];
          const [address, typedData] = p;
          if (
            typeof address !== "string" ||
            address.toLowerCase() !== s.address.toLowerCase()
          ) {
            throw new ClaspProviderError(
              4100,
              "eth_signTypedData_v4 params[0] must be the connected account.",
            );
          }
          // EIP-1193 carries the payload as a JSON string; some direct
          // callers hand the object. Re-serializing is safe HERE (unlike
          // calldata) because what gets signed is the struct hash, not
          // these bytes — the popup parses and canaries it regardless.
          let json: string | null = null;
          if (typeof typedData === "string") {
            json = typedData;
          } else if (typedData !== null && typeof typedData === "object") {
            try {
              json = JSON.stringify(typedData);
            } catch {
              json = null;
            }
          }
          if (!validTypedDataJson(json)) {
            throw new ClaspProviderError(
              -32602,
              "eth_signTypedData_v4 params[1] must be the EIP-712 payload (JSON, at most 256 KiB).",
            );
          }
          const network = networkForOrThrow(s.chainId);
          const r = await getSdk().evmSignTypedData({
            network,
            address: s.address as EvmHex,
            typedDataJson: json,
          });
          return r.signature;
        }

        case "wallet_switchEthereumChain": {
          // Local, like the connector's own switchChain: the EVM account is
          // chain-independent and the wallet holds no session, so nothing
          // round-trips. EIP-3326: unrecognized chain → 4902.
          const first = Array.isArray(params) ? (params as unknown[])[0] : undefined;
          const rawId =
            first && typeof first === "object"
              ? (first as Record<string, unknown>).chainId
              : undefined;
          if (typeof rawId !== "string" || !/^0x[0-9A-Fa-f]+$/.test(rawId)) {
            throw new ClaspProviderError(
              -32602,
              "wallet_switchEthereumChain params[0].chainId must be a 0x hex chain id.",
            );
          }
          const id = Number(BigInt(rawId));
          if (!chainFor(id) || !evmNetworkForChainId(id)) {
            throw new ClaspProviderError(
              4902,
              `Chain ${id} isn't configured — Clasp serves XRPL EVM ${CLASP_EVM_CHAIN_IDS.mainnet} (mainnet) and ${CLASP_EVM_CHAIN_IDS.testnet} (testnet).`,
            );
          }
          const s = await currentSession();
          if (s) {
            session = { ...s, chainId: id };
            try {
              await storage?.setItem(STORAGE_KEY, session);
            } catch {
              /* best-effort */
            }
          }
          config.emitter.emit("change", { chainId: id });
          return null;
        }

        default:
          if (FORWARDED_METHODS.has(method)) return forwardToRpc(method, params);
          // Everything else — v1/v3 typed data, raw signing, batching,
          // unknown methods — is 4200. NEVER -32601 (see toProviderError's
          // note).
          throw new ClaspProviderError(4200, refusedMessage(method));
      }
    }

    return {
      id: "clasp",
      name: "Clasp",
      type: claspConnector.type,
      rdns: "com.claspwallet",
      // A real hosted asset built from app/icon.svg — the mark's geometry
      // lives in components/SealMark.tsx and is never restated by hand.
      icon: "https://claspwallet.com/icon.svg",

      async connect(parameters = {}) {
        const { chainId, isReconnecting, withCapabilities } = parameters as {
          chainId?: number;
          isReconnecting?: boolean;
          withCapabilities?: boolean;
        };
        // wagmi ≥2.22 threads a withCapabilities generic through connect's
        // return type; the never-cast is the same shape wagmi's own
        // connectors use to satisfy the conditional.
        const shape = (address: Address, cid: number) => ({
          accounts: (withCapabilities
            ? [{ address, capabilities: {} }]
            : [address]) as never,
          chainId: cid,
        });
        try {
          if (isReconnecting) {
            // Reconnect path: storage only, never a popup (wagmi calls this
            // on every page load with no gesture).
            const stored = await readStored();
            if (!stored) {
              throw new ClaspProviderError(4100, "No stored Clasp session to restore.");
            }
            session = stored;
            return shape(stored.address, stored.chainId);
          }

          const targetChainId = chainId ?? config.chains[0].id;
          const network = networkForOrThrow(targetChainId);
          // No await between the user's click and this call: evmConnect
          // opens the popup synchronously inside the gesture stack.
          const result = await getSdk().evmConnect({ network });
          if (
            !validEvmAddressShape(result.address) ||
            result.chainId !== CLASP_EVM_CHAIN_IDS[result.network]
          ) {
            throw new ClaspProviderError(
              -32603,
              "Malformed response from the Clasp wallet.",
            );
          }
          session = { address: result.address as Address, chainId: result.chainId };
          try {
            await storage?.setItem(STORAGE_KEY, session);
          } catch {
            /* storage is an optimization, never load-bearing */
          }
          return shape(session.address, session.chainId);
        } catch (e) {
          throw toProviderError(e);
        }
      },

      async disconnect() {
        // Local-only: the wallet keeps no standing session, so there is
        // nothing to revoke on the other side.
        await clearSession();
      },

      async getAccounts() {
        const s = await currentSession();
        return s ? [s.address] : [];
      },

      async getChainId() {
        return currentChainId();
      },

      async getProvider() {
        if (!provider) {
          provider = {
            request: async ({ method, params }) => {
              try {
                return await handleRequest(method, params);
              } catch (e) {
                throw toProviderError(e);
              }
            },
            on: () => {},
            removeListener: () => {},
          };
        }
        return provider;
      },

      async isAuthorized() {
        return (await currentSession()) !== null;
      },

      async switchChain({ chainId }) {
        const chain = chainFor(chainId);
        if (!chain) {
          throw new ClaspProviderError(
            4901,
            `Chain ${chainId} isn't configured in this app.`,
          );
        }
        networkForOrThrow(chainId);
        // The EVM account is chain-independent — same key, same address on
        // both XRPL EVM chains — and the wallet holds no session, so a chain
        // switch is honestly a local affair.
        const s = await currentSession();
        if (s) {
          session = { ...s, chainId };
          try {
            await storage?.setItem(STORAGE_KEY, session);
          } catch {
            /* best-effort */
          }
        }
        config.emitter.emit("change", { chainId });
        return chain;
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) void clearSession();
        else config.emitter.emit("change", { accounts: accounts as Address[] });
      },

      onChainChanged(chainId) {
        const id = Number(chainId);
        if (session) session = { ...session, chainId: id };
        config.emitter.emit("change", { chainId: id });
      },

      async onDisconnect() {
        await clearSession();
        config.emitter.emit("disconnect");
      },
    };
  };
}
