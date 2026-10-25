# Live Composer handoff

Codex independently ran the supplier's unchanged composer/run.mjs and DcaComposerPlan.sol against fresh Composer API compilations on a local Robinhood fork.

- Repository: e6bdd1057f4cb68d492e2c503736d7e30d24b0c0; clean detached checkout; SDK 0.3.0 built successfully.
- 26 PASS / 0 FAIL; mode=live; programSource=FRESH_LIVE_COMPOSER_COMPILATION.
- Fork block: 96434989, 0xb5e5bc47923e72e5cda852a24ffbab46a491ec111b29c4d8540b46d9cb0220fb.
- A-2 and B-2 passed: actual plan-address compiles match the signer-independent placeholder template.
- A-4/A-6 and B-4/B-6 passed: two 5-USDG purchases per model, four total. All final deliveries and zero plan deltas were separately checked.
- A-5/B-5 passed: failing router execution rolls back funding, approvals, plan counters and (B) enforcer counters.
- Four SDK inner-call bindings pass CALL_TRACE. All four overall SDK decisions remain FAILED / INPUT_BALANCE_BELOW_PLAN. Full verification acceptance remains NOT_MET. Do not relabel this VERIFIED.
- Public transactions: zero. The relay rejects eth_sendRawTransaction. Locally generated keys and fork-only funding were used.
- Real MetaMask/Rabby signatures: NOT TESTED. No SDK source change, merge, publication or public-chain deployment was performed.

Windows install note: solc 0.8.23 has a non-Windows n@9.2.3 dependency. Ordinary prototype npm ci fails EBADPLATFORM. npm ci --ignore-scripts --force installed the supplied lock unchanged; compiler remained 0.8.23+commit.f704f362. The pinned repository used npm ci --ignore-scripts and npm run build --prefix packages/bag-sdk.

Please use this live evidence before implementing a separately enabled SDK verification mode. Bind funding source, Composer caller and final recipient to the authorized plan; preserve existing verification defaults. Input debit should follow the plan's actual swapped share when a BAG retains USDG, not assume gross amount always equals swapped amount.

The supplied historical 34 mock/26 replay and separate bytecode/27-immutable results were not rerun or added to this count. Cache files and credentials are excluded from the package.
