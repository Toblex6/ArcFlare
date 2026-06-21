import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export function withApiKey(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      if (req.method === 'GET') {
        return await handler(req);
      }

      const nextUrl = new URL(req.url);
      const apiKey = req.headers.get('x-api-key') ?? nextUrl.searchParams.get('apiKey');

      if (!apiKey) {
        return NextResponse.json({ success: false, error: 'Missing API key.' }, { status: 401 });
      }

      const apiKeyRecord = await (prisma as any).apiKey.findUnique({
        where: { key: apiKey },
      });

      if (!apiKeyRecord) {
        return NextResponse.json({ success: false, error: 'Invalid API key.' }, { status: 403 });
      }

      (req as any).apiKey = apiKeyRecord;
      return await handler(req);
    } catch (error: any) {
      console.error('Auth System Error:', error);
      return NextResponse.json({ success: false, error: 'Internal Auth Error' }, { status: 500 });
    }
  };
}
