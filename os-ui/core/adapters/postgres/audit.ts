/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Append to and verify the hash-chained `os_governance.audit_events`
 * USER STORY: As an auditor I want to record a governance event in the same transaction as the
 *             change it describes, and to check with one call that nothing in the log was altered.
 * ARCHITECTURE:
 *   - The hash chain lives in the database (migration `…_audit-events-chain.sql`): a BEFORE INSERT
 *     trigger sets id, time, prev_hash and hash; `audit_verify()` walks the chain. This module
 *     only inserts the event's fields and calls the verifier, so the rule has one definition.
 *   - Pass a transaction's client to record the event atomically with the change (10 F2: the
 *     approval row, the approved write and the audit event commit together). On `ok:false` the
 *     transaction is aborted by Postgres; the caller rolls it back.
 *   - Both calls return the adapter contract (`Fetched`): a refused append (wrong isolation level
 *     → `invalid`, a role without INSERT → `forbidden`) or a dropped connection is a reason, not a
 *     thrown exception and never an empty value.
 */
import type { Fetched } from '@core/adapters/_contract';
import { fetchedOk, pgFailure, type Queryable } from './pool.ts';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditEventInput {
  actorUid: string;
  actorKind: 'user' | 'agent' | 'service' | 'system';
  action: string;
  objectKind?: string;
  objectId?: string;
  domain?: string;
  outcome?: 'allow' | 'deny' | 'error' | 'info';
  decisionId?: string;
  policyRev?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

export interface AppendedAuditEvent {
  id: string;
  occurredAt: Date;
  prevHash: string;
  hash: string;
}

export async function appendAuditEvent(db: Queryable, e: AuditEventInput): Promise<Fetched<AppendedAuditEvent>> {
  let r;
  try {
    r = await db.query(
    `insert into os_governance.audit_events
       (actor_uid, actor_kind, action, object_kind, object_id, domain, outcome, decision_id, policy_rev, run_id, payload)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, 'info'), $8, $9, $10, coalesce($11::jsonb, '{}'::jsonb))
     returning id, occurred_at, prev_hash, hash`,
    [
      e.actorUid,
      e.actorKind,
      e.action,
      e.objectKind ?? null,
      e.objectId ?? null,
      e.domain ?? null,
      e.outcome ?? null,
      e.decisionId ?? null,
      e.policyRev ?? null,
      e.runId ?? null,
      e.payload === undefined ? null : JSON.stringify(e.payload),
    ],
  );
  } catch (err) {
    return pgFailure(err);
  }
  const row = r.rows[0];
  return fetchedOk({ id: String(row.id), occurredAt: row.occurred_at, prevHash: row.prev_hash, hash: row.hash });
}

export interface AuditVerification {
  /** The chain itself is intact (the database answered; see `Fetched.ok` for that). */
  ok: boolean;
  checked: number;
  /** The first row that fails, as a string id (bigint). */
  firstBadId: string | null;
  reason: string | null;
  /** Hash of the last verified row; compare with an external anchor to detect a cut tail. */
  headHash: string | null;
}

export async function verifyAuditChain(db: Queryable): Promise<Fetched<AuditVerification>> {
  let r;
  try {
    r = await db.query(`select ok, checked, first_bad_id, reason, head_hash from os_governance.audit_verify()`);
  } catch (err) {
    return pgFailure(err);
  }
  const row = r.rows[0];
  return fetchedOk({
    ok: row.ok,
    checked: Number(row.checked),
    firstBadId: row.first_bad_id === null ? null : String(row.first_bad_id),
    reason: row.reason,
    headHash: row.head_hash,
  });
}
