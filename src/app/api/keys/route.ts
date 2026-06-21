import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { randomBytes } from 'crypto';

function verifyAdminSecret(req: NextRequest): boolean {
  const adminSecret = req.headers.get('x-admin-secret');
  const trueSecret = process.env.ADMIN_SECRET;
  return !!trueSecret && adminSecret === trueSecret;
}

// ─── POST: Generate a new API Key ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Invalid Admin Secret.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { label, ownerEmail } = body;

    if (!label) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Label parameter required.' },
        { status: 400 }
      );
    }

    const secureToken = `arc_live_${randomBytes(24).toString('hex')}`;

    const newKey = await prisma.apiKey.create({
      data: {
        key: secureToken,
        label,
        ownerEmail: ownerEmail || null,
        active: true, // Default to true
      },
    });

    return NextResponse.json({
      success: true,
      apiKey: newKey.key,
      label: newKey.label,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ─── DELETE: Revoke an existing API Key ───────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Invalid Admin Secret.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { key } = body;

    if (!key) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Target key string required.' },
        { status: 400 }
      );
    }

    // Use update instead of delete to keep a record of the key history
    await prisma.apiKey.update({
      where: { key },
      data: { active: false },
    });

    return NextResponse.json({
      success: true,
      message: 'API key permanently revoked from the active gateway.',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
