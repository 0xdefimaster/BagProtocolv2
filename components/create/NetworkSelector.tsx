import { NETWORKS } from '@/lib/constants';
import { Check } from 'lucide-react';

// -----------------------------------------------------------------------------
// Production-hardening P0-1 — SINGLE-CHAIN network model.
//
// A Bag lives on exactly one chain (`BasketRecipe.chain`, `ExecutionPlan`,
// `BagExecutionGraph.chainId` — every one of these is a single `ChainId`,
// never a list). This control used to accept/toggle an ARRAY of network
// ids, which let a creator "select" Ethereum + Base + Arbitrum together —
// but only `selectedNetworkIds[0]` was ever actually used anywhere
// downstream (asset registry fetch, `chain:` on the create payload). The
// other toggled chips did nothing except lie to the creator on the Review
// step ("Networks: Ethereum, Base, Arbitrum") about what they were
// actually publishing. This is now a real single-select (radio-button
// semantics): choosing a network always deselects whatever was chosen
// before, so the component's own type signature makes the old
// multi-select workaround impossible to reintroduce by accident.
// -----------------------------------------------------------------------------

interface NetworkSelectorProps {
  selected: string;
  onChange: (networkId: string) => void;
}

export function NetworkSelector({ selected, onChange }: NetworkSelectorProps) {
  return (
    <div className="network-grid" role="radiogroup" aria-label="Deploy network">
      {NETWORKS.map((net) => {
        const active = net.id === selected;
        return (
          <button
            type="button"
            key={net.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(net.id)}
            className={`network-chip ${active ? 'active' : ''}`}
            style={active ? { borderColor: net.color, background: `${net.color}1A` } : undefined}
          >
            <span className="network-glyph" style={{ color: net.color }}>
              {net.glyph}
            </span>
            <span className="network-label">{net.label}</span>
            {active && <Check size={14} className="network-check" style={{ color: net.color }} />}
          </button>
        );
      })}
    </div>
  );
}
