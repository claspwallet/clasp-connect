/**
 * Clasp Connect wire protocol — the single source of truth, imported by
 * both the SDK (dapp side) and the wallet popup. ZERO dependencies: this
 * file must never import anything.
 *
 * Structural validation lives here; the wallet re-validates everything and
 * additionally checksum-verifies addresses. The popup trusts nothing the
 * SDK claims to have checked.
 */

export const CLASP_PROTOCOL_VERSION = 1 as const;

export type ClaspNetwork = "testnet" | "mainnet";

export type ClaspErrorCode =
  | "user_rejected"
  | "unsupported_tx"
  | "unsupported_message"
  | "wrong_wallet"
  | "network_unavailable"
  | "tx_failed"
  | "not_confirmed"
  | "bad_request"
  | "timeout"
  | "busy"
  | "popup_blocked";

export type ClaspError = { code: ClaspErrorCode; message: string };

/* ---------- methods ---------- */

export type ConnectParams = {
  network?: ClaspNetwork;
  /** ≤256 printable ASCII chars; presence requests an ownership proof. */
  challenge?: string;
  /**
   * Also share the XRPL EVM address, on the same screen and with the same touch (since 0.4.0).
   * Its `network` defaults to this request's XRP Ledger network. A wallet that predates the
   * field answers without `evm`: ask with `evmConnect` then (a second popup, so a second click).
   */
  evm?: EvmConnectParams;
};

export type ConnectResult = {
  address: string;
  publicKey: string;
  network: ClaspNetwork;
  proof?: { payload: string; signature: string };
  /** Present when the request carried `evm`. EIP-55 checksummed, like `evmConnect`'s. */
  evm?: EvmConnectResult;
};

export type IouAmount = { currency: string; issuer: string; value: string };

/** A memo, each part hex as the ledger stores it. */
export type XrplMemo = {
  Memo: { MemoType?: string; MemoData?: string; MemoFormat?: string };
};

/**
 * A transaction a site asks Clasp to sign: any type, with any of its fields.
 *
 * Open signing (Shane, 2026-11-11, a core principle): Clasp can't shield people
 * from every bad or malicious site, and vetting the site is the person's job, as
 * with any wallet. So Clasp signs what the site sends. It fills in `Account`,
 * `Sequence`, `Fee` and `LastLedgerSequence` only when the site leaves them out,
 * changes nothing else, and shows every field before the touch.
 */
export type XrplTxRequest = { TransactionType: string; [field: string]: unknown };

/** @deprecated Since 2026-11-11 Clasp signs any transaction. Use `XrplTxRequest`. */
export type WhitelistedTx = XrplTxRequest;

export type SignAndSubmitParams = {
  network?: ClaspNetwork;
  /**
   * If present, the approving passkey must derive exactly this address. A
   * `tx.Account` is the same pin, and the two must agree.
   */
  address?: string;
  tx: XrplTxRequest;
};

export type SignAndSubmitResult = { hash: string; engineResult: "tesSUCCESS" };

/**
 * `sign`: the same request as `sign_and_submit`, and the same review and touch,
 * but Clasp hands the signed transaction back instead of sending it. The site
 * submits `tx_blob` itself and reads the outcome off the ledger. Clasp fills
 * `Sequence`, `Fee` and `LastLedgerSequence` only where the site left them
 * out, so a blob Clasp completed expires a few ledgers after it was signed.
 */
export type SignParams = SignAndSubmitParams;

export type SignResult = { tx_blob: string; hash: string };

/* ---------- envelopes ---------- */

export type ClaspReady = { clasp: "ready"; v: typeof CLASP_PROTOCOL_VERSION };

export type ClaspRequest =
  | { clasp: "request"; v: 1; id: string; method: "connect"; params: ConnectParams }
  | { clasp: "request"; v: 1; id: string; method: "sign_and_submit"; params: SignAndSubmitParams }
  | { clasp: "request"; v: 1; id: string; method: "sign"; params: SignParams }
  | { clasp: "request"; v: 1; id: string; method: "evm_connect"; params: EvmConnectParams }
  | { clasp: "request"; v: 1; id: string; method: "evm_personal_sign"; params: EvmPersonalSignParams }
  | { clasp: "request"; v: 1; id: string; method: "evm_sign_and_submit"; params: EvmSignAndSubmitParams }
  | { clasp: "request"; v: 1; id: string; method: "evm_sign_typed_data"; params: EvmSignTypedDataParams };

