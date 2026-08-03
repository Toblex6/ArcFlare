// src/app/api/test/echo/route.ts
// Trivial internal target for validating the marketplace proxy without
// depending on a third-party demo API's uptime/bot-blocking. Not for
// production listings — just a stable thing to point targetUrl at while testing.

import { NextRequest, NextResponse } from 'next/server';

async function echo(req: NextRequest) {
    let body: unknown = null;
    try {
        body = await req.text();
    } catch {
        // no body — fine
    }
    return NextResponse.json({
        ok: true,
        method: req.method,
        receivedBody: body,
        timestamp: new Date().toISOString(),
    });
}

export const GET = echo;
export const POST = echo;
export const PUT = echo;
export const DELETE = echo;