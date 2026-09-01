'use client';

// src/components/WalletConnectPanel.tsx
//
// Reusable SIWE connect flow for merchant dashboard settings.
// Connects via wagmi (EIP-6963 injected discovery on desktop, WalletConnect
// deep-links on mobile), requests a nonce challenge, signs it, and posts to
// /api/merchant/wallet/connect — only after the wallet proves control.

import React, { useEffect, useState, useRef } from 'react';
import { useAccount, useConnect, useDisconnect, useSignMessage, useChainId, useSwitchChain } from 'wagmi';
import { arcTestnet } from '@/lib/wagmi';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { dedupeConnectors, friendlyConnectorLabel, hasInjectedProvider, isMobileViewport, withTimeout } from '@/lib/wallet/walletLabels';

interface WalletConnectPanelProps {
  onConnected?: (result: { walletProvider: string; walletAddress: string }) => void;
}

const WALLET_KIND_BY_CONNECTOR_NAME: Record<string, string> = {
  MetaMask: 'METAMASK',
  'Coinbase Wallet': 'COINBASE',
  WalletConnect: 'WALLETCONNECT',
};

function guessWalletKind(connectorName: string): string {
  for (const [key, kind] of Object.entries(WALLET_KIND_BY_CONNECTOR_NAME)) {
    if (connectorName.toLowerCase().includes(key.toLowerCase())) return kind;
  }
  return 'METAMASK';
}

const CONNECT_TIMEOUT_MS = 45000;

