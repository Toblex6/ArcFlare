# FlareHQ Job 3d: Gate 1

## Verification without production writes

Use a fresh PostgreSQL database on loopback. Set `DATABASE_URL` in the test shell before running anything; a repo dotenv file is not a substitute. `npm test` rejects missing or non-loopback URLs, strips inherited application credentials, and runs an explicit list of offline, local-DB, and in-process contract suites. Build first for the HTTP boot smoke test. Run `next build --webpack` directly, **not** `npm run build`, unless you intend to run migrations against the configured database. Do not point legacy fixture or HTTP suites at a shared dev server or a tunneled database. Live E2E scripts are not part of Gate 1.

Gate 1 verification: 44 migrations applied to disposable loopback PostgreSQL only; 23/23 regression stages passed, including 618/618 Node tests (zero skipped) and 35/35 built-server boot checks. The standalone nonincremental TypeScript check passed. `withGateway()`, the UnitFlow configuration, and the UnitFlow/Tower provider files are unchanged.

## Safe owner control (operator only)

[Safe's chain config](https://safe-config.safe.global/api/v1/chains/5042/) lists Arc as `arc`; [Safe{Wallet}](https://app.safe.global/home?safe=arc:0x0B0c2386CAbfeE832b8C5781751aa547b63Eb07e) recognizes the new Safe. Its transaction service and on-chain getters agree on 2-of-3 and nonce 0. The deployment preflight also checks the singleton, owners, threshold, nonce, absence of modules and guards, and runtime code presence. This proves configuration, not control of the signing keys.

If using the hosted UI for the owner-control proof, connect one owner on Arc, choose **New transaction → Transaction Builder**, and prepare one `CALL` to the Safe itself with `getThreshold()` (`0xe75235b8`), value `0`, no refund and no delegatecall. Review the actual typed data. Sign off-chain only; the second owner opens the same queued proposal and confirms off-chain without executing. Stop when Safe shows two confirmations. Abort if the UI offers only an on-chain confirmation, rewrites the call into a delegatecall, or requires a broadcast. The signatures may be public and a fully signed proposal can consume the nonce if someone executes it; never broadcast the proof. If nonce 0 changes, stop: preflight intentionally refuses the changed Safe.

## Old contracts (read only)

At Arc mainnet block 32283602, all three supplied addresses had runtime code. All share owner `0xb54f4Fa6F155CAb249f6Bbc194F2D5f363d4D9b4` and pending owner `0x0000000000000000000000000000000000000000`.

| Contract | Address | Runtime bytes | Role |
| --- | --- | ---: | --- |
| ArcFlareJobEscrow | `0x017F4616d2ed07E3Ed4A5d8B2355ab4A19f5fC65` | 16,278 | relayer `0x4D73C0D2afF09B85e92CF778cB767670a7E2C291`; arbiter `0x04001685D381aFa5e604d0cf0A4Ab14468A84DD5` |
| ArcFlareSpendLimit | `0xF9DA48a0165aA4D15F9db7431C1bA5E10513CEFE` | 7,323 | recorder `0x4D73C0D2afF09B85e92CF778cB767670a7E2C291` |
| ArcFlarePayroll | `0x456E10375715A06509D86B9851F1e4Ef6F9F6B8B` | 12,167 | relayer `0x4D73C0D2afF09B85e92CF778cB767670a7E2C291` |

Other queried role getters reverted. Do not change the shared `RELAYER_PRIVATE_KEY` in isolation: the new address cannot use the old relayer/recorder permissions. The old owner, if controlled, can rotate the roles separately (not authorized for this gate). Payroll also has a merchant-specific execution path, which does not make the new app relayer the old relayer. New FlareHQEscrow does not depend on the legacy relayer. Never redeploy or repoint `JOB_ESCROW_CONTRACT_ADDRESS` during this gate.

`node scripts/deploy-flarehq-escrow.mjs --preview-replacements` estimates Payroll and SpendLimit only, assigning the Safe as owner and `0xf3b3947673B27197B228a3712dDC806a7392D2cf` as relayer/recorder. Neither constructor has an arbiter. Preview cannot broadcast. Replacements would start with empty batches/policies; do not cut over until legacy obligations and policy data are accounted for.

## Escrow deploy and Render (operator only)

Use the exact reviewed branch-tip SHA from the Gate 1 report, set in `ESCROW_DEPLOY_COMMIT`. The entry point checks that SHA, requires a clean Git tree and matching source bytes for execution, compiles fresh using the local Hardhat config (Solidity 0.8.24), validates chain and Safe, estimates from the pinned deployer, and checks owner, arbiter, treasury, pending owner, token and fee after the receipt. `--execute` only deploys **FlareHQEscrow**, not ArcFlareJobEscrow. The dry run does not load the deployer key.

```powershell
$env:ESCROW_DEPLOY_COMMIT = '<reviewed full SHA from Gate 1 report>'
git fetch origin job3-mainnet-complete
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch reviewed branch' }
git switch --detach $env:ESCROW_DEPLOY_COMMIT
if ($LASTEXITCODE -ne 0) { throw 'Could not check out reviewed revision' }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed' }
$env:ARC_MAINNET_RPC_URL = 'https://rpc.mainnet.arc.io'
$env:ESCROW_ARBITER_ADDRESS = '0xBCE45360f06f705Dc7eFaA0e5F170a7c710ecaAd'
$env:ESCROW_TREASURY_ADDRESS = '0x0B0c2386CAbfeE832b8C5781751aa547b63Eb07e'
node scripts/deploy-flarehq-escrow.mjs
if ($LASTEXITCODE -ne 0) { throw 'Dry run failed' }
# Only after the owner proof and dry run: load MAINNET_DEPLOYER_KEY privately via your secret manager.
# The key must derive 0xA2228A6541C1be0792BdBB30D7aC8663f81B7cAD.
try { node scripts/deploy-flarehq-escrow.mjs --execute; if ($LASTEXITCODE -ne 0) { throw 'Execution failed; inspect before any retry' } }
finally { Remove-Item Env:MAINNET_DEPLOYER_KEY -ErrorAction SilentlyContinue }
```

After successful on-chain post-deploy checks only: `ARC_MAINNET_ESCROW_ADDRESS` = new FlareHQEscrow address; `ESCROW_ADMIN_PRIVATE_KEY` = private arbiter key deriving `0xBCE45360f06f705Dc7eFaA0e5F170a7c710ecaAd` (not the deployer or a Safe owner key); `ESCROW_MAX_AMOUNT_USDC` = `50`. The cap is app-level, not a restriction on direct on-chain calls. Pre-existing funded escrows and in-flight receipt confirmations are not subject to the new create cap. Leave `JOB_ESCROW_CONTRACT_ADDRESS`, `PAYROLL_CONTRACT_ADDRESS`, `SPEND_LIMIT_CONTRACT_ADDRESS`, and `RELAYER_PRIVATE_KEY` unchanged for this gate. Any later cutover needs separate approval and confirmation of the legacy permissions. The branch tip uses `[skip render]`; this handoff does not change Render settings or start a Render deploy.
