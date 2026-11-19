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
export const COINBASE_TOKENIZED_STOCKS_BASE: ReadonlyMap<string, string> = new Map([
  ['0xb20000000000000000000078ee7ce2fe4908108c', 'NVDAc'],
  ['0xb200000000000000000000c2e324d24d7eecd1fb', 'AAPLc'],
  ['0xb2000000000000000000002d0ba3164cc74f58b7', 'GOOGLc'],
  ['0xb2000000000000000000008bc8786b856e61707c', 'METAc'],
]);

export function isCoinbaseTokenizedStock(asset: { chain: string; address: string }): boolean {
  return asset.chain === 'base' && COINBASE_TOKENIZED_STOCKS_BASE.has(asset.address.toLowerCase());
}

/** The pinned Coinbase stock symbols whose address appears in `calldata` (e.g. a Composer transaction), in order. */
export function coinbaseStocksInCalldata(calldata: string): string[] {
  const data = calldata.toLowerCase();
  return [...COINBASE_TOKENIZED_STOCKS_BASE.entries()].filter(([address]) => data.includes(address.slice(2))).map(([, symbol]) => symbol);
}