export default function WalletConnectPanel({ onConnected }: WalletConnectPanelProps) {
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [linking, setLinking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const pageUrlRef = useRef<string>('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') pageUrlRef.current = window.location.href;
  }, []);

  useEffect(() => {
    if (connectError) setError(friendlyWalletError(connectError));
  }, [connectError]);

  const deduped = dedupeConnectors(connectors);
  const injectedConnectors = deduped.filter((c) => c.type === 'injected');
  const walletConnectConnector = deduped.find((c) => c.type === 'walletConnect');
  const otherConnectors = deduped.filter((c) => c.type !== 'injected' && c.type !== 'walletConnect');

  const isMobile = mounted ? isMobileViewport() : false;
  const hasProvider = mounted ? hasInjectedProvider() : false;
  const showInjected = !(isMobile && !hasProvider);

  const handleConnect = async (connector: (typeof connectors)[number]) => {
    setError(null);
    setConnecting(true);
    try {
      await withTimeout(connectAsync({ connector }), CONNECT_TIMEOUT_MS, 'Wallet connection timed out');
    } catch (err: any) {
      setError(friendlyWalletError(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleLinkWallet = async () => {
    if (!address) return;
    setLinking(true);
    setError(null);
    setSuccess(null);
    setNetworkMismatch(false);
    setShowTechnical(false);
    try {
      if (chainId !== arcTestnet.id) {
        const getProvider = async () => {
          try {
            return await (activeConnector as any)?.getProvider?.();
          } catch {
            return null;
          }
        };
        const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider });
        if (!net.ok) {
          setNetworkMismatch(true);
          setError(net.message);
          setLinking(false);
          return;
        }
      }

      const challengeRes = await fetch(`/api/merchant/wallet/connect?address=${address}`);
      const challengeData = await challengeRes.json();
      if (!challengeData.success) throw new Error(challengeData.error);

      const signature = await Promise.race([
        signMessageAsync({ message: challengeData.message }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Your wallet didn't respond. Open your wallet app and try again.")), 60000)
        ),
      ]);

      const connectorName = activeConnector?.name || 'MetaMask';
      const walletKind = guessWalletKind(connectorName);

      const verifyRes = await fetch('/api/merchant/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          message: challengeData.message,
          signature,
          walletKind,
        }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) throw new Error(verifyData.error);

      setSuccess(`Connected — payments will now settle to ${address.slice(0, 6)}...${address.slice(-4)}.`);
      onConnected?.(verifyData.wallet);
    } catch (err: any) {
      setError(friendlyWalletError(err) || 'Could not link this wallet. Please try again.');
    } finally {
      setLinking(false);
    }
  };

  const busy = connecting || isConnecting || isSigning || linking;
  const pageUrl = pageUrlRef.current || (typeof window !== 'undefined' ? window.location.href : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(10px, 1.5vw, 14px)', width: '100%' }}>
      {!isConnected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          {showInjected &&
            injectedConnectors.map((c) => (
              <button
                key={c.uid}
                onClick={() => handleConnect(c)}
                disabled={busy}
                style={{
                  width: '100%',
                  padding: 'clamp(12px, 1.6vw, 16px)',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  fontSize: 'clamp(13px, 1.1vw, 15px)',
                  fontWeight: 700,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  background: 'var(--surface-secondary)',
                  color: 'var(--text)',
                  boxSizing: 'border-box',
                }}
              >
                {busy ? 'Connecting...' : `Connect ${friendlyConnectorLabel(c)}`}
              </button>
            ))}

          {walletConnectConnector && (
            <button
              key={walletConnectConnector.uid}
              onClick={() => handleConnect(walletConnectConnector)}
              disabled={busy}
              style={{
                width: '100%',
                padding: 'clamp(12px, 1.6vw, 16px)',
                borderRadius: 12,
                border: '1px solid var(--border)',
                fontSize: 'clamp(13px, 1.1vw, 15px)',
                fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer',
                background: 'var(--surface-secondary)',
                color: 'var(--text)',
                boxSizing: 'border-box',
              }}
            >
              {busy ? 'Connecting...' : !showInjected ? 'Connect Wallet' : 'Connect with WalletConnect'}
            </button>
          )}

          {otherConnectors.map((c) => (
            <button
              key={c.uid}
              onClick={() => handleConnect(c)}
              disabled={busy}
              style={{
                width: '100%',
                padding: 'clamp(12px, 1.6vw, 16px)',
                borderRadius: 12,
                border: '1px solid var(--border)',
                fontSize: 'clamp(13px, 1.1vw, 15px)',
                fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer',
                background: 'var(--surface-secondary)',
                color: 'var(--text)',
                boxSizing: 'border-box',
              }}
            >
              {busy ? 'Connecting...' : `Connect ${friendlyConnectorLabel(c)}`}
            </button>
          ))}

          {injectedConnectors.length === 0 && !walletConnectConnector && otherConnectors.length === 0 && (
            <p style={{ fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)', margin: 0 }}>
              Wallet connections are temporarily unavailable. Please refresh or try again later.
            </p>
          )}

          {isMobile && !hasProvider && walletConnectConnector && (
            <>
              <p style={{ fontSize: 'clamp(12px, 1vw, 14px)', color: 'var(--text)', margin: '4px 0 0', fontWeight: 600, lineHeight: 1.5 }}>
                Connect your wallet to pay on Arc Testnet.
              </p>
              <p style={{ fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)', margin: '0', lineHeight: 1.5 }}>
                Open this page in your wallet app, or copy the link below and open it there.
              </p>
            </>
          )}
          {isMobile && !hasProvider && pageUrl && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                readOnly
                value={pageUrl}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  background: 'var(--surface-secondary)',
                  color: 'var(--text)',
                }}
              />
              <button
                onClick={() => navigator.clipboard.writeText(pageUrl)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: 'var(--surface-secondary)',
                  color: 'var(--text)',
                  flexShrink: 0,
                }}
              >
                Copy link
              </button>
            </div>
          )}

          {!walletConnectConnector && isMobile && !hasProvider && (
            <p style={{ fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
              WalletConnect isn&apos;t configured for this deployment. On mobile, open this page inside your wallet app&apos;s
              browser.
            </p>
          )}
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              background: 'var(--surface-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 'clamp(10px, 1.5vw, 14px)',
            }}
          >
            <span
              style={{
                fontFamily: 'monospace',
                fontSize: 'clamp(11px, 1vw, 13px)',
                color: 'var(--text)',
                wordBreak: 'break-all',
              }}
            >
              {address}
            </span>
            <button
              onClick={() => disconnect()}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--primary)',
                cursor: 'pointer',
                fontSize: 'clamp(11px, 1vw, 13px)',
                fontWeight: 600,
                padding: 0,
                flexShrink: 0,
              }}
            >
              Disconnect
            </button>
          </div>

          <button
            onClick={handleLinkWallet}
            disabled={busy}
            style={{
              width: '100%',
              padding: 'clamp(12px, 1.6vw, 16px)',
              borderRadius: 12,
              border: 'none',
              fontSize: 'clamp(13px, 1.1vw, 15px)',
              fontWeight: 800,
              cursor: busy ? 'not-allowed' : 'pointer',
              background: busy ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
              color: busy ? 'rgba(14,11,8,0.5)' : 'var(--background)',
              boxSizing: 'border-box',
            }}
          >
            {isSigning ? 'Sign the message in your wallet...' : linking ? 'Linking...' : 'Sign to prove ownership & connect'}
          </button>
        </>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0, wordBreak: 'break-word' }}>
          ❌ {error}
        </p>
      )}
      {networkMismatch && (
        <div style={{ background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: 'clamp(10px, 1.5vw, 14px)' }}>
          <p style={{ color: 'var(--text)', fontSize: 'clamp(11px, 1vw, 13px)', fontWeight: 600, margin: '0 0 6px', lineHeight: 1.5 }}>
            FlareHQ uses Arc Testnet for this payment. Your wallet couldn&apos;t switch automatically. Open your wallet and select/add{' '}
            <strong>Arc Testnet</strong>, then return here and try again.
          </p>
          <button
            onClick={() => setShowTechnical((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--primary)',
              cursor: 'pointer',
              fontSize: 'clamp(11px, 1vw, 13px)',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {showTechnical ? 'Hide technical details' : 'Show technical details'}
          </button>
          {showTechnical && (
            <div style={{ marginTop: 10 }}>
              {[
                ['Network Name', 'Arc Testnet'],
                ['Chain ID', String(arcTestnet.id)],
                ['RPC URL', arcTestnet.rpcUrls.default.http[0]],
                ['Currency Symbol', 'ARC'],
                ['Block Explorer', arcTestnet.blockExplorers.default.url],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 'clamp(10px, 0.9vw, 12px)',
                    color: 'var(--text-secondary)',
                    padding: '4px 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span>{label}</span>
                  <span
                    style={{ color: 'var(--text)', fontFamily: 'monospace', cursor: 'pointer', wordBreak: 'break-all', textAlign: 'right' }}
                    onClick={() => navigator.clipboard.writeText(value)}
                    title="Tap to copy"
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {success && (
        <p style={{ color: 'var(--success)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0, wordBreak: 'break-word' }}>
          ✓ {success}
        </p>
      )}
    </div>
  );
}
