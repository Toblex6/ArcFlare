// src/app/api/admin/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { issueAdminToken } from '@/src/lib/middleware/withAdminAuth';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { timingSafeEqual, createHash } from 'crypto';

export async function POST(req: NextRequest) {
    try {
        // M8: strict rate-limit tier on this privileged route (5/min).
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'keys');
        if (!allowed) return limitResponse;

        const { email, password } = await req.json().catch(() => ({}));

        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminEmail || !adminPassword) {
            return NextResponse.json(
                { success: false, error: 'Admin login is not configured.' },
                { status: 500 }
            );
        }

        // M8: constant-time comparison — hash both sides to a fixed length
        // first (timingSafeEqual throws on length mismatch), then compare.
        // A plaintext !== would leak credential-prefix timing.
        const emailDigest = createHash('sha256').update(String(email ?? '')).digest();
        const expectedEmailDigest = createHash('sha256').update(adminEmail).digest();
        const passDigest = createHash('sha256').update(String(password ?? '')).digest();
        const expectedPassDigest = createHash('sha256').update(adminPassword).digest();
        const emailOk = timingSafeEqual(emailDigest, expectedEmailDigest);
        const passOk = timingSafeEqual(passDigest, expectedPassDigest);
        if (!emailOk || !passOk) {
            return NextResponse.json(
                { success: false, error: 'Invalid credentials.' },
                { status: 401 }
            );
        }

        const token = await issueAdminToken();
        const response = NextResponse.json({ success: true });
        response.cookies.set('admin_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 60 * 60 * 12, // 12h — this is a privileged session, kept short
            path: '/',
        });
        return response;
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'Login failed.' }, { status: 500 });
    }
}

export async function DELETE() {
    const response = NextResponse.json({ success: true });
    response.cookies.delete('admin_token');
    return response;
}