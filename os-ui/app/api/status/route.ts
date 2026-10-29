import { NextResponse } from 'next/server';
import { probeServices } from '@tabs/admin/lib/services';
import { requireUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/**
 * Home / Settings stack-status strip. Server-side pings each platform-service
 * health endpoint in parallel (via the shared `probeServices` helper, reused by
 * Platform → Components) and reports up/down. No backend address or key reaches
 * the browser.
 */
export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  return NextResponse.json(await probeServices());
}
