import { encode } from "ripple-binary-codec";
import { describe, expect, it } from "vitest";
import {
  MEMOS_MAX_BYTES,
  CLASP_EVM_CHAIN_IDS,
  evmNetworkForChainId,
  isClaspReady,
  isClaspRequest,
  isClaspResponse,
  makeProofPayload,
  validateEvmTx,
  validateTx,
  validChallenge,
  validConnectEvm,
  validEvmAddressShape,
  validEvmMessageHex,
  validTypedDataJson,
} from "./protocol";

const DEST = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD = "524C555344000000000000000000000000000000";

const EVM_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EVM_RECIPIENT = "0x297f8f879203DE36c36B5dFBc2ae00e7996ba92E";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Canonical transfer(address,uint256) calldata, built the hard way. */
function transferData(recipient: string, units: bigint): string {
  return (
    "0xa9059cbb" +
    recipient.slice(2).toLowerCase().padStart(64, "0") +
    units.toString(16).padStart(64, "0")
  );
}

describe("envelope guards", () => {
  it("accepts well-formed messages", () => {
    expect(isClaspReady({ clasp: "ready", v: 1 })).toBe(true);
    expect(
      isClaspRequest({ clasp: "request", v: 1, id: "a", method: "connect", params: {} }),
    ).toBe(true);
    expect(
      isClaspResponse({ clasp: "response", v: 1, id: "a", ok: true, result: {} }),
    ).toBe(true);
  });
  it("rejects junk, wrong versions, unknown methods", () => {
    expect(isClaspReady(null)).toBe(false);
    expect(isClaspReady({ clasp: "ready", v: 2 })).toBe(false);
    expect(
      isClaspRequest({ clasp: "request", v: 1, id: "a", method: "sign_blob", params: {} }),
    ).toBe(false);
    expect(isClaspRequest({ clasp: "request", v: 1, id: "", method: "connect", params: {} })).toBe(false);
  });
  it("accepts the three XRPL methods: connect, sign_and_submit and sign", () => {
    for (const method of ["connect", "sign_and_submit", "sign"]) {
      expect(isClaspRequest({ clasp: "request", v: 1, id: "a", method, params: {} })).toBe(true);
    }
  });
});

/**
 * Memos are signed as the site sent them; the rules below are only the ledger's
 * own (rippled `isMemoOkay`) plus xrpl.js's, so a memo the network would refuse
 * never reaches a screen. Plus one that is Clasp's: no BYOW sign-in statement.
 */
