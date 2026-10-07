# BAG Protocol Roadmap

> A living roadmap for BAG Protocol. This communicates product and infrastructure direction, not guaranteed delivery dates. Priorities may change as the protocol, market infrastructure, and ecosystem evolve.

## Today

### Strategy Standard
- [x] `bag.json` v1 portable strategy definition
- [x] Deterministic validation, normalization and hashing
- [x] Version history and strategy diffs
- [x] Strategy Passport and provenance
- [x] Policy objects and deterministic `validate_bag`
- [x] Strategy lineage and forks

### Verified Execution
- [x] Provider-independent execution graph
- [x] Execution provider abstraction and compiler
- [x] LI.FI sequential execution
- [x] LI.FI Composer single-transaction basket execution
- [x] Execution candidate comparison
- [x] Execution-plan hashing
- [x] Per-asset output verification
- [x] Minimum-output enforcement
- [x] Wallet and transaction binding
- [x] On-chain receipt verification
- [x] Execution history and receipts

### Execution Security
- [x] Bounded approvals
- [x] Execution-target allowlists
- [x] Token / target separation
- [x] Exact calldata binding for BAG-native execution
- [x] Approval revocation after execution
- [x] Balance-delta output verification
- [x] Transaction replay protection
- [x] Server-side receipt verification
- [x] Fail-closed execution checks

### Developer Access
- [x] Unified Strategy API
- [x] Read-only BAG MCP
- [x] Standalone `bag.json` SDK
- [ ] Public SDK distribution

---

# Next

## Best Execution

Move from choosing an execution provider to selecting the best executable plan for the strategy.

- [ ] Enable the provider compiler in the live purchase path
- [ ] Parallel provider quote collection
- [ ] Add independent execution providers
- [ ] Normalize quote, gas, fee and timing data
- [ ] Route feasibility filtering
- [ ] Basket-level execution optimization
- [ ] Historical execution-quality scoring

### Goal

> **What is the best executable way to implement this strategy right now?**

BAG should optimize for the strategy as a whole rather than simply preferring one router.

---

## Portfolio Management

Turn a BAG from a strategy people buy into a strategy they can continuously manage.

### Rebalancing

- [ ] Portfolio drift detection
- [ ] Target vs. current allocation
- [ ] Rebalance simulation
- [ ] Delta-based rebalance planning
- [ ] Best-execution rebalance
- [ ] One-click rebalance
- [ ] Verified post-rebalance state

### Smart DCA

- [ ] Scheduled strategy purchases
- [ ] Strategy-aware DCA
- [ ] Drift-aware allocation
- [ ] Underweight-first execution
- [ ] Best execution for recurring purchases

---

## Execution Intelligence

Use observed execution data to improve future routing decisions.

- [ ] Quote vs. actual execution analysis
- [ ] Provider success-rate tracking
- [ ] Route execution-quality metrics
- [ ] Actual price-impact measurement
- [ ] Execution latency analytics
- [ ] Failed-route analysis
- [ ] Provider reliability scores
- [ ] Strategy-level execution statistics

### Long-term direction

BAG should learn which execution paths perform best for a given chain, asset, trade size and strategy from observed execution results rather than static assumptions.

---

## Strategy Intelligence

Help users understand whether a strategy is practical, not only whether it is valid.

### Strategy Analysis

- [ ] Liquidity analysis
- [ ] Route availability
- [ ] Concentration analysis
- [ ] Weight and risk analysis
- [ ] Estimated execution cost
- [ ] Price-impact warnings
- [ ] Strategy health indicators

### Strategy Doctor

- [ ] Detect difficult-to-execute assets
- [ ] Detect excessive concentration
- [ ] Detect high execution cost
- [ ] Suggest alternative allocations
- [ ] Explain why a strategy is currently difficult to execute

A strategy should eventually be able to say more than **Valid**:

> **Valid, executable, and currently efficient to execute.**

---

## Automation

Turn strategy rules into actionable portfolio policies.

- [ ] Threshold-based rebalance triggers
- [ ] Scheduled rebalances
- [ ] Conditional execution
- [ ] Execute when a required route becomes available
- [ ] Rebalance when portfolio drift exceeds a threshold
- [ ] Automation policies

Target model:

```
Strategy
   +
Policy
   +
Market conditions
   +
Execution optimizer
        ↓
Portfolio action
```

---

## Open Strategy Network

Make BAG strategies portable outside the BAG application.

- [ ] Public Strategy Registry
- [ ] Public strategy verification
- [ ] Published strategy versions
- [ ] Portable `bag.json` URLs
- [ ] Third-party verification
- [ ] Public execution provenance
- [ ] Strategy discovery
- [ ] Strategy marketplace
- [ ] Forkable strategies

A BAG should be something another wallet, application or agent can discover, understand and execute.

---

## AI & Agents

Make strategy creation and execution machine-readable.

- [ ] AI → structured strategy
- [ ] Natural-language strategy creation
- [ ] Deterministic strategy validation
- [ ] Strategy simulation
- [ ] AI-assisted portfolio analysis
- [ ] Strategy recommendation
- [ ] Agent-readable execution results
- [ ] Authenticated agent execution

Target flow:

```
Natural language
      ↓
Structured strategy
      ↓
bag.json
      ↓
Validate
      ↓
Analyze
      ↓
Quote
      ↓
Simulate
      ↓
Compile
      ↓
User authorization
      ↓
Verified execution
```

AI should construct and explain the strategy; deterministic BAG infrastructure should validate, constrain and verify what actually executes.

---

## Advanced Execution

- [ ] EIP-5792 wallet batching
- [ ] Permit / Permit2 approval reduction
- [ ] Smart-account execution
- [ ] Large-order execution optimization
- [ ] Low-impact execution mode
- [ ] Multi-provider route splitting
- [ ] RFQ and solver integrations
- [ ] Cross-chain strategy execution

Cross-chain execution will be introduced only when the required liquidity, settlement, bridging and failure-handling model can provide equivalent safety and verification guarantees.

---

## Native Portfolio Settlement

Explore stronger portfolio primitives when they are justified by real usage.

- [ ] Evaluate production-ready vault architecture
- [ ] Contract-held basket assets
- [ ] Share-based portfolio ownership
- [ ] Native portfolio settlement
- [ ] Automated rebalance execution
- [ ] On-chain portfolio accounting where economically justified

This phase is intended to expand BAG from a non-custodial execution layer into broader programmable portfolio infrastructure without adding unnecessary custody or trust assumptions.

---

# Long-Term Vision

BAG Protocol aims to make investment strategies **portable, programmable, executable and verifiable**.

```
Static basket
      ↓
Programmable strategy
      ↓
Verified execution
      ↓
Best execution
      ↓
Portfolio management
      ↓
Automation
      ↓
Open strategy network
      ↓
AI-native strategy infrastructure
```

The goal is not simply to make buying a basket easier.

The goal is to make the **strategy itself a reusable piece of financial infrastructure**.
