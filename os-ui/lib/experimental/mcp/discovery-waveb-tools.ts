/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from '@/lib/mcp/server';
import {
  P, fail, str, strArr, NO_ARGS, idArg, resolveQueryable,
  type Principal,
} from './discovery-common';

// --- Governed read/list lib functions (the EXACT same the UI + /api call) ------
import { listDatasets, getDataset } from '@/lib/experimental/data/store';
import { listWorkflows, getWorkflow } from '@/lib/experimental/knowledge/store';
import { listFiles, searchFiles, getFile } from '@/lib/experimental/files/store';
import { listMetrics } from '@/lib/experimental/metrics/store';
import { listDashboards, getDashboard } from '@/lib/experimental/dashboards/store';
import { normalizePanel, panelMetrics } from '@/lib/experimental/dashboards/model';
import { getSystem } from '@/lib/agents/store';
import {
  listAppsForUser,
  getAppForUser,
  listAppFilesForViewer,
  readAppFileForViewer,
  templateFiles,
  dirListing,
} from '@/lib/experimental/software/apps';
import { getSnapshot, hydrateSnapshot } from '@/lib/experimental/software/server';
import { getReviewCard, listReviewCards, reconcileDeployStatus, previewNoteForRunner } from '@/lib/experimental/software/review';
import type { RunnerStatus } from '@/lib/experimental/software/runner';
import { getConnectionForUser } from '@/lib/experimental/connections';
import { scaffoldMetricYaml } from '@/lib/experimental/data/metrics';
import { loadGuide, isGuidePath, GUIDE_PATHS, type GuidePath } from '@/lib/tabs/guides';
import { config } from '@/lib/core/config';
import { queryRun } from '@/lib/infra/governed';
import { versionTarget } from '@/lib/experimental/data/store-fqn';
import { builtLayerFqn } from '@/lib/experimental/data/store';
import type { Layer } from '@/lib/experimental/data';
import { LAYERS } from '@/lib/experimental/data';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type ProfileColumn,
} from '@/lib/experimental/data/profile';
import { getMetric } from '@/lib/experimental/metrics/store';
import { exploreMetric } from '@/lib/experimental/metrics/build/explore-server';
import type { Granularity } from '@/lib/experimental/metrics/explorer';
import { claimsFromUser, delegate } from '@/lib/experimental/data/identity';

// ====================== WAVE B — OPERATE & READ-BACK PARITY ===================
// Single-read + honest-status tools: an AI that cannot re-read its artifacts
// iterates blind. Each is a THIN delegate over the same governed single-get the
// UI calls, under the caller's identity — unseeable ids are typed not_found/
// forbidden, restricted content is metadata-only, and no URL is ever claimed
// that is not actually served.

/** Honest truncation caps: long content is cut with an explicit note, never silently. */
const FILE_TEXT_CAP = 8000;
const APP_FILE_CAP = 24000;

function truncated(text: string, cap: number): { text: string; note: string | null } {
  if (text.length <= cap) return { text, note: null };
  return {
    text: text.slice(0, cap),
    note: `Truncated: showing the first ${cap} of ${text.length} characters. Read the rest in the tab UI.`,
  };
}