export type ClaspResponse =
  | {
      clasp: "response";
      v: 1;
      id: string;
      ok: true;
      result:
        | ConnectResult
        | SignAndSubmitResult
        | SignResult
        | EvmConnectResult
        | EvmPersonalSignResult
        | EvmSignAndSubmitResult
        | EvmSignTypedDataResult;
    }
  | { clasp: "response"; v: 1; id: string; ok: false; error: ClaspError };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isClaspReady(x: unknown): x is ClaspReady {
  return isRecord(x) && x.clasp === "ready" && x.v === 1;
}

const REQUEST_METHODS = new Set([
  "connect",
  "sign_and_submit",
  "sign",
  "evm_connect",
  "evm_personal_sign",
  "evm_sign_and_submit",
  "evm_sign_typed_data",
]);

export function isClaspRequest(x: unknown): x is ClaspRequest {
  return (
    isRecord(x) &&
    x.clasp === "request" &&
    x.v === 1 &&
    typeof x.id === "string" &&
    x.id.length > 0 &&
    x.id.length <= 128 &&
    typeof x.method === "string" &&
    REQUEST_METHODS.has(x.method) &&
    isRecord(x.params)
  );
}

export function isClaspResponse(x: unknown): x is ClaspResponse {
  return (
    isRecord(x) &&
    x.clasp === "response" &&
    x.v === 1 &&
    typeof x.id === "string" &&
    typeof x.ok === "boolean"
  );
}

/* ---------- validation ---------- */

const CLASSIC_ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const CHALLENGE_RE = /^[\x20-\x7e]{1,256}$/;
const TX_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** The signature is the wallet's. A request that carries one asks to sign something already signed. */
const SIGNATURE_FIELDS: readonly string[] = ["SigningPubKey", "TxnSignature", "Signers"];

/** Far above any real transaction (a Batch of eight is a few KB): a bound on what a review has to draw. */
const MAX_TX_JSON_CHARS = 64 * 1024;
const MAX_TX_DEPTH = 12;

function depthWithin(v: unknown, max: number, depth = 0): boolean {
  if (depth > max) return false;
  if (Array.isArray(v)) return v.every((x) => depthWithin(x, max, depth + 1));
  if (isRecord(v)) return Object.values(v).every((x) => depthWithin(x, max, depth + 1));
  return true;
}

/* ---------- memos ---------- */

