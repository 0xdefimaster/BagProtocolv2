# Try the BAG SDK on Base

Goal: turn one strategy file into a reviewed basket purchase, then independently verify what reached the wallet. This starter uses only the SDK tarball, LI.FI Composer and a Base RPC. It does not need the BAG website, API, account or Supabase database.

**Current scope:** validate → check configuration → quote → wallet purchase → verify receipt. Sale and application position accounting are not SDK APIs in this version. The BAG app has a separate sale flow. This starter's purchases are `NOT_BAG_ACCOUNTED`; they will not create a BAG app position to redeem there.

## 1. Install

Use Node 24 or newer. The 0.4.0 candidate is supplied as `bagprotocol-sdk-0.4.0.tgz`; do not assume it is published to npm. Put the tarball next to this `consumer` directory, then run inside `consumer`:

```sh
npm install --ignore-scripts --no-audit --no-fund ../bagprotocol-sdk-0.4.0.tgz
npm run build
npm run quickstart -- bag.base.example.json
npm run demo
```

The quickstart validates and hashes the Base WETH/cbBTC 50/50 example. The offline demo must report `OFFLINE_DEMO_OK` and `SYNTHETIC_ONLY`. Neither executes a trade.

## 2. Configure your own connection

Copy `.env.base.example` to `.env` and fill in **your own** `RPC_URL` and `LIFI_API_KEY`. The live commands automatically load this file. Keep it private. No private key is needed.

The template contains the maintainer-reviewed Base Composer deployment pin. Review it for your application. The SDK compares that pin against the live chain instead of trusting the address alone. Base uses native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, not USDbC. Delivery proof is enabled and receipts use `DELIVERY_LOG`.

The example strategy has zero performance fee. The amount `2000000` below means **2 USDC**, because USDC has 6 decimals. It is a small integration-test example, not a suggested investment. Gas is paid separately in Base ETH.

## 3. Check and get a quote — no signature

Replace `<your-public-wallet>` with the same address you will connect in the browser:

```sh
npm run check -- bag.base.example.json 2000000 <your-public-wallet>
npm run quote -- bag.base.example.json 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 2000000 <your-public-wallet>
```

`check` verifies the strategy's token decimals, RPC chain, Composer deployment and proxy, then reports the wallet's input and ETH balances. It does **not** estimate gas or prove a swap can execute. `NEEDS_FUNDING` exits 4.

`quote` asks live Composer for an unsigned basket transaction. Inspect `simulation`, each token's estimate/minimum, the approval spender, and price impact. `NEEDS_APPROVAL` means an allowance is still required; it is not a completed swap simulation. Other non-ready simulation results exit 4. A quote is not a transaction receipt and will expire. Failed checks must not be bypassed to obtain a successful demo.

## 4. Purchase with your browser wallet

```sh
npm run sign -- bag.base.example.json 2000000 8787
```

Open the exact local URL printed in the terminal in Chrome/Brave with your wallet extension. Connect the same address on Base, get a **fresh** quote, review the minimum deliveries, save the intent, and approve/send only after checking the wallet prompts. The private RPC and LI.FI credentials stay in the Node process.

After submission, use **SDK ile doğrula**. A successful result requires `VERIFIED` for the submitted transaction. `FAILED` or `INDETERMINATE` does not close the test. Never send again just because verification is delayed. Original intent, checksum, transaction hash and successful verification are retained in `live-purchases/`.

This starter makes no BAG creation transaction and charges no BAG creation fee. The separate BAG app creation flow has its own on-chain fee.

## 5. Tell us where it helped or failed

Record these without credentials or a seed phrase:

- Node/OS, SDK version and the tarball checksum supplied with the pilot.
- Minutes from opening this guide to the first valid strategy and first unsigned quote.
- First failed command, its stable error code, and the instruction that was unclear.
- Whether you needed help from BAG's maintainer; where and how much.
- What this replaced in your own app; whether you would use it again and why.
- If you chose to transact: transaction hash and SDK receipt status, with the wallet owner's consent before sharing.

A run by the maintainer proves a technical path. A developer completing it independently is a separate result; neither proves ongoing demand by itself.
