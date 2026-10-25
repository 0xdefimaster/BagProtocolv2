# Gölge ölçüm (v2)

Blok modu: **NON_ARCHIVE_PER_UNIT** — non-archive RPC: one fresh fork per leg and per basket. Sources and amounts for one leg share a block; different legs and the basket do NOT. Cross-leg sums are not same-block evidence.

Fork blokları: leg GME 97254498, leg ASML 97255084, leg COIN 97255319, leg AAPL 97255591, basket 5 USDG 97256110, basket 100 USDG 97256304 · BAG 955df6e0-b6ea-44ba-a5eb-1288a80c0a06 · kaynaklar: uniswap-v3, uniswap-v4, composer · public işlem 0 · çıkış COMPLETE (0)

Kanıt aşamaları: RECEIPT_VERIFIED = fork makbuzu + bakiye farkları + Transfer logları + transit/onay sıfır. Fiyat kapısı: **kanıtlanmadı → hiçbir rota kullanıcı için çalıştırılabilir değil (PRICE_POLICY_UNPROVEN)**.

## 5 USDG

| Bacak | Aday (kaynak · rota) | Durum / kanıt | Çıktı | En iyiye göre | Etki (bps) | Uygunluk | Kapı |
|---|---|---|---|---|---|---|---|
| GME | uniswap-v3 fee 100 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| GME | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 0.0538909 | 0 | 0 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 0.0538604 | -5 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 0.0535633 | -60 | 0 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x3d436b4f fee 10000 | OK / RECEIPT_VERIFIED | 0.0536647 | -41 | 2 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x659e64f0 fee 2120 | OK / RECEIPT_VERIFIED | 0.0536017 | -53 | 6 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x3f05d2b2 fee 3000 | PARTIAL_FILL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 100 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 500 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 0.000827160 | 0 | 2 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 0.000820981 | -74 | 0 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0x95dfd346 fee 7000 | OK / RECEIPT_VERIFIED | 0.000820309 | -82 | 3 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0x5b8d4320 fee 4000 | OK / RECEIPT_VERIFIED | 0.000823545 | -43 | 3 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0xf15156b8 fee 31000 | OK / RECEIPT_VERIFIED | 0.000730117 | -1173 | 6 | ELIGIBLE | FAIL |
| COIN | uniswap-v3 fee 100 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 0.0113027 | 0 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v3 fee 3000 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v3 fee 10000 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v4 v4 0x007a13fa fee 10000 | OK / RECEIPT_VERIFIED | 0.0112625 | -35 | 0 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v4 v4 0xe2e1a0e3 fee 2500 | OK / RECEIPT_VERIFIED | 0.0112964 | -5 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v4 v4 0x8138ea28 fee 8388608 hook 0x5Eb87F | OK / RECEIPT_VERIFIED | 0.0112962 | -5 | 0 | HOOK_NOT_ALLOWLISTED | FAIL |
| AAPL | uniswap-v3 fee 100 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| AAPL | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 0.00144050 | -2 | 0 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 0.00143760 | -22 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 0.00142274 | -126 | 2 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v4 v4 0xc748f467 fee 3000 | OK / RECEIPT_VERIFIED | 0.00143596 | -34 | -1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v4 v4 0xa2347ba6 fee 8388608 hook 0x70a9A8 | OK / RECEIPT_VERIFIED | 0.00144090 | 0 | 0 | HOOK_NOT_ALLOWLISTED | FAIL |
| AAPL | uniswap-v4 v4 0xab946acc fee 375 hook 0xc52fc5 | PARTIAL_FILL / NONE |  |  |  | HOOK_NOT_ALLOWLISTED |  |

Router seçimleri: GME: uniswap-v3 fee 500 (PRICE_POLICY_UNPROVEN) · ASML: uniswap-v3 fee 3000 (PRICE_POLICY_UNPROVEN) · COIN: uniswap-v3 fee 500 (PRICE_POLICY_UNPROVEN) · AAPL: uniswap-v3 fee 500 (PRICE_POLICY_UNPROVEN)

Composer (sepet): NOT_RUN — LIFI_API_KEY not in --env-file

Sepet, mevcut BagExecutionRouter ile: **EXECUTED / RECEIPT_VERIFIED**
tx 0xe54dc584b0f423a4eceff712ee53942c65911aa233facab6da1fe2d596b24669 · gas 803708

- GME (uniswap-v3): tek başına 0.0539014 → sepette 0.0539014 (0 bps)
- ASML (uniswap-v3): tek başına 0.000827160 → sepette 0.000827160 (0 bps)
- COIN (uniswap-v3): tek başına 0.0113027 → sepette 0.0113027 (0 bps)
- AAPL (uniswap-v3): tek başına 0.00144050 → sepette 0.00144050 (0 bps)

Sepet kapısı: **PRICE_POLICY_UNPROVEN** (NO_REFERENCE_PRICE, POLICY_NOT_PROVEN) · kullanıcı için çalıştırılabilir: hayır

## 100 USDG