const MEMO_FIELDS: readonly string[] = ["MemoType", "MemoData", "MemoFormat"];
const MEMO_HEX_RE = /^(?:[0-9A-Fa-f]{2})+$/;
/** RFC 3986's URL characters: everything rippled allows inside a MemoType or a MemoFormat. */
const MEMO_URL_CHARS_RE = /^[0-9A-Za-z\-._~:/?#[\]@!$&'()*+,;=%]*$/;
/** The ledger's cap on a transaction's memos, serialized (rippled `isMemoOkay`). */
export const MEMOS_MAX_BYTES = 1024;
/**
 * "byow/sign-in" as hex. A BYOW sign-in proof is minted by `connect` and by
 * nothing else (lib/byow/door.ts), so no site may ask for a transaction that
 * carries one, over either wire. A payment could never pass as a sign-in (the
 * verifier wants an AccountSet that cannot apply); this keeps that true
 * whatever a sloppier verifier checks.
 */
const SIGN_IN_MEMO_TYPE_HEX = "62796F772F7369676E2D696E";

function hexToLatin1(hex: string): string {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return s;
}

/**
 * Why these memos can't be signed, or null when they can. The rules are the
 * ledger's own (rippled `isMemoOkay`), plus xrpl.js's refusal of an empty
 * part, run before any screen: a memo the network would refuse is never shown
 * and approved. The size is counted the way rippled counts it: per memo, its
 * field id and end marker, and per part a field id, a length prefix and the
 * bytes (pinned against ripple-binary-codec in protocol.test.ts).
 */
function memosProblem(memos: unknown): string | null {
  const shape = "Memos must be an array of {Memo: {MemoType?, MemoData?, MemoFormat?}}";
  if (!Array.isArray(memos)) return shape;
  let bytes = 0;
  for (const entry of memos) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1 || !isRecord(entry.Memo)) return shape;
    const memo = entry.Memo;
    const keys = Object.keys(memo);
    if (keys.length === 0) return "a Memo must carry MemoType, MemoData or MemoFormat";
    bytes += 2;
    for (const key of keys) {
      if (!MEMO_FIELDS.includes(key)) return `Memo field "${key}" is not supported`;
      const hex = memo[key];
      if (typeof hex !== "string" || !MEMO_HEX_RE.test(hex)) return `${key} must be non-empty hex`;
      if (key !== "MemoData" && !MEMO_URL_CHARS_RE.test(hexToLatin1(hex))) {
        return `${key} may only contain characters allowed in a URL`;
      }
      const len = hex.length / 2;
      bytes += 1 + (len <= 192 ? 1 : len <= 12480 ? 2 : 3) + len;
    }
    if (typeof memo.MemoType === "string" && memo.MemoType.toUpperCase() === SIGN_IN_MEMO_TYPE_HEX) {
      return "a sign-in memo (byow/sign-in) can't be requested in a transaction";
    }
  }
  if (bytes > MEMOS_MAX_BYTES) return `Memos are ${bytes} bytes; the ledger allows ${MEMOS_MAX_BYTES}`;
  return null;
}

export function validChallenge(c: unknown): c is string {
  return typeof c === "string" && CHALLENGE_RE.test(c);
}

/** `connect`'s `evm` field: absent, `{}`, or `{ network: "testnet" | "mainnet" }`, and nothing else. */
export function validConnectEvm(x: unknown): x is EvmConnectParams | undefined {
  if (x === undefined) return true;
  if (!isRecord(x)) return false;
  if (Object.keys(x).some((k) => k !== "network")) return false;
  return x.network === undefined || x.network === "testnet" || x.network === "mainnet";
}

export function validClassicAddressShape(a: unknown): a is string {
  return typeof a === "string" && CLASSIC_ADDR_RE.test(a);
}

export type TxValidation =
  | { ok: true; tx: XrplTxRequest }
  | { ok: false; reason: string };

/**
 * Open signing (Shane, 2026-11-11): any transaction a site asks for is signed as
 * sent, and the popup shows every field of it first. Refused here is only what
 * Clasp can't sign, or must not:
 *
 *  - something that isn't a transaction, or is too large or deep to show;
 *  - a request that already carries a signature;
 *  - memos the ledger itself would refuse (`memosProblem`);
 *  - a BYOW sign-in statement (`memosProblem`). Only `connect` makes one, with
 *    the origin the browser stamped. Signing one a site wrote would let that
 *    site sign the person in to ANOTHER site, which no vetting of this site
 *    could catch: the XRPL twin of the SIWE-domain refusal on the EVM side.
 *
 * Whether the XRP Ledger can encode the request at all is checked by the popup,
 * which carries the codec (`checkSignable`, components/connect/dapp-tx.ts). This
 * file has no dependencies, so it checks structure only.
 */
export function validateTx(input: unknown): TxValidation {
  if (!isRecord(input)) return { ok: false, reason: "tx must be an object" };
  const type = input.TransactionType;
  if (typeof type !== "string" || !TX_TYPE_RE.test(type)) {
    return { ok: false, reason: "TransactionType must be a transaction type name" };
  }
  for (const key of SIGNATURE_FIELDS) {
    if (key in input) return { ok: false, reason: `"${key}" is part of a signature, which a site never supplies` };
  }
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return { ok: false, reason: "tx must be plain JSON" };
  }
  if (json.length > MAX_TX_JSON_CHARS) return { ok: false, reason: "tx is too large to show for review" };
  if (!depthWithin(input, MAX_TX_DEPTH)) return { ok: false, reason: "tx is nested too deeply to show for review" };
  if ("Memos" in input) {
    const problem = memosProblem(input.Memos);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, tx: input as XrplTxRequest };
}

