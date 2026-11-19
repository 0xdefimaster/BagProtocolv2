// -----------------------------------------------------------------------------
// Coinbase Tokenized Stocks on Base (B20 precompile tokens issued by Coinbase).
//
// LI.FI names them plainly ("NVIDIA Corporation"), so no naming scheme marks
// the issuer: the contract address is the only signal, pinned here. Source:
// Base's Tokenized Stocks list (docs.base.org/sdks/tokenized-stocks); re-check
// against GET https://api.coinbase.com/v1/tokenized-stocks before adding one.
// Derivatives wrapping these tokens (aBNVDAc, PT-/YT-NVDAc, ...) are different
// contracts and never match.
//
// B20 specifics that matter to BAG (docs.base.org/specifications/b20/tokenized-stocks-on-base):
//  - the issuer can pause specific functions (a paused transfer reverts);
//  - transfer policies (allow/block lists) can block a sender or receiver,
//    and `approve()` is not policy-gated, so an allowance does not mean the
//    tokens can move;
//  - the Chainlink reference feed runs 24/5, holds the last value off-hours
//    and freezes during corporate actions; DEX prices keep moving.
// Shared by the server (registry import) and the browser (notices, errors).
// -----------------------------------------------------------------------------

/** Lower-case address → the symbol LI.FI must report for it. */
// Pinned 2026-11-19 from the official list, each with a LI.FI buy and sell route under 2% round trip at $1,000
// (scripts/check-lifi-routes.mjs --coinbase). Thinner names (NIOc, SONYc, CRWVc, ...) and names without a route
// (RIVNc, GMEc, AMCc, DJTc, ...) are left out on purpose; HOODc routes but LI.FI does not mark it verified yet.
export const COINBASE_TOKENIZED_STOCKS_BASE: ReadonlyMap<string, string> = new Map([
  ['0xb20000000000000000000078ee7ce2fe4908108c', 'NVDAc'], // NVIDIA Corporation
  ['0xb200000000000000000000c2e324d24d7eecd1fb', 'AAPLc'], // Apple Inc.
  ['0xb2000000000000000000002d0ba3164cc74f58b7', 'GOOGLc'], // Alphabet Inc.
  ['0xb2000000000000000000008bc8786b856e61707c', 'METAc'], // Meta Platforms Inc.
  ['0xb200000000000000000000d9192b6b456483c2e8', 'AMZNc'], // Amazon.com Inc.
  ['0xb200000000000000000000ab99cfa739e253872b', 'MSFTc'], // Microsoft Corporation
  ['0xb2000000000000000000001e800a7f5189430cd0', 'TSLAc'], // Tesla Inc.
  ['0xb200000000000000000000fc737aea6196ab5a4c', 'AVGOc'], // Broadcom Inc.
  ['0xb2000000000000000000000d8ce462e99ee7a47b', 'AMDc'], // Advanced Micro Devices, Inc.
  ['0xb200000000000000000000fd2f87532b90095211', 'MUc'], // Micron Technology Inc.
  ['0xb200000000000000000000347afba223d7b6b63c', 'ORCLc'], // Oracle Corporation
  ['0xb20000000000000000000058b8c947e44011dfe6', 'NFLXc'], // Netflix Inc
  ['0xb2000000000000000000007d16372840df4dabbe', 'PLTRc'], // Palantir Technologies Inc.
  ['0xb2000000000000000000004884b426556b92883d', 'MSTRc'], // Strategy Inc.
  ['0xb2000000000000000000007b9fcbd005511acbd5', 'SPCXc'], // Space Exploration Technologies Corp.
  ['0xb20000000000000000000019f6e7c675b73c2e4d', 'CRCLc'], // Circle Internet Group Inc.
  ['0xb20000000000000000000043a599976181bcf336', 'HIMSc'], // Hims & Hers Health, Inc.
  ['0xb200000000000000000000397293cb8cda9a10c5', 'SNDKc'], // Sandisk Corporation
  ['0xb200000000000000000000f720c26062bc3067da', 'TTWOc'], // Take-Two Interactive Software, Inc.
  ['0xb2000000000000000000004aff16039ba04bdfbc', 'INTCc'], // Intel Corporation
  ['0xb200000000000000000000187f7071d6e321a7d2', 'SKHYc'], // SK hynix Inc.
  ['0xb20000000000000000000016f9dfe862feba122b', 'BEc'], // Bloom Energy Corporation
]);

export function isCoinbaseTokenizedStock(asset: { chain: string; address: string }): boolean {
  return asset.chain === 'base' && COINBASE_TOKENIZED_STOCKS_BASE.has(asset.address.toLowerCase());
}

/** The pinned Coinbase stock symbols whose address appears in `calldata` (e.g. a Composer transaction), in order. */
export function coinbaseStocksInCalldata(calldata: string): string[] {
  const data = calldata.toLowerCase();
  return [...COINBASE_TOKENIZED_STOCKS_BASE.entries()].filter(([address]) => data.includes(address.slice(2))).map(([, symbol]) => symbol);
}
