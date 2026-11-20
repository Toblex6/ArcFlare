// Pure/static standalone stream tests — no DB/RPC/funds.
import { readFileSync } from 'node:fs';
import { parseStreamAmount, formatStreamAmount } from '../src/lib/stream/standalone';
import { computeTrancheAmounts } from '../src/lib/contracts/streamContract';
let passed=0, failed=0; const ok=(n:string,c:boolean)=>c?(passed++,console.log(`  ✅ ${n}`)):(failed++,console.log(`  ❌ ${n}`)); const read=(p:string)=>readFileSync(p,'utf8');
ok('amount parser uses six decimals', parseStreamAmount('1.000001')===1_000_001n); ok('formatter uses six decimals', formatStreamAmount(1_000_001n)==='1.000001');
for(const bad of ['', '0','-1','1.0000001','abc']){let t=false;try{parseStreamAmount(bad)}catch{t=true}ok(`rejects ${JSON.stringify(bad)}`,t)}
const split=computeTrancheAmounts(10n,3); ok('split floors first tranches',split[0]===3n&&split[1]===3n);ok('remainder lands in last tranche',split[2]===4n);ok('split sums exactly',split.reduce((a,b)=>a+b,0n)===10n);
const routes=['src/app/api/streams/route.ts','src/app/api/streams/[reference]/release/route.ts','src/app/api/streams/[reference]/close/route.ts'];
for(const f of routes){const s=read(f);ok(`${f} stream-gated`,s.includes('streamAddressOr503'));ok(`${f} has no ERC-8183 dependency`,!/erc8183|Erc8183Job/i.test(s));ok(`${f} uses single ownership gate`,s.includes('verifyCallerControlsAddress'))}
const create=read(routes[0]), release=read(routes[1]), close=read(routes[2]);
ok('create invokes standalone openStream',create.includes('openStream(address,address,uint256,uint256)'));ok('create accepts 1–50 tranches',create.includes('trancheCount > 50'));ok('external create is receipt/state verified',create.includes('verifyStreamTransaction')&&create.includes('exactStreamState'));ok('release invokes releaseTranche',release.includes('releaseTranche(uint256,uint256)'));ok('release checks authoritative state',release.includes('readStreamOnChain'));ok('close invokes closeStream',close.includes('closeStream(uint256)'));ok('close proves remainder paid',close.includes('state.totalReleased !== state.totalBudget'));ok('close labels no-refund semantics',close.includes('not a refund'));
const config=read('src/lib/config/network.ts');ok('mainnet stream pin is centralized',config.includes('MAINNET_STREAM_CONTRACT_ADDRESS')&&config.includes('0x79230A415dF3B22cD8c7DDB9b7Cd1f860e95375e'));
console.log(`\nstandalone-stream-tests: ${passed} passed, ${failed} failed`);if(failed)process.exit(1);
