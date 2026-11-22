/**
 * FEATURE:    Run an agent system from the app and return what it produced.
 * USER STORY: As a user I want to ask the review agent a question and see its answer, or see that
 *             it is waiting for a human approval.
 * ARCHITECTURE: `os.agents.run` starts the run as the caller. A run held for approval comes back as
 *               `state: 'parked'` with its approvalId; it is passed on as such, never as an answer.
 */
import { asCaller } from '@/lib/os';

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { systemId?: string; message?: string } | null;
  if (!body?.systemId || !body.message) {
    return Response.json({ error: 'invalid', reason: 'systemId and message are required' }, { status: 400 });
  }
  const { systemId, message } = body;
  return asCaller(request, async (os) => Response.json(await os.agents.run(systemId, message)));
}