describe("validateTx — memos, by the ledger's own rules", () => {
  const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
  const pay = (extra: Record<string, unknown>) =>
    validateTx({ TransactionType: "Payment", Destination: DEST, Amount: "1", ...extra });
  const trust = (extra: Record<string, unknown>) =>
    validateTx({
      TransactionType: "TrustSet",
      LimitAmount: { currency: RLUSD, issuer: DEST, value: "1" },
      ...extra,
    });
  const memo = (m: Record<string, unknown>) => ({ Memos: [{ Memo: m }] });
  const reason = (v: ReturnType<typeof validateTx>) => (v.ok ? "(accepted)" : v.reason);
  /** What rippled measures: the codec's bytes less the Memos field id and the array's end marker. */
  const ledgerBytes = (memos: unknown) => encode({ Memos: memos } as never).length / 2 - 2;

  it("accepts a source tag and memos on a payment and on a trust line, unchanged", () => {
    const bridge = {
      SourceTag: 2608140001,
      Memos: [
        { Memo: { MemoType: hex("type"), MemoData: hex("interchain_transfer") } },
        { Memo: { MemoType: hex("destination_address"), MemoData: hex("1111111111111111111111111111111111111111") } },
      ],
    };
    const p = pay(bridge);
    expect(p).toEqual({ ok: true, tx: { TransactionType: "Payment", Destination: DEST, Amount: "1", ...bridge } });
    expect(trust(bridge).ok).toBe(true);
    expect(pay({ SourceTag: 0 }).ok).toBe(true);
    expect(pay({ SourceTag: 0xffffffff }).ok).toBe(true);
  });

  it("accepts a memo with any one part, any bytes in its data, either hex case, and no memos at all", () => {
    for (const m of [
      { MemoData: "00FF7F80" }, // binary: shown as hex
      { MemoType: hex("note") },
      { MemoFormat: hex("text/plain") },
      { MemoType: hex("a-b._~:/?#[]@!$&'()*+,;=%z"), MemoData: "ab", MemoFormat: hex("application/json") },
      { MemoData: "abcdef" }, // lowercase: the same bytes
    ]) {
      expect(reason(pay(memo(m))), JSON.stringify(m)).toBe("(accepted)");
    }
    expect(pay({ Memos: [] }).ok).toBe(true);
  });

  it("refuses memos the ledger would refuse", () => {
    const cases: [unknown, RegExp][] = [
      [{ Memos: "AB" }, /^Memos must be an array/],
      [{ Memos: [{ MemoData: "AB" }] }, /^Memos must be an array/],
      [{ Memos: [{ Memo: { MemoData: "AB" }, Extra: 1 }] }, /^Memos must be an array/],
      [{ Memos: [{ Memo: "AB" }] }, /^Memos must be an array/],
      [memo({}), /^a Memo must carry/],
      [memo({ MemoData: "AB", Note: "AB" }), /^Memo field "Note" is not supported/],
      [memo({ MemoData: "" }), /^MemoData must be non-empty hex/],
      [memo({ MemoData: "ABC" }), /^MemoData must be non-empty hex/], // xrpl.js would sign this; the bytes would not be these
      [memo({ MemoData: "zz" }), /^MemoData must be non-empty hex/],
      [memo({ MemoData: 7 }), /^MemoData must be non-empty hex/],
      [memo({ MemoType: hex("a b") }), /^MemoType may only contain characters allowed in a URL/],
      [memo({ MemoType: hex("<script>") }), /^MemoType may only contain characters allowed in a URL/],
      [memo({ MemoFormat: hex("text/plain\n") }), /^MemoFormat may only contain characters allowed in a URL/],
      [memo({ MemoType: "C3A9" }), /^MemoType may only contain characters allowed in a URL/], // é
    ];
    for (const [extra, why] of cases) {
      expect(reason(pay(extra as Record<string, unknown>)), JSON.stringify(extra)).toMatch(why);
      expect(reason(trust(extra as Record<string, unknown>)), JSON.stringify(extra)).toMatch(why);
    }
  });

  it("counts memo bytes the way the ledger does, and refuses past its 1 KB", () => {
    expect(MEMOS_MAX_BYTES).toBe(1024);
    const at = (n: number) => [{ Memo: { MemoData: "AB".repeat(n) } }];
    expect(ledgerBytes(at(1019))).toBe(1024);
    expect(pay({ Memos: at(1019) }).ok).toBe(true);
    expect(ledgerBytes(at(1020))).toBe(1025);
    expect(reason(pay({ Memos: at(1020) }))).toBe("Memos are 1025 bytes; the ledger allows 1024");
    // Across memos, and across the 192-byte step in a part's length prefix.
    const split = [
      { Memo: { MemoType: hex("t".repeat(192)), MemoData: "AB".repeat(193) } },
      { Memo: { MemoFormat: hex("f"), MemoData: "CD".repeat(625) } },
    ];
    const bytes = ledgerBytes(split);
    expect(bytes).toBe(1025);
    expect(reason(pay({ Memos: split }))).toBe(`Memos are ${bytes} bytes; the ledger allows 1024`);
  });

  it("refuses a BYOW sign-in memo in any hex case, on both types", () => {
    for (const t of ["62796F772F7369676E2D696E", "62796f772f7369676e2d696e"]) {
      for (const v of [pay(memo({ MemoType: t, MemoData: "7B7D" })), trust(memo({ MemoType: t }))]) {
        expect(reason(v)).toBe("a sign-in memo (byow/sign-in) can't be requested in a transaction");
      }
    }
    // Only the type marks a sign-in statement: the same words in the data are just data.
    expect(pay(memo({ MemoData: "62796F772F7369676E2D696E" })).ok).toBe(true);
  });

});

