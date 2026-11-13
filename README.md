# clasp-connect

Dapp SDK for [Clasp](https://claspwallet.com) — the passkey wallet for the
XRP Ledger and XRPL EVM. One passkey touch derives both chains; the user
holds the seed; every approval is a fresh touch in a Clasp-owned popup that
shows exactly what is being signed. **Clasp never signs what it can't show.**

Two faces, one package, zero runtime dependencies:

- **`clasp-connect`** — the vanilla SDK: XRPL sign-in, signing and sending,
  and the XRPL EVM methods, over a popup + postMessage transport.
- **`clasp-connect/wagmi`** — a [wagmi](https://wagmi.sh) v2 connector for
  XRPL EVM dapps (plus `clasp-connect/rainbowkit` for RainbowKit).

## Install

The vanilla SDK, with zero dependencies:

```sh
npm i clasp-connect
```

With the wagmi connector:

```sh
npm i clasp-connect @wagmi/core viem
```

## wagmi (XRPL EVM dapps)

```ts
import { createConfig, http } from "wagmi";
import { claspConnector, xrplevm, xrplevmTestnet } from "clasp-connect/wagmi";

export const config = createConfig({
  chains: [xrplevm, xrplevmTestnet],
  transports: { [xrplevm.id]: http(), [xrplevmTestnet.id]: http() },
  connectors: [claspConnector()],
});
```

That's the whole integration. `useConnect`, `useAccount`, `useBalance`,
`useReadContract`, SIWE via `signMessage`, `useSendTransaction`,
`useWriteContract` for any contract, and `useSignTypedData` — all work.
Every transaction renders in the Clasp popup at the deepest fidelity
available: known operations (transfers, approvals, NFT moves) decoded in
full, calls against explorer-verified contracts decoded by name and
arguments, and everything else shown byte-for-byte behind a warning — the
user always decides. The two deliberate refusals: `eth_sign` (blind signing)
and sign-in messages naming a different site than yours.

### RainbowKit

```ts
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { claspWallet } from "clasp-connect/rainbowkit";

const connectors = connectorsForWallets(
  [{ groupName: "Recommended", wallets: [claspWallet] }],
  { appName: "My dapp", projectId: "…" },
);
```

## Vanilla SDK

```ts
import { ClaspConnect } from "clasp-connect";

const clasp = new ClaspConnect({ walletUrl: "https://claspwallet.com" });

// "testnet" is play money. Leave it out and Clasp uses mainnet, which is
// real money. Change this one line when you ship.
const network = "testnet";

// XRPL
const { address, proof } = await clasp.connect({
  network,
  challenge: crypto.randomUUID(),
});
const { hash } = await clasp.signAndSubmit({
  network,
  tx: { TransactionType: "Payment", Destination: "r…", Amount: "1000000" },
  address,
});

// Sign without sending (0.4.0): the same review and touch, and you get the
// signed transaction back to submit yourself. If Clasp filled
// LastLedgerSequence, the signature expires a few ledgers later.
const { tx_blob } = await clasp.sign({
  network,
  tx: { TransactionType: "Payment", Destination: "r…", Amount: "1000000" },
  address,
});

// Both ledgers with one touch (0.4.0): the same popup also shares the XRPL EVM address.
const both = await clasp.connect({ network, challenge: crypto.randomUUID(), evm: {} });
// both.address (XRP Ledger), both.evm?.address and both.evm?.chainId (XRPL EVM).
// A Clasp that predates the field answers without `evm`: fall back to evmConnect on the next click.

// XRPL EVM
const evm = await clasp.evmConnect({ network });
const { signature } = await clasp.evmPersonalSign({
  network,
  address: evm.address,
  messageHex: "0x…", // hex-encoded message bytes (personal_sign params[0])
});
const sent = await clasp.evmSignAndSubmit({
  network,
  address: evm.address,
  tx: { to: "0x…", value: "0xde0b6b3a7640000" }, // hex wei
});
```

`network` is per call and nothing remembers it between calls, so name it
every time. With wagmi, connect on the test chain with
`connect({ connector, chainId: xrplevmTestnet.id })`. To fund a test
account, open Clasp's Settings, tick "Show test networks" under Advanced,
and choose Testnet.

Calls must originate from a user gesture (click handlers) or the browser
blocks the popup — Safari is strictest. One request per popup; one request
in flight per `ClaspConnect` instance.

## ⚠️ The wallet URL is a constant

`https://claspwallet.com` is the only wallet host that exists. A Clasp
passkey is welded to that hostname (the WebAuthn rpID), so a different host
is not a mirror or a staging copy — it is a **different wallet holding none
of the user's money**, and it fails silently: the user sees a valid-looking
account with a zero balance. This is why `claspConnector()` has no URL
option at all. Never proxy, never mirror, never "self-host" the wallet.

## Integrator notes

- **COOP:** if your site sends `Cross-Origin-Opener-Policy: same-origin`,
  the browser severs the popup's channel and every request times out (the
  timeout message says so). Use `same-origin-allow-popups` or the default.
- **Persistence:** the connector stores only `{ address, chainId }` in your
  origin's storage — no secrets exist outside the wallet, and the wallet
  itself keeps no session. Disconnect is local by construction.
- **Gas and nonces are wallet-estimated.** The connector silently drops
  `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `nonce` and
  `type` from `eth_sendTransaction` — the wallet always estimates itself.
  On the wire those fields are refused outright: a site never controls the
  fee a user pays.
- **`eth_sendTransaction` resolves at broadcast** with the transaction
  hash — the same contract as MetaMask — and your app confirms with its own
  receipt wait (wagmi's `useWaitForTransactionReceipt` works unchanged).
- **Chained requests reuse the window.** After a request finishes, the
  Clasp window lingers briefly instead of closing, so a follow-up request
  fired from an async continuation (the classic approve → deposit shape)
  navigates the same window rather than opening a new one — which popup
  blockers would refuse outside a click. Fire sequential writes freely; if
  the user has closed the window, a non-gesture request surfaces `-32002`
  ("browser blocked the Clasp window") and your retry button covers it.

## Method table

| Bucket | Methods | Behaviour |
|---|---|---|
| Local | `eth_accounts`, `eth_chainId`, `eth_requestAccounts`, `net_version`, `wallet_switchEthereumChain` | Answered from the connector's session — never a round-trip. (The EVM account is chain-independent, so a switch is honestly local; an unrecognized chain is `4902`.) |
| Popup | `personal_sign`, `eth_sendTransaction`, `eth_signTypedData_v4` | Open the Clasp popup: full review, fresh passkey touch. Transactions render at the deepest tier that resolves — decoded operation, verified-ABI decode, or raw bytes behind a warning — and typed data renders as its own structured field tree. Malformed transactions fail fast with `4200` before any popup opens (not `-32602` — viem retries that as `wallet_sendTransaction`). |
| Forwarded | `eth_call`, `eth_getBalance`, `eth_estimateGas`, `eth_getLogs`, receipts/blocks/fees | Plain JSON-RPC to your configured chain's RPC, from your page (your CSP governs). Normal wagmi reads never come this way — they use your `transports`. |
| Refused (`4200`) | `eth_sign`, `eth_signTypedData` (v1) / `_v3`, `eth_signTransaction`, `wallet_sendCalls`, everything unknown | `eth_sign` is blind signing and stays dead; v1/v3 typed data point at v4. Never `-32601` (viem would silently retry). |

Error codes: `4001` user rejected / closed the window, `4100` not
connected / account mismatch, `4200` unsupported, `4901` wrong chain,
`4902` unrecognized chain on switch, `-32602` malformed params, `-32002`
popup blocked / timed out / busy / not confirmed (viem shows its canned
text for `4001`, so only a real user "no" may wear that code), `-32003`
failed transaction, `-32603` internal.

## Source and issues

This repository is a copy of the SDK from Clasp's main repository, where it
is built and tested beside the wallet. The copy is replaced on every sync, so
open an [issue](https://github.com/claspwallet/clasp-connect/issues) rather
than a pull request. Report a security problem
[privately](https://github.com/claspwallet/clasp-connect/security/advisories/new),
never in a public issue.

```sh
npm install && npm test && npm run build
```

MIT — see [LICENSE](./LICENSE). The full guide, with the parts that bite, is
at [claspwallet.com/developers](https://claspwallet.com/developers).
