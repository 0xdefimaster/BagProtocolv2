import type { SupabaseClient } from '@supabase/supabase-js';
import type { BasketRecipe } from '@/types/basket-protocol';
import { computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';

// -----------------------------------------------------------------------------
// The version a Bag was DEPLOYED with is on-chain version 1: BagFactory.createBag
// commits its compositionHash in the BagCreated event. confirm_bag_deployment
// (lib/server/deploy-bag.ts) records a deployment only after checking that event's
// compositionHash equals computeOnChainCompositionHash() of the Bag's then-current
// version — but it stores the deployment, not which version that was. Later
// on-chain versions (2, 3, …) are stored per version row by
// record_onchain_bag_version (migration 0035).
//
// This module identifies that deployed version from what the database guarantees,
// so on-chain version 1 is not shown as "not recorded on-chain":
//   * the current version only ever moves forward (to the newest version);
//   * once a Bag is DEPLOYED, a new version is only created through
//     record_onchain_bag_version, which writes onchain_version 2, 3, … on that row
//     and keeps bag_deployments.on_chain_version in step (0035).
// So the deployed version is the newest version WITHOUT an on-chain record, and
// every version after it must carry onchain_version 2..N with N equal to the
// deployment's on_chain_version. Anything else (e.g. a deployment that predates
// 0035 and was followed by off-chain versions) resolves to null — never a guess.
// -----------------------------------------------------------------------------

export interface DeployedVersionRow {
  id: string;
  version: number;
  created_at: string;
  onchain_tx_hash: string | null;
  onchain_version?: number | null;
}

export interface DeployedVersionDeployment {
  status: string;
  txHash: string | null;
  createdAt: string;
  onChainVersion?: number | null;
}

/** Id of the version the Bag was deployed with (on-chain version 1), or null when it cannot be proven from the records. */
export function resolveDeployedVersionId(rows: DeployedVersionRow[], deployment: DeployedVersionDeployment | null): string | null {
  if (!deployment || deployment.status !== 'DEPLOYED' || !deployment.txHash) return null;
  const ascending = [...rows].sort((a, b) => a.version - b.version);
  let deployedIndex = -1;
  for (let i = ascending.length - 1; i >= 0; i--) {
    if (ascending[i].onchain_tx_hash === null) {
      deployedIndex = i;
      break;
    }
  }
  if (deployedIndex === -1) return null;
  const deployed = ascending[deployedIndex];
  const after = ascending.slice(deployedIndex + 1);
  // Versions after the deployed one: on-chain versions 2..N, contiguous, and N is the deployment's current on-chain version.
  if (after.some((v, i) => v.onchain_version !== i + 2)) return null;
  if ((deployment.onChainVersion ?? 1) !== after.length + 1) return null;
  // The deployed version existed when the deployment was recorded (a user-signed deployment row is created at confirm).
  if (Date.parse(deployed.created_at) > Date.parse(deployment.createdAt)) return null;
  return deployed.id;
}

/** On-chain version 1's commitment, recomputed from the deployed version's recipe — the value confirm checked against the BagCreated event. */
export function deployedCompositionHash(recipe: Pick<BasketRecipe, 'assets'>): string | null {
  try {
    return computeOnChainCompositionHash(recipe.assets).toLowerCase();
  } catch {
    return null;
  }
}

/** The Bag's DEPLOYED deployment row (one chain per Bag); null when not deployed or ambiguous. */
export async function loadDeployedDeployment(admin: SupabaseClient, bagId: string): Promise<DeployedVersionDeployment | null> {
  const { data, error } = await admin.from('bag_deployments').select('status,tx_hash,created_at,on_chain_version').eq('bag_id', bagId).eq('status', 'DEPLOYED');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { status: string; tx_hash: string | null; created_at: string; on_chain_version: number | null }[];
  if (rows.length !== 1) return null;
  const r = rows[0];
  return { status: r.status, txHash: r.tx_hash, createdAt: r.created_at, onChainVersion: r.on_chain_version };
}
