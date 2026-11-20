import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
export class PreflightError extends Error {}

export function checkDeploymentRevision(source, expected) {
  const head = git('rev-parse', 'HEAD').toString().trim();
  if (!/^[0-9a-f]{40}$/.test(expected ?? '') || head !== expected) {
    throw new PreflightError('HEAD must match the full reviewed ESCROW_DEPLOY_COMMIT SHA.');
  }
  if (git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none').length) {
    throw new PreflightError('Refusing deployment: Git working tree is dirty.');
  }
  // Also check bytes explicitly (with Git checkout filters for Windows CRLF).
  // This catches edits hidden by assume-unchanged / skip-worktree flags.
  const bytes = readFileSync(join(root, source));
  const object = `${head}:${source}`;
  if ((!git('cat-file', 'blob', object).equals(bytes) && !git('cat-file', '--filters', object).equals(bytes)) ||
      git('hash-object', `--path=${source}`, source).toString().trim() !== git('rev-parse', `${head}:${source}`).toString().trim()) {
    throw new PreflightError('Refusing deployment: contract source differs from HEAD.');
  }
  return head;
}

export function buildMainnetContract(name) {
  const temp = mkdtempSync(join(tmpdir(), 'flarehq-mainnet-build-'));
  try {
    const source = `contracts/${name}.sol`;
    // Do not load dotenv or expose the deployer key to the compiler subprocess.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|TEMP|TMP)$/i.test(k)));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/hardhat/dist/src/cli.js'), '--config', 'hardhat.local.config.js', 'build', '--force', '--no-tests', source], {
      cwd: root, env: { ...env, FLAREHQ_BUILD_DIR: temp }, stdio: 'ignore',
    });
    if (result.status !== 0) throw new PreflightError('Fresh offline contract build failed. Install locked dependencies and ensure Solidity 0.8.24 is available to Hardhat.');
    return JSON.parse(readFileSync(join(temp, 'artifacts', source, `${name}.json`), 'utf8'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
