import { getCircleClient } from '../src/lib/circle/client';

async function main() {
  const client = getCircleClient();
  // Replace with the actual Circle transaction ID from the error message
  // For example, from the latest error: "6c0dd74d-6a2c-5794-9591-129982a25684"
  const txId = '6c0dd74d-6a2c-5794-9591-129982a25684';
  const tx = await client.getTransaction({ id: txId });
  console.log(JSON.stringify(tx.data, null, 2));
}
main();
