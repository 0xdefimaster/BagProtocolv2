import { isBagChain } from './chains';
import { JsonSyntaxError, parseJsonStrict } from './json';
import {
  BAG_JSON_FORMAT_VERSION,
  MUTABILITIES,
  NO_ROUTE_ASSET_POLICIES,
  REBALANCE_FREQUENCIES,
  STRATEGY_KINDS,
  type BagDefinition,
  type BagDocument,
  type BagIssue,
} from './types';

// -----------------------------------------------------------------------------
// parseBag: bytes (or an already-parsed value) → a typed bag.json v1 document,
// or the complete list of reasons it is not one. Shape and types only; rules
// that relate values to each other (weights sum, bounds, duplicates, decimals
// against the token) are validateBag's.
//
// Strict by design (D5): an unknown key, a missing key, a wrong type, a
// fraction or exponent where an integer is required, a duplicate JSON key, a
// non-canonical decimal string or a chain outside the v1 enum all reject.
// Nothing is coerced and no default is filled in.
// -----------------------------------------------------------------------------

export type ParseResult = { ok: true; bag: BagDocument; issues: [] } | { ok: false; bag: null; issues: BagIssue[] };

const DOCUMENT_KEYS = ['bagJson', 'definition', 'metadata', 'definitionHash', 'ref', 'network', 'commitments', 'forkedFrom'] as const;
const REQUIRED_DOCUMENT_KEYS = ['bagJson', 'definition'];
const DEFINITION_KEYS = ['kind', 'chain', 'mutability', 'assets', 'rules'];
const ASSET_KEYS = ['chain', 'address', 'decimals', 'weightBps'];
const RULE_KEYS = ['weightBounds', 'maxAssets', 'minInvestment', 'swapSlippageBps', 'rebalance', 'performanceFeeBps', 'noRouteAssetPolicy'];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Canonical non-negative decimal: no sign, no leading zeros, no trailing fractional zeros, no exponent. */
const CANONICAL_DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

class Reader {
  readonly issues: BagIssue[] = [];
  constructor(private readonly nonIntegerNumbers: Set<string>) {}

  error(code: string, path: string, message: string): void {
    this.issues.push({ code, severity: 'error', path, message });
  }

  /** Exactly `allowed` keys may appear; every key in `required` must. Reports and returns false on any difference. */
  keys(obj: Obj, path: string, allowed: readonly string[], required: readonly string[] = allowed): boolean {
    let ok = true;
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) {
        this.error('UNKNOWN_FIELD', at(path, k), `"${at(path, k)}" is not a bag.json v1 field.`);
        ok = false;
      }
    }
    for (const k of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) {
        this.error('MISSING_FIELD', at(path, k), `"${at(path, k)}" is required (use null for "not set").`);
        ok = false;
      }
    }
    return ok;
  }

  // `undefined` = the key is absent: already reported as MISSING_FIELD by `keys`, so not reported again here.
  object(v: unknown, path: string): Obj | null {
    if (v === undefined) return null;
    if (isObject(v)) return v;
    this.error('WRONG_TYPE', path, `"${path}" must be an object.`);
    return null;
  }

  string(v: unknown, path: string): string | null {
    if (v === undefined) return null;
    if (typeof v === 'string') return v;
    this.error('WRONG_TYPE', path, `"${path}" must be a string.`);
    return null;
  }

  integer(v: unknown, path: string, min = -Infinity): number | null {
    if (v === undefined) return null;
    if (typeof v !== 'number') {
      this.error('WRONG_TYPE', path, `"${path}" must be an integer.`);
      return null;
    }
    if (!Number.isSafeInteger(v) || this.nonIntegerNumbers.has(path)) {
      this.error('NOT_AN_INTEGER', path, `"${path}" must be written as an integer (no fraction or exponent).`);
      return null;
    }
    if (v < min) {
      this.error('OUT_OF_RANGE', path, `"${path}" must be at least ${min}.`);
      return null;
    }
    return v;
  }

  integerOrNull(v: unknown, path: string): number | null {
    return v === null ? null : this.integer(v, path);
  }

  oneOf<T extends string>(v: unknown, path: string, values: readonly T[], nullable: boolean): T | null {
    if (v === undefined || (v === null && nullable)) return null;
    if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T;
    this.error(typeof v === 'string' ? 'INVALID_VALUE' : 'WRONG_TYPE', path, `"${path}" must be one of ${values.join(', ')}${nullable ? ' or null' : ''}.`);
    return null;
  }

  chain(v: unknown, path: string) {
    if (v === undefined) return null;
    if (isBagChain(v)) return v;
    this.error(typeof v === 'string' ? 'UNSUPPORTED_CHAIN' : 'WRONG_TYPE', path, `"${path}" must be a bag.json v1 chain.`);
    return null;
  }

  address(v: unknown, path: string): string | null {
    const s = this.string(v, path);
    if (s === null) return null;
    if (ADDRESS_RE.test(s)) return s;
    this.error('INVALID_ADDRESS', path, `"${path}" must be a 0x-prefixed 20-byte hex address.`);
    return null;
  }
}

