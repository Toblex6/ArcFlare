import { NextResponse } from 'next/server';
import { getExternalBridgeAvailability } from '@/lib/bridge/externalAvailability';

export async function GET() {
  const availability = getExternalBridgeAvailability();
  return NextResponse.json(availability, { status: availability.available ? 200 : 503 });
}
