// Intentionally no signer, key loading, provider, or deployment operation.
import { readFile } from 'node:fs/promises';
if (process.argv.length > 2) throw new Error('Dry-run only: no execution flags accepted.');
const artifact = JSON.parse(await readFile('artifacts/contracts/FlareHQEscrow.sol/FlareHQEscrow.json', 'utf8'));
console.log(JSON.stringify({ mode: 'dry-run-only', contract: artifact.contractName, bytecodeBytes: (artifact.bytecode.length - 2) / 2, constructor: ['network-resolved USDC token', '0xb54f4Fa6F155CAb249f6Bbc194F2D5f363d4D9b4'], next: 'Owner review required. Keep ARC_MAINNET_ESCROW_ADDRESS unset until deployment and verification.' }, null, 2));
