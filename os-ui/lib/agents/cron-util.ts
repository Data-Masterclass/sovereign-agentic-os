/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE cron helpers with NO server-only dependencies — safe to import from a
 * client component or a client-imported module. `schedule-cron.ts` (which drags in
 * the in-cluster k8s client via `lib/infra/k8s.ts`) re-exports `isValidCron` from
 * here for back-compat, so the browser bundle never pulls `node:fs`/`node:https`.
 */

/** A cron expression is minimally valid when it has exactly 5 non-empty fields. */
export function isValidCron(cron: string | undefined): cron is string {
  if (!cron || typeof cron !== 'string') return false;
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => f.length > 0);
}
