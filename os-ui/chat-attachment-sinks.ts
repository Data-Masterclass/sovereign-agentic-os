/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The three destinations a chat attachment can land in — Data, Files, Knowledge
 * USER STORY: As a user attaching a file to a chat message I want it handled by exactly the
 *             service the Data, Files or Knowledge tab uses, so a dataset, a file or a note made
 *             from the chat is the same thing the tab would have made, in my My scope.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (like `domain-delete-sources.ts`): the one place allowed to
 *     know the kernel and several tabs. `instrumentation.ts` registers it at boot; the door
 *     (`core/runtime/chat-attachments-server.ts`, via `POST /api/assistant/attachments`) reads it.
 *   - Each sink calls the tab's EXISTING service and nothing else:
 *       Data       createDatasetService → ingestAndRegisterBronze (csv/tsv/parquet/json/ndjson);
 *                  an .xlsx is read with the Connections tab's `readXlsxSheet` FIRST (nothing is
 *                  created for an unreadable workbook) and lands through `landGridAsBronze`, the
 *                  same grid → Bronze path the sandbox extract uses.
 *                  A FAILED ingest can still have landed its Bronze table (the runner wrote and
 *                  verified it, then registration refused — a column name, a throw in buildVersion).
 *                  So the take-back drops the caller's lane table through the governed `/execute`
 *                  path (`DROP TABLE IF EXISTS`, the caller's own `personal_<uid>` lane), VERIFIES it
 *                  is gone, and only then deletes the record and says nothing was kept. If the drop or
 *                  the check fails, the dataset is KEPT and named, and the message says so.
 *       Files      storeUploadedFile (the Files upload's own path: object store + Docling).
 *       Knowledge  createPersonalKnowledge (the Knowledge tab's personal note).
 *   - Audit goes to the platform audit store (`tabs/admin/lib/audit.ts`), tenant-stamped.
 */
import 'server-only';
import { registerAttachmentWiring, AttachmentKeptError, type AttachmentSinks, type AttachmentUser } from '@core/runtime/chat-attachments-server';
import { KNOWLEDGE_NOTE_MAX_BYTES, type AttachmentKind } from '@core/runtime/chat-attachments';
import { config } from '@core/kernel/config';
import { ensureHydrated as ensureDataHydrated, deleteDataset } from '@tabs/data/lib/store';
import { createDatasetService } from '@tabs/data/lib/mutations-server';
import { ingestAndRegisterBronze, landGridAsBronze, type IngestReport } from '@tabs/data/lib/ingest';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { bronzeTarget, laneSlug, personalSchema } from '@tabs/data/lib/store-fqn';
import { executeRoute, executeRun, queryRun, type ExecuteIdentity } from '@core/infra/governed';
import { routeFor } from '@core/infra/trino-source';
import { OfflineMockRefusedError } from '@core/kernel/offline-mock';
import { readXlsxSheet } from '@tabs/connections/lib/office-extract';
import { ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { storeUploadedFile } from '@tabs/files/lib/upload-server';
import { ensureHydrated as ensureKnowledgeHydrated, createPersonalKnowledge } from '@tabs/knowledge/lib/personal-store';
import { audit } from '@tabs/admin/lib/audit';
import { currentTenantId } from '@tabs/admin/lib/tenant';

const MIME: Record<AttachmentKind, string> = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', parquet: 'application/vnd.apache.parquet', json: 'application/json',
  ndjson: 'application/x-ndjson', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', md: 'text/markdown', txt: 'text/plain',
};

const principal = (u: AttachmentUser) => ({ id: u.id, domains: u.domains, role: u.role });

/** A new private dataset named after the file; "Sales (2)" when the domain already has "Sales". */
function createUniqueDataset(user: AttachmentUser, title: string): Dataset {
  for (let n = 1; n <= 20; n += 1) {
    try {
      return createDatasetService(principal(user), { name: n === 1 ? title : `${title} (${n})` });
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
    }
  }
  throw new Error(`There are already 20 datasets named “${title}” in your domain; rename the file and attach it again.`);
}

/** The physical operations the Data sink needs — the real governed ones by default, a fake in tests. */
export type DataSinkDeps = {
  ingestFile: (user: { id: string; domains: string[]; role: AttachmentUser['role'] }, datasetId: string, fileName: string, body: Buffer) => Promise<{ ok: boolean; report: IngestReport }>;
  ingestGrid: (user: { id: string; domains: string[]; role: AttachmentUser['role'] }, datasetId: string, grid: { columns: string[]; rows: string[][] }) => Promise<{ ok: boolean; report: IngestReport }>;
  /** One governed write (`executeRun`) as the caller. */
  exec: (sql: string, identity: ExecuteIdentity) => Promise<unknown>;
  /** Does this fully-qualified table exist? Reads Trino's information_schema as the caller. */
  tableExists: (fqn: string, user: AttachmentUser) => Promise<boolean>;
};

const realDataDeps: DataSinkDeps = {
  ingestFile: ingestAndRegisterBronze,
  ingestGrid: landGridAsBronze,
  exec: (sql, identity) => executeRun(sql, identity, executeRoute(identity, 'data-delete')),
  tableExists: async (fqn, user) => {
    const [, schema, table] = fqn.split('.');
    const q = await queryRun(
      `SELECT count(*) FROM iceberg.information_schema.tables WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'`,
      user.id,
      routeFor({ domains: user.domains }, 'data-ingest'),
    );
    return Number(q.rows[0]?.[0] ?? '0') > 0;
  },
};

/**
 * Take back a dataset this call created when its ingest did not succeed. `landed` = whether a
 * physical Bronze table may exist (false only when we KNOW nothing was written: the offline teaching
 * mock, or a refusal before the runner ran). Returns null when everything is gone, else why not.
 */
async function takeBack(user: AttachmentUser, ds: Dataset, landed: boolean, deps: DataSinkDeps): Promise<string | null> {
  if (landed) {
    const fqn = bronzeTarget(personalSchema(user.id), laneSlug(ds)); // the exact table ingestUpload writes
    const identity: ExecuteIdentity = { principal: user.id, uid: user.id, domains: user.domains, role: user.role }; // the owner's own lane
    try {
      await deps.exec(`drop table if exists ${fqn}`, identity);
    } catch (e) {
      return `its table ${fqn} could not be removed (${(e as Error).message || 'drop failed'})`;
    }
    try {
      if (await deps.tableExists(fqn, user)) return `its table ${fqn} is still there after the drop`;
    } catch (e) {
      return `removing its table ${fqn} could not be confirmed (${(e as Error).message || 'check failed'})`;
    }
  }
  deleteDataset(ds.id, principal(user)); // the record goes only once nothing physical is left
  return null;
}

export function makeChatAttachmentSinks(deps: DataSinkDeps = realDataDeps): AttachmentSinks {
  return {
  data: {
    maxBytes: () => config.uploadMaxBytes,
    create: async (user, { name, title, kind, bytes }) => {
      await ensureDataHydrated();
      // A workbook is read BEFORE anything is created: an unreadable one leaves nothing behind.
      let grid: { columns: string[]; rows: string[][] } | null = null;
      let sheetNote = '';
      if (kind === 'xlsx') {
        const t = readXlsxSheet(bytes);
        if (t.truncated) throw new Error(`The sheet “${t.sheet}” has ${t.totalRows.toLocaleString('en')} rows, more than can be read from a workbook here. Save it as CSV and attach that.`);
        if (t.columns.length === 0) throw new Error(`The first sheet (“${t.sheet}”) is empty.`);
        grid = { columns: t.columns, rows: t.rows };
        sheetNote = t.sheetNames.length > 1 ? `, first sheet “${t.sheet}” of ${t.sheetNames.length}` : '';
      }
      const ds = createUniqueDataset(user, title);
      const item = { type: 'dataset' as const, id: ds.id, title: ds.name, href: `/data?focus=${encodeURIComponent(ds.id)}` };
      let reason: string;
      let landed = true;
      try {
        const r = grid ? await deps.ingestGrid(principal(user), ds.id, grid) : await deps.ingestFile(principal(user), ds.id, name, bytes);
        if (r.ok) {
          const mock = r.report.mode === 'offline-mock' ? ' (offline teaching mock)' : '';
          return { ...item, detail: `Bronze landed${mock}: ${r.report.rowCount.toLocaleString('en')} rows in ${r.report.table}${sheetNote}` };
        }
        reason = r.report.error ?? 'the ingest could not be verified';
        landed = r.report.mode !== 'offline-mock'; // the teaching mock writes no table
      } catch (e) {
        reason = (e as Error).message;
        if (e instanceof OfflineMockRefusedError) landed = false; // refused before the runner ran
      }
      const left = await takeBack(user, ds, landed, deps);
      if (left === null) throw new Error(`The data could not be ingested: ${reason}. Nothing was kept.`);
      throw new AttachmentKeptError(
        `The data could not be ingested: ${reason}. The dataset “${ds.name}” is KEPT in your Data because ${left}; open it to retry the upload or delete it.`,
        { ...item, detail: 'kept after a failed ingest' },
      );
    },
  },
  files: {
    maxBytes: () => config.uploadMaxBytes,
    create: async (user, { name, kind, bytes }) => {
      await ensureFilesHydrated();
      const a = await storeUploadedFile(principal(user), { name, bytes, contentType: MIME[kind] });
      const ex = a.indexing.extraction?.status;
      const out = a.indexing.outcome?.status;
      const detail = out === 'indexed' ? 'searchable' : ex === 'pending' ? 'text extraction still running' : out === 'failed' || ex === 'failed' ? 'stored; not searchable yet' : 'stored';
      return { type: 'file', id: a.id, title: a.name, href: `/unstructured?focus=${encodeURIComponent(a.id)}`, detail };
    },
  },
  knowledge: {
    maxBytes: () => KNOWLEDGE_NOTE_MAX_BYTES,
    create: async (user, { title, bytes }) => {
      await ensureKnowledgeHydrated();
      const md = bytes.toString('utf8').replace(/^﻿/, '');
      const rec = createPersonalKnowledge(principal(user), { title, md });
      return { type: 'knowledge', id: rec.id, title: rec.title, href: `/knowledge?focus=${encodeURIComponent(rec.id)}`, detail: 'personal note' };
    },
  },
  };
}

export const chatAttachmentSinks: AttachmentSinks = makeChatAttachmentSinks();

export function registerChatAttachmentSinks(): void {
  registerAttachmentWiring({
    sinks: chatAttachmentSinks,
    audit: (e) => { audit({ tenant: currentTenantId(), ...e }); },
  });
}
