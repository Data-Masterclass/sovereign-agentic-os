/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Start the WP-02 harness's OpenAI-compatible model stub for a test, and script it
 * USER STORY: As a test author I want the ONLY faked hop to be the model, served over real HTTP in
 *             the OpenAI wire format, so `ChatOpenAI` (OS run) and `node run.mjs` (eject) talk to
 *             the same endpoint the same way they would talk to LiteLLM.
 * ARCHITECTURE:
 *   - Spawns `python3 tests/e2e/kind/model-stub/stub.py` (stdlib only) on a free port, waits for
 *     `/health`, and stops it in `stop()`. A script is a list of replies consumed in order
 *     (`POST /__stub/script`); a call past the end is HTTP 409, never an invented answer.
 *   - `python3` missing → `start()` throws (the caller decides whether that is a skip or a failure).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../tests/e2e/kind/model-stub/stub.py');

export type StubReply = { content?: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] };

export function python3Available(): boolean {
  return spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export type ModelStub = {
  /** The OpenAI-compatible base URL (`…/v1`). */
  url: string;
  script(steps: StubReply[]): Promise<void>;
  stats(): Promise<{ total: number; cursor: number }>;
  stop(): void;
};

export async function startModelStub(): Promise<ModelStub> {
  const port = await freePort();
  const proc: ChildProcess = spawn('python3', ['-I', STUB], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    const up = await fetch(`${base}/health`).then((r) => r.ok, (e: unknown) => (e instanceof Error ? false : false));
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error('the model stub did not start');
  }
  return {
    url: `${base}/v1`,
    async script(steps) {
      const r = await fetch(`${base}/__stub/script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: steps.map((reply) => ({ reply })) }) });
      if (!r.ok) throw new Error(`stub script refused: ${r.status}`);
    },
    async stats() {
      const j = (await (await fetch(`${base}/__stub/stats`)).json()) as { total: number; cursor: number };
      return j;
    },
    stop() {
      proc.kill();
    },
  };
}
