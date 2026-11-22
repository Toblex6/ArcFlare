// FlareHQ Jobs role-aware UI regression suite.
//
// Pure view-model + static wiring checks only: no browser, database, RPC,
// wallet, signing or funds. The production module is compiled directly so
// these assertions fail on the pre-fix page/behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTypescript } from './fixtures/load-typescript.mjs';

const view = loadTypescript('src/lib/jobs/flarehqJobsView.ts', {});
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const client = `0x${'11'.repeat(20)}`;
const provider = `0x${'22'.repeat(20)}`;
const applicant = `0x${'33'.repeat(20)}`;
const outsider = `0x${'44'.repeat(20)}`;

function makeJob(overrides = {}) {
  return {
    status: 'OPEN',
    clientAddress: client,
    providerAddress: null,
    applications: [{ id: 'app1', applicantAddress: applicant, pitch: 'I can ship this today.', status: 'PENDING' }],
    ...overrides,
  };
}

test('client sees Select provider and never the Apply box', () => {
  const result = view.jobViewFor(makeJob(), client);
  assert.equal(result.role, 'client');
  assert.equal(result.canApply, false);
  assert.equal(result.showApplyBox, false);
  assert.equal(result.showSelectProvider, true);
  assert.equal(result.showApplications, true);
  assert.equal(result.application, null);
});

test('a non-client visitor sees job details and the Apply box only', () => {
  const result = view.jobViewFor(makeJob(), outsider);
  assert.equal(result.role, 'visitor');
  assert.equal(result.canApply, true);
  assert.equal(result.showApplyBox, true);
  assert.equal(result.showSelectProvider, false);
  assert.equal(result.showApplications, false);
});

test('an applicant gets You applied with pitch + status and no Apply box', () => {
  const result = view.jobViewFor(makeJob(), applicant);
  assert.equal(result.role, 'applicant');
  assert.equal(result.showApplyBox, false);
  assert.equal(result.canApply, false);
  assert.equal(result.showSelectProvider, false);
  assert.equal(result.application.pitch, 'I can ship this today.');
  assert.equal(result.application.status, 'PENDING');
});

test('an applicant stays unable to apply after selection or rejection', () => {
  for (const status of ['SELECTED', 'FUNDED', 'SUBMITTED', 'COMPLETED']) {
    const result = view.jobViewFor(makeJob({
      status,
      providerAddress: provider,
      applications: [{ id: 'app1', applicantAddress: applicant, pitch: 'Pitch', status: 'REJECTED' }],
    }), applicant);
    assert.equal(result.showApplyBox, false, status);
    assert.equal(result.application.status, 'REJECTED', status);
  }
});

test('server rule is mirrored: the client can never apply to its own job', () => {
  assert.equal(view.canApplyToJob(makeJob({ applications: [] }), client), false);
  assert.equal(view.canApplyToJob(makeJob({ applications: [] }), outsider), true);
});

test('apply is closed once the job leaves OPEN', () => {
  for (const status of ['SELECTED', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED']) {
    assert.equal(view.canApplyToJob(makeJob({ status }), outsider), false, status);
  }
});

test('applicant stepper shows only their current step', () => {
  const steps = view.jobViewFor(makeJob(), applicant).steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'Awaiting client selection');
  assert.equal(steps[0].state, 'current');
});

test('client and provider steppers omit steps that are not theirs', () => {
  const clientSteps = view.jobViewFor(makeJob({ status: 'SELECTED', providerAddress: provider }), client).steps;
  assert.deepEqual(clientSteps.map((s) => s.label), ['Select provider', 'Fund escrow', 'Submit work', 'Approve & release']);
  assert.equal(clientSteps.find((s) => s.label === 'Fund escrow').state, 'current');

  const providerSteps = view.jobViewFor(makeJob({ status: 'FUNDED', providerAddress: provider }), provider).steps;
  assert.deepEqual(providerSteps.map((s) => s.label), ['Fund escrow', 'Submit work', 'Accept release']);
  assert.ok(!providerSteps.some((s) => s.label === 'Select provider'));
  assert.equal(providerSteps.find((s) => s.label === 'Submit work').state, 'current');
});

test('a single signed-in wallet is selected automatically', () => {
  const wallet = { address: provider };
  assert.equal(view.resolveDefaultJobActor('', [wallet], null), provider);
  assert.equal(view.resolveDefaultJobActor('', [wallet], makeJob()), provider);
});

test('an explicit valid wallet choice is never overridden', () => {
  const wallets = [{ address: client }, { address: provider }];
  assert.equal(view.resolveDefaultJobActor(provider, wallets, makeJob()), provider);
  assert.equal(view.resolveDefaultJobActor(provider.toUpperCase().replace('0X', '0x'), wallets, makeJob()), provider);
});

