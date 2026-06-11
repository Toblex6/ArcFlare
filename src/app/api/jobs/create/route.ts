import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  console.log("Minimal endpoint reached");
  return NextResponse.json({ message: "Create job endpoint works!" });
}