/**
 * Open signing (Shane, 2026-11-11, a core principle): Clasp signs any transaction
 * a site sends, exactly as sent, and the person vets the site. `validateTx` is
 * structure only: it refuses what isn't a transaction, a request that already
 * carries a signature, memos the ledger refuses, a BYOW sign-in statement, and
 * anything too large to show. Whether the ledger can encode the rest is
 * `checkSignable`'s job (lib/xrpl/signable.ts), which carries the codec.
 */
describe("validateTx — open signing", () => {
  const RLUSD_LIMIT = { currency: RLUSD, issuer: DEST, value: "1000000000" };

  it("accepts any transaction type, with any of its fields, and hands back the request itself", () => {
    for (const tx of [
      { TransactionType: "Payment", Destination: DEST, Amount: "1000000" },
      {
        TransactionType: "Payment",
        Account: DEST,
        Destination: DEST,
        Amount: { currency: RLUSD, issuer: DEST, value: "10.5" },
        SendMax: "20000000",
        DeliverMin: { currency: RLUSD, issuer: DEST, value: "10" },
        Paths: [[{ currency: RLUSD, issuer: DEST }]],
        Flags: 131072,
        Fee: "5000000",
        Sequence: 7,
        LastLedgerSequence: 99,
        InvoiceID: "00".repeat(32),
      },
      { TransactionType: "TrustSet", LimitAmount: RLUSD_LIMIT },
      { TransactionType: "TrustSet", LimitAmount: RLUSD_LIMIT, Flags: 262144 },
      { TransactionType: "OfferCreate", TakerGets: "1000000", TakerPays: { currency: RLUSD, issuer: DEST, value: "1" }, Flags: 524288 },
      { TransactionType: "AccountSet", SetFlag: 1 },
      { TransactionType: "SetRegularKey", RegularKey: DEST },
      { TransactionType: "AccountDelete", Destination: DEST },
      { TransactionType: "Batch", Flags: 65536, RawTransactions: [] },
      { TransactionType: "NFTokenCreateOffer", NFTokenID: "00".repeat(32), Amount: "0", Flags: 1 },
      // Structure only: whether the ledger knows this type is checkSignable's question.
      { TransactionType: "SomethingNewer" },
    ]) {
      const v = validateTx(tx);
      expect(v, JSON.stringify(tx)).toEqual({ ok: true, tx });
      if (v.ok) expect(v.tx).toBe(tx);
    }
  });

  it("refuses what isn't a transaction", () => {
    for (const input of [null, "Payment", 42, [], { Destination: DEST }, { TransactionType: 42 }, { TransactionType: "" }, { TransactionType: "Pay ment" }]) {
      const v = validateTx(input);
      expect(v.ok, JSON.stringify(input)).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/^(tx must be|TransactionType must be)/);
    }
  });

  it("refuses a request that already carries a signature", () => {
    for (const field of ["SigningPubKey", "TxnSignature", "Signers"]) {
      const v = validateTx({ TransactionType: "Payment", Destination: DEST, Amount: "1", [field]: "AB" });
      expect(v).toEqual({ ok: false, reason: `"${field}" is part of a signature, which a site never supplies` });
    }
  });

  it("refuses a request too large or too deeply nested to show", () => {
    expect(validateTx({ TransactionType: "Payment", Destination: DEST, Amount: "1", Note: "x".repeat(70_000) })).toEqual({
      ok: false,
      reason: "tx is too large to show for review",
    });
    let deep: unknown = "leaf";
    for (let i = 0; i < 14; i++) deep = { deep };
    expect(validateTx({ TransactionType: "Payment", Nested: deep })).toEqual({
      ok: false,
      reason: "tx is nested too deeply to show for review",
    });
  });
});

describe("proof payload", () => {
  it("binds origin and challenge with the domain prefix", () => {
    expect(makeProofPayload("https://dapp.example", "nonce-123")).toBe(
      "clasp:proof:v1:https://dapp.example:nonce-123",
    );
  });
  it("rejects oversized or non-printable challenges", () => {
    expect(validChallenge("a".repeat(256))).toBe(true);
    expect(validChallenge("a".repeat(257))).toBe(false);
    expect(validChallenge("evil\x00bytes")).toBe(false);
    expect(validChallenge("")).toBe(false);
    expect(() => makeProofPayload("https://x", "\x07")).toThrow();
  });
});