| Bacak | Aday (kaynak · rota) | Durum / kanıt | Çıktı | En iyiye göre | Etki (bps) | Uygunluk | Kapı |
|---|---|---|---|---|---|---|---|
| GME | uniswap-v3 fee 100 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| GME | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 1.07779 | 0 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 1.07555 | -20 | 17 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 1.07126 | -60 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x3d436b4f fee 10000 | OK / RECEIPT_VERIFIED | 1.07071 | -65 | 26 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x659e64f0 fee 2120 | OK / RECEIPT_VERIFIED | 1.06002 | -164 | 117 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| GME | uniswap-v4 v4 0x3f05d2b2 fee 3000 | PARTIAL_FILL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 100 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 500 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| ASML | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 0.0164754 | 0 | 43 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 0.0164167 | -35 | 2 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0x95dfd346 fee 7000 | OK / RECEIPT_VERIFIED | 0.0163210 | -93 | 55 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0x5b8d4320 fee 4000 | OK / RECEIPT_VERIFIED | 0.0163738 | -61 | 62 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| ASML | uniswap-v4 v4 0xf15156b8 fee 31000 | OK / RECEIPT_VERIFIED | 0.0144561 | -1225 | 105 | ELIGIBLE | FAIL |
| COIN | uniswap-v3 fee 100 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 0.225711 | -8 | 16 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v3 fee 3000 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v3 fee 10000 | NO_LIQUIDITY / NONE |  |  |  | ELIGIBLE |  |
| COIN | uniswap-v4 v4 0x007a13fa fee 10000 | OK / RECEIPT_VERIFIED | 0.225248 | -29 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v4 v4 0xe2e1a0e3 fee 2500 | OK / RECEIPT_VERIFIED | 0.225909 | 0 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| COIN | uniswap-v4 v4 0x8138ea28 fee 8388608 hook 0x5Eb87F | OK / RECEIPT_VERIFIED | 0.225876 | -1 | 3 | HOOK_NOT_ALLOWLISTED | FAIL |
| AAPL | uniswap-v3 fee 100 | NO_POOL / NONE |  |  |  | ELIGIBLE |  |
| AAPL | uniswap-v3 fee 500 | OK / RECEIPT_VERIFIED | 0.0288099 | -2 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v3 fee 3000 | OK / RECEIPT_VERIFIED | 0.0287515 | -23 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v3 fee 10000 | OK / RECEIPT_VERIFIED | 0.0283588 | -159 | 35 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v4 v4 0xc748f467 fee 3000 | OK / RECEIPT_VERIFIED | 0.0287193 | -34 | 1 | ELIGIBLE | PRICE_POLICY_UNPROVEN |
| AAPL | uniswap-v4 v4 0xa2347ba6 fee 8388608 hook 0x70a9A8 | OK / RECEIPT_VERIFIED | 0.0288179 | 0 | 1 | HOOK_NOT_ALLOWLISTED | FAIL |
| AAPL | uniswap-v4 v4 0xab946acc fee 375 hook 0xc52fc5 | PARTIAL_FILL / NONE |  |  |  | HOOK_NOT_ALLOWLISTED |  |

Router seçimleri: GME: uniswap-v3 fee 500 (PRICE_POLICY_UNPROVEN) · ASML: uniswap-v3 fee 3000 (PRICE_POLICY_UNPROVEN) · COIN: uniswap-v4 v4 (PRICE_POLICY_UNPROVEN) · AAPL: uniswap-v3 fee 500 (PRICE_POLICY_UNPROVEN)

Composer (sepet): NOT_RUN — LIFI_API_KEY not in --env-file

Sepet, mevcut BagExecutionRouter ile: **EXECUTED / RECEIPT_VERIFIED**
tx 0x263de62771067dd83466e3491791fb705bd50ff206a1c0efe68aa2459f089082 · gas 852409

- GME (uniswap-v3): tek başına 1.07800 → sepette 1.07800 (0 bps)
- ASML (uniswap-v3): tek başına 0.0164754 → sepette 0.0164754 (0 bps)
- COIN (uniswap-v4): tek başına 0.225510 → sepette 0.225510 (0 bps)
- AAPL (uniswap-v3): tek başına 0.0288099 → sepette 0.0288099 (0 bps)

Sepet kapısı: **PRICE_POLICY_UNPROVEN** (NO_REFERENCE_PRICE, POLICY_NOT_PROVEN) · kullanıcı için çalıştırılabilir: hayır

## Composer'sız DCA hazırlığı: **BLOCKED**

- ✅ EXECUTION_EVIDENCE: 5 USDG basket: EXECUTED/RECEIPT_VERIFIED; 100 USDG basket: EXECUTED/RECEIPT_VERIFIED
- ⛔ PRICE_POLICY: 5 USDG: PRICE_POLICY_UNPROVEN (NO_REFERENCE_PRICE, POLICY_NOT_PROVEN); 100 USDG: PRICE_POLICY_UNPROVEN (NO_REFERENCE_PRICE, POLICY_NOT_PROVEN)
- ⛔ SAME_BLOCK_EVIDENCE: NON_ARCHIVE_PER_UNIT
- ⛔ PLAN_SIGNER_TRUST: BagExecutionRouter executes whatever calldata/minimums the backend planSigner signs. A user-permissioned DCA needs target, token, selector, recipient, spend and value rules enforced on chain from the user permission; removing the signature without that would let anyone choose calldata.
- ⛔ ROUTER_PLAN_CONTRACT: DcaComposerPlan pins a Composer program template. A router-based plan variant with the same per-period budget, total budget, recipient binding, atomic delivery and SDK receipt evidence is not written.
- ⛔ BAG_REGISTRY: The shadow run used ShadowBagFactory (a mock that reports every bagId as registered); a real BAG registry check is not exercised.
- ⛔ V4_ADAPTER: ShadowV4Adapter is a research helper with adversarial unit tests, not a reviewed production adapter.
