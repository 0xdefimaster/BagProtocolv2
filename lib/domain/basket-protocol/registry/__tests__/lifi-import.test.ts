import { describe, expect, it, vi } from 'vitest';
import { CanonicalAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// "Which coins/stocks exist on which network" — pulled from LI.FI's own
// getTokens(), scoped to the curated LOCAL_COIN_CANDIDATES list, never a
// blind bulk import of everything LI.FI happens to know about a chain.
// -----------------------------------------------------------------------------

const getTokensMock = vi.fn();
vi.mock('@lifi/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lifi/sdk')>();
  return {
    ...actual,
    getTokens: (...args: unknown[]) => getTokensMock(...args),
  };
});

const { fetchLiFiTokenCandidatesForChain, fetchLiFiStockCandidatesForChain, planLiFiImportForChain, applyLiFiImportPlan } = await import(
  '../lifi-import'
);

function makeCanonicalAsset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'asset_1',
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111a',
    symbol: 'ETH',
    decimals: 18,
    name: 'Ethereum',
    status: 'VERIFIED',
    assetType: 'crypto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('fetchLiFiTokenCandidatesForChain', () => {
  it('keeps only tokens matching a curated candidate symbol — never LI.FI\'s whole per-chain list', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        1: [
          { address: '0xeth', symbol: 'ETH', name: 'Ethereum', decimals: 18, tags: ['MAJOR_ASSET'] },
          { address: '0xrandom', symbol: 'RANDOMSHITCOIN', name: 'Random', decimals: 9, tags: [] },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [{ symbol: 'ETH', name: 'Ethereum' }]);

    expect(result.fetchError).toBeUndefined();
    expect(result.candidates).toEqual([
      { chain: 'ethereum', address: '0xeth', symbol: 'ETH', decimals: 18, name: 'Ethereum', assetType: 'crypto' },
    ]);
  });

  it('classifies a token tagged "rwa" as a stock (LI.FI\'s own tokenized-equity signal)', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        1: [{ address: '0xnvda', symbol: 'XNVDA', name: 'NVIDIA (tokenized)', decimals: 18, tags: ['rwa'] }],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [{ symbol: 'XNVDA', name: 'NVIDIA' }]);

    expect(result.candidates).toEqual([
      { chain: 'ethereum', address: '0xnvda', symbol: 'XNVDA', decimals: 18, name: 'NVIDIA (tokenized)', assetType: 'stock' },
    ]);
  });

  it('a symbol with no LI.FI deployment on this chain is simply absent from candidates (never fabricated)', async () => {
    getTokensMock.mockResolvedValue({ tokens: { 1: [] } });

    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [{ symbol: 'BTC', name: 'Bitcoin' }]);

    expect(result.candidates).toEqual([]);
    expect(result.fetchError).toBeUndefined();
  });

  it('never throws on a LI.FI API failure — resolves to an empty candidate list plus fetchError', async () => {
    getTokensMock.mockRejectedValue(new Error('LI.FI is down'));

    const result = await fetchLiFiTokenCandidatesForChain('base', [{ symbol: 'ETH', name: 'Ethereum' }]);

    expect(result.candidates).toEqual([]);
    expect(result.fetchError).toBe('LI.FI is down');
  });

  it('never accepts a symbol match alone — impostor names, the native token and bridged stand-ins are skipped', async () => {
    // Shapes taken from a real ethereum/base run of the old symbol-only importer.
    getTokensMock.mockResolvedValue({
      tokens: {
        1: [
          { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'ETH', decimals: 18 },
          { address: '0xfcaf', symbol: 'SHIB', name: 'NicCageWaluigiElmo42069Inu', decimals: 18 },
          { address: '0xbe04', symbol: 'PEPE', name: 'Pepe Community', decimals: 18 },
          { address: '0xd31a', symbol: 'SOL', name: 'Wrapped SOL (Wormhole)', decimals: 9 },
          { address: '0x2e9a', symbol: 'MKR', name: '4d616b6572000000000000000000000000000000000000000000000000000000', decimals: 18 },
          { address: '0x1f98', symbol: 'UNI', name: 'Uniswap', decimals: 18 },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [
      { symbol: 'ETH', name: 'Ethereum' },
      { symbol: 'SHIB', name: 'Shiba Inu' },
      { symbol: 'PEPE', name: 'Pepe' },
      { symbol: 'SOL', name: 'Solana' },
      { symbol: 'MKR', name: 'Maker' },
      { symbol: 'UNI', name: 'Uniswap' },
    ]);

    expect(result.candidates.map((c) => c.symbol)).toEqual(['UNI']);
    expect(result.skipped.map((s) => [s.symbol, s.reason])).toEqual([
      ['ETH', 'NATIVE_TOKEN'],
      ['SHIB', 'NAME_MISMATCH'],
      ['PEPE', 'NAME_MISMATCH'],
      ['SOL', 'NAME_MISMATCH'],
      ['MKR', 'NAME_MISMATCH'],
    ]);
  });

  it('accepts known alternate names for the same coin ("Curve DAO Token", "Matic Token", "StargateToken")', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        42161: [
          { address: '0x11cd', symbol: 'CRV', name: 'Curve DAO Token', decimals: 18 },
          { address: '0x5618', symbol: 'MATIC', name: 'Matic Token', decimals: 18 },
          { address: '0xaf51', symbol: 'STG', name: 'StargateToken', decimals: 18 },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('arbitrum', [
      { symbol: 'CRV', name: 'Curve' },
      { symbol: 'MATIC', name: 'Polygon' },
      { symbol: 'STG', name: 'Stargate' },
    ]);

    expect(result.candidates.map((c) => c.symbol)).toEqual(['CRV', 'MATIC', 'STG']);
    expect(result.skipped).toEqual([]);
  });

  it('registers neither token when two plausible contracts share a symbol — never guesses', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        42161: [
          { address: '0x6694', symbol: 'STG', name: 'StargateToken', decimals: 18 },
          { address: '0xe018', symbol: 'STG', name: 'StargateToken', decimals: 18 },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('arbitrum', [{ symbol: 'STG', name: 'Stargate' }]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped.map((s) => [s.address, s.reason])).toEqual([
      ['0x6694', 'AMBIGUOUS_SYMBOL'],
      ['0xe018', 'AMBIGUOUS_SYMBOL'],
    ]);
  });

  it('a LI.FI-flagged token or a reported tiny market cap is skipped, and resolves an otherwise ambiguous symbol', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        42161: [
          { address: '0xreal', symbol: 'PEPE', name: 'Pepe', decimals: 18, verificationStatus: 'verified', marketCapUSD: 3_000_000_000 },
          { address: '0xfake', symbol: 'PEPE', name: 'Pepe', decimals: 18, verificationStatus: 'flagged' },
          { address: '0xtiny', symbol: 'PEPE', name: 'Pepe', decimals: 18, marketCapUSD: 12_000 },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('arbitrum', [{ symbol: 'PEPE', name: 'Pepe' }]);

    expect(result.candidates.map((c) => c.address)).toEqual(['0xreal']);
    expect(result.skipped.map((s) => [s.address, s.reason])).toEqual([
      ['0xfake', 'FLAGGED_BY_LIFI'],
      ['0xtiny', 'LOW_MARKET_CAP'],
    ]);
  });

  it('carries LI.FI\'s logoURI through as the candidate logoUrl (https only)', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        1: [
          { address: '0x1f98', symbol: 'UNI', name: 'Uniswap', decimals: 18, logoURI: 'https://static.example/uni.png' },
          { address: '0x7fc6', symbol: 'AAVE', name: 'Aave', decimals: 18, logoURI: 'http://static.example/aave.png' },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [
      { symbol: 'UNI', name: 'Uniswap' },
      { symbol: 'AAVE', name: 'Aave' },
    ]);

    expect(result.candidates.map((c) => [c.symbol, c.logoUrl])).toEqual([
      ['UNI', 'https://static.example/uni.png'],
      ['AAVE', undefined],
    ]);
  });

  it('on robinhood, imports crypto (WETH, USDG) but never a Stock Token LI.FI tags rwa', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        4663: [
          { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'ETH', decimals: 18 },
          { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
          { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'USDG', decimals: 6, tags: ['stablecoin'] },
          { address: '0xnvda', symbol: 'NVDA', name: 'NVIDIA', decimals: 18, tags: ['rwa'] },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('robinhood', [
      { symbol: 'ETH', name: 'Ethereum' },
      { symbol: 'WETH', name: 'Wrapped Ether' },
      { symbol: 'USDG', name: 'Global Dollar' },
      { symbol: 'NVDA', name: 'NVIDIA' },
    ]);

    expect(result.candidates.map((c) => [c.chain, c.symbol, c.assetType])).toEqual([
      ['robinhood', 'WETH', 'crypto'],
      ['robinhood', 'USDG', 'crypto'],
    ]);
    expect(result.skipped.map((s) => [s.symbol, s.reason])).toEqual([
      ['ETH', 'NATIVE_TOKEN'],
      ['NVDA', 'STOCK_TOKEN'],
    ]);
  });

  it('on robinhood, registers the config-pinned USDG/WETH even though LI.FI marks them unverified, and rejects look-alikes', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        4663: [
          { address: '0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F', symbol: 'USDG', name: 'Paxos USDG', decimals: 6, verificationStatus: 'unverified' },
          { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'USDG', decimals: 6, verificationStatus: 'unverified' },
          { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, verificationStatus: 'unverified' },
          { address: '0x492641F648a4986844848E0beFE66D14817bCE34', symbol: 'LINK', name: 'ChainLink Token', decimals: 18, verificationStatus: 'unverified' },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('robinhood', [
      { symbol: 'USDG', name: 'Global Dollar' },
      { symbol: 'WETH', name: 'Wrapped Ether' },
      { symbol: 'LINK', name: 'Chainlink' },
    ]);

    expect(result.candidates.map((c) => [c.symbol, c.address, c.decimals])).toEqual([
      ['USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6],
      ['WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18],
    ]);
    expect(result.skipped.map((s) => [s.symbol, s.reason])).toEqual([
      ['USDG', 'NOT_PINNED_ADDRESS'],
      ['LINK', 'UNVERIFIED_BY_LIFI'],
    ]);
  });

  it('on robinhood, registers the owner-approved community tokens (CASHCAT, PONS) from LI.FI\'s own list, with their logos', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        4663: [
          { address: '0x00000000000000000000000000000000000CA7ca', symbol: 'CASHCAT', name: 'Cash Cat', decimals: 18, verificationStatus: 'unverified', logoURI: 'https://static.example/cashcat.png' },
          { address: '0x0000000000000000000000000000000000009045', symbol: 'PONS', name: 'Pons', decimals: 18, verificationStatus: 'unverified' },
          { address: '0x000000000000000000000000000000000000beef', symbol: 'RANDOM', name: 'Random', decimals: 18, verificationStatus: 'unverified' },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('robinhood', []);

    expect(result.candidates.map((c) => [c.symbol, c.address, c.assetType, c.logoUrl])).toEqual([
      ['CASHCAT', '0x00000000000000000000000000000000000CA7ca', 'crypto', 'https://static.example/cashcat.png'],
      ['PONS', '0x0000000000000000000000000000000000009045', 'crypto', undefined],
    ]);
  });

  it('never registers a community token when LI.FI lists two contracts with its symbol (possible impostor), or flags it', async () => {
    getTokensMock.mockResolvedValue({
      tokens: {
        4663: [
          { address: '0x00000000000000000000000000000000000CA7ca', symbol: 'CASHCAT', name: 'Cash Cat', decimals: 18, verificationStatus: 'unverified' },
          { address: '0x00000000000000000000000000000000000CA7cb', symbol: 'CASHCAT', name: 'Cash Cat', decimals: 18, verificationStatus: 'unverified' },
          { address: '0x0000000000000000000000000000000000009045', symbol: 'PONS', name: 'Pons', decimals: 18, verificationStatus: 'flagged' },
        ],
      },
    });

    const result = await fetchLiFiTokenCandidatesForChain('robinhood', []);

    expect(result.candidates).toEqual([]);
    expect(result.skipped.map((s) => [s.symbol, s.reason])).toEqual([
      ['PONS', 'FLAGGED_BY_LIFI'],
      ['CASHCAT', 'AMBIGUOUS_SYMBOL'],
      ['CASHCAT', 'AMBIGUOUS_SYMBOL'],
    ]);
  });

  it('community tokens are chain-scoped — CASHCAT on another chain is not listed', async () => {
    getTokensMock.mockResolvedValue({
      tokens: { 1: [{ address: '0x00000000000000000000000000000000000CA7ca', symbol: 'CASHCAT', name: 'Cash Cat', decimals: 18, verificationStatus: 'verified' }] },
    });
    const result = await fetchLiFiTokenCandidatesForChain('ethereum', [{ symbol: 'USDC', name: 'USD Coin' }]);
    expect(result.candidates).toEqual([]);
  });

  it('an empty candidate list never calls LI.FI at all', async () => {
    getTokensMock.mockClear();
    const result = await fetchLiFiTokenCandidatesForChain('ethereum', []);
    expect(result.candidates).toEqual([]);
    expect(getTokensMock).not.toHaveBeenCalled();
  });
});

describe('planLiFiImportForChain', () => {
  it('a candidate not yet in the registry goes to toRegister', () => {
    const plan = planLiFiImportForChain(
      [{ chain: 'ethereum', address: '0xnew', symbol: 'NEW', decimals: 18, name: 'New Token', assetType: 'crypto' }],
      []
    );
    expect(plan.toRegister).toHaveLength(1);
    expect(plan.alreadyRegistered).toEqual([]);
  });

  it('a candidate already registered at the same (chain, address) goes to alreadyRegistered, not toRegister', () => {
    const existing = makeCanonicalAsset({ chain: 'ethereum', address: '0xeth' });
    const plan = planLiFiImportForChain(
      [{ chain: 'ethereum', address: '0xeth', symbol: 'ETH', decimals: 18, name: 'Ethereum', assetType: 'crypto' }],
      [existing]
    );
    expect(plan.toRegister).toEqual([]);
    expect(plan.alreadyRegistered).toEqual([existing]);
    expect(plan.staleVerified).toEqual([]);
  });

  it('a VERIFIED curated-symbol row that is no longer a candidate is reported as staleVerified', () => {
    const impostor = makeCanonicalAsset({ id: 'shib_fake', address: '0xfcaf', symbol: 'SHIB', name: 'NicCageWaluigiElmo42069Inu' });
    const unrelated = makeCanonicalAsset({ id: 'other', address: '0xother', symbol: 'OTHER' });
    const alreadyDeprecated = makeCanonicalAsset({ id: 'dep', address: '0xdep', symbol: 'PEPE', status: 'DEPRECATED' });

    const plan = planLiFiImportForChain([], [impostor, unrelated, alreadyDeprecated], ['SHIB', 'PEPE']);

    expect(plan.staleVerified).toEqual([impostor]);
  });

  it('a DEPRECATED row that is an accepted candidate again is planned for re-verification', () => {
    const deprecated = makeCanonicalAsset({ id: 'fet', address: '0xfet', symbol: 'FET', status: 'DEPRECATED' });
    const plan = planLiFiImportForChain(
      [{ chain: 'ethereum', address: '0xfet', symbol: 'FET', decimals: 18, name: 'Artificial Superintelligence Alliance', assetType: 'crypto' }],
      [deprecated]
    );
    expect(plan.toRegister).toEqual([]);
    expect(plan.toReverify).toEqual([deprecated]);
  });

  it('an already-registered candidate without a stored logo gets a logoUpdate', () => {
    const existing = makeCanonicalAsset({ chain: 'ethereum', address: '0xuni', symbol: 'UNI' });
    const plan = planLiFiImportForChain(
      [{ chain: 'ethereum', address: '0xuni', symbol: 'UNI', decimals: 18, name: 'Uniswap', assetType: 'crypto', logoUrl: 'https://l/uni.png' }],
      [existing]
    );
    expect(plan.logoUpdates).toEqual([{ asset: existing, logoUrl: 'https://l/uni.png' }]);
  });
});

describe('applyLiFiImportPlan', () => {
  it('registers every toRegister candidate, reporting failures without aborting the rest', async () => {
    const registerAssetFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, asset: makeCanonicalAsset({ symbol: 'A' }) })
      .mockResolvedValueOnce({ ok: false, error: 'DB_ERROR', message: 'boom' });

    const plan = {
      toRegister: [
        { chain: 'ethereum' as const, address: '0xa', symbol: 'A', decimals: 18, name: 'A', assetType: 'crypto' as const },
        { chain: 'ethereum' as const, address: '0xb', symbol: 'B', decimals: 18, name: 'B', assetType: 'crypto' as const },
      ],
      alreadyRegistered: [],
      staleVerified: [],
      toReverify: [],
      logoUpdates: [],
    };

    const result = await applyLiFiImportPlan(registerAssetFn, plan);

    expect(result.registered).toHaveLength(1);
    expect(result.failed).toEqual([{ input: plan.toRegister[1], error: 'boom' }]);
  });
});

describe('fetchLiFiStockCandidatesForChain (tokenized stocks on ethereum / base / arbitrum)', () => {
  const stock = (o: Record<string, unknown>) => ({ decimals: 18, tags: ['rwa'], verificationStatus: 'verified', ...o });
  const tokens = () => ({
    tokens: {
      8453: [
        stock({ address: '0xaaa', symbol: 'TSLAx', name: 'Tesla xStock', marketCapUSD: 1234567.8, priceUSD: '412.5' }),
        stock({ address: '0xbbb', symbol: 'NVDAx', name: 'NVIDIA xStock' }),
        stock({ address: '0xccc', symbol: 'FAKE', name: 'Unverified stock', verificationStatus: 'unverified' }),
        stock({ address: '0xddd', symbol: 'BAD', name: 'Flagged stock', verificationStatus: 'flagged' }),
        stock({ address: '0xe01', symbol: 'DUP', name: 'One' }),
        stock({ address: '0xe02', symbol: 'DUP', name: 'Two' }),
        { address: '0xfff', symbol: 'USDC', name: 'USDC', decimals: 6, tags: ['stablecoin'], verificationStatus: 'verified' },
        stock({ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether' }),
      ],
    },
  });

  it('lists only LI.FI-verified rwa tokens, from LI.FI’s own fields, as stocks; crypto is never touched', async () => {
    getTokensMock.mockResolvedValue(tokens());
    const r = await fetchLiFiStockCandidatesForChain('base');
    expect(r.fetchError).toBeUndefined();
    expect(r.candidates.map((c) => [c.symbol, c.address, c.assetType, c.chain])).toEqual([
      ['NVDAx', '0xbbb', 'stock', 'base'],
      ['TSLAx', '0xaaa', 'stock', 'base'],
    ]);
    expect(r.candidates.find((c) => c.symbol === 'TSLAx')).toMatchObject({ marketCapUSD: 1234567.8, priceUSD: '412.5', decimals: 18, name: 'Tesla xStock', signal: 'rwa' });
    expect(Object.fromEntries(r.skipped.map((s) => [s.address, s.reason]))).toEqual({
      '0xccc': 'UNVERIFIED_BY_LIFI',
      '0xddd': 'FLAGGED_BY_LIFI',
      '0xe01': 'AMBIGUOUS_SYMBOL',
      '0xe02': 'AMBIGUOUS_SYMBOL',
      '0x0000000000000000000000000000000000000000': 'NATIVE_TOKEN',
    });
  });

  it('recognises Backed / xStocks / Ondo tokens LI.FI does not tag rwa, only when both name and symbol follow the issuer scheme', async () => {
    const plain = (o: Record<string, unknown>) => ({ decimals: 18, tags: [], verificationStatus: 'verified', ...o });
    getTokensMock.mockResolvedValue({
      tokens: {
        42161: [
          plain({ address: '0xb01', symbol: 'bNVDA', name: 'Backed NVIDIA Corp' }),
          plain({ address: '0xb02', symbol: 'NVDAon', name: 'NVIDIA (Ondo Tokenized)' }),
          plain({ address: '0xb03', symbol: 'AAPLx', name: 'Apple xStock' }),
          plain({ address: '0xb04', symbol: 'BNVDA', name: 'Backed NVIDIA Corp' }), // symbol off-scheme
          plain({ address: '0xb05', symbol: 'bFAKE', name: 'NVIDIA Backed by nothing' }), // name off-scheme
          plain({ address: '0xb06', symbol: 'bTSLA', name: 'Backed Tesla Inc', verificationStatus: 'unverified' }),
          plain({ address: '0xb07', symbol: 'NVITREK', name: 'NVITREK' }),
        ],
      },
    });
    const r = await fetchLiFiStockCandidatesForChain('arbitrum');
    expect(r.candidates.map((c) => [c.symbol, c.address, c.signal, c.assetType])).toEqual([
      ['AAPLx', '0xb03', 'xstock', 'stock'],
      ['bNVDA', '0xb01', 'backed', 'stock'],
      ['NVDAon', '0xb02', 'ondo', 'stock'],
    ]);
    expect(r.skipped).toEqual([{ symbol: 'bTSLA', address: '0xb06', name: 'Backed Tesla Inc', reason: 'UNVERIFIED_BY_LIFI' }]);
  });

  it('--only keeps just the requested symbols (case-insensitive); the rest are NOT_REQUESTED', async () => {
    getTokensMock.mockResolvedValue(tokens());
    const r = await fetchLiFiStockCandidatesForChain('base', { only: ['tslax'] });
    expect(r.candidates.map((c) => c.symbol)).toEqual(['TSLAx']);
    expect(r.skipped.find((s) => s.symbol === 'NVDAx')?.reason).toBe('NOT_REQUESTED');
  });

  it('a fetch failure is reported, never thrown; stock mode never marks an existing row stale', async () => {
    getTokensMock.mockRejectedValue(new Error('rate limited'));
    expect(await fetchLiFiStockCandidatesForChain('ethereum')).toEqual({ candidates: [], skipped: [], fetchError: 'rate limited' });
    const plan = planLiFiImportForChain([], [makeCanonicalAsset({ symbol: 'WETH', status: 'VERIFIED', assetType: 'crypto' })], []);
    expect(plan.staleVerified).toEqual([]);
  });
});
