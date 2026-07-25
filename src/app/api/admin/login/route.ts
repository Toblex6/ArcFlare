// src/app/api/admin/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { issueAdminToken } from '@/src/lib/middleware/withAdminAuth';
import { checkRateLimit } from '@/src/lib/ratelimit';

export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
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

        if (email !== adminEmail || password !== adminPassword) {
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