// src/components/ConnectorLogo.tsx
//
// EIP-6963 wallet icon for the connect-wallet pickers. wagmi v3 connectors
// carry the wallet's own announced icon (typically a data URI) on `icon` —
// rendered as-is, never invented. When absent (e.g. WalletConnect, generic
// "Browser Wallet") the row stays text-only. Same trust basis as the
// announced name already rendered by friendlyConnectorLabel.

import React from "react";

export function ConnectorLogo({ c }: { c: { icon?: unknown; name?: unknown } }) {
  const icon = (c as { icon?: unknown })?.icon;
  if (typeof icon !== "string" || icon.length === 0) return null;
  return (
    <img
      src={icon}
      alt=""
      aria-hidden="true"
      width={22}
      height={22}
      style={{ borderRadius: 6, flexShrink: 0 }}
    />
  );
}
