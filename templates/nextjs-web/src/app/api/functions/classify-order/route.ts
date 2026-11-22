/**
 * FEATURE:    The `classify_order` function the OS registers as a governed agent tool.
 * USER STORY: As an agent builder I want to call this app's rule as a tool, with the OS deciding
 *             whether my agent may and recording every call.
 * ARCHITECTURE: Declared in actions.yml, described by operationId `classify_order` in openapi.yaml.
 *               The OS authorises the call (OPA) and traces it before proxying here, so this handler
 *               holds no policy: it validates its input and runs the rule.
 */
import { classifyOrder } from '@/lib/classify-order';

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { amount?: unknown } | null;
  if (!body || typeof body.amount !== 'number') {
    return Response.json({ error: 'invalid', reason: 'amount must be a number' }, { status: 400 });
  }
  try {
    return Response.json(classifyOrder(body.amount));
  } catch (e) {
    return Response.json({ error: 'invalid', reason: (e as Error).message }, { status: 400 });
  }
}
