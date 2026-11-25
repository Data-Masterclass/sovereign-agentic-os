/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * stop-server.test — regression for the run-identity teardown hang (PR #340): a client that holds a
 * request open and never sends FIN/RST (the force-removed OPA sidecar's long poll) must not keep
 * stopServer waiting past its bounds.
 *
 * Run: cd os-ui && node --import ./scripts/test-setup.mjs --test ../tests/dagster/stop-server.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { connect, type Socket } from 'node:net';
import { stopServer, within } from './stop-server.ts';

async function serverWithSilentPeer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const received = new Promise<void>((r) => server.once('request', () => r()));
  // A peer that sends one complete request and then goes silent: it never ends or resets.
  const peer: Socket = connect(port, '127.0.0.1');
  peer.on('error', () => {});
  peer.write('GET /long-poll HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
  await received;
  return { server, peer };
}

test('precondition: the pre-fix order (await close() before dropping connections) waits on a silent peer', async () => {
  const { server, peer } = await serverWithSilentPeer(() => {
    /* never responds */
  });
  const closing = new Promise<void>((r) => server.close(() => r()));
  server.closeIdleConnections();
  assert.equal(await within(closing, 300), false, 'close() alone does not call back while the peer is silent');
  server.closeAllConnections();
  peer.destroy();
});

test('a silent peer with an open long poll does not hold teardown: bounded, and the server closes', async () => {
  let release!: () => void;
  const stuck = new Promise<void>((r) => (release = r));
  const { server, peer } = await serverWithSilentPeer(() => {
    /* never responds: the long poll is still open */
  });
  const closeEvent = new Promise<void>((r) => server.once('close', () => r()));
  const t0 = Date.now();
  const r = await stopServer(server, [stuck], { inflightMs: 200, closeMs: 2_000 });
  const took = Date.now() - t0;
  assert.equal(r.inflightSettled, false, 'the stuck handler was bounded, not awaited');
  assert.equal(r.closed, true, 'closeAllConnections let the server close');
  assert.ok(took < 3_000, `teardown took ${took} ms`);
  assert.equal(await within(closeEvent, 0), true, "the server emitted 'close'");
  assert.equal(server.listening, false);
  release();
  peer.destroy();
});

test('handlers that finish in time are awaited before connections drop', async () => {
  let answered = false;
  let done!: () => void;
  const handler = new Promise<void>((r) => (done = r));
  const { server, peer } = await serverWithSilentPeer((_req, res) => {
    setTimeout(() => {
      res.end('304');
      answered = true;
      done();
    }, 150);
  });
  const r = await stopServer(server, [handler], { inflightMs: 5_000, closeMs: 2_000 });
  assert.equal(r.inflightSettled, true);
  assert.equal(r.closed, true);
  assert.equal(answered, true);
  peer.destroy();
});

test('no server is a no-op', async () => {
  assert.deepEqual(await stopServer(undefined, []), { inflightSettled: true, closed: true });
});
