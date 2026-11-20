// Server-only configuration check for the browser-signed Bridge Kit flow.
// The topology still fails closed here; production readiness was separately
// proven by the completed Base → Arc transfer recorded on 2026-11-19.
import { Arc, ArcTestnet } from '@circle-fin/bridge-kit/chains';
import { getArcChain, getNetworkConfig } from '@/lib/config/network';
import { getBridgeSourceChains } from './sourceChains';

if (typeof window !== 'undefined') throw new Error('externalAvailability is server-only.');

export function getExternalBridgeAvailability() {
  try {
    const network = getNetworkConfig();
    const destination = network.name === 'mainnet' ? Arc : ArcTestnet;
    const transmitter = (destination.cctp?.contracts?.v2 as any)?.messageTransmitter;
    const aligned = destination.chainId === network.chainId &&
      destination.cctp?.domain === network.cctpDomain &&
      destination.usdcAddress?.toLowerCase() === network.usdcAddress.toLowerCase() &&
      typeof transmitter === 'string' && transmitter.toLowerCase() === network.cctpMessageTransmitter.toLowerCase();
    if (!aligned) throw new Error('Bridge Kit destination does not match the active network.');
    return {
      available: true,
      network: network.name,
      status: 'available',
      destination: { id: destination.chain, label: getArcChain().name, chainId: network.chainId },
      sourceChains: getBridgeSourceChains(network.name),
      message: null,
    };
  } catch {
    return { available: false, network: null, status: 'unavailable', sourceChains: [], message: 'External bridging is unavailable: the configured destination does not match the installed Bridge Kit.' };
  }
}
