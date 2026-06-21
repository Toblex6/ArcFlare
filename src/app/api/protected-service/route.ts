import { NextResponse } from 'next/server';

/**
 * POST /api/protected-service
 * Fully automated environment resolution for ArcFlare Gateway Rails
 */
export async function POST(request: Request) {
  try {
    const headerToken = request.headers.get('X-ArcFlare-Reference');

    // 1. Dynamically extract the origin (handles localhost or Render automatically)
    const { origin } = new URL(request.url);

    // If no tracking reference header is attached, issue the challenge
    if (!headerToken) {
      return NextResponse.json(
        {
          status: false,
          error: 'Payment Required',
          message: 'This resource is protected by ArcFlare Agentic Paywalls.',
          payment_instructions: {
            currency: 'USDC',
            amount: 0.1,
            chain: 'Arc-L1',
            // 👇 Dynamically uses localhost on your machine, or Render when live!
            initialization_endpoint: `${origin}/api/payments/initialize`,
          },
        },
        {
          status: 402,
          headers: { 'WWW-Authenticate': 'ArcFlare-USDC-Micropayment' },
        }
      );
    }

    // 2. Dynamically look up the verification route on the current running host
    const verificationUrl = `${origin}/api/payments/verify/${headerToken}`;

    console.log(`📡 [Gatekeeper]: Verifying reference via: ${verificationUrl}`);

    // 3. Query the internal validation route
    const verifyCheck = await fetch(verificationUrl);
    const verifyResult = await verifyCheck.json();

    if (!verifyResult.status || verifyResult.data.status !== 'SUCCESS') {
      return NextResponse.json(
        {
          status: false,
          error: 'Payment Unverified',
          message: 'The provided payment reference has not been settled on-chain yet.',
          verification_check_url: verificationUrl,
        },
        { status: 402 }
      );
    }

    // 4. Access Granted!
    return NextResponse.json(
      {
        status: true,
        message: 'Access Granted. Resource unlocked successfully.',
        data: {
          secretPayload:
            'Welcome to the agentic economy. This is secure data processed autonomously.',
          computedBy: 'ArcFlare Gateway Engine',
        },
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ Gatekeeper Failure:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}
