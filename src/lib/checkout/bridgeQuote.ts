import { BridgeKit } from '@circle-fin/bridge-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { formatBridgeBaseUnits, type BridgeSourceChain } from '@/lib/bridge/sourceChains';
import { estimatedBridgeFee, grossUpInvoiceAmount } from './bridgeGross';

export async function quoteCheckoutBridge(input: {
  source: BridgeSourceChain;
  network: 'mainnet' | 'testnet';
  payer: `0x${string}`;
  destination: `0x${string}`;
  shortfall: bigint;
}) {
  type Provider = Parameters<typeof createViemAdapterFromProvider>[0]['provider'];
  const request = async ({ method }: { method: string }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [input.payer];
    if (method === 'eth_chainId') return `0x${input.source.chainId.toString(16)}`;
    throw new Error('Checkout quote adapter has no signing or execution access.');
  };
  const provider: Provider = { request: request as Provider['request'], on() {}, removeListener() {} };
  const adapter = await createViemAdapterFromProvider({ provider });
  const kit = new BridgeKit();
  const params = {
    from: { adapter, chain: input.source.id },
    to: { chain: input.network === 'mainnet' ? 'Arc' : 'Arc_Testnet', recipientAddress: input.destination, useForwarder: true },
    token: 'USDC',
  } as Omit<Parameters<BridgeKit['estimate']>[0], 'amount'>;
  async function estimate(amount: bigint) {
    const result = await kit.estimate({ ...params, amount: formatBridgeBaseUnits(amount) });
    return estimatedBridgeFee(result.fees);
  }
  // Requote the actual gross because a percentage component can change with it.
  let gross = grossUpInvoiceAmount(input.shortfall, await estimate(input.shortfall));
  for (let attempt = 0; attempt < 3; attempt++) {
    const fee = await estimate(gross);
    const required = grossUpInvoiceAmount(input.shortfall, fee);
    if (gross >= required) return { gross, fee };
    gross = required;
  }
  throw new Error('The live bridge fee estimate did not stabilize.');
}
