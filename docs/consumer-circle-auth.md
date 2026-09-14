# Consumer Circle user-controlled wallet auth

Individual/consumer "FlareHQ wallet" sign-in uses **Circle's user-controlled
wallet model** with Web2 authentication (Google social login, email OTP).
This is intentionally separate from the existing developer-controlled wallet
model (Circle API key + entity secret, server signs) and from the
bring-your-own external wallet flow (nonce challenge + `viem verifyMessage`).

## Architecture chosen

- **Circle Web SDK** (`@circle-fin/w3s-pw-web-sdk`, browser-only) runs the
  OAuth/OTP ceremony and the wallet-creation challenge. Private keys and user
  key material never touch FlareHQ servers.
- **Thin server proxy** (`src/app/api/consumer/circle/route.ts` → pure
  helpers in `src/lib/circle/userControlled.ts`) forwards the five Circle
  REST steps with `CIRCLE_API_KEY`: `social-token`, `email-token`,
  `initialize`, `wallets`, `refresh`. The per-user `userToken` lives in
  browser memory only (never localStorage, never a cookie, never logged).
- **Session link** (`POST /api/consumer/session { circleAuth }`, "Path C")
  verifies the `userToken` server-side via Circle `listWallets`, binds the
  Arc-network wallet, and maps it into the **existing** `consumer_token` JWT
  session (`issueConsumerSessionToken`). No second session system.
- **Returning users** resolve via `ConsumerAccount.circleUserId` OR wallet
  address (`findFirst({ OR: … })`) — same Google/email identity always lands
  on the existing row (`isNew: false`); no duplicates.
- **Custody label**: new rows use
  `ConsumerAccount.walletType = 'USER_CONTROLLED'` (+ `circleUserId`,
  `circleWalletId`, `onboardingSource = 'circle-user-controlled'`). A
  developer-controlled (`CIRCLE` + `walletSetId`) row is never converted —
  address collision across custody models fails closed with `CUSTODY_CONFLICT`.
- **Merchant auth was NOT reused**: merchants stay on email+password →
  `merchant_token` (separate JWT system per repo invariants). Nothing about
  merchant signup/login was changed.
- **Preserved**: external-wallet challenge/signature flow (Path A),
  legacy instant dev-wallet creation (Path B, now tertiary in the UI),
  legacy email-OTP recovery (`/api/consumer/email`, `/api/consumer/recover`)
  for those legacy wallets, wallet switching, and the consumer PIN step-up.

## What a USER_CONTROLLED wallet can / cannot do (honest gating)

- Balances, activity, discovery, escrow viewing: work (on-chain reads).
- Flow Swap: requires a browser-signable wallet — user-controlled wallets
  land in the existing "Use a wallet you control" notice alongside legacy
  Circle wallets (only `EXTERNAL` is wagmi-signable). No swap math changed.
- Send / scheduled Save / settle: the server cannot sign for these wallets
  (only the owner signs through Circle), so settle and scheduled creation
  fail closed with an explicit message instead of debiting anything else.
- Bridge (CCTP v2): supported via the server-orchestrated,
  browser-executed burn flow. `POST /api/cctp/transfer` (with a per-request
  `userToken`, never stored) resolves the user's source-chain wallet from
  Circle's authoritative list, checks the TokenMessenger allowance, and
  returns a challenge (`needs-provision` / `needs-approval` / `needs-burn`)
  that the browser executes through the Web SDK
  (`UserControlledBridge.tsx`: setAuthentication → execute). The browser
  then advances via `POST /api/cctp/transfer/challenge` (challenge →
  Circle tx → mined-receipt verification, Pattern A on the burn event) and
  polls `GET /api/cctp/transfer/status` for the Arc mint (balance-delta —
  the destination mint needs no wallet signature, Circle's relayer
  completes it). Source-chain balances for these wallets are read straight
  from the chain (USDC `balanceOf`), no Circle call needed.
  Signing-model authority: `src/lib/wallet/signingModel.ts`
  (`server-signed` / `user-controlled-challenge` / `external-eoa` /
  `unsupported`) — routes branch on the model, never on raw `walletType`
  strings. Calldata authority: `src/lib/circle/cctpChallenge.ts` (mirrors
  `@circle-fin/adapter-viem-v2` 1:1; SLOW path only, maxFee 0 — FAST fee
  pricing is future work).

## Required console configuration (cannot be done from code)

1. **Google Cloud Console**
   - New project → Google Auth Platform → app name, support email,
     audience **External**.
   - Create OAuth client → type **Web application** → Authorized redirect
     URIs: every origin that serves `/consumer` (e.g.
     `http://localhost:3000`, `https://<your-domain>`).
   - Copy the OAuth **Client ID** → `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
   - **Audience → Publish app** (or add test users) or only your own
     account can sign in.
2. **Circle Developer Console → Wallets → User Controlled → Configurator**
   - Authentication Methods → Social Logins → Google → paste the Client ID
     into **Client ID (Web)**.
   - Authentication Methods → Email → From address + your SMTP
     host/port/username/password (Circle sends OTPs via your provider).
   - Copy the **App ID** → `CIRCLE_APP_ID` and `NEXT_PUBLIC_CIRCLE_APP_ID`.
3. **Environment** (see `.env.example`): `CIRCLE_API_KEY` (existing),
   `CIRCLE_APP_ID`, `NEXT_PUBLIC_CIRCLE_APP_ID`,
   `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Without `CIRCLE_APP_ID` the proxy fails
   closed (`CIRCLE_APP_ID_MISSING`) and the UI shows the not-configured
   state with external-wallet fallback.

## Env summary

| Variable | Scope | Purpose |
|---|---|---|
| `CIRCLE_API_KEY` | server (existing) | proxy credential for Circle REST |
| `CIRCLE_APP_ID` | server (new) | user-controlled configurator id |
| `NEXT_PUBLIC_CIRCLE_APP_ID` | browser (new) | Web SDK `appSettings.appId` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | browser (new) | Web SDK Google `clientId` |
| `CIRCLE_BASE_URL` | server (optional) | REST override, https only |

## Limitations / non-goals

- No server-side Google OAuth: intentionally — Circle's Web SDK owns the
  social flow (per Circle docs, the supported integration).
- No in-app signing for user-controlled wallets yet except the CCTP bridge
  burn flow above (send/swap/settle from these wallets via Circle
  challenge-based signing is future work; those routes fail closed with
  explicit messages today). The bridge ships SLOW finality only (maxFee 0);
  FAST burns need the Iris fee-tier pricing wired into `cctpChallenge.ts`
  first.
- Google and email identities are distinct Circle users (Circle-side
  behavior): signing in with Google then email creates two Circle users and
  therefore two FlareHQ rows — documented, not deduplicated.