function readDefinition(r: Reader, raw: unknown): BagDefinition | null {
  const d = r.object(raw, 'definition');
  if (!d) return null;
  r.keys(d, 'definition', DEFINITION_KEYS);

  const kind = r.oneOf(d.kind, 'definition.kind', STRATEGY_KINDS, true);
  const chain = r.chain(d.chain, 'definition.chain');
  const mutability = r.oneOf(d.mutability, 'definition.mutability', MUTABILITIES, true);

  const assets: BagDefinition['assets'] = [];
  if (d.assets === undefined) {
    // reported as MISSING_FIELD
  } else if (!Array.isArray(d.assets)) r.error('WRONG_TYPE', 'definition.assets', '"definition.assets" must be an array.');
  else
    d.assets.forEach((rawAsset, i) => {
      const p = at('definition.assets', i);
      const a = r.object(rawAsset, p);
      if (!a) return;
      r.keys(a, p, ASSET_KEYS);
      const assetChain = r.chain(a.chain, at(p, 'chain'));
      const address = r.address(a.address, at(p, 'address'));
      const decimals = r.integer(a.decimals, at(p, 'decimals'));
      const weightBps = r.integer(a.weightBps, at(p, 'weightBps'));
      if (assetChain && address !== null && decimals !== null && weightBps !== null) assets.push({ chain: assetChain, address, decimals, weightBps });
    });

  const rr = r.object(d.rules, 'definition.rules');
  let rules: BagDefinition['rules'] | null = null;
  if (rr) {
    r.keys(rr, 'definition.rules', RULE_KEYS);
    const wb = r.object(rr.weightBounds, 'definition.rules.weightBounds');
    if (wb) r.keys(wb, 'definition.rules.weightBounds', ['minBps', 'maxBps']);

    let minInvestment: BagDefinition['rules']['minInvestment'] = null;
    if (rr.minInvestment !== null) {
      const mi = r.object(rr.minInvestment, 'definition.rules.minInvestment');
      if (mi) {
        r.keys(mi, 'definition.rules.minInvestment', ['amount', 'measuredAs']);
        const amount = r.string(mi.amount, 'definition.rules.minInvestment.amount');
        if (amount !== null && !CANONICAL_DECIMAL_RE.test(amount)) {
          r.error('NON_CANONICAL_DECIMAL', 'definition.rules.minInvestment.amount', 'minInvestment.amount must be a canonical decimal string (e.g. "10", "0.5"; no leading or trailing zeros, sign or exponent).');
        }
        const measuredAs = r.oneOf(mi.measuredAs, 'definition.rules.minInvestment.measuredAs', ['PAYMENT_TOKEN_AMOUNT'] as const, false);
        if (amount !== null && measuredAs) minInvestment = { amount, measuredAs };
      }
    }

    let rebalance: BagDefinition['rules']['rebalance'] = null;
    if (rr.rebalance !== null) {
      const rb = r.object(rr.rebalance, 'definition.rules.rebalance');
      if (rb) {
        r.keys(rb, 'definition.rules.rebalance', ['frequency', 'driftThresholdBps']);
        rebalance = {
          frequency: r.oneOf(rb.frequency, 'definition.rules.rebalance.frequency', REBALANCE_FREQUENCIES, true),
          driftThresholdBps: r.integerOrNull(rb.driftThresholdBps, 'definition.rules.rebalance.driftThresholdBps'),
        };
      }
    }

    rules = {
      weightBounds: {
        minBps: wb ? r.integerOrNull(wb.minBps, 'definition.rules.weightBounds.minBps') : null,
        maxBps: wb ? r.integerOrNull(wb.maxBps, 'definition.rules.weightBounds.maxBps') : null,
      },
      maxAssets: r.integerOrNull(rr.maxAssets, 'definition.rules.maxAssets'),
      minInvestment,
      swapSlippageBps: r.integerOrNull(rr.swapSlippageBps, 'definition.rules.swapSlippageBps'),
      rebalance,
      performanceFeeBps: r.integerOrNull(rr.performanceFeeBps, 'definition.rules.performanceFeeBps'),
      noRouteAssetPolicy: r.oneOf(rr.noRouteAssetPolicy, 'definition.rules.noRouteAssetPolicy', NO_ROUTE_ASSET_POLICIES, true),
    };
  }

  if (!chain || !rules) return null;
  return { kind, chain, mutability, assets, rules };
}

