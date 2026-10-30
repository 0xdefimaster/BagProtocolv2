# Kaynaklar ve derleme ayarları

## BAG Protocol
| | |
|---|---|
| Repo | `0xdefimaster/BagProtocolv2` |
| Branch / commit | `codex/app-dca-local-trial` @ `e6bdd1057f4cb68d492e2c503736d7e30d24b0c0` (PR #125; #124 ve #123'ün üzerine) |
| `main` (dokunulmadı) | `82b3b2926da467e3530eba0c9f6c38452d8511ab` |
| Kullanılan parçalar | `packages/bag-sdk/dist` (bu commit'te `npm run build`), `scripts/research/dca-trial/basket-wire.mjs`, `scripts/research/usdg-recurring/wire.mjs`, `scripts/research/usdg-composer/settings.mjs`, `scripts/research/dca-trial/fixtures/955df6e0-…` |
| Gerçek BAG | `955df6e0-b6ea-44ba-a5eb-1288a80c0a06` v1, `definitionHash 0x5d6118db…fbb9`, 4 token (2675/2601/3724/1000 bps), performans ücreti %0 |
| Uyarlanan kaynak | `scripts/research/dca-trial/contracts/BasketPurchase.sol` → `composer/contracts/DcaComposerPlan.sol`. `usdg-composer/contracts/LocalArbSysRead.sol` → `composer/contracts/LocalArbSysRead.sol` (pragma 0.8.23) |

## MetaMask Delegation Framework
| | |
|---|---|
| Repo / tag | `MetaMask/delegation-framework` `v1.3.0` @ `bfbdf9795a976833ed2fa000baf42fbb83958b03` |
| Submodule'ler | openzeppelin-contracts `105fa4e1…`, erc7579-implementation `16138d1a…`, account-abstraction `7af70c89…`, SCL `6c3d762d…`, FCL `8179e08c…`, FreshCryptoLib `d9bb3b0f…`, solidity-bytes-utils `6458fb27…` |
| Derleme (karşılaştırma) | solc 0.8.23, optimizer açık, runs 200, `evmVersion: london`, viaIR kapalı. Bunlar repodaki `foundry.toml` varsayılanları |
| Adresler | `@metamask/delegation-deployments` 2.1.0 → `DELEGATOR_CONTRACTS["1.3.0"][4663]` |

## npm (kilitli: `package-lock.json`)
`hardhat 3.14.0`, `viem 2.56.0`, `solc 0.8.23`, `@metamask/smart-accounts-kit 2.0.0` (→ `@metamask/delegation-deployments 2.1.0`). Node 24.22.0.
Kit, `DO_NOT_TRACK` ayarlı değilse `mm-sdk-analytics.api.cx.metamask.io` adresine kullanım verisi gönderiyor. Betikler bu yüzden `DO_NOT_TRACK=1` ayarlıyor.

## Prototip kontratları
| Dosya | Derleme |
|---|---|
| `fork/contracts/*.sol` | solc 0.8.23, optimizer 200, `shanghai` |
| `composer/contracts/*.sol` | solc 0.8.23, optimizer runs 1, **viaIR açık**, `shanghai` (viaIR kapalıyken "stack too deep" hatası alındı). Plan runtime 12.238 B |

## Zincir
Robinhood Chain 4663, public RPC `https://rpc.mainnet.chain.robinhood.com`. Fork blok numaraları her `results.json` dosyasında kayıtlı. Upstream yalnızca okuma çağrıları alıyor.
