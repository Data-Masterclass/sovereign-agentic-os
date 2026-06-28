import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Liveness/readiness probe target — cheap, no backend calls.
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
