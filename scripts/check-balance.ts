import { getCircleClient } from '../src/lib/circle/client';

async function main() {
  const client = getCircleClient();
  const walletId = '4c2cb05e-f6bb-5cdb-994f-bfdaba87c49b';
  const balance = await client.getWalletTokenBalance({ id: walletId });
  console.log(JSON.stringify(balance.data, null, 2));
}
main();
