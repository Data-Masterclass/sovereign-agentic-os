/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The Data tab's engineering view — the dbt model, the Dagster asset, the git files
 * USER STORY: As an engineer I open "Under the hood" on a data product and read the dbt model SQL
 *             and the `schema.yml` AS COMMITTED, the repo path, the Dagster asset key, job and
 *             schedule with its last run, and the commands `dbt build --select <node>` and
 *             `dagster asset materialize --select <key>` (checklist T1, T3, T4, T6).
 * ARCHITECTURE:
 *   - The adapter contract of `core/engineering/` (plan D25): the tab's OWN gated read first
 *     (`getDataset`, which throws the 404/403 the MCP maps to `not_found`/`forbidden`), then a
 *     pure mapping onto the shared section builders. No React, no route import.
 *   - The dbt bytes come from the REPOSITORY, not from the generator: `readRepoFiles` reads the
 *     blobs at `main`, so the panel shows what `git show` shows. The model is located by the
 *     physical slug the generator itself uses (`physicalSlug`), and the paths found are reported
 *     rather than predicted.
 *   - Dagster is read over GraphQL and may be unreachable; that is a labelled fact on the section
 *     (`lastRunNote`), never a substituted value.
 */
import 'server-only';
import { getDataset } from '@tabs/data/lib/store';
import { physicalSlug } from '@tabs/data/lib/store-fqn';
import { readRepoFiles, repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS, type DagsterFacts } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';
import { dagsterConfigured, modelAssetKey, runsForDataset, sanitizeName, scheduleNameFor } from '@core/infra/dagster';
import { roleAllowed, TOOLS } from '@core/infra/tool-proxy';

const OS_NOUN = 'data product';

/**
 * Where "Open in Dagster" may send this caller, and why it may not.
 *
 * Dagster's console is **not** opened through the `/tools/dagster` proxy: `core/infra/tool-proxy.ts`
 * declares `ownTab` for it precisely because its Next.js chunks load from the site root and render
 * blank behind the prefix, so the honest address is its own ingress (`dagsterConsoleUrl`). The
 * tool's own `minRole` still decides who may follow it — the panel must not hand a creator a link
 * the proxy and the ingress would both refuse.
 */
export function dagsterConsoleFor(principal: EngineeringPrincipal): { url: string | null; reason?: string } {
  const tool = TOOLS.dagster;
  if (!dagsterConfigured()) return { url: null, reason: 'Dagster is not configured in this deployment (no DAGSTER_URL), so there is no console to open' };
  if (!roleAllowed(principal.role, tool.minRole)) {
    return { url: null, reason: `opening the Dagster console needs ${tool.minRole}; you are ${principal.role}. The asset key and the command below are yours either way` };
  }
  const consoleUrl = tool.ownTab?.consoleUrl ?? '';
  if (!consoleUrl) {
    return { url: null, reason: 'this deployment does not expose the Dagster console (DAGSTER_CONSOLE_URL is empty), so the run exists but has no address here' };
  }
  return { url: consoleUrl };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The committed dbt model paths of one data product: `models/**\/<layer>_<slug>[__<id>].sql`. */
export function modelPathsFor(paths: string[], slug: string): string[] {
  const re = new RegExp(`(^|/)(bronze|silver|gold)_${escape(slug)}(__[a-z0-9_]+)?\\.sql$`);
  return paths.filter((p) => p.startsWith('models/') && re.test(p)).sort();
}

/** The dbt node name of a model path — the file's basename, which is what `--select` takes. */
export function nodeOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.sql$/, '');
}

/** The layer order the panel prefers when a product has several models. */
const LAYER_RANK = ['gold', 'silver', 'bronze'];
function preferredNode(modelPaths: string[]): string | null {
  const ranked = [...modelPaths].sort((a, b) => {
    const la = LAYER_RANK.findIndex((l) => nodeOf(a).startsWith(`${l}_`));
    const lb = LAYER_RANK.findIndex((l) => nodeOf(b).startsWith(`${l}_`));
    return (la < 0 ? 9 : la) - (lb < 0 ? 9 : lb);
  });
  return ranked.length ? nodeOf(ranked[0]) : null;
}