test('multiple wallets select the one that matches the job', () => {
  const clientSide = [{ address: client }, { address: provider }, { address: outsider }];
  assert.equal(view.resolveDefaultJobActor('', clientSide, makeJob({ applications: [] })), client);

  const providerSide = [{ address: provider }, { address: client }, { address: applicant }];
  assert.equal(view.resolveDefaultJobActor('', providerSide, makeJob({ status: 'SELECTED', providerAddress: provider, clientAddress: outsider, applications: [] })), provider);

  const applicantSide = [{ address: client }, { address: applicant }, { address: provider }];
  assert.equal(view.resolveDefaultJobActor('', applicantSide, makeJob({ clientAddress: outsider })), applicant);
});

test('multiple wallets stay ambiguous only when nothing matches', () => {
  const wallets = [{ address: client }, { address: provider }];
  assert.equal(view.resolveDefaultJobActor('', wallets, makeJob({ clientAddress: outsider, applications: [] })), '');
  assert.equal(view.resolveDefaultJobActor('', wallets, null), '');
  assert.equal(view.resolveDefaultJobActor('', [], makeJob()), '');
});

test('My Jobs splits posted and applied jobs for the selected wallet', () => {
  const posted = makeJob({ id: 'posted', applications: [] });
  const applied = makeJob({ id: 'applied', clientAddress: provider });
  const unrelated = makeJob({ id: 'unrelated', clientAddress: outsider, applications: [] });
  const result = view.partitionMyJobs([posted, applied, unrelated], applicant);
  assert.deepEqual(result.posted.map((j) => j.id), []);
  assert.deepEqual(result.applied.map((j) => j.id), ['applied']);

  const own = view.partitionMyJobs([posted, applied, unrelated], client);
  assert.deepEqual(own.posted.map((j) => j.id), ['posted']);
  assert.deepEqual(own.applied.map((j) => j.id), []);
});

test('My Jobs empty copy is plain and never asks for a wallet that is already selected', () => {
  assert.equal(view.myJobsEmptyMessage('posted', 0), 'Sign in to see the jobs you posted and applied to.');
  assert.equal(view.myJobsEmptyMessage('posted', 1), 'You have not posted any jobs yet.');
  assert.equal(view.myJobsEmptyMessage('applied', 2), 'You have not applied to any jobs yet.');
});

test('wallet addresses are truncated for display', () => {
  const short = view.shortJobAddress(client);
  assert.ok(short.includes('…'));
  assert.ok(short.length < client.length);
  assert.equal(short, `${client.slice(0, 6)}…${client.slice(-4)}`);
  assert.equal(view.shortJobAddress(''), '');
});

test('sidebar Jobs entry opens the FlareHQ Jobs workspace', () => {
  const sidebar = read('src/components/DashboardSidebar.tsx');
  assert.match(sidebar, /\{ label: 'Jobs', href: '\/flarehq-jobs' \}/);
  assert.doesNotMatch(sidebar, /\{ label: 'Jobs', href: '\/jobs' \}/);
});

test('legacy /jobs page stays reachable and says it is not available on mainnet', () => {
  const legacy = read('src/app/jobs/page.tsx');
  assert.match(legacy, /not available on mainnet/);
  assert.match(legacy, /href="\/flarehq-jobs"/);
});

test('page renders from the role view and keeps only one short escrow line', () => {
  const page = read('src/app/flarehq-jobs/page.tsx');
  assert.match(page, /jobViewFor\(selected, actor\?\.address\)/);
  assert.match(page, /view\.showApplyBox/);
  assert.match(page, /view\.showSelectProvider/);
  assert.match(page, /You applied/);
  assert.match(page, /AddressChip/);
  assert.doesNotMatch(page, /not ERC-8183|does not import its jobs|FlareHQEscrow holds job funds/);
  assert.match(page, /Funds are held in escrow on-chain; FlareHQ never holds them\./);
  assert.match(page, /<AddressChip value=\{selected\.clientAddress\}/);
  assert.match(page, /<AddressChip value=\{app\.applicantAddress\}/);
  assert.doesNotMatch(page, />\{selected\.clientAddress\}</);
  assert.doesNotMatch(page, />\{app\.applicantAddress\}</);
  assert.match(page, /wallets\.length > 1/);
  assert.match(page, /myJobsEmptyMessage\('posted', wallets\.length\)/);
  assert.match(page, /myJobsEmptyMessage\('applied', wallets\.length\)/);
});
