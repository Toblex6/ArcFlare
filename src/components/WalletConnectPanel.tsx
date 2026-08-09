'use client';

// src/components/WalletConnectPanel.tsx
//
// Reusable SIWE (Sign-In With Ethereum) connect flow. Connects via wagmi
// (MetaMask/injected on desktop, WalletConnect deep-links into mobile
// wallet apps — same setup already proven working in the checkout page),
// requests a nonce challenge, signs it, and posts to
// /api/merchant/wallet/connect to link the wallet — only after the
// merchant has proven they actually control the address.
//
// Mobile-first: every size uses clamp() so it scales down cleanly on small
// screens, buttons are full-width and stack vertically, nothing relies on
// hover states or fixed pixel widths that would overflow a narrow viewport.

import React, { useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi';

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
  // Injected wallets that aren't MetaMask (Rabby, Brave Wallet, etc.) —
  // still a standard EIP-1193 signer, closest bucket is METAMASK since
  // that's the injected-connector-family label users recognize.
  return 'METAMASK';
}

export default function WalletConnectPanel({ onConnected }: WalletConnectPanelProps) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleLinkWallet = async () => {
    if (!address) return;
    setLinking(true);
    setError(null);
    setSuccess(null);
    try {
      // Step 1 — get a nonce challenge, tied to this merchant's session
      // via the merchant_token cookie (sent automatically, same-origin).
      const challengeRes = await fetch(`/api/merchant/wallet/connect?address=${address}`);
      const challengeData = await challengeRes.json();
      if (!challengeData.success) throw new Error(challengeData.error);

      // Step 2 — sign the challenge message with the connected wallet.
      const signature = await signMessageAsync({ message: challengeData.message });

      // Step 3 — verify + link.
      const connectorName = connectors.find((c) => c.uid)?.name || 'MetaMask';
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
      setError(err.message || 'Could not link this wallet.');
    } finally {
      setLinking(false);
    }
  };

  const busy = isConnecting || isSigning || linking;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(10px, 1.5vw, 14px)', width: '100%' }}>
      {!isConnected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          {connectors.map((c) => (
            <button
              key={c.uid}
              onClick={() => connect({ connector: c })}
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
              {isConnecting ? 'Connecting...' : `Connect ${c.name}`}
            </button>
          ))}
          {connectors.length === 0 && (
            <p style={{ fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)', margin: 0 }}>
              No wallet connectors configured.
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

      {(error || connectError) && (
        <p style={{ color: 'var(--danger)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0, wordBreak: 'break-word' }}>
          ❌ {error || connectError?.message}
        </p>
      )}
      {success && (
        <p style={{ color: 'var(--success)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0, wordBreak: 'break-word' }}>
          ✓ {success}
        </p>
      )}
    </div>
  );
}
