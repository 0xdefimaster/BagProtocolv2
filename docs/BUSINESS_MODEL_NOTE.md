# Business model note

Short and non-binding: direction only, not a pricing decision. Written 2026-11-03.

## What exists today

| Flow | Who receives it | Protocol revenue? |
|---|---|---|
| Performance fee on a sale (RedeemSettlement) | The Bag's **creator**, and 20% of it to a fork's root creator (v2), paid directly in the sale transaction | **No.** The protocol share is 0, and nothing passes through a BAG treasury |
| Bag creation fee (BagFactory) | The protocol treasury, in native ETH, with an immutable cap | Yes, but small; it is a spam deterrent, not a business |
| Composer / LI.FI fees | LI.FI and integrators, per their own terms | Not BAG's |

Creator fees are the creators' income. Counting them as BAG revenue would be wrong in reporting, and wrong for
creators' trust.

## Options considered

All of these are off-chain or contractual. **None needs new fee logic in a BAG contract.**

1. **SDK / API.** The SDK stays MIT and free. Hosted conveniences can be paid tiers: strategy hosting and portable
   URLs, verification API, receipt indexing, rate-limited and higher-limit access.
2. **B2B integration.** Wallets, exchanges and fintechs embed BAG strategies through the SDK, with paid support,
   SLAs and qualification of their chains.
3. **White-label.** A partner runs the BAG app or strategy pages under its own brand. Licensing plus support.
4. **Transparent execution fee.** If ever used, it is set **in the routing provider's integrator-fee field**:
   - disclosed in the quote before signing;
   - shown in the receipt;
   - visible to SDK users, and opt-out for them.

   It is not hidden in contract logic and is not taken from creator fees.

## Not proposed

- No new fee parameter, fee recipient or fee share in any BAG contract.
- No protocol cut of creator performance fees.
- No fee that a user cannot see before signing.

Any move away from these would be a separate decision. It would need its own security review and release notes.
