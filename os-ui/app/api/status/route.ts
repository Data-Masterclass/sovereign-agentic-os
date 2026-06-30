import { NextResponse } from 'next/server';
import { probeServices } from '@/lib/platform-admin/services';

export const dynamic = 'force-dynamic';

/**
 * Home / Settings stack-status strip. Server-side pings each platform-service
 * health endpoint in parallel (via the shared `probeServices` helper, reused by
 * Platform → Components) and reports up/down. No backend address or key reaches
 * the browser.
 */
export async function GET() {
  return NextResponse.json(await probeServices());
}