describe("connect's evm field (dual sign-in, 0.4.0)", () => {
  it("is optional, and when present names at most a network", () => {
    expect(validConnectEvm(undefined)).toBe(true);
    expect(validConnectEvm({})).toBe(true);
    expect(validConnectEvm({ network: "mainnet" })).toBe(true);
    expect(validConnectEvm({ network: "testnet" })).toBe(true);
  });

  it("refuses anything else, so a site can't smuggle fields through it", () => {
    expect(validConnectEvm(null)).toBe(false);
    expect(validConnectEvm(true)).toBe(false);
    expect(validConnectEvm([])).toBe(false);
    expect(validConnectEvm({ network: "devnet" })).toBe(false);
    expect(validConnectEvm({ network: "mainnet", chainId: 1 })).toBe(false);
  });
});

describe("EVM envelope", () => {
  it("accepts the four EVM methods", () => {
    for (const method of [
      "evm_connect",
      "evm_personal_sign",
      "evm_sign_and_submit",
      "evm_sign_typed_data",
    ]) {
      expect(
        isClaspRequest({ clasp: "request", v: 1, id: "a", method, params: {} }),
      ).toBe(true);
    }
  });
  it("still rejects unknown methods and bad ids", () => {
    expect(
      isClaspRequest({ clasp: "request", v: 1, id: "a", method: "evm_sign_blob", params: {} }),
    ).toBe(false);
    expect(
      isClaspRequest({ clasp: "request", v: 1, id: "", method: "evm_connect", params: {} }),
    ).toBe(false);
    expect(
      isClaspRequest({
        clasp: "request",
        v: 1,
        id: "x".repeat(129),
        method: "evm_connect",
        params: {},
      }),
    ).toBe(false);
  });
});

describe("EVM chain identity", () => {
  it("pins the wire-level chain ids (a transposition here re-routes money)", () => {
    expect(CLASP_EVM_CHAIN_IDS).toEqual({ mainnet: 1440000, testnet: 1449000 });
  });
  it("maps chain ids to networks and nothing else", () => {
    expect(evmNetworkForChainId(1440000)).toBe("mainnet");
    expect(evmNetworkForChainId(1449000)).toBe("testnet");
    expect(evmNetworkForChainId(1)).toBe(null);
    expect(evmNetworkForChainId("1440000")).toBe(null);
    expect(evmNetworkForChainId(null)).toBe(null);
  });
});

describe("validateEvmTx — structural (open signing)", () => {
  it("accepts a clean value transfer and parses the triple", () => {
    const v = validateEvmTx({ to: EVM_TO, value: "0xde0b6b3a7640000" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.parsed).toEqual({ to: EVM_TO, valueWei: 10n ** 18n, data: "0x" });
    }
  });
  it('normalizes absent and "0x" calldata to "0x"', () => {
    const bare = validateEvmTx({ to: EVM_TO, value: "0x1" });
    const empty = validateEvmTx({ to: EVM_TO, value: "0x1", data: "0x" });
    expect(bare.ok && bare.parsed.data).toBe("0x");
    expect(empty.ok && empty.parsed.data).toBe("0x");
  });
  it("accepts arbitrary calldata verbatim — meaning is the popup's job", () => {
    const good = transferData(EVM_RECIPIENT, 1n);
    for (const data of [
      good, // canonical transfer
      good.slice(0, -2), // off-length
      "0xdeadbeef" + good.slice(10), // foreign selector
      "0xa9059cbb" + "ff" + good.slice(12), // dirty padding
      transferData(ZERO_ADDR, 1n), // zero recipient
      transferData(EVM_RECIPIENT, 0n), // zero units
      "0xdeadbeef",
    ]) {
      const v = validateEvmTx({ to: EVM_TO, data });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.parsed.data).toBe(data);
    }
  });
  it("accepts payable calls (value + calldata) and zero-value pings", () => {
    const payable = validateEvmTx({ to: EVM_TO, value: "0x1", data: "0xd0e30db0" });
    expect(payable.ok).toBe(true);
    if (payable.ok) expect(payable.parsed.valueWei).toBe(1n);
    // No value, no data: a zero-value call — structurally fine.
    const ping = validateEvmTx({ to: EVM_TO });
    expect(ping.ok).toBe(true);
    if (ping.ok) expect(ping.parsed).toEqual({ to: EVM_TO, valueWei: 0n, data: "0x" });
    expect(validateEvmTx({ to: EVM_TO, value: "0x0" }).ok).toBe(true);
  });
  it("accepts the zero address as a destination (the popup warns instead)", () => {
    expect(validateEvmTx({ to: ZERO_ADDR, value: "0x1" }).ok).toBe(true);
  });
  it("refuses malformed quantities", () => {
    expect(validateEvmTx({ to: EVM_TO, value: "0xzz" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO, value: "0x" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO, value: "1000000" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO, value: "0x" + "f".repeat(65) }).ok).toBe(false);
  });
  it("refuses malformed destinations and calldata bytes", () => {
    expect(validateEvmTx({ to: "not-an-addr", value: "0x1" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO.slice(0, 41), value: "0x1" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO, data: "0x123" }).ok).toBe(false); // odd length
    expect(validateEvmTx({ to: EVM_TO, data: "0xzz" }).ok).toBe(false);
    expect(validateEvmTx({ to: EVM_TO, data: "deadbeef" }).ok).toBe(false);
  });
  it("caps calldata at 128 KiB", () => {
    const atCap = "0x" + "ab".repeat(131_072);
    expect(validateEvmTx({ to: EVM_TO, data: atCap }).ok).toBe(true);
    expect(validateEvmTx({ to: EVM_TO, data: atCap + "ab" }).ok).toBe(false);
  });
});

