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
// Allowlist for new deployments. It does not describe existing deployments.
export const MAINNET_PRODUCTION_ROLES = Object.freeze({
  /** OWNER / SAFE (also SPEND_LIMIT_OWNER, PAYROLL_OWNER) */
  owner: '0x0B0c2386CAbfeE832b8C5781751aa547b63Eb07e',
  arbiter: '0xBCE45360f06f705Dc7eFaA0e5F170a7c710ecaAd',
  /** RELAYER (also SPEND_LIMIT_RECORDER, PAYROLL_RELAYER) */
  relayer: '0xf3b3947673B27197B228a3712dDC806a7392D2cf',
  get treasurySink() { return this.owner; },
});

export const MAINNET_ESCROW_DEPLOYER = '0xA2228A6541C1be0792BdBB30D7aC8663f81B7cAD';
export const MAINNET_ESCROW_SAFE = Object.freeze({
  singleton: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  owners: Object.freeze([
    '0x24Fb5F47b710b27f190bfb05f4705d3cb65A8197',
    '0x1682f32ae97d5e209b40fea9e8446804458aac1a',
    '0xf981856e9d5422a49f3945c136dddfe299b51d28',
  ]),
  version: '1.5.0',
  threshold: 2n,
  nonce: 0n,
});

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

export function matchesMainnetEscrowSafe({ singleton, version, threshold, nonce, owners }) {
  const expected = MAINNET_ESCROW_SAFE;
  return norm(singleton) === norm(expected.singleton)
    && version === expected.version && threshold === expected.threshold && nonce === expected.nonce
    && owners.length === expected.owners.length
    && owners.map(norm).sort().join(',') === expected.owners.map(norm).sort().join(',');
}

function assertNotTestnetRole(envName, value) {
  const hit = KNOWN_TESTNET_ROLE_ADDRESSES.some((t) => norm(t) === norm(value));
  if (hit) {
    throw new Error(
      `${envName} is a KNOWN TESTNET address — refusing to assign a testnet role on Arc Mainnet (chain 5042). ` +
        `This is the exact failure that produced the abandoned 0x62Ca…fA4fA deployment. Supply the production address.`
    );
  }
}

function assertExactRole(envName, value, expected, label) {
  if (norm(value) !== norm(expected)) {
    throw new Error(
      `${envName} does not match the production ${label} ${expected} — refusing to deploy on Arc Mainnet (chain 5042). ` +
        `Mainnet roles are allowlisted exactly; supply the production address.`
    );
  }
}

export function assertMainnetFlareHQEscrowRoles({ arbiter, treasury, deployer }) {
  for (const [name, value, expected, label] of [
    ['ESCROW_ARBITER_ADDRESS', arbiter, MAINNET_PRODUCTION_ROLES.arbiter, 'arbiter'],
    ['ESCROW_TREASURY_ADDRESS', treasury, MAINNET_PRODUCTION_ROLES.treasurySink, 'treasury Safe'],
    ['Derived deployer address', deployer, MAINNET_ESCROW_DEPLOYER, 'escrow deployer'],
  ]) {
    if (!value) throw new Error(`${name} is not set — refusing to deploy on Arc Mainnet (chain 5042).`);
    assertNotTestnetRole(name, value);
    assertExactRole(name, value, expected, label);
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
