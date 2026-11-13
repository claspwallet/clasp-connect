/**
 * Connector tests — node environment. The popup transport is already covered
 * by index.test.ts, so ClaspConnect is mocked at the module boundary here
 * (h.* fns) and the tests assert the connector's own contract: reconnect
 * discipline (never a popup without a gesture), the routing buckets, the
 * error-code table (never -32601), and param translation. A second harness
 * drives the REAL @wagmi/core state machine to prove the connector against
 * wagmi itself, not an imitation of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaspError } from "./index";
import {
  claspConnector,
  ClaspProviderError,
  toProviderError,
  xrplevm,
  xrplevmTestnet,
} from "./wagmi";

const h = vi.hoisted(() => ({
  evmConnect: vi.fn(),
  evmPersonalSign: vi.fn(),
  evmSignAndSubmit: vi.fn(),
  evmSignTypedData: vi.fn(),
  constructed: [] as unknown[],
}));

vi.mock("./index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./index.js")>();
  class FakeClaspConnect {
    evmConnect = h.evmConnect;
    evmPersonalSign = h.evmPersonalSign;
    evmSignAndSubmit = h.evmSignAndSubmit;
    evmSignTypedData = h.evmSignTypedData;
    constructor(readonly opts: unknown) {
      h.constructed.push(opts);
    }
  }
  return { ...orig, ClaspConnect: FakeClaspConnect };
});

const FIXTURE = "0x297f8f879203DE36c36B5dFBc2ae00e7996ba92E";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const KEY = "clasp-connect.v1.evm";

function memStorage(seed?: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    map: m,
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: unknown) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
  };
}

type UnitConnector = ReturnType<ReturnType<typeof claspConnector>>;

function unit(opts: { chains?: unknown[]; storage?: unknown; seedSession?: boolean } = {}) {
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : memStorage(
          opts.seedSession ? { [KEY]: { address: FIXTURE, chainId: 1449000 } } : {},
        );
  const emitter = { uid: "test", emit: vi.fn() };
  const config = {
    chains: opts.chains ?? [xrplevmTestnet, xrplevm],
    emitter,
    storage,
  };
  const connector = claspConnector()(
    config as unknown as Parameters<ReturnType<typeof claspConnector>>[0],
  ) as UnitConnector;
  return { connector, emitter, storage: storage as ReturnType<typeof memStorage> | null };
}

beforeEach(() => {
  h.evmConnect.mockReset();
  h.evmPersonalSign.mockReset();
  h.evmSignAndSubmit.mockReset();
  h.evmSignTypedData.mockReset();
  h.constructed.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconnect discipline — no popup without a gesture", () => {
  it("getProvider/isAuthorized/getAccounts/getChainId/reconnecting-connect never construct the transport", async () => {
    const { connector } = unit({ seedSession: true });
    await connector.getProvider();
    await connector.isAuthorized();
    await connector.getAccounts();
    await connector.getChainId();
    const res = await connector.connect({ isReconnecting: true });
    expect(res).toEqual({ accounts: [FIXTURE], chainId: 1449000 });
    expect(h.constructed).toHaveLength(0); // the wire client never even existed
  });

  it("reconnecting with nothing stored throws 4100 without a popup", async () => {
    const { connector } = unit();
    await expect(connector.connect({ isReconnecting: true })).rejects.toMatchObject({
      code: 4100,
    });
    expect(h.constructed).toHaveLength(0);
  });
});

describe("interactive connect", () => {
  it("maps the chain, opens the transport, verifies and persists the result", async () => {
    h.evmConnect.mockResolvedValue({ address: FIXTURE, chainId: 1449000, network: "testnet" });
    const { connector, storage } = unit();
    const res = await connector.connect({});
    expect(h.evmConnect).toHaveBeenCalledWith({ network: "testnet" });
    expect(res).toEqual({ accounts: [FIXTURE], chainId: 1449000 });
    expect(storage!.map.get(KEY)).toEqual({ address: FIXTURE, chainId: 1449000 });
  });

  it("rejects a malformed wallet response as -32603", async () => {
    h.evmConnect.mockResolvedValue({ address: FIXTURE, chainId: 1, network: "testnet" });
    const { connector } = unit();
    await expect(connector.connect({})).rejects.toMatchObject({ code: -32603 });
  });

  it("refuses a non-XRPL-EVM chainId with 4901", async () => {
    const { connector } = unit();
    await expect(connector.connect({ chainId: 1 })).rejects.toMatchObject({ code: 4901 });
    expect(h.evmConnect).not.toHaveBeenCalled();
  });
});

describe("storage round-trip", () => {
  it("a second connector over the same storage is authorized; disconnect clears it", async () => {
    h.evmConnect.mockResolvedValue({ address: FIXTURE, chainId: 1449000, network: "testnet" });
    const storage = memStorage();
    const a = unit({ storage }).connector;
    await a.connect({});

    const b = unit({ storage }).connector;
    expect(await b.isAuthorized()).toBe(true);
    expect(await b.getAccounts()).toEqual([FIXTURE]);
    await expect(b.connect({ isReconnecting: true })).resolves.toEqual({
      accounts: [FIXTURE],
      chainId: 1449000,
    });

    await b.disconnect();
    expect(storage.map.has(KEY)).toBe(false);
    expect(await b.isAuthorized()).toBe(false);
  });
});

describe("provider — local answers", () => {
  it("answers eth_chainId as a hex string, eth_accounts and net_version from the session", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x161c28");
    expect(await provider.request({ method: "net_version" })).toBe("1449000");
    expect(await provider.request({ method: "eth_accounts" })).toEqual([FIXTURE]);
    expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([FIXTURE]);
    expect(h.constructed).toHaveLength(0);
  });

  it("eth_requestAccounts without a session throws 4100 (interactive connect goes through wagmi)", async () => {
    const { connector } = unit();
    const provider = await connector.getProvider();
    await expect(provider.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
      code: 4100,
    });
  });
});

describe("provider — refusals are 4200, never -32601", () => {
  const methods = [
    "eth_sign",
    "eth_signTransaction",
    "eth_signTypedData",
    "eth_signTypedData_v3",
    "wallet_sendCalls",
    "wallet_getCapabilities",
    "wallet_watchAsset",
    "wallet_addEthereumChain",
    "wallet_requestPermissions",
    "eth_subscribe",
    "personal_ecRecover",
    "totally_unknown_method",
  ];
  for (const method of methods) {
    it(`${method} → 4200`, async () => {
      const { connector } = unit({ seedSession: true });
      const provider = await connector.getProvider();
      const err = await provider.request({ method }).then(
        () => null,
        (e: unknown) => e as ClaspProviderError,
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe(4200);
      expect(err!.code).not.toBe(-32601);
    });
  }
});

describe("provider — eth_sendTransaction translation", () => {
  it("picks exactly {to, value, data}, dropping gas/nonce/fee fields before the wire", async () => {
    h.evmSignAndSubmit.mockResolvedValue({ hash: "0x" + "ab".repeat(32) });
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: FIXTURE.toLowerCase(),
          to: OTHER,
          value: "0x1",
          data: "0x",
          gas: "0x5208",
          nonce: "0x1",
          maxFeePerGas: "0x1",
          type: "0x2",
        },
      ],
    });
    expect(hash).toBe("0x" + "ab".repeat(32));
    const wire = h.evmSignAndSubmit.mock.calls[0][0] as {
      tx: Record<string, unknown>;
      address: string;
      network: string;
    };
    expect(Object.keys(wire.tx).sort()).toEqual(["data", "to", "value"]);
    expect(wire.address).toBe(FIXTURE);
    expect(wire.network).toBe("testnet");
  });

  it("a mismatched from is 4100 and never reaches the wire", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: OTHER, to: FIXTURE, value: "0x1" }],
      }),
    ).rejects.toMatchObject({ code: 4100 });
    expect(h.evmSignAndSubmit).not.toHaveBeenCalled();
  });

  it("arbitrary calldata reaches the wire — the popup owns the review", async () => {
    h.evmSignAndSubmit.mockResolvedValue({ hash: "0x" + "ab".repeat(32) });
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    for (const tx of [
      { to: OTHER, data: "0xdeadbeef" },
      { to: OTHER, value: "0x1", data: "0xa9059cbb" + "0".repeat(128) }, // payable + dirty calldata
    ]) {
      await expect(
        provider.request({ method: "eth_sendTransaction", params: [tx] }),
      ).resolves.toBe("0x" + "ab".repeat(32));
    }
    expect(h.evmSignAndSubmit).toHaveBeenCalledTimes(2);
  });

  it("malformed structure fails fast with 4200 and no popup", async () => {
    // 4200, not -32602: viem retries a -32602 from eth_sendTransaction as
    // wallet_sendTransaction (verified in e2e) — same trap as -32601.
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    for (const tx of [
      { to: "0xnope", value: "0x1" },
      { to: OTHER, value: "not-hex" },
      { to: OTHER, data: "0x123" },
    ]) {
      await expect(
        provider.request({ method: "eth_sendTransaction", params: [tx] }),
      ).rejects.toMatchObject({ code: 4200 });
    }
    expect(h.evmSignAndSubmit).not.toHaveBeenCalled();
    expect(h.constructed).toHaveLength(0);
  });
});

describe("provider — eth_signTypedData_v4 translation", () => {
  const PAYLOAD = {
    types: { X: [{ name: "a", type: "uint256" }] },
    primaryType: "X",
    domain: { chainId: 1449000 },
    message: { a: "1" },
  };

  it("passes [address, json] through with the session network", async () => {
    h.evmSignTypedData.mockResolvedValue({ signature: "0x" + "cd".repeat(65) });
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    const sig = await provider.request({
      method: "eth_signTypedData_v4",
      params: [FIXTURE.toLowerCase(), JSON.stringify(PAYLOAD)],
    });
    expect(sig).toBe("0x" + "cd".repeat(65));
    expect(h.evmSignTypedData).toHaveBeenCalledWith({
      network: "testnet",
      address: FIXTURE,
      typedDataJson: JSON.stringify(PAYLOAD),
    });
  });

  it("tolerates an object payload by serializing it", async () => {
    h.evmSignTypedData.mockResolvedValue({ signature: "0x" + "cd".repeat(65) });
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await provider.request({
      method: "eth_signTypedData_v4",
      params: [FIXTURE, PAYLOAD],
    });
    const wire = h.evmSignTypedData.mock.calls[0][0] as { typedDataJson: string };
    expect(JSON.parse(wire.typedDataJson)).toEqual(PAYLOAD);
  });

  it("a foreign address is 4100; junk payload is -32602 — no popup either way", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: "eth_signTypedData_v4",
        params: [OTHER, JSON.stringify(PAYLOAD)],
      }),
    ).rejects.toMatchObject({ code: 4100 });
    await expect(
      provider.request({ method: "eth_signTypedData_v4", params: [FIXTURE, 42] }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(h.evmSignTypedData).not.toHaveBeenCalled();
  });
});

describe("provider — wallet_switchEthereumChain", () => {
  it("switches locally, persists, emits and answers null", async () => {
    const { connector, emitter, storage } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    const res = await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x15f900" }],
    });
    expect(res).toBe(null);
    expect(emitter.emit).toHaveBeenCalledWith("change", { chainId: 1440000 });
    expect(storage!.map.get(KEY)).toEqual({ address: FIXTURE, chainId: 1440000 });
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x15f900");
    expect(h.constructed).toHaveLength(0);
  });

  it("unrecognized chains are 4902 (EIP-3326); junk params are -32602", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x1" }],
      }),
    ).rejects.toMatchObject({ code: 4902 });
    await expect(
      provider.request({ method: "wallet_switchEthereumChain", params: [{}] }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("provider — personal_sign translation", () => {
  it("passes [messageHex, address] through with the session address", async () => {
    h.evmPersonalSign.mockResolvedValue({ signature: "0x" + "cd".repeat(65) });
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    const sig = await provider.request({
      method: "personal_sign",
      params: ["0x68656c6c6f", FIXTURE.toLowerCase()],
    });
    expect(sig).toBe("0x" + "cd".repeat(65));
    expect(h.evmPersonalSign).toHaveBeenCalledWith({
      network: "testnet",
      address: FIXTURE,
      messageHex: "0x68656c6c6f",
    });
  });

  it("detects the eth_sign transposition and says so", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({ method: "personal_sign", params: [FIXTURE, "0x68656c6c6f"] }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("message first"),
    });
    expect(h.evmPersonalSign).not.toHaveBeenCalled();
  });

  it("a foreign address is 4100", async () => {
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({ method: "personal_sign", params: ["0x68656c6c6f", OTHER] }),
    ).rejects.toMatchObject({ code: 4100 });
  });
});

describe("provider — forwarded reads", () => {
  it("POSTs JSON-RPC to the configured chain's RPC and unwraps result", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "0x1234" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    const res = await provider.request({
      method: "eth_getBalance",
      params: [FIXTURE, "latest"],
    });
    expect(res).toBe("0x1234");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rpc.testnet.xrplevm.org");
    expect(JSON.parse(init.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "eth_getBalance",
      params: [FIXTURE, "latest"],
    });
  });

  it("maps RPC errors and non-200s", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: { code: -32000, message: "nope" } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({ method: "eth_call", params: [] }),
    ).rejects.toMatchObject({ code: -32000, message: "nope" });
    await expect(
      provider.request({ method: "eth_call", params: [] }),
    ).rejects.toMatchObject({ code: -32603 });
  });
});

describe("switchChain", () => {
  it("switches locally, persists and emits — no popup", async () => {
    const { connector, emitter, storage } = unit({ seedSession: true });
    const chain = await connector.switchChain!({ chainId: 1440000 });
    expect(chain.id).toBe(1440000);
    expect(emitter.emit).toHaveBeenCalledWith("change", { chainId: 1440000 });
    expect(storage!.map.get(KEY)).toEqual({ address: FIXTURE, chainId: 1440000 });
    const provider = await connector.getProvider();
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x15f900");
    expect(h.constructed).toHaveLength(0);
  });

  it("refuses unconfigured and non-XRPL-EVM chains with 4901", async () => {
    const bogus = { ...xrplevm, id: 10, name: "Optimism" };
    const { connector } = unit({ chains: [xrplevmTestnet, bogus], seedSession: true });
    await expect(connector.switchChain!({ chainId: 99999 })).rejects.toMatchObject({
      code: 4901,
    });
    await expect(connector.switchChain!({ chainId: 10 })).rejects.toMatchObject({
      code: 4901,
    });
  });
});

describe("toProviderError — the whole table", () => {
  const table: Array<[ConstructorParameters<typeof ClaspError>[0], number]> = [
    ["user_rejected", 4001],
    ["unsupported_tx", 4200],
    ["unsupported_message", 4200],
    ["wrong_wallet", 4001],
    ["network_unavailable", 4901],
    ["bad_request", -32602],
    // NOT 4001: viem replaces any 4001's message with its canned "User
    // rejected the request." — a blocked popup or a timeout is not a user
    // act, and dressing it as one hid the real failure for an evening.
    ["timeout", -32002],
    ["busy", -32002],
    ["popup_blocked", -32002],
    ["tx_failed", -32003],
    ["not_confirmed", -32002],
  ];
  for (const [code, expected] of table) {
    it(`${code} → ${expected}`, () => {
      const mapped = toProviderError(new ClaspError(code, "msg"));
      expect(mapped.code).toBe(expected);
      expect(mapped.code).not.toBe(-32601);
    });
  }
  it("popup_blocked tells the user what to do", () => {
    expect(toProviderError(new ClaspError("popup_blocked", "x")).message).toContain(
      "Allow popups",
    );
  });
  it("unknown errors become -32603 and ClaspProviderError passes through", () => {
    expect(toProviderError(new Error("boom")).code).toBe(-32603);
    const passed = new ClaspProviderError(4200, "kept");
    expect(toProviderError(passed)).toBe(passed);
  });
  it("end-to-end: a wire rejection surfaces as its mapped code", async () => {
    h.evmPersonalSign.mockRejectedValue(new ClaspError("user_rejected", "declined"));
    const { connector } = unit({ seedSession: true });
    const provider = await connector.getProvider();
    await expect(
      provider.request({ method: "personal_sign", params: ["0x6869", FIXTURE] }),
    ).rejects.toMatchObject({ code: 4001 });
  });
});

describe("chain literals", () => {
  it("pin ids, RPCs, decimals and the multicall3 hole", () => {
    expect(xrplevm.id).toBe(1440000);
    expect(xrplevmTestnet.id).toBe(1449000);
    expect(xrplevm.rpcUrls.default.http[0]).toBe("https://rpc.xrplevm.org");
    expect(xrplevmTestnet.rpcUrls.default.http[0]).toBe(
      "https://rpc.testnet.xrplevm.org",
    );
    for (const chain of [xrplevm, xrplevmTestnet]) {
      expect(chain.nativeCurrency).toEqual({ decimals: 18, name: "XRP", symbol: "XRP" });
      expect(chain.contracts?.multicall3).toBeUndefined();
    }
  });
});

describe("real @wagmi/core state machine", () => {
  it("connects, restores through real reconnect with zero popups, disconnects", async () => {
    const { connect, createConfig, createStorage, disconnect, getAccount, reconnect } =
      await import("@wagmi/core");
    const { http } = await import("viem");

    const backing = new Map<string, string>();
    const makeConfig = () =>
      createConfig({
        chains: [xrplevmTestnet as never],
        transports: { [xrplevmTestnet.id]: http("http://127.0.0.1:1") },
        connectors: [claspConnector()],
        storage: createStorage({
          storage: {
            getItem: (k) => backing.get(k) ?? null,
            setItem: (k, v) => void backing.set(k, v),
            removeItem: (k) => void backing.delete(k),
          },
        }),
        multiInjectedProviderDiscovery: false,
      });

    h.evmConnect.mockResolvedValue({
      address: FIXTURE,
      chainId: 1449000,
      network: "testnet",
    });

    const cfgA = makeConfig();
    await connect(cfgA, { connector: cfgA.connectors[0] });
    expect(getAccount(cfgA).address).toBe(FIXTURE);
    expect(getAccount(cfgA).chainId).toBe(1449000);
    expect(h.evmConnect).toHaveBeenCalledTimes(1);

    // A fresh config over the same storage — the page reload. Real
    // reconnect() must restore the session without the transport existing.
    const cfgB = makeConfig();
    await reconnect(cfgB);
    expect(getAccount(cfgB).address).toBe(FIXTURE);
    expect(h.evmConnect).toHaveBeenCalledTimes(1); // still one — no popup

    await disconnect(cfgB);
    expect(getAccount(cfgB).status).toBe("disconnected");
  });
});
