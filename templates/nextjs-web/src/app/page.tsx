/**
 * FEATURE:    The home page: who is signed in, and what the app can do.
 * USER STORY: As a user I want to see that I am signed in through the OS and which actions exist.
 * ARCHITECTURE: Server component. Identity comes from the OS through src/lib/os, never from this file.
 */
import { headers } from 'next/headers';
import { osFor, requireUser } from '@/lib/os';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const h = await headers();
  const request = new Request('http://app.local/', { headers: { cookie: h.get('cookie') ?? '' } });
  let line = 'Not signed in through the OS.';
  try {
    const user = await requireUser(osFor(request));
    line = `Signed in as ${user.username ?? user.id} (${user.role ?? 'no role'}).`;
  } catch (e) {
    line = e instanceof Error ? e.message : line;
  }
  return (
    <main>
      <h1>Orders</h1>
      <p>{line}</p>
      <ul>
        <li>POST /api/orders - add an order (governed write)</li>
        <li>POST /api/ask - run the review agent and return its output</li>
        <li>POST /api/functions/classify-order - the function agents may call</li>
      </ul>
    </main>
  );
}
