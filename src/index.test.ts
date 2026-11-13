/**
 * ClaspConnect transport tests — node environment, no jsdom. The class
 * touches only window.open/addEventListener/removeEventListener, timers and
 * a duck-typed popup, all stubbable. The popup-blocked case is the load-
 * bearing one: it regressed once as a TDZ ReferenceError that also wedged
 * the instance's busy flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaspConnect } from "./index";

const WALLET = "https://wallet.test";
const READY = { clasp: "ready", v: 1 };

type FakeEvent = { origin: string; source: unknown; data: unknown };
type Listener = (e: FakeEvent) => void;

function makeFakePopup() {
  return { closed: false, postMessage: vi.fn(), close: vi.fn() };
}

let listeners: Set<Listener>;
let fakeWin: {
  open: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  setInterval: (fn: () => void, ms: number) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

function dispatch(e: FakeEvent) {
  for (const fn of [...listeners]) fn(e);
}

beforeEach(() => {
  listeners = new Set();
  fakeWin = {
    open: vi.fn(() => null),
    addEventListener: vi.fn((type: string, fn: Listener) => {
      if (type === "message") listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.delete(fn);
    }),
    // Delegate to the globals so vi.useFakeTimers() controls them.
    setInterval: (fn, ms) => setInterval(fn, ms),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  vi.stubGlobal("window", fakeWin);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("popup blocked", () => {
  it("rejects with popup_blocked (not a ReferenceError) and resets busy", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    fakeWin.open.mockReturnValueOnce(null);
    await expect(sdk.connect()).rejects.toMatchObject({
      name: "ClaspError",
      code: "popup_blocked",
    });

    // The regression: busy must be reset, so a second call reaches
    // window.open instead of rejecting "busy".
    vi.useFakeTimers();
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p2 = sdk.connect();
    const settled = expect(p2).rejects.toMatchObject({ code: "user_rejected" });
    expect(fakeWin.open).toHaveBeenCalledTimes(2);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(300);
    await settled;
  });
});

describe("handshake", () => {
  it("ready → request → response, exact targetOrigin, popup left open", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);

    const p = sdk.evmConnect({ network: "testnet" });
    expect(fakeWin.open).toHaveBeenCalledWith(
      `${WALLET}/connect/`,
      expect.stringMatching(/^clasp-connect-/),
      "width=420,height=680,popup=yes",
    );

    dispatch({ origin: WALLET, source: popup, data: READY });
    expect(popup.postMessage).toHaveBeenCalledTimes(1);
    const [envelope, target] = popup.postMessage.mock.calls[0] as [
      { clasp: string; v: number; id: string; method: string; params: unknown },
      string,
    ];
    expect(target).toBe(WALLET);
    expect(envelope).toMatchObject({
      clasp: "request",
      v: 1,
      method: "evm_connect",
      params: { network: "testnet" },
    });

    const result = {
      address: "0x0000000000000000000000000000000000000001",
      chainId: 1449000,
      network: "testnet",
    };
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: envelope.id, ok: true, result },
    });
    await expect(p).resolves.toEqual(result);
    // The SDK never closes the popup: the window owns its own lifecycle,
    // and a follow-up request reuses it by name (a navigation, which popup
    // blockers permit where a fresh window.open outside a click is not).
    expect(popup.close).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("sign asks for method sign and resolves with the signed transaction", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);

    const tx = { TransactionType: "Payment", Destination: "rEzuT5Grm7tyFYP4QqX58pcvfCaJjKzcnG", Amount: "1000000" };
    const p = sdk.sign({ network: "testnet", tx });
    dispatch({ origin: WALLET, source: popup, data: READY });
    const [envelope] = popup.postMessage.mock.calls[0] as [{ id: string; method: string; params: unknown }, string];
    expect(envelope).toMatchObject({ method: "sign", params: { network: "testnet", tx } });

    const result = { tx_blob: "1200002280000000", hash: "A".repeat(64) };
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: envelope.id, ok: true, result },
    });
    await expect(p).resolves.toEqual(result);
  });

  it("answers ready exactly once", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();

    dispatch({ origin: WALLET, source: popup, data: READY });
    dispatch({ origin: WALLET, source: popup, data: READY });
    expect(popup.postMessage).toHaveBeenCalledTimes(1);

    const [envelope] = popup.postMessage.mock.calls[0] as [{ id: string }];
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: envelope.id, ok: true, result: {} },
    });
    await p;
  });

  it("ignores wrong origins, wrong sources and foreign ids", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();

    dispatch({ origin: "https://evil.test", source: popup, data: READY });
    dispatch({ origin: WALLET, source: { not: "the popup" }, data: READY });
    expect(popup.postMessage).not.toHaveBeenCalled();

    dispatch({ origin: WALLET, source: popup, data: READY });
    const [envelope] = popup.postMessage.mock.calls[0] as [{ id: string }];

    // A response with a foreign id must not settle the request…
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: "someone-else", ok: true, result: { wrong: true } },
    });
    // …so the matching one still wins.
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: envelope.id, ok: true, result: { right: true } },
    });
    await expect(p).resolves.toEqual({ right: true });
  });

  it("rejects a concurrent call with busy", async () => {
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();

    await expect(sdk.connect()).rejects.toMatchObject({ code: "busy" });

    dispatch({ origin: WALLET, source: popup, data: READY });
    const [envelope] = popup.postMessage.mock.calls[0] as [{ id: string }];
    dispatch({
      origin: WALLET,
      source: popup,
      data: { clasp: "response", v: 1, id: envelope.id, ok: true, result: {} },
    });
    await p;
  });
});

describe("failure timers", () => {
  it("a closed popup rejects user_rejected via the 300ms poll", async () => {
    vi.useFakeTimers();
    const sdk = new ClaspConnect({ walletUrl: WALLET });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();
    const settled = expect(p).rejects.toMatchObject({ code: "user_rejected" });
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(300);
    await settled;
  });

  it("timeout without ready names dapp-side COOP as the likely cause", async () => {
    vi.useFakeTimers();
    const sdk = new ClaspConnect({ walletUrl: WALLET, timeoutMs: 1000 });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();
    const settled = expect(p).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("Cross-Origin-Opener-Policy"),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it("timeout after ready is a plain approval timeout", async () => {
    vi.useFakeTimers();
    const sdk = new ClaspConnect({ walletUrl: WALLET, timeoutMs: 1000 });
    const popup = makeFakePopup();
    fakeWin.open.mockReturnValueOnce(popup);
    const p = sdk.connect();
    dispatch({ origin: WALLET, source: popup, data: READY });
    const settled = expect(p).rejects.toMatchObject({
      code: "timeout",
      message: "Timed out waiting for approval.",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });
});

describe("window names", () => {
  it("are per-instance so two clients can't hijack each other's popup", async () => {
    vi.useFakeTimers();
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sdk = new ClaspConnect({ walletUrl: WALLET });
      const popup = makeFakePopup();
      fakeWin.open.mockReturnValueOnce(popup);
      const p = sdk.connect();
      const settled = expect(p).rejects.toMatchObject({ code: "user_rejected" });
      names.push(fakeWin.open.mock.lastCall?.[1] as string);
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(300);
      await settled;
    }
    expect(names[0]).toMatch(/^clasp-connect-/);
    expect(names[1]).toMatch(/^clasp-connect-/);
    expect(names[0]).not.toBe(names[1]);
  });
});