/* ---------- ownership proof ---------- */

/**
 * Domain-separated proof payload. Starts with ASCII "clasp:" — XRPL tx
 * preimages start with the STX\0 hash prefix (0x53545800), so this can
 * never collide with signable transaction bytes. The prefix is load-bearing,
 * not branding: any rename must stay printable ASCII and must not be STX\0,
 * or a crafted challenge could become a spendable signature.
 */
export function makeProofPayload(origin: string, challenge: string): string {
  if (!validChallenge(challenge)) {
    throw new Error("challenge must be 1-256 printable ASCII characters");
  }
  return `clasp:proof:v1:${origin}:${challenge}`;
}

/* ---------- EVM (XRPL EVM sidechain) ---------- */

/**
 * A parallel universe to the XRPL types above, never merged — the same rule
 * as EvmNetworkId vs NetworkId in the app (lib/evm/networks.ts mirrors this
 * union and a drift test pins the two, plus the chain ids, against each other).
 */
export type ClaspEvmNetwork = "mainnet" | "testnet";

export type EvmHex = `0x${string}`;

/** Wire-level chain identity — canon, pinned by tests on both sides. */
export const CLASP_EVM_CHAIN_IDS: Record<ClaspEvmNetwork, number> = {
  mainnet: 1440000,
  testnet: 1449000,
};

export function evmNetworkForChainId(chainId: unknown): ClaspEvmNetwork | null {
  if (chainId === CLASP_EVM_CHAIN_IDS.mainnet) return "mainnet";
  if (chainId === CLASP_EVM_CHAIN_IDS.testnet) return "testnet";
  return null;
}

export type EvmConnectParams = { network?: ClaspEvmNetwork };

export type EvmConnectResult = {
  /** EIP-55 checksummed by the wallet. */
  address: EvmHex;
  chainId: number;
  network: ClaspEvmNetwork;
};

export type EvmPersonalSignParams = {
  network?: ClaspEvmNetwork;
  /** If present, the approving passkey must derive exactly this address. */
  address?: EvmHex;
  /** EIP-1193 personal_sign params[0] verbatim — hex-encoded message bytes. */
  messageHex: EvmHex;
};

/** 65-byte ECDSA signature: 0x + 130 hex chars. */
export type EvmPersonalSignResult = { signature: EvmHex };

export type EvmTxFields = {
  to: EvmHex;
  /** Hex quantity in wei, exactly as EIP-1193 carries it. */
  value?: EvmHex;
  /** Arbitrary calldata as 0x hex bytes; what it means is the popup's job. */
  data?: EvmHex;
};

export type EvmSignAndSubmitParams = {
  network?: ClaspEvmNetwork;
  address?: EvmHex;
  tx: EvmTxFields;
};

export type EvmSignAndSubmitResult = { hash: EvmHex };

export type EvmSignTypedDataParams = {
  network?: ClaspEvmNetwork;
  /** If present, the approving passkey must derive exactly this address. */
  address?: EvmHex;
  /** eth_signTypedData_v4 params[1] verbatim — the EIP-712 JSON string. */
  typedDataJson: string;
};

/** 65-byte ECDSA signature: 0x + 130 hex chars. */
export type EvmSignTypedDataResult = { signature: EvmHex };

const EVM_ADDR_RE = /^0x[0-9A-Fa-f]{40}$/;
const EVM_QUANTITY_RE = /^0x[0-9A-Fa-f]{1,64}$/; // ≤32 bytes, read via BigInt
const EVM_BYTES_RE = /^0x(?:[0-9A-Fa-f]{2})*$/;
/**
 * Aligned with the popup's honest-render cap so a connector can refuse a
 * doomed message before a popup ever opens.
 */