function readMetadata(r: Reader, raw: unknown): BagDocument['metadata'] {
  const m = r.object(raw, 'metadata');
  if (!m) return undefined;
  r.keys(m, 'metadata', ['name', 'symbol', 'description', 'assets']);
  const assets: NonNullable<BagDocument['metadata']>['assets'] = [];
  if (m.assets === undefined) {
    // reported as MISSING_FIELD
  } else if (!Array.isArray(m.assets)) r.error('WRONG_TYPE', 'metadata.assets', '"metadata.assets" must be an array.');
  else
    m.assets.forEach((raw, i) => {
      const p = at('metadata.assets', i);
      const a = r.object(raw, p);
      if (!a) return;
      r.keys(a, p, ['chain', 'address', 'symbol']);
      const chain = r.chain(a.chain, at(p, 'chain'));
      const address = r.address(a.address, at(p, 'address'));
      const symbol = r.string(a.symbol, at(p, 'symbol'));
      if (chain && address !== null && symbol !== null) assets.push({ chain, address, symbol });
    });
  return { name: r.string(m.name, 'metadata.name') ?? '', symbol: r.string(m.symbol, 'metadata.symbol') ?? '', description: r.string(m.description, 'metadata.description') ?? '', assets };
}

function readUuid(r: Reader, v: unknown, path: string): string | null {
  const s = r.string(v, path);
  if (s !== null && !UUID_RE.test(s)) {
    r.error('INVALID_VALUE', path, `"${path}" must be a lowercase UUID.`);
    return null;
  }
  return s;
}

/**
 * Parses a bag.json v1 document. Accepts the file's text (preferred: duplicate keys and `1.0` are only
 * detectable in the text) or an already-parsed JSON value. Returns every problem found, not just the first.
 */
export function parseBag(input: string | unknown): ParseResult {
  let value: unknown = input;
  let nonIntegerNumbers = new Set<string>();
  if (typeof input === 'string') {
    try {
      ({ value, nonIntegerNumbers } = parseJsonStrict(input));
    } catch (e) {
      const message = e instanceof JsonSyntaxError ? e.message : String(e);
      return { ok: false, bag: null, issues: [{ code: message.startsWith('duplicate key') ? 'DUPLICATE_KEY' : 'JSON_SYNTAX', severity: 'error', path: '', message }] };
    }
  }

  const r = new Reader(nonIntegerNumbers);
  if (!isObject(value)) {
    r.error('WRONG_TYPE', '', 'A bag.json document must be a JSON object.');
    return { ok: false, bag: null, issues: r.issues };
  }
  r.keys(value, '', DOCUMENT_KEYS, REQUIRED_DOCUMENT_KEYS);
  if ('bagJson' in value && value.bagJson !== BAG_JSON_FORMAT_VERSION) {
    r.error('UNSUPPORTED_FORMAT_VERSION', 'bagJson', `Only bag.json v${BAG_JSON_FORMAT_VERSION} is supported.`);
  }

  const definition = 'definition' in value ? readDefinition(r, value.definition) : null;
  const bag: Partial<BagDocument> = { bagJson: BAG_JSON_FORMAT_VERSION };

  if ('metadata' in value) bag.metadata = readMetadata(r, value.metadata);
  if ('definitionHash' in value) {
    const h = r.string(value.definitionHash, 'definitionHash');
    if (h !== null && !BYTES32_RE.test(h)) r.error('INVALID_VALUE', 'definitionHash', '"definitionHash" must be a 0x-prefixed 32-byte hex string.');
    else if (h !== null) bag.definitionHash = h;
  }
  if ('ref' in value) {
    const ref = r.object(value.ref, 'ref');
    if (ref) {
      r.keys(ref, 'ref', ['strategyId', 'version', 'parentVersion', 'createdAt']);
      const strategyId = readUuid(r, ref.strategyId, 'ref.strategyId');
      const version = r.integer(ref.version, 'ref.version', 1);
      const parentVersion = ref.parentVersion === null ? null : r.integer(ref.parentVersion, 'ref.parentVersion', 1);
      const createdAt = r.string(ref.createdAt, 'ref.createdAt');
      if (strategyId !== null && version !== null && createdAt !== null) bag.ref = { strategyId, version, parentVersion, createdAt };
    }
  }
  if ('network' in value) {
    const n = r.object(value.network, 'network');
    if (n) {
      r.keys(n, 'network', ['chainId']);
      bag.network = { chainId: r.integerOrNull(n.chainId, 'network.chainId') };
    }
  }
  if ('commitments' in value) {
    // BAG's own record of on-chain commitments. Kept for display; never authority (see verifyRegistryCommitment).
    const c = r.object(value.commitments, 'commitments');
    if (c) bag.commitments = c;
  }
  if ('forkedFrom' in value) {
    if (value.forkedFrom === null) bag.forkedFrom = null;
    else {
      const f = r.object(value.forkedFrom, 'forkedFrom');
      if (f) {
        r.keys(f, 'forkedFrom', ['strategyId', 'version']);
        const strategyId = readUuid(r, f.strategyId, 'forkedFrom.strategyId');
        const version = f.version === null ? null : r.integer(f.version, 'forkedFrom.version', 1);
        if (strategyId !== null) bag.forkedFrom = { strategyId, version };
      }
    }
  }

  if (r.issues.length > 0 || !definition) return { ok: false, bag: null, issues: r.issues };
  return { ok: true, bag: { ...bag, definition } as BagDocument, issues: [] };
}
