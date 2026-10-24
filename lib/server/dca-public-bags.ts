import { parseBag, validateBag, hashBag } from '@/packages/bag-sdk/src/index';
import { SUPPORTED_CHAINS } from '@/types/basket-protocol';
import type { BagJson } from '@/types/strategy';
import type { DcaTrialBag } from '@/lib/dca/reference';

const source = 'https://bagprotocol.com';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function publicDcaSourceEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.BAG_DCA_TRIAL === 'true' &&
    process.env.NEXT_PUBLIC_DCA_TRIAL === 'true' && process.env.BAG_DCA_PUBLIC_SOURCE === 'bagprotocol.com';
}
function requireLocalMode() {
  if (!publicDcaSourceEnabled()) throw new Error('Public BAG source is only enabled for this local trial.');
}
async function readPublicJson(path: string): Promise<unknown> {
  requireLocalMode();
  const response = await fetch(source + path, {
    method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Could not read the current public BAG data.');
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Public BAG response is too large.');
  return JSON.parse(text);
}
export async function listPublicDcaBags(): Promise<DcaTrialBag[]> {
  const body = await readPublicJson('/api/bags') as { bags?: unknown };
  if (!Array.isArray(body.bags) || body.bags.length > 250) throw new Error('Invalid public BAG list.');
  const bags: DcaTrialBag[] = body.bags.map((value: unknown) => {
    const b = value as DcaTrialBag;
    if (!b || !uuid.test(b.id) || typeof b.name !== 'string' || b.name.length > 500 ||
      !Number.isSafeInteger(b.version) || !b.version || b.version < 1 ||
      !Array.isArray(b.chains) || b.chains.length !== 1 || !(SUPPORTED_CHAINS as readonly string[]).includes(b.chains[0]) ||
      !Array.isArray(b.composition) || b.composition.length < 1 || b.composition.length > 100) throw new Error('Invalid public BAG entry.');
    const composition = b.composition.map(a => {
      const weightBps = a.weightBps ?? a.weight * 100;
      if (!a || typeof a.address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(a.address) ||
        typeof a.symbol !== 'string' || !Number.isSafeInteger(weightBps) || weightBps < 1 || weightBps > 10000) throw new Error('Invalid public BAG composition.');
      return { address: a.address.toLowerCase(), symbol: a.symbol, weightBps, weight: weightBps / 100 };
    });
    if (composition.reduce((sum,a) => sum + a.weightBps,0) !== 10000 || new Set(composition.map(a => a.address)).size !== composition.length) throw new Error('Invalid public BAG allocation.');
    return { id: b.id, name: b.name, version: b.version, chains: b.chains, composition };
  });
  if (new Set(bags.map(b => b.id)).size !== bags.length) throw new Error('Duplicate public BAG identity.');
  return bags;
}
export async function loadPublicDcaBag(id: string): Promise<{ bag: DcaTrialBag; document: BagJson }> {
  requireLocalMode();
  if (!uuid.test(id)) throw new Error('Invalid BAG identity.');
  const bag = (await listPublicDcaBags()).find(b => b.id === id);
  if (!bag) throw new Error('This BAG is not present in the current public list.');
  const raw = await readPublicJson(`/api/strategies/${id}/versions/${bag.version}`);
  const parsed = parseBag(raw);
  if (!parsed.ok || !validateBag(parsed.bag).valid) throw new Error('The public strategy failed SDK validation.');
  const document = raw as BagJson;
  if (document.ref?.strategyId !== id || document.ref.version !== bag.version ||
      document.definitionHash !== hashBag(parsed.bag) || document.definition.chain !== bag.chains[0]) throw new Error('Strategy identity, version or definition hash does not match.');
  const weights = new Map(bag.composition.map(a => [a.address!.toLowerCase(), a.weightBps]));
  if (document.definition.assets.length !== weights.size || document.definition.assets.some(a =>
    a.chain !== document.definition.chain || weights.get(a.address.toLowerCase()) !== a.weightBps)) throw new Error('The strategy changed while loading. Reload the BAG list.');
  return { bag: { ...bag, performanceFeeBps: document.definition.rules.performanceFeeBps, definitionHash: document.definitionHash }, document };
}