/** The engineering view of one data product. */
export async function datasetEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const d = getDataset(id, principal);
  const domain = d.domain;
  const slug = physicalSlug(d);
  // A Company-tier (`product`) data product is visible to a caller who is NOT in its domain, but
  // the domain REPOSITORY is members-only (`requireMember` in `tabs/data/lib/dbt/read.ts`, which
  // every project route goes through). So a non-member sees this product's OWN model files and
  // nothing domain-wide, and is offered no export: showing bytes the blob route would 403, or a
  // download that would 403, is exactly the kind of quiet inconsistency this panel exists to kill.
  const member = principal.domains.includes(domain);

  // ---- dbt: the bytes in the repository ----------------------------------------
  const listed = await repoPaths(domain);
  const modelPaths = modelPathsFor(listed.paths, slug);
  const dirs = new Set(modelPaths.map((p) => p.split('/').slice(0, -1).join('/')));
  const tracked = new Set(listed.paths);
  const wanted = new Set<string>(modelPaths);
  // Only paths that are REALLY tracked: a `schema.yml` the generator has not written yet must not
  // appear in the git file list as though it were committed.
  for (const dir of dirs) if (member && tracked.has(`${dir}/schema.yml`)) wanted.add(`${dir}/schema.yml`);
  if (member && tracked.has('models/sources.yml')) wanted.add('models/sources.yml');
  if (member) for (const p of listed.paths) if (p.startsWith('models/semantic/') && modelPaths.some((m) => p.endsWith(`/${nodeOf(m)}.yml`))) wanted.add(p);
  const read = await readRepoFiles(domain, (p) => wanted.has(p));
  const node = preferredNode(modelPaths);
  const hasSemantic = read.files.some((f) => f.path.startsWith('models/semantic/'));
  const dbt = dbtSection({
    osNoun: OS_NOUN,
    node,
    files: read.files,
    metrics: hasSemantic ? d.measures.map((m) => m.name) : [],
    unavailable:
      read.reason ??
      listed.reason ??
      `no dbt model named \`<layer>_${slug}\` is committed in '${domain}' yet — build a layer and the generator writes \`models/<layer>/${slug}.sql\` on the next commit`,
    caveats: [
      ...(member
        ? []
        : [
          `You are not a member of '${domain}', so this panel shows only this data product's own dbt model file. The rest of the domain's dbt project — \`models/sources.yml\`, the other models, the semantic files — and the project export are members-only, which is the same rule the project API applies.`,
        ]),
      ...(hasSemantic ? [] : [
        `No \`models/semantic/<model>.yml\` is committed for this data product yet, so there is no dbt \`semantic_models:\`/\`metrics:\` block to show here and \`mf query\` would find nothing. The KPI's own panel shows the dbt metric once the semantic emitter lands it.`,
      ]),
    ],
  });

  // ---- Dagster: the asset the scheduler runs -----------------------------------
  const assetKeys = modelPaths.map((p) => modelAssetKey(domain, nodeOf(p)));
  const consoleLink = dagsterConsoleFor(principal);
  const facts: DagsterFacts = {
    assetKeys,
    jobName: assetKeys.length ? `${sanitizeName(domain)}__all` : null,
    scheduleName: assetKeys.length ? scheduleNameFor(domain, d.id) : null,
    lastRun: null,
    uiBaseUrl: consoleLink.url,
    ...(consoleLink.reason ? { noLinkReason: consoleLink.reason } : {}),
  };
  if (assetKeys.length) {
    if (!dagsterConfigured()) {
      facts.lastRunNote = 'Dagster is not configured in this deployment (no DAGSTER_URL), so no run can be read';
    } else {
      const runs = await runsForDataset(d.id, 1);
      if (!runs.ok) facts.lastRunNote = `Dagster did not answer, so the last run is unknown: ${runs.error}`;
      else if (runs.data.length === 0) facts.lastRunNote = 'this asset has no Dagster run yet';
      else facts.lastRun = { runId: runs.data[0].runId, status: runs.data[0].status, startedAt: runs.data[0].startedAt };
    }
  }
  const dagster = dagsterSection({
    osNoun: OS_NOUN,
    facts,
    unavailable: assetKeys.length ? undefined : 'no dbt model is committed for this data product, so the code location defines no Dagster asset for it',
  });

  // ---- git + Langfuse ----------------------------------------------------------
  const git = gitSection({
    osNoun: OS_NOUN,
    repo: domain,
    cloneUrl: null,
    head: listed.head,
    files: [...wanted].sort().map((p) => ({ path: p })),
    tracked,
    unavailable: listed.reason ?? `nothing is committed for \`${slug}\` in '${domain}' yet`,
  });
  const langfuse = langfuseSection({
    osNoun: OS_NOUN,
    traces: [],
    enabled: false,
    unavailable:
      'a dbt build is traced by Dagster, not by Langfuse — Langfuse carries agent runs and model calls, and this data product has neither',
    redactions: LANGFUSE_REDACTIONS,
  });

  return sealView({
    kind: 'dataset',
    id: d.id,
    name: d.name,
    domain,
    sections: [dbt, dagster, git, langfuse],
    export: {
      tool: 'dbt',
      label: 'dbt project tarball',
      href: member ? `/api/data/projects/${encodeURIComponent(domain)}/export` : null,
      ...(member
        ? {}
        : { unresolvedReason: `the dbt project of '${domain}' is members-only, and you are not a member of it — ask for domain membership, or clone the repository as someone who has it` }),
      commands: [
        `tar -xf ${domain}-<sha>.tar -C ${domain}`,
        `cd ${domain} && dbt parse --profiles-dir .`,
        node ? `dbt build --select ${node} --profiles-dir .` : 'dbt build --profiles-dir .',
      ],
    },
  }, tracked);
}
