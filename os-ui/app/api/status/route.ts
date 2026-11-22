import { NextResponse } from 'next/server';
import { probeServices } from '@tabs/admin/lib/services';
import { requireUser } from '@core/kernel/auth';
import { hydrationShortfalls } from '@core/infra/os-mirror';
import { healthWarnings } from '@core/infra/health-warnings';

export const dynamic = 'force-dynamic';

/**
 * Home / Settings stack-status strip. Server-side pings each platform-service
 * health endpoint in parallel (via the shared `probeServices` helper, reused by
 * Platform → Components) and reports up/down. No backend address or key reaches
 * the browser.
 *
 * `storeWarnings`: every in-process store whose last load from its index was cut at the
 * store's hydration cap (`hydrationShortfalls`) — a health signal, so "records are missing"
 * is visible to a signed-in person instead of silent. Empty when every store loaded in full.
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
  const storeWarnings = [
    ...hydrationShortfalls().map((s) => `${s.index}: loaded ${s.loaded} of ${s.total} records (hydration cap) — lists over this store are incomplete.`),
    ...healthWarnings(),
  ];
  return NextResponse.json({ ...(await probeServices()), storeWarnings });
}