export const waveBReadTools: McpTool[] = [
  {
    name: 'get_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Read ONE governed metric (also called: KPI, measure, indicator) — its definition (aggregation + aggregated column), the gold dataset it is defined on, its tier + owner, the canonical member every consumer resolves, and the generated metric YAML. Purpose: read back exactly what define_metric registered so you iterate on the real definition instead of guessing. Before: list_metrics (take the `id`, shaped `<datasetId>.<measure>`). After: query_metric to evaluate the number, or create_dashboard to chart the member. Governance: read-only, resolved through the SAME dataset canView gate as list_metrics — a metric on a dataset you cannot see is a typed not_found/forbidden (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: 'Metric id from list_metrics — `<datasetId>.<measure>`, e.g. "ds_ab12cd.revenue".' },
      },
      required: ['metricId'],
      examples: [{ metricId: 'ds_ab12cd.revenue' }],
    },
    call: async (user, args) => {
      const metricId = str(args.metricId).trim();
      if (!metricId) fail('get_metric needs a `metricId` (from list_metrics, shaped `<datasetId>.<measure>`)', 400);
      const r = getMetric(metricId, P(user)); // canView guard via getDataset (403/404)
      return {
        id: r.id,
        name: r.measure.name,
        member: r.member,
        tier: r.tier,
        owner: r.owner,
        datasetId: r.dataset.id,
        datasetName: r.dataset.name,
        definition: {
          aggregation: r.measure.type,
          column: r.measure.sql || null,
          // The sliceable dimensions come from the gold columns.
          dimensions: r.dataset.columns.map((c) => c.name),
        },
        definitionYaml: scaffoldMetricYaml(r.dataset),
      };
    },
  },
  {
    name: 'get_dashboard',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'Read ONE dashboard you can see (also called: report, business intelligence (BI), data visualization) — its charts with their governed metric members, the governed view they bind to, tier and owner. Purpose: read back exactly what create_dashboard saved so you can iterate (create_dashboard with the same `id` replaces it) Before: list_dashboards. After: query_metric on a chart’s member to read the same number. Governance: read-only, the SAME visibility rule as list_dashboards (My · Domain · Company) — an unseeable id is a typed not_found/forbidden (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Dashboard id from list_dashboards.' },
      },
      required: ['dashboardId'],
      examples: [{ dashboardId: 'dash_sales_overview_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.dashboardId).trim();
      if (!id) fail('get_dashboard needs a `dashboardId` (from list_dashboards)', 400);
      const d = getDashboard(id, P(user)); // visibility guard (403/404)
      return {
        id: d.id,
        name: d.spec.name,
        view: d.spec.view,
        tier: d.tier,
        owner: d.owner,
        domain: d.domain,
        // Normalize each panel and expose a back-compat `metric` (first member) alongside
        // the authoritative `metrics`, so existing MCP consumers keep reading `chart.metric`.
        charts: d.spec.charts.map((c) => {
          const p = normalizePanel(c);
          return { ...p, metric: panelMetrics(p)[0] };
        }),
      };
    },
  },
  {
    name: 'get_file',
    tab: 'files',
    minRole: 'creator',
    description:
      'Read ONE governed file you are entitled to — metadata (name, folder, tags, description, sensitivity, tier, version history) plus the extracted text. Purpose: read back what upload_file stored so agents can quote the actual content, not a guess. Before: list_files or search_files. After: request_promotion once documented, or reference the content in knowledge/agent work. Governance: read-only through the SAME document-level entitlement filter (DLS) as the Files tab — an unentitled id is a typed not_found/forbidden. Honesty: `restricted` files return metadata ONLY (the text is stored but never returned or indexed), and long text is truncated at ~8k characters with an explicit note — never silently.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File id from list_files / search_files.' },
      },
      required: ['fileId'],
      examples: [{ fileId: 'as_ab12cd34' }],
    },
    call: async (user, args) => {
      const id = str(args.fileId).trim();
      if (!id) fail('get_file needs a `fileId` (from list_files / search_files)', 400);
      const v = getFile(id, P(user)); // DLS entitlement guard (403/404)
      const a = v.asset;
      const restricted = a.sensitivity === 'restricted';
      const body = restricted ? { text: null, note: 'This file is `restricted` — its text is stored but never returned or indexed. You see metadata only.' } : truncated(v.text, FILE_TEXT_CAP);
      return {
        id: a.id,
        name: a.name,
        owner: a.owner,
        domain: a.domain,
        tier: a.tier,
        visibility: a.visibility,
        folder: a.folder,
        tags: a.tags,
        description: a.description,
        sensitivity: a.sensitivity,
        kind: a.kind,
        indexing: a.indexing.mode,
        version: a.version,
        bytes: v.bytes,
        history: v.history,
        text: body.text,
        textNote: body.note,
        /** Present when the original bytes were stored (UI or MCP binary upload);
         *  null for text-only (MCP `upload_file` without `base64Content`) records. */
        object: v.object ? { key: v.object.key, contentType: v.object.contentType, bytes: v.object.bytes } : null,
      };
    },
  },
  {
    name: 'read_app_files',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read an app’s FILE TREE — or, when `path` is given, one FILE’s content (kind "file") OR a DIRECTORY’s immediate entries (kind "dir"). The read-back counterpart of `commit`: what you committed is what you read. Purpose: iterate on the real code instead of re-guessing it. Before: list_software / get_software (you must be able to SEE the app — the same gate). After: commit changed files, start_preview, get_software_status. Governance: read-only under YOUR identity; an unseeable app is a typed not_found (no existence leak). Honesty: reads the live Forgejo repo when reachable (mode "live"); otherwise the last tree committed through the governed commit door — or the template seed for a fresh app — honestly labelled mode "offline-mock". Large files are truncated at ~24k characters with an explicit note.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        path: { type: 'string', description: 'Optional. A FILE path returns its content; a DIRECTORY path returns its entries (drill down); omit it for the whole tree.' },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd34' }, { appId: 'app_ab12cd34', path: 'app.yaml' }],
    },
    call: async (user, args) => {
      const appId = str(args.appId).trim();
      if (!appId) fail('read_app_files needs an `appId` (from list_software)', 400);
      const path = str(args.path).trim().replace(/\/+$/, ''); // tolerate a trailing slash
      const app = await getAppForUser(appId, user); // visibility guard (404)
      // The last tree committed through the governed commit door (or the template seed
      // for a fresh app) — the OS's own snapshot store is the source of truth now that
      // there is no external git forge. Hydrate the durable mirror first so this
      // survives a pod restart (the tree is not lost when the committing process is gone).
      await hydrateSnapshot(app.id);
      const tree = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
      const note = 'Forgejo is unreachable — this is the app’s last governed-commit tree (or the template seed for a fresh app), labelled offline-mock.';
      if (!path) {
        return { appId, mode: 'offline-mock', branch: 'main', files: tree.map((f) => f.path).sort((a, b) => a.localeCompare(b)), note };
      }
      const f = tree.find((x) => x.path === path);
      if (!f) {
        // Not a file — is it a directory? Return its listing instead of a bare 404 so
        // the agent can drill down. Only a path matching NOTHING is a true not_found.
        const dir = dirListing(tree.map((x) => x.path), path);
        if (dir.length > 0) return { appId, mode: 'offline-mock', branch: 'main', kind: 'dir', path, entries: dir, note };
        fail(`Path not found in the app tree: ${path}`, 404);
      }
      const body = truncated(f.content, APP_FILE_CAP);
      return { appId, mode: 'offline-mock', kind: 'file', path: f.path, content: body.text, contentNote: body.note, note };
    },
  },
  {
    name: 'get_software_status',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read ONE app’s HONEST status card: preview state (with a URL only when a runner actually serves one — never fabricated), deploy state (requested / approved / denied, with the reviewer and note), release count and the last governed commit. Purpose: the single read that tells you where an app truly is in create → preview → review → live, so you never act on a claimed-but-not-served URL. Before: list_software / get_software. After: start_preview or request_deploy (or fix and re-commit after a denial). Governance: read-only, the same visibility gate as get_software — an unseeable app is a typed not_found. Honesty rule, enforced: `preview.url` and `deploy.liveUrl` are null unless the workload is actually served; a pending runner or an offline cluster is SAID, not papered over.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd34' }],
    },
    call: async (user, args) => {
      const appId = str(args.appId).trim();
      if (!appId) fail('get_software_status needs an `appId` (from list_software)', 400);
      let app = await getAppForUser(appId, user); // visibility guard (404)
      // RECONCILE the live runner at READ time (0.6.114): the persisted `app.deploy`
      // captured previewUrl at start_preview — when the pod was NOT yet running — so a
      // stale read re-emits "runner unreachable" even though the pod is now 1/1 Running.
      // reconcileDeployStatus re-polls the real Deployment and self-heals previewUrl.
      // Fail-soft: a non-owner creator (403) or offline cluster falls back to the stale
      // fields + the honest pending note; we never fabricate a URL.
      let runner: RunnerStatus | null = null;
      try {
        const reconciled = await reconcileDeployStatus(appId, user);
        app = reconciled.app;
        runner = reconciled.status;
      } catch {
        /* fail-soft: keep the last persisted deploy fields */
      }
      // Honest preview note from the FRESH runner status (running ⇒ served URL, no note;
      // provisioned-not-running ⇒ image build in progress; offline/null ⇒ unreachable).
      const previewNote = previewNoteForRunner(runner);
      const openCard = app.deploy.reviewCardId ? await getReviewCard(app.deploy.reviewCardId) : null;
      const latest = openCard ?? (await listReviewCards({ domain: app.domain })).find((c) => c.appId === app.id) ?? null;
      const isLive = app.deploy.state === 'live';
      // NEVER claim a working URL that is not actually served: live state alone is not
      // enough — a runner must actually be serving the workload right now.
      const liveServed = isLive && runner?.phase === 'running' && runner.ready >= 1;
      const lastCommit = [...app.chat].reverse().find((m) => m.role === 'assistant' && m.content.startsWith('Committed:')) ?? null;
      return {
        appId: app.id,
        name: app.name,
        status: app.status,
        preview: {
          state: app.deploy.state,
          url: app.deploy.previewUrl,
          ...(app.deploy.previewUrl ? {} : { note: previewNote }),
        },
        deploy: {
          state: app.deploy.state,
          releases: app.deploy.releases,
          approvedEnvelope: app.deploy.approved,
          review: latest
            ? {
                cardId: latest.id,
                decision: latest.decision,
                requestedBy: latest.requestedBy,
                requestedAt: latest.requestedAt,
                decidedBy: latest.decidedBy ?? null,
                note: latest.note ?? null,
              }
            : null,
          liveUrl: liveServed ? `https://${app.subdomain}` : null,
          ...(isLive && !liveServed
            ? { liveUrlNote: 'Approved to go live, but no cluster runner serves it here — so no URL is claimed.' }
            : {}),
        },
        build: {
          lastCommit: lastCommit ? { message: lastCommit.content, at: lastCommit.at } : null,
          updatedAt: app.updatedAt,
        },
      };
    },
  },
];

