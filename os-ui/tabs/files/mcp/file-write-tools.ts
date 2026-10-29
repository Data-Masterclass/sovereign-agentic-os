/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles, INGEST_MAX_BYTES,
  type Principal,
} from '@core/mcp/write-common';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  archiveDataset,
  deleteDataset,
  defineMeasure,
  buildGoldJoin as commitGoldJoin,
  addCheck,
  builtLayerFqn,
  type PromotionRequest,
} from '@tabs/data/lib/store';
import { runQualityChecks } from '@tabs/data/lib/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@tabs/data/lib/index';
import { queryRun } from '@core/infra/governed';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@core/policy/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@tabs/data/lib/panels';
import { ingestAndRegisterBronze } from '@tabs/data/lib/ingest';
import { buildStage, commitLayerVersion } from '@tabs/data/lib/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToModel,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@tabs/data/lib/transform';
import { assetTarget } from '@tabs/data/lib/store-fqn';
import type { ExecuteIdentity } from '@core/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@tabs/data/lib/index';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@tabs/metrics/lib/model';
import type { MeasureType } from '@tabs/data/lib/metrics';
import { buildMetric } from '@tabs/metrics/lib/build/server';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';
import type { Granularity } from '@tabs/metrics/lib/explorer';
import { getMetric } from '@tabs/metrics/lib/store';
import { governMetric, canPromote as canPromoteMetric } from '@tabs/metrics/lib/governance';
import { transition as transitionDataset } from '@tabs/data/lib/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@tabs/knowledge/lib/store';
import { knowledgeConsumers } from '@tabs/knowledge/lib/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@core/policy/ladder';
import { pendingHandle } from '@core/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@tabs/knowledge/lib/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@tabs/knowledge/lib/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@tabs/files/lib/store';
import { reindexFile } from '@tabs/files/lib/pipeline-server';
import { putBlob } from '@tabs/files/lib/object-store';
import type { Sensitivity } from '@tabs/files/lib/asset-schema';

import { saveDashboard } from '@tabs/dashboards/lib/store';
import { fromTiles, type ChartSpec } from '@tabs/dashboards/lib/model';
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@tabs/agents/lib/store';
import { isTemplateKey } from '@tabs/agents/lib/templates';
import { buildSystem } from '@tabs/agents/lib/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@tabs/software/lib/apps';
import { normalizeContextGrants } from '@core/kernel/context-grants';

// ================================ FILES =======================================
export const fileWriteTools: McpTool[] = [
  {
    name: 'upload_file',
    tab: 'files',
    minRole: 'creator',
    description:
      'Upload a governed file (private object-store file at v1) into the Files tab — the SAME governed path as the UI upload. ' +
      'For BINARY files (PDFs, images, Office docs, etc.) provide the raw bytes as `base64Content` (standard base64) and set `mimeType` (e.g. "application/pdf"). ' +
      'The decoded bytes are stored in the governed object store so Download returns the REAL file byte-for-byte. ' +
      'For plain-text files (Markdown, CSV, JSON, TXT) you may omit `base64Content` and pass the content as `text` instead; it is indexed for search. ' +
      'Do NOT pass a markdown description of a binary file as `text` and omit the bytes — that produces a misleading text-only record. ' +
      'MCP in-band limit: ~4 MB of base64 (≈3 MB decoded). Larger files must be uploaded through the Files tab UI. ' +
      '`restricted` sensitivity is stored-but-not-indexed. A `description` + ≥1 tag make the file eligible for `promote_file`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name including extension, e.g. "invoice-2026-01.pdf".' },
        base64Content: {
          type: 'string',
          description:
            'The file\'s raw bytes encoded as standard base64. Required for binary files (PDF, PNG, DOCX, XLSX, …). ' +
            'Must be paired with `mimeType`. Omit for plain-text files where `text` carries the content.',
        },
        mimeType: {
          type: 'string',
          description:
            'MIME type of the file, e.g. "application/pdf", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document". ' +
            'Required when `base64Content` is provided.',
        },
        folder: { type: 'string', description: 'Optional folder path.' },
        text: {
          type: 'string',
          description:
            'Extracted/preview text for search indexing. For plain-text files pass the full content here. ' +
            'For binary files this is OPTIONAL supplemental text (e.g. a pre-extracted transcript or summary) — do NOT use it as a substitute for the real bytes.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (≥1 needed to promote).' },
        description: { type: 'string', description: 'What this file is (needed to promote it).' },
        sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'], description: 'Governs indexing (restricted ⇒ not indexed).' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
      },
      required: ['name'],
      examples: [
        {
          name: 'invoice-2026-01.pdf',
          base64Content: 'JVBERi0xLjQK…',
          mimeType: 'application/pdf',
          folder: 'invoices',
          tags: ['invoice', 'finance'],
          description: 'January 2026 supplier invoice',
          sensitivity: 'confidential',
        },
        {
          name: 'refund-policy.md',
          text: 'Refunds are processed within 5 days.',
          folder: 'policies',
          tags: ['policy'],
          description: 'Customer refund policy',
          sensitivity: 'internal',
        },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('upload_file needs a `name`', 400);

      // Validate + decode binary content when provided.
      const b64 = typeof args.base64Content === 'string' ? args.base64Content : '';
      const mimeType = typeof args.mimeType === 'string' ? args.mimeType.trim() : '';
      if (b64 && !mimeType) fail('upload_file: `mimeType` is required when `base64Content` is provided', 400);

      let binaryBytes: Buffer | null = null;
      if (b64) {
        // Decode base64 → raw bytes; fail clearly on corrupt input (never silently store garbage).
        try {
          binaryBytes = Buffer.from(b64, 'base64');
        } catch {
          fail('upload_file: `base64Content` is not valid base64', 400);
        }
        // ~4 MB base64 ≈ 3 MB decoded; match the ingest cap.
        if (binaryBytes.length > INGEST_MAX_BYTES) {
          fail(
            `upload_file: decoded content is ${(binaryBytes.length / 1048576).toFixed(1)} MB — the MCP in-band limit is ${INGEST_MAX_BYTES / 1048576} MB. ` +
              'Upload larger files through the Files tab UI.',
            400,
          );
        }
      }

      const p = P(user);
      const tags = strArr(args.tags);
      const textArg = typeof args.text === 'string' ? args.text : undefined;

      const asset = createFile(p, {
        name,
        folder: str(args.folder) || undefined,
        text: textArg,
        bytes: binaryBytes ? binaryBytes.length : undefined,
        tags,
        sensitivity: (str(args.sensitivity) as Sensitivity) || undefined,
        domain: str(args.domain) || undefined,
      });

      // Store the original bytes in the governed object store so Download returns the
      // REAL file (identical path to the UI multipart upload: putBlob + attachObject).
      if (binaryBytes) {
        const key = objectKeyForAsset(asset);
        if (key) {
          await putBlob(key, binaryBytes, mimeType);
          attachObject(asset.id, p, { contentType: mimeType, bytes: binaryBytes.length });
        }
      }

      const description = str(args.description);
      const documented = description ? setFileDocs(asset.id, p, { description, tags }) : asset;
      try {
        await reindexFile(documented, textArg ?? '');
      } catch {
        /* indexing is best-effort; the upload already succeeded */
      }
      return documented;
    },
  },
];

