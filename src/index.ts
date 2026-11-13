/**
 * clasp-connect — dapp-side SDK for Clasp Connect (docs/CONNECT.md).
 * Zero dependencies. One popup per request; calls must originate from a
 * user gesture or the popup gets blocked.
 */
import {
  isClaspReady,
  isClaspResponse,
  type ClaspErrorCode,
  type ClaspRequest,
  type ConnectParams,
  type ConnectResult,
  type EvmConnectParams,
  type EvmConnectResult,
  type EvmPersonalSignParams,
  type EvmPersonalSignResult,
  type EvmSignAndSubmitParams,
  type EvmSignAndSubmitResult,
  type EvmSignTypedDataParams,
  type EvmSignTypedDataResult,
  type SignAndSubmitParams,
  type SignAndSubmitResult,
  type SignParams,
  type SignResult,
} from "./protocol.js";

export class ClaspError extends Error {
  constructor(
    public readonly code: ClaspErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaspError";
  }
}

export type ClaspConnectOptions = {
  /**
   * "https://claspwallet.com" — the production wallet, and the only value a
   * dapp should ship. A passkey welds to the rpID (= the hostname), so a
   * different host is not a different deployment of the same wallet, it is a
   * different wallet with none of the user's money in it. The domain was
   * bought 2026-07-30 and has no moves left.
   */
  walletUrl: string;
  /** default 5 minutes — approvals involve a human */
  timeoutMs?: number;
};

export class ClaspConnect {
  private readonly walletOrigin: string;
  private readonly popupUrl: string;
  private readonly timeoutMs: number;
  /**
   * Per-instance: window.open with a FIXED name navigates an existing window
   * of that name, so a second ClaspConnect on the same page (say, the wagmi
   * connector next to the vanilla SDK) would hijack an in-flight approval —
   * and `busy` is per-instance, so it can't prevent that.
   */
  private readonly windowName = `clasp-connect-${Math.random().toString(36).slice(2, 8)}`;
  private busy = false;

  constructor(opts: ClaspConnectOptions) {
    const origin = new URL(opts.walletUrl).origin;
    this.walletOrigin = origin;
    this.popupUrl = `${origin}/connect/`;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  connect(params: ConnectParams = {}): Promise<ConnectResult> {
    return this.request("connect", params) as Promise<ConnectResult>;
  }

  signAndSubmit(params: SignAndSubmitParams): Promise<SignAndSubmitResult> {
    return this.request("sign_and_submit", params) as Promise<SignAndSubmitResult>;
  }

  /**
   * The same review and touch as `signAndSubmit`, but Clasp hands back the
   * signed transaction (`tx_blob`) and sends nothing: your site submits it and
   * reads the outcome off the ledger.
   */
  sign(params: SignParams): Promise<SignResult> {
    return this.request("sign", params) as Promise<SignResult>;
  }

  evmConnect(params: EvmConnectParams = {}): Promise<EvmConnectResult> {
    return this.request("evm_connect", params) as Promise<EvmConnectResult>;
  }

  evmPersonalSign(params: EvmPersonalSignParams): Promise<EvmPersonalSignResult> {
    return this.request("evm_personal_sign", params) as Promise<EvmPersonalSignResult>;
  }

  evmSignAndSubmit(params: EvmSignAndSubmitParams): Promise<EvmSignAndSubmitResult> {
    return this.request("evm_sign_and_submit", params) as Promise<EvmSignAndSubmitResult>;
  }

  evmSignTypedData(params: EvmSignTypedDataParams): Promise<EvmSignTypedDataResult> {
    return this.request("evm_sign_typed_data", params) as Promise<EvmSignTypedDataResult>;
  }

  private request(method: ClaspRequest["method"], params: unknown): Promise<unknown> {
    if (this.busy) {
      return Promise.reject(
        new ClaspError("busy", "Another Clasp request is already in flight."),
      );
    }
    this.busy = true;

    return new Promise((resolve, reject) => {
      const id = `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      let popup: Window | null = null;
      let settled = false;
      let sent = false;
      let gotReady = false;
      // Declared BEFORE cleanup: the popup-blocked path settles before the
      // timers exist, and a const below would put them in cleanup's temporal
      // dead zone — a ReferenceError that also leaves `busy` stuck true.
      let closePoll: number | undefined = undefined;
      let deadline: number | undefined = undefined;

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (closePoll !== undefined) clearInterval(closePoll);
        if (deadline !== undefined) clearTimeout(deadline);
        this.busy = false;
        // Deliberately NOT popup.close(): the window owns its own lifecycle.
        // Closing it here killed a window that could be mid-signature (the
        // deadline path), and it broke request chaining — the popup lingers
        // after finishing precisely so a follow-up request can REUSE it by
        // name, because window.open on an existing named window is a
        // navigation, which popup blockers permit, while creating a fresh
        // window outside a click is blocked (approve → supply, the shape
        // every lending dapp fires from an async continuation).
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onMessage = (e: MessageEvent) => {
        if (e.origin !== this.walletOrigin) return;
        if (e.source !== popup) return;
        if (isClaspReady(e.data)) {
          gotReady = true;
          if (!sent && popup) {
            sent = true;
            popup.postMessage(
              { clasp: "request", v: 1, id, method, params },
              this.walletOrigin,
            );
          }
          return;
        }
        if (isClaspResponse(e.data) && e.data.id === id) {
          const msg = e.data;
          if (msg.ok) finish(() => resolve(msg.result));
          else finish(() => reject(new ClaspError(msg.error.code, msg.error.message)));
        }
      };

      window.addEventListener("message", onMessage);

      popup = window.open(this.popupUrl, this.windowName, "width=420,height=680,popup=yes");
      if (!popup) {
        finish(() =>
          reject(
            new ClaspError(
              "popup_blocked",
              "The browser blocked the Clasp window — call from a click handler.",
            ),
          ),
        );
        return;
      }

      closePoll = window.setInterval(() => {
        if (popup?.closed && !settled) {
          finish(() =>
            reject(new ClaspError("user_rejected", "The Clasp window was closed.")),
          );
        }
      }, 300);

      deadline = window.setTimeout(() => {
        finish(() =>
          reject(
            new ClaspError(
              "timeout",
              gotReady
                ? "Timed out waiting for approval."
                : "Timed out before the Clasp window answered. If this repeats, check that this site does not send Cross-Origin-Opener-Policy: same-origin.",
            ),
          ),
        );
      }, this.timeoutMs);
    });
  }
}

export {
  CLASP_EVM_CHAIN_IDS,
  EVM_CALLDATA_MAX_BYTES,
  EVM_TYPED_DATA_MAX_BYTES,
  evmNetworkForChainId,
  validateEvmTx,
  validEvmAddressShape,
  validEvmMessageHex,
  validTypedDataJson,
} from "./protocol.js";

export type {
  ClaspErrorCode,
  ClaspEvmNetwork,
  ConnectParams,
  ConnectResult,
  EvmConnectParams,
  EvmConnectResult,
  EvmHex,
  EvmPersonalSignParams,
  EvmPersonalSignResult,
  EvmSignAndSubmitParams,
  EvmSignAndSubmitResult,
  EvmSignTypedDataParams,
  EvmSignTypedDataResult,
  EvmTxFields,
  EvmTxParsed,
  EvmTxValidation,
  SignAndSubmitParams,
  SignAndSubmitResult,
  SignParams,
  SignResult,
  WhitelistedTx,
  XrplMemo,
  XrplTxRequest,
} from "./protocol.js";
