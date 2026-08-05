/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * OPERATIONAL CURSOR HONESTY — PURE and client-safe (no secrets, no server imports),
 * exactly the `kajabi-resources.ts` discipline (imported by BOTH the server registry and
 * the UI so the cursor-honesty chip, the SyncPanel/adopt cursor lock, and the executor
 * agree on ONE truth per entity). Nothing here is guessed:
 *
 *   • Salesforce — the canonical replication cursor is SystemModstamp (set on every DML,
 *     including a record's own updates): TRUE incremental. Deletes are not detected in v1;
 *     an object without SystemModstamp fails the run honestly (real per-object describe is
 *     the exact check, but every standard/most custom queryable object carries it, so the
 *     catalog-level chip is honestly "incremental").
 *   • Kajabi — verbatim from the curated `kajabi-resources.ts` map (updated_at = true
 *     incremental, created_at = append-only edits-not-detected, null = full-refresh only).
 *
 * This module is the SINGLE SOURCE the server `operational-registry.ts` delegates its
 * `cursorFor` to, so server and client can never drift.
 */
import { kajabiCursorField } from './kajabi-resources.ts';
import type { OperationalPlatform } from './operational-platform.ts';

/** The honest cursor-support answer for one entity: whether it can sync incrementally,
 *  the cursor column, the honesty CHIP the UI shows, and one honest WHY line. NOTHING is
 *  fabricated. */
export type EntityCursorSupport = {
  incremental: boolean;
  /** The cursor column an incremental pull uses, or null for full-refresh-only. */
  cursorColumn: string | null;
  /** The chip: "Incremental (SystemModstamp)" | "Incremental (updated_at)" | "Full refresh only". */
  chip: string;
  note: string;
};

const SALESFORCE_CURSOR: EntityCursorSupport = {
  incremental: true,
  cursorColumn: 'SystemModstamp',
  chip: 'Incremental (SystemModstamp)',
  note:
    'Change tracking uses SystemModstamp (set on every update) — new AND changed records sync. ' +
    'Deletes are not detected in v1; an object without SystemModstamp fails the run honestly.',
};

function kajabiCursorFor(entity: string): EntityCursorSupport {
  const cursor = kajabiCursorField(entity);
  if (cursor === null) {
    return {
      incremental: false,
      cursorColumn: null,
      chip: 'Full refresh only',
      note: 'This Kajabi resource documents no timestamp cursor — full refresh is the only honest mode.',
    };
  }
  if (cursor === 'updated_at') {
    return {
      incremental: true,
      cursorColumn: 'updated_at',
      chip: 'Incremental (updated_at)',
      note: 'sort=updated_at is documented — new AND changed records sync (true incremental).',
    };
  }
  return {
    incremental: true,
    cursorColumn: 'created_at',
    chip: 'Incremental (created_at)',
    note:
      'sort=created_at is documented but not updated_at — new records append; edits to existing ' +
      'records are NOT detected (run a full refresh to capture them).',
  };
}

/**
 * OData (sap-odata / odata-v4) and Workday RaaS honesty is PER-ENTITY and only knowable
 * from the source's own metadata (a detected change-timestamp property for OData; an
 * admin-configured date prompt for a Workday report), which the pure/client layer does
 * not have. So the client-safe chip is the SAFE, honest DEFAULT — "Full refresh only" —
 * and the note says incremental turns on at sync time ONLY when the source exposes a real
 * change cursor (detected, never guessed). The server slice runner enforces this: an
 * `append` against an entity with no detected/configured cursor fails the run honestly.
 */
const ODATA_DEFAULT_CURSOR: EntityCursorSupport = {
  incremental: false,
  cursorColumn: null,
  chip: 'Full refresh only',
  note:
    'Incremental sync turns on automatically when this entity exposes a change-timestamp ' +
    'property in its $metadata (e.g. LastChangeDateTime / ChangedOn) — detected, never guessed. ' +
    'Without one, full refresh is the only honest mode.',
};

const WORKDAY_DEFAULT_CURSOR: EntityCursorSupport = {
  incremental: false,
  cursorColumn: null,
  chip: 'Full refresh only',
  note:
    'Workday RaaS reports are full-refresh by default (v1). An incremental window applies only ' +
    'when the admin configured a date prompt on the report — otherwise full refresh is the only ' +
    'honest mode. True per-entity incremental arrives with the SOAP integration (v2).',
};

/** The honest cursor support for one entity of an operational platform — the source of
 *  the cursor-honesty chip, the SyncPanel/adopt cursor lock, and the deferredReason. */
export function cursorSupportForPlatform(platform: OperationalPlatform, entity: string): EntityCursorSupport {
  switch (platform) {
    case 'kajabi':
      return kajabiCursorFor(entity);
    case 'odata':
      return ODATA_DEFAULT_CURSOR;
    case 'workday':
      return WORKDAY_DEFAULT_CURSOR;
    default:
      return SALESFORCE_CURSOR;
  }
}
