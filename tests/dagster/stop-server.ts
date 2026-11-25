/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * stop-server — bounded teardown for the host-side os-ui server of run-identity.int.test.
 *
 * `server.close(cb)` calls back only once EVERY connection has ended. The OPA sidecar's long poll is
 * an open keep-alive socket; when its container is force-removed first, the host never gets a FIN or
 * an RST, so the socket stays ESTABLISHED until TCP gives up on retransmits (~15 min). Awaiting the
 * close callback before dropping connections therefore hung the job after all tests had passed
 * (PR #340 verifier, 25 Nov 2026). The order here: let in-flight handlers finish (bounded), drop
 * every connection ourselves, then close — and bound that wait too.
 */
import type { Server } from 'node:http';

/** Resolves true when `p` settled within `ms`, false otherwise; the timer never holds the process. */
export async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopServer(
  server: Server | undefined,
  inflight: Iterable<Promise<unknown>>,
  { inflightMs = 20_000, closeMs = 5_000 } = {},
): Promise<{ inflightSettled: boolean; closed: boolean }> {
  if (!server) return { inflightSettled: true, closed: true };
  // Stop accepting; idle keep-alive sockets go now. The callback is NOT awaited unbounded (see above).
  const closing = new Promise<void>((r) => server.close(() => r()));
  server.closeIdleConnections();
  // Handlers already running (the long poll answers 304 at its 10 s deadline) finish before the pool goes.
  const inflightSettled = await within(Promise.allSettled([...inflight]), inflightMs);
  // Every remaining socket is destroyed locally: no wait on a peer that will never answer.
  server.closeAllConnections();
  const closed = await within(closing, closeMs);
  return { inflightSettled, closed };
}
