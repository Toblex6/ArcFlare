// src/app/api/payments/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { z } from 'zod';

// Define a schema for the query parameters
const PaymentQuerySchema = z.object({
  id: z.string().uuid('Invalid payment ID format.'), // Changed to 'id'
});

export async function GET(request: NextRequest) {
  try {
    // 1. Rate Limiting Check
    const { allowed, response: limitResponse } = await checkRateLimit(request, 'payments');
    if (!allowed) return limitResponse;

    // 2. Input Validation
    const { searchParams } = new URL(request.url);
    const query = { id: searchParams.get('id') }; // Changed to 'id'
    const validationResult = PaymentQuerySchema.safeParse(query);

    if (!validationResult.success) {
      return NextResponse.json(
        { success: false, error: validationResult.error.errors },
        { status: 400 }
      );
    }

    const { id } = validationResult.data; // Changed to 'id'

    const payment = await prisma.paymentLog.findUnique({ where: { id } }); // Query by 'id'

    if (!payment)
      return NextResponse.json(
        { success: false, error: 'Invoice node not found.' },
        { status: 404 }
      );

    return NextResponse.json({ success: true, payment });
  } catch (error) {
    console.error('Database mapping read failure:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