describe("validateEvmTx — wallet-filled and unknown fields", () => {
  it("refuses every wallet-filled field by name", () => {
    for (const key of [
      "from",
      "gas",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "nonce",
      "chainId",
      "type",
      "accessList",
    ]) {
      const v = validateEvmTx({ to: EVM_TO, value: "0x1", [key]: "0x1" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("wallet-filled");
    }
  });
  it("refuses unknown fields", () => {
    const v = validateEvmTx({ to: EVM_TO, value: "0x1", foo: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not supported");
  });
});

describe("validEvmMessageHex", () => {
  it("accepts hex byte strings up to 8 KiB", () => {
    expect(validEvmMessageHex("0x68690a")).toBe(true);
    expect(validEvmMessageHex("0x" + "ab".repeat(8192))).toBe(true);
  });
  it("rejects empty, odd, non-hex, oversized and non-strings", () => {
    expect(validEvmMessageHex("0x")).toBe(false);
    expect(validEvmMessageHex("0x123")).toBe(false);
    expect(validEvmMessageHex("0xzz")).toBe(false);
    expect(validEvmMessageHex("0x" + "ab".repeat(8193))).toBe(false);
    expect(validEvmMessageHex(42)).toBe(false);
    expect(validEvmMessageHex(undefined)).toBe(false);
  });
});

describe("validTypedDataJson", () => {
  it("accepts a JSON string up to 256 KiB of UTF-8", () => {
    expect(validTypedDataJson('{"a":1}')).toBe(true);
    expect(validTypedDataJson("x".repeat(262_144))).toBe(true);
  });
  it("rejects non-strings, empty, and oversized input", () => {
    expect(validTypedDataJson(undefined)).toBe(false);
    expect(validTypedDataJson(42)).toBe(false);
    expect(validTypedDataJson({})).toBe(false);
    expect(validTypedDataJson("")).toBe(false);
    expect(validTypedDataJson("x".repeat(262_145))).toBe(false);
    // Multi-byte chars: the cap is bytes, not chars — 87382 × 3 bytes > cap.
    expect(validTypedDataJson("€".repeat(87_382))).toBe(false);
  });
});

describe("validEvmAddressShape", () => {
  it("accepts 40-hex addresses in any case", () => {
    expect(validEvmAddressShape(EVM_TO)).toBe(true);
    expect(validEvmAddressShape(EVM_TO.toLowerCase())).toBe(true);
  });
  it("rejects wrong lengths and missing prefix", () => {
    expect(validEvmAddressShape(EVM_TO.slice(2))).toBe(false);
    expect(validEvmAddressShape(EVM_TO + "a")).toBe(false);
    expect(validEvmAddressShape(EVM_TO.slice(0, 41))).toBe(false);
  });
});
