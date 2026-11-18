/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    ONE switch and ONE predicate deciding whether this deployment may fabricate
 * USER STORY: As an operator of a real cluster I must never be shown an invented number, an
 *             invented table, an invented row count or a green security scan because a backend
 *             was unreachable — an unreachable engine must be an honest refusal, and the
 *             fabricating teaching path must be impossible unless somebody switched it on.
 * ARCHITECTURE:
 *   - THE DEFECT THIS REPLACES. Every degrade-to-mock site keyed its own gate on
 *     `config.deploymentProfile !== 'local'` (`OS_PROFILE`), and `OS_PROFILE` is set NOWHERE in
 *     `charts/`, `values*.yaml`, `deploy/` or `scripts/`. So on the live cluster every such gate
 *     read `local` and an unreachable Trino / data-runner / query-tool produced hash-seeded
 *     `offline-mock` rows — labelled, but fabricated. `config.ts` says so itself, twice
 *     (lines 655 and 673), which is exactly why the two existing fail-closed guards there key on
 *     `NODE_ENV` instead.
 *   - SO: `OS_OFFLINE_MOCK` is the one switch, and it is keyed the same way. Unset ⇒ `refuse`
 *     whenever `NODE_ENV === 'production'` (the one variable the deploy DOES set —
 *     `images/base/os-ui/Dockerfile`), `allow` otherwise, so a laptop / kind / `npm test` is
 *     byte-identical to before. A CLOSED allow-list, not a boolean parse: anything but the exact
 *     string `allow` resolves to `refuse`, so a typo can never open the door.
 *   - ONE PREDICATE, ONE TRIPWIRE. Every site that CHOOSES offline-mock calls
 *     `offlineMockAllowed()` and nothing else, and `offline-mock-tripwire.test.ts` greps
 *     `tabs/**` + `core/**` to prove it — a new fabricating path cannot be added without either
 *     consulting this module or being deliberately classified as a label.
 *   - REFUSING IS TYPED, never silent and never a row. `refuseOfflineMock(reason)` throws
 *     `OfflineMockRefusedError` (`status` 503, `code` ENGINE_UNAVAILABLE), which
 *     `core/mcp/server.ts` `structuredError` — the ONE error-mapping door — surfaces to an agent
 *     as `{ error: { code: 'ENGINE_UNAVAILABLE', … } }`. A path that must return a value instead
 *     of throwing uses `offlineMockRefusal(reason)`, whose shape
 *     (`{ ok: false, code: 'ENGINE_UNAVAILABLE', unavailable: true, reason }`) matches the
 *     `unavailable` branch the metrics explorer already serves.
 *   - KERNEL, not a tab: nine decision sites across six tabs consult it, and the kernel may not
 *     import a tab. Pure: it reads `process.env` on every call (never a frozen snapshot), so a
 *     test can drive the switch without re-importing the module graph.
 */

/** The ONE environment variable. `allow` enables the teaching fabrication path; anything else refuses. */
export const OFFLINE_MOCK_ENV = 'OS_OFFLINE_MOCK';

/** The only value that enables fabrication. A closed allow-list — not a boolean parse. */
export const OFFLINE_MOCK_ALLOW = 'allow';
/** The explicit refusal value. Also what every unrecognised value resolves to. */
export const OFFLINE_MOCK_REFUSE = 'refuse';

/** The typed code every refusal carries, on the error AND on the value shape. */
export const ENGINE_UNAVAILABLE = 'ENGINE_UNAVAILABLE';

/** The resolved setting, as reported on Settings and in a refusal message. */
export type OfflineMockSetting = typeof OFFLINE_MOCK_ALLOW | typeof OFFLINE_MOCK_REFUSE;

/**
 * Resolve the switch. Explicit `allow` wins; explicit anything-else refuses; UNSET falls back to
 * the production key — `refuse` under `NODE_ENV=production`, `allow` on a laptop or in the suite.
 *
 * Injectable for tests; the defaults read the live environment on every call so a caller never
 * depends on import order (`config` is frozen at module load — this deliberately is not).
 */
export function offlineMockSetting(
  raw: string | undefined = process.env[OFFLINE_MOCK_ENV],
  nodeEnv: string | undefined = process.env.NODE_ENV,
): OfflineMockSetting {
  const v = (raw ?? '').trim();
  if (v) return v === OFFLINE_MOCK_ALLOW ? OFFLINE_MOCK_ALLOW : OFFLINE_MOCK_REFUSE;
  return nodeEnv === 'production' ? OFFLINE_MOCK_REFUSE : OFFLINE_MOCK_ALLOW;
}

/**
 * THE predicate. `true` ⇒ this deployment may serve a deterministic, honestly-labelled
 * offline-mock when the real engine is unreachable (the local teaching flow). `false` ⇒ an
 * unreachable engine is an OUTAGE and must be refused, never fabricated around.
 */
export function offlineMockAllowed(
  raw?: string | undefined,
  nodeEnv?: string | undefined,
): boolean {
  return offlineMockSetting(raw, nodeEnv) === OFFLINE_MOCK_ALLOW;
}

/** The sentence appended to every refusal so the reader knows which switch governs it. */
export const OFFLINE_MOCK_HINT =
  'This deployment refuses fabricated results: a result that cannot be computed is reported as ' +
  'unavailable rather than invented. Check the component’s health row in Platform → Components ' +
  `and retry. (Governed by ${OFFLINE_MOCK_ENV}; the local teaching flow sets it to ‘${OFFLINE_MOCK_ALLOW}’.)`;

/**
 * The typed refusal. 503, because the request is well-formed and the OS is willing — a dependency
 * it needs is unreachable and this deployment will not stand in for it.
 */
export class OfflineMockRefusedError extends Error {
  readonly code = ENGINE_UNAVAILABLE;
  readonly status = 503;
  /** What could not be computed — carried separately so a caller can re-label without re-parsing. */
  readonly reason: string;
  constructor(reason: string) {
    super(`${reason} ${OFFLINE_MOCK_HINT}`);
    this.name = 'OfflineMockRefusedError';
    this.reason = reason;
  }
}

/** Is this the typed offline-mock refusal? Used by the MCP error mapper (no instanceof across bundles). */
export function isOfflineMockRefused(e: unknown): e is OfflineMockRefusedError {
  return Boolean(e) && typeof e === 'object' && (e as { code?: unknown }).code === ENGINE_UNAVAILABLE;
}

/**
 * REFUSE. Call this at the point where the code would otherwise have fabricated — never later,
 * and never after a partial write. Throws; it does not return, so a caller cannot forget the
 * branch.
 */
export function refuseOfflineMock(reason: string): never {
  throw new OfflineMockRefusedError(reason);
}

/** The non-throwing refusal VALUE, for a path whose contract is a result rather than an exception. */
export type OfflineMockRefusal = {
  readonly ok: false;
  readonly code: typeof ENGINE_UNAVAILABLE;
  readonly unavailable: true;
  readonly reason: string;
  readonly hint: string;
};

/** Build the refusal value. Deliberately carries NO rows, NO counts and NO defaults. */
export function offlineMockRefusal(reason: string): OfflineMockRefusal {
  return { ok: false, code: ENGINE_UNAVAILABLE, unavailable: true, reason, hint: OFFLINE_MOCK_HINT };
}
