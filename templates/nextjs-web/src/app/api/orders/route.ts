/**
 * FEATURE:    Add an order to the app's governed records.
 * USER STORY: As a signed-in user I want to record an order so my team can see it.
 * ARCHITECTURE: `os.records.add` is the governed write door: it runs as the caller, is checked by the
 *               OS (OPA + the app's approved envelope) and may answer 403. No database lives here.
 */
import { asCaller } from '@/lib/os';

export async function POST(request: Request): Promise<Response> {
  const order = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!order || typeof order.amount !== 'number') {
    return Response.json({ error: 'invalid', reason: 'body must be an object with a numeric amount' }, { status: 400 });
  }
  return asCaller(request, async (os) => Response.json(await os.records.add(order), { status: 201 }));
}
