// Pre-signature checks shared by the signing page (browser) and the automated wallet client (Node).
// Input is exactly what the local server hands out for a pending step; the typed data is decoded
// from scratch and every value is compared with the plan and the expected addresses.
import { decodeDelegationTypedData, compareDelegationToPlan, decodeUserOpTypedData } from './dca-rules.mjs';

export const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const lc = a => String(a ?? '').toLowerCase();

export function checkDelegationStep(p) {
  const { decoded, errors } = decodeDelegationTypedData(p.typedData, p.expect.enforcers);
  const bad = [...errors, ...compareDelegationToPlan(decoded, p.spec, p.expect)];
  if (lc(p.expect.mainnetChecks?.factory?.code) !== '0x' || lc(p.expect.mainnetChecks?.paymaster?.code) !== '0x') bad.push('keyless factory/paymaster has code on Robinhood Chain');
  if (lc(p.planAddress) !== lc(decoded.delegate)) bad.push('plan address differs from delegate');
  if (lc(p.plan?.recipient) !== lc(p.expect.owner)) bad.push('purchase recipient is not the connected account');
  return { decoded, bad };
}

export function checkUserOpStep(p) {
  const { decoded, errors } = decodeUserOpTypedData(p.typedData);
  const bad = [...errors];
  if (decoded.domain.chainId !== 4663) bad.push('chainId is not 4663');
  if (lc(decoded.sender) !== lc(p.expect.smartAccount) || lc(decoded.domain.verifyingContract) !== lc(p.expect.smartAccount)) bad.push('sender is not your smart account');
  if (lc(decoded.entryPoint) !== ENTRY_POINT) bad.push('unexpected EntryPoint');
  if (lc(decoded.paymaster?.address) !== lc(p.expect.paymaster)) bad.push('paymaster is not the fork-only paymaster');
  if (!(decoded.paymaster?.validUntil > 0n)) bad.push('paymaster window has no expiry');
  if (p.id === 'CANCEL' && (lc(decoded.call?.target) !== lc(p.expect.delegationManager) || decoded.call?.selector !== '0x49934047')) bad.push('call is not DelegationManager.disableDelegation');
  if (p.id === 'WITHDRAW' && lc(decoded.call?.transfer?.to) !== lc(p.expect.owner)) bad.push('withdraw recipient is not your account');
  if (!['CANCEL', 'WITHDRAW'].includes(p.id)) bad.push('unknown user operation step');
  return { decoded, bad };
}
