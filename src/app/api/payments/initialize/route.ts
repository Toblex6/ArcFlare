import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export async function POST(
  request: Request
) {
  try {
    const body = await request.json();

    const {
      amount,
      email,
      merchantName,
    } = body;

    if (!amount || !email) {
      return NextResponse.json(
        {
          error:
            "Amount and email required",
        },
        {
          status: 400,
        }
      );
    }

    const reference = `arcflare_${Date.now()}`;

    const payment =
      await prisma.payment.create({
        data: {
          reference,
          amount: Number(amount),
          email,
          merchantName:
            merchantName ||
            "ArcFlare Merchant",
          status: "pending",
        },
      });

    const checkoutUrl = `http://localhost:3000/checkout/${reference}`;

    return NextResponse.json({
      success: true,

      data: {
        reference:
          payment.reference,

        amount:
          payment.amount,

        status:
          payment.status,

        checkoutUrl,
      },
    });
  } catch (error) {
    console.log(error);

    return NextResponse.json(
      {
        error:
          "Internal server error",
      },
      {
        status: 500,
      }
    );
  }
}