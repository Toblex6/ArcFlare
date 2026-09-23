// scripts/mainnet-roles.mjs
//
// Production role allowlist for Arc Mainnet (chain 5042) contract deployments.
//
// Context: the abandoned mainnet deployment at 0x62CadfEdb71b31Efa590154eDb5F3e58B5b3A4fA
// used TESTNET role addresses on mainnet (owner=recorder=0x03ba testnet relayer).
// The deploy scripts already refuse the wrong chain and require explicit role
// inputs on mainnet — this module FAILS CLOSED unless those inputs exactly
// match the production allowlist below. Testnet behavior is untouched (these
// asserts only run when the deploy script detects chainId 5042).
//
// Pure module: no hardhat/network imports, so tests/mainnet-deploy-roles.test.mjs
// exercises it directly with `node --test` (no chain, no funds).
//
// Production allowlist (verified 2026-09-23; owner = 2-of-2 Safe on all three
// mainnet contracts — SpendLimit 0xF9DA…CEFE, JobEscrow 0x017F…f5fC65,
// Payroll 0x456E…6F9F6B8B):
export const MAINNET_PRODUCTION_ROLES = {
  /** OWNER / SAFE (also SPEND_LIMIT_OWNER, PAYROLL_OWNER) */
  owner: '0xb54f4Fa6F155CAb249f6Bbc194F2D5f363d4D9b4',
  /** ARBITER (JobEscrow only) */
  arbiter: '0x04001685D381aFa5e604d0cf0A4Ab14468A84DD5',
  /** RELAYER (also SPEND_LIMIT_RECORDER, PAYROLL_RELAYER) */
  relayer: '0x4D73C0D2afF09B85e92CF778cB767670a7E2C291',
  /** TREASURY SINK (JobEscrow only) */
  treasurySink: '0x59018590Ad61264EC706EC139700C1DdE9A244CD',
};

// Known testnet addresses that must NEVER be assigned a mainnet role.
// Explicit denylist (checked before the allowlist) so a testnet-role deploy
// fails with an actionable "testnet address on mainnet" error even if the
// allowlist above were ever edited — and so the failure mode that produced
// the abandoned 0x62Ca…fA4fA deployment is named, not just mismatched.
export const KNOWN_TESTNET_ROLE_ADDRESSES = [
  '0x0d9Dc1733FEA587Ce16E4CbBE449B8E01E677F44', // testnet relayer, COMPROMISED key (retired 2026-09-18)
  '0x03badcdb102433798df5feb854b87c7a37dde3a6', // testnet relayer/EOA (abandoned 0x62Ca… owner=recorder)
  '0xc119bb61dCd7Ce422557485ecD17D679f44250a1', // testnet seller/merchant EOA
  '0x7a8214dad7630a7a39054e0121acdbc7a65821c9', // testnet platform-default payer SCA
  '0x902C565bE31c146a79350387C1f77d6896814B58', // testnet platform-default merchant SCA
];

const norm = (v) => (v ?? '').trim().toLowerCase();

function assertNotTestnetRole(envName, value) {
  const hit = KNOWN_TESTNET_ROLE_ADDRESSES.some((t) => norm(t) === norm(value));
  if (hit) {
    throw new Error(
      `${envName}=${value} is a KNOWN TESTNET address — refusing to assign a testnet role on Arc Mainnet (chain 5042). ` +
        `This is the exact failure that produced the abandoned 0x62Ca…fA4fA deployment. Supply the production address.`
    );
  }
}

function assertExactRole(envName, value, expected, label) {
  if (norm(value) !== norm(expected)) {
    throw new Error(
      `${envName}=${value} does not match the production ${label} ${expected} — refusing to deploy on Arc Mainnet (chain 5042). ` +
        `Mainnet roles are allowlisted exactly; supply the production address.`
    );
  }
}

// JobEscrow + SpendLimit roles (scripts/deploy-arcflare.mjs). Every value is
// the RESOLVED address the script is about to deploy with (env or default).
// SPEND_LIMIT_* default to the escrow owner/relayer — pass the resolved values
// so an explicit testnet override cannot sneak through the default path.
export function assertMainnetJobEscrowRoles({
  owner,
  arbiter,
  treasurySink,
  relayer,
  spendLimitOwner,
  spendLimitRecorder,
}) {
  for (const [envName, value] of [
    ['JOB_ESCROW_OWNER', owner],
    ['JOB_ESCROW_ARBITER', arbiter],
    ['JOB_ESCROW_TREASURY_SINK', treasurySink],
    ['JOB_ESCROW_RELAYER', relayer],
    ['SPEND_LIMIT_OWNER', spendLimitOwner ?? owner],
    ['SPEND_LIMIT_RECORDER', spendLimitRecorder ?? relayer],
  ]) {
    if (!value) throw new Error(`${envName} is not set — refusing to deploy on Arc Mainnet (chain 5042).`);
    assertNotTestnetRole(envName, value);
  }
  // Owner must never be the relayer: a single hot key holding both roles can
  // drain/redirect unilaterally. Checked before the allowlist so the violation
  // is named even when both values are allowlisted-shaped.
  if (norm(owner) === norm(relayer)) {
    throw new Error(
      `JOB_ESCROW_OWNER (${owner}) must not equal JOB_ESCROW_RELAYER — refusing to deploy on Arc Mainnet (chain 5042). ` +
        `Ownership stays on the production Safe; operation stays on the relayer.`
    );
  }
  assertExactRole('JOB_ESCROW_OWNER', owner, MAINNET_PRODUCTION_ROLES.owner, 'owner/Safe');
  assertExactRole('JOB_ESCROW_ARBITER', arbiter, MAINNET_PRODUCTION_ROLES.arbiter, 'arbiter');
  assertExactRole('JOB_ESCROW_TREASURY_SINK', treasurySink, MAINNET_PRODUCTION_ROLES.treasurySink, 'treasury sink');
  assertExactRole('JOB_ESCROW_RELAYER', relayer, MAINNET_PRODUCTION_ROLES.relayer, 'relayer');
  assertExactRole('SPEND_LIMIT_OWNER', spendLimitOwner ?? owner, MAINNET_PRODUCTION_ROLES.owner, 'owner/Safe');
  assertExactRole('SPEND_LIMIT_RECORDER', spendLimitRecorder ?? relayer, MAINNET_PRODUCTION_ROLES.relayer, 'relayer');
}

// Payroll roles (scripts/deploy-payroll.mjs): PAYROLL_OWNER must equal the
// production Safe, PAYROLL_RELAYER must equal the production relayer.
export function assertMainnetPayrollRoles({ owner, relayer }) {
  for (const [envName, value] of [
    ['PAYROLL_OWNER', owner],
    ['PAYROLL_RELAYER', relayer],
  ]) {
    if (!value) throw new Error(`${envName} is not set — refusing to deploy on Arc Mainnet (chain 5042).`);
    assertNotTestnetRole(envName, value);
  }
  if (norm(owner) === norm(relayer)) {
    throw new Error(
      `PAYROLL_OWNER (${owner}) must not equal PAYROLL_RELAYER — refusing to deploy on Arc Mainnet (chain 5042). ` +
        `Ownership stays on the production Safe; operation stays on the relayer.`
    );
  }
  assertExactRole('PAYROLL_OWNER', owner, MAINNET_PRODUCTION_ROLES.owner, 'owner/Safe');
  assertExactRole('PAYROLL_RELAYER', relayer, MAINNET_PRODUCTION_ROLES.relayer, 'relayer');
}
