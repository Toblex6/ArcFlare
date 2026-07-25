// src/lib/middleware/withAdminAuth.ts
// Admin auth is deliberately its own thing — not a role flag on Merchant,
// not reachable via any merchant/consumer credential. A single admin
// identity, checked against env vars, its own signed cookie. This is you,
// the platform owner, not a customer role.

import { NextRequest } from 'next/server';
import { jwtVerify, SignJWT } from 'jose';

const ADMIN_JWT_SECRET = new TextEncoder().encode(
    process.env.ADMIN_JWT_SECRET || 'flarehq-admin-secret-change-in-production'
);

export async function resolveAdminSession(req: NextRequest): Promise<boolean> {
    const token = req.cookies.get('admin_token')?.value;
    if (!token) return false;
    try {
        const { payload } = await jwtVerify(token, ADMIN_JWT_SECRET);
        return payload.role === 'admin';
    } catch {
        return false;
    }
}

export async function issueAdminToken(): Promise<string> {
    return new SignJWT({ role: 'admin' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('12h')
        .sign(ADMIN_JWT_SECRET);
}