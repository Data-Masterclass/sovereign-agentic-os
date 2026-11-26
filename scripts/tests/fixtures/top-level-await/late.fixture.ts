// SPDX-License-Identifier: Apache-2.0
// Fixture for scripts/tests/check-test-top-level-await.test.mjs — NOT a test (never run).
// The shape of chat-attachment-sinks.test.ts before #365: tests and a root after() are registered,
// THEN the module awaits at top level, THEN more tests are registered.
import { test, after } from 'node:test';

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
const { a } = await import('./a');

test('one', async () => { await a(); });
after(() => { globalThis.fetch = realFetch; });

const { b } = await import('./b');
const both = { ...(await import('./c')) };
for await (const x of [Promise.resolve(1)]) void x;

test('two', async () => { await b(both); });
