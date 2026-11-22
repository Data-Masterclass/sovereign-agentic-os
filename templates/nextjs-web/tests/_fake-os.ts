/**
 * FEATURE:    A fake OS for unit tests: scripted answers to the SDK's HTTP calls.
 * USER STORY: As the author of a route test I want to see what the app sends to the OS and script the OS's answer, including refusals.
 * ARCHITECTURE: Replaces globalThis.fetch for one test; records every call. No network, no real OS.
 */
export type Call = { url: string; method: string; cookie: string; body: unknown };

export function fakeOs(answers: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  process.env.OS_BASE_URL = 'http://os.test';
  process.env.APP_SLUG = 'orders';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, cookie: headers.cookie ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace('http://os.test', '');
    const hit = answers[`${method} ${path}`];
    if (!hit) return new Response(JSON.stringify({ error: `unscripted ${method} ${path}` }), { status: 599 });
    return new Response(JSON.stringify(hit.json), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const ALICE = { json: { user: { id: 'u1', username: 'alice', role: 'creator' } } };
