import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      reference: string;
    }>;
  }
) {
  try {
    const params =
      await context.params;

    const reference =
      params.reference;

    const payment =
      await prisma.payment.findUnique({
        where: {
          reference,
        },
      });

    if (!payment) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Payment not found",
        },
        {
          status: 404,
        }
      );
    }

    return NextResponse.json({
      success: true,

      data: payment,
    });
  } catch (error) {
    console.log(error);

    return NextResponse.json(
      {
        success: false,
        error:
          "Internal server error",
      },
      {
        status: 500,
      }
    );
  }
}