/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * ONE honest classifier for "the physical table/schema isn't there yet" errors.
 *
 * A registry dataset can be recorded (and even flagged "built") before its Iceberg
 * table has actually been materialized — e.g. a demo mart that was never `dbt build`-ed,
 * or a warehouse that was re-provisioned out from under the registry. When a governed
 * read then targets that FQN, Trino answers `TABLE_NOT_FOUND … does not exist`.
 *
 * That is NOT an error the user should see raw: it means "not built yet", not "the
 * platform is broken". This module centralises the distinction so the catalog probe,
 * the row-preview route and the NL→SQL (ask) flow all classify identically — a missing
 * table degrades to a calm "not materialized yet" state, while a genuinely unreachable
 * engine still surfaces as a real fault.
 *
 * Pure string-in/bool-out (no `server-only`, no network) so it stays trivially testable.
 */

/** Trino/object-store signatures that mean the target simply hasn't been built yet. */
const NOT_MATERIALIZED =
  /TABLE_NOT_FOUND|SCHEMA_NOT_FOUND|does not exist|NoSuchBucket|NoSuchKey|NoSuchTable|Table .* not found/i;

/** True when an error means "the physical table/schema is not materialized yet"
 *  (as opposed to the warehouse being unreachable or another real fault). */
export function isNotMaterialized(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return NOT_MATERIALIZED.test(msg);
}

/** A calm, honest one-liner for a target that isn't materialized yet — build first. */
export function notMaterializedReason(what = 'This version'): string {
  return `${what} isn't materialized yet — build and publish it first, then it can be previewed and queried here.`;
}