const EVM_MESSAGE_MAX_BYTES = 8192;
/**
 * Calldata cap: 128 KiB of bytes is far beyond any real contract call and
 * small enough that the tier-C raw render stays a review, not a hang.
 */
export const EVM_CALLDATA_MAX_BYTES = 131_072;
/**
 * EIP-712 JSON cap, MetaMask-comparable: covers Seaport/Blur-scale bulk
 * orders with headroom while keeping parse + render bounded.
 */
export const EVM_TYPED_DATA_MAX_BYTES = 262_144;

export function validTypedDataJson(x: unknown): x is string {
  if (typeof x !== "string" || x.length === 0) return false;
  // Byte-cap on UTF-8 length; string length is a cheap lower bound so the
  // encoder only runs when the answer could differ.
  if (x.length > EVM_TYPED_DATA_MAX_BYTES) return false;
  return new TextEncoder().encode(x).length <= EVM_TYPED_DATA_MAX_BYTES;
}

/**
 * Fields the wallet always fills itself; presence in a request is refusal,
 * never override. The wallet estimates gas (docs/EVM.md §3) and the client
 * library manages the nonce — a dapp must never control the fee.
 */
const EVM_WALLET_FILLED = new Set([
  "from",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "chainId",
  "type",
  "accessList",
]);

export function validEvmAddressShape(a: unknown): a is EvmHex {
  return typeof a === "string" && EVM_ADDR_RE.test(a);
}

export function validEvmMessageHex(m: unknown): m is EvmHex {
  return (
    typeof m === "string" &&
    EVM_BYTES_RE.test(m) &&
    m.length > 2 &&
    (m.length - 2) / 2 <= EVM_MESSAGE_MAX_BYTES
  );
}

/** The normalized triple every downstream layer works from. `data` is "0x"
 * when the request carried none — the exact bytes signed, nothing inferred. */
export type EvmTxParsed = { to: EvmHex; valueWei: bigint; data: EvmHex };

export type EvmTxValidation =
  | { ok: true; tx: EvmTxFields; parsed: EvmTxParsed }
  | { ok: false; reason: string };

/**
 * Structural validation only — the open-signing law (2026-08-06 reversal).
 * This gate answers "is this a well-formed EVM transaction request?", never
 * "do we understand it?". What the calldata MEANS is the popup's job: it
 * renders known shapes whole, decodes verified ABIs with provenance, and
 * shows everything else byte-for-byte behind a warning. The one policy that
 * still lives here is EVM_WALLET_FILLED — fee, nonce and gas fields are the
 * wallet's alone, presence is refusal, never override.
 */
export function validateEvmTx(input: unknown): EvmTxValidation {
  if (!isRecord(input)) return { ok: false, reason: "tx must be an object" };

  for (const key of Object.keys(input)) {
    if (EVM_WALLET_FILLED.has(key)) {
      return {
        ok: false,
        reason: `"${key}" is wallet-filled and must not be supplied`,
      };
    }
  }
  const allowed = new Set(["to", "value", "data"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `EVM field "${key}" is not supported` };
    }
  }

  const { to, value, data } = input as Record<string, unknown>;
  if (!validEvmAddressShape(to)) {
    return { ok: false, reason: "to is not a 0x EVM address" };
  }

  let valueWei = 0n;
  if (value !== undefined) {
    if (typeof value !== "string" || !EVM_QUANTITY_RE.test(value)) {
      return {
        ok: false,
        reason: "value must be a 0x hex quantity of at most 32 bytes",
      };
    }
    valueWei = BigInt(value);
  }

  if (data !== undefined) {
    if (typeof data !== "string" || !EVM_BYTES_RE.test(data)) {
      return { ok: false, reason: "data must be 0x-prefixed hex bytes" };
    }
    if ((data.length - 2) / 2 > EVM_CALLDATA_MAX_BYTES) {
      return { ok: false, reason: "calldata is larger than 128 KiB" };
    }
  }

  const normalizedData = (data === undefined ? "0x" : data) as EvmHex;
  return {
    ok: true,
    tx: input as unknown as EvmTxFields,
    parsed: { to, valueWei, data: normalizedData },
  };
}
