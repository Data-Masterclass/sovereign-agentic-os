/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-30 (design 04 M7, 11 A24) — workflow guardrails as OPA DATA from git, decided by
 *             the platform policy `os.guardrails` (charts/sovereign-agentic-os/policies/guardrails.rego)
 * USER STORY: As an operator I want OPA to enforce exactly the guardrails each domain has committed,
 *             loaded by OPA's own bundle mechanism, and a missing OPA to deny.
 * ARCHITECTURE:
 *   - SOURCE (`restoreGuardrailsFromGit`, registered `bundled` in `opa-state-sources.ts` when
 *     `OS_GUARDRAILS_DATA` is on): for every domain repository at its HEAD commit, each committed
 *     `knowledge/workflows/<slug>/guardrails.json` goes to `os_data.guardrails[<workflow id>]`,
 *     the id read from the sibling `workflow.md`'s `x-sovereign-os-meta` (OKF extension point).
 *     The os-data bundle compiler runs it in capture mode; OPA downloads the bundle
 *     (https://www.openpolicyagent.org/docs/management-bundles). No policy module is uploaded.
 *   - COMPLETE OR NOTHING: a file that does not parse or does not match the shape, a workflow.md
 *     without an id, or one id committed twice refuses the source, so the bundle compiler keeps the
 *     last good bundle. Knowledge git off refuses too: there is nothing to enforce from.
 *   - DECISION (`decideGuardrails`): `POST /v1/data/os/guardrails/decision`. Unreachable OPA, an
 *     error or an undefined result is a deny (`policy_unreachable`). No in-process fallback.
 *   - VERIFY (`verifyGuardrails`): what the Rules panel shows — OPA's active guardrail ids for the
 *     workflow equal the ids compiled from its hard rules.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { listRepos, listTree, log, readBlob } from '@core/infra/git-store';
import { publishOpa } from '@core/policy/opa-publish';
import type { OpaSourceResult } from '@core/policy/opa-reconcile';
import { KNOWLEDGE_WORKFLOWS_DIR } from '@core/infra/repo-layout';
import { OS_META_KEY, splitFrontmatter } from '@tabs/knowledge/lib/git/bundle';
import { knowledgeGitEnabled } from '@tabs/knowledge/lib/git/commit';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import type { GuardrailResult } from '@tabs/knowledge/lib/guardrails-apply';
import type { Workflow } from '@tabs/knowledge/lib/schema';

export type GuardrailDecision = { allow: boolean; reason: string; violated: string[]; guardrails: string[] };
type GuardrailDoc = { guardrails: { id: string; level: string; step_id?: string; text: string }[] };

/** The OPA data path of the guardrails (one document, every workflow). */
export const GUARDRAILS_DATA_PATH = 'os_data/guardrails';

const FILE_RE = new RegExp(`^${KNOWLEDGE_WORKFLOWS_DIR}/([^/]+)/guardrails\\.json$`);

/** The committed file's shape (the compiler's `data`), or a reason it is not. */
function checkDoc(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'guardrails' || !Array.isArray((v as GuardrailDoc).guardrails)) return 'expected exactly {"guardrails": [...]}';
  for (const g of (v as GuardrailDoc).guardrails) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id || typeof g.text !== 'string' || (g.level !== 'workflow' && g.level !== 'step')) {
      return `invalid guardrail ${JSON.stringify(g)}`;
    }
    if (g.step_id !== undefined && typeof g.step_id !== 'string') return `invalid step_id in ${g.id}`;
  }
  return null;
}

/** Every domain repository's committed guardrails → `os_data.guardrails`. Never throws. */
export async function restoreGuardrailsFromGit(opts: { reposDir?: string } = {}): Promise<OpaSourceResult> {
  const reposDir = opts.reposDir ?? config.reposDir;
  if (!opts.reposDir && !knowledgeGitEnabled()) {
    return { ok: false, detail: 'knowledge git is off (DATA_PROJECT_GIT=false): there are no committed guardrails to compile' };
  }
  const out: Record<string, GuardrailDoc> = {};
  const from = new Map<string, string>();
  const read: string[] = [];
  try {
    for (const repo of await listRepos({ reposDir })) {
      const domain = repo.name;
      const sha = (await log(domain, { reposDir, limit: 1 }))[0]?.sha;
      if (!sha) continue;
      read.push(`${domain}@${sha.slice(0, 12)}`);
      for (const e of await listTree(domain, sha, { reposDir })) {
        const m = FILE_RE.exec(e.path);
        if (!m) continue;
        const where = `${domain}@${sha.slice(0, 12)}:${e.path}`;
        let doc: unknown;
        try {
          doc = JSON.parse(await readBlob(domain, sha, e.path, { reposDir }));
        } catch (err) {
          return { ok: false, detail: `${where}: ${err instanceof Error ? err.message : String(err)}` };
        }
        const bad = checkDoc(doc);
        if (bad) return { ok: false, detail: `${where}: ${bad}` };
        const wfPath = `${KNOWLEDGE_WORKFLOWS_DIR}/${m[1]}/workflow.md`;
        const meta = splitFrontmatter(await readBlob(domain, sha, wfPath, { reposDir }).catch(() => '')).front[OS_META_KEY] as Record<string, unknown> | undefined;
        const id = meta?.id ? String(meta.id) : '';
        if (!id) return { ok: false, detail: `${where}: ${wfPath} names no workflow id (${OS_META_KEY}.id)` };
        if (from.has(id)) return { ok: false, detail: `${where}: workflow ${id} is also committed at ${from.get(id)}` };
        from.set(id, where);
        out[id] = doc as GuardrailDoc;
      }
    }
  } catch (err) {
    return { ok: false, detail: `reading the domain repositories: ${err instanceof Error ? err.message : String(err)}` };
  }
  const r = await publishOpa({ kind: 'data', path: GUARDRAILS_DATA_PATH, value: out });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, detail: `${Object.keys(out).length} workflow(s) with guardrails from ${read.length} repo(s) [${read.join(', ')}]` };
}

const DENY = (reason: string): GuardrailDecision => ({ allow: false, reason, violated: [], guardrails: [] });

/** Ask OPA. Any failure to get a decision is a deny. */
export async function decideGuardrails(workflowId: string, violations: string[], opts: { opaUrl?: string; timeoutMs?: number } = {}): Promise<GuardrailDecision> {
  const url = `${opts.opaUrl ?? config.opaUrl}/v1/data/os/guardrails/decision`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { workflow_id: workflowId, violations } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
    });
    if (!res.ok) return DENY('policy_unreachable');
    const d = ((await res.json()) as { result?: GuardrailDecision }).result;
    if (!d || typeof d.allow !== 'boolean' || !Array.isArray(d.guardrails) || !Array.isArray(d.violated)) return DENY('policy_unreachable');
    return { allow: d.allow, reason: String(d.reason), violated: d.violated, guardrails: d.guardrails };
  } catch {
    return DENY('policy_unreachable');
  }
}

/**
 * The Rules panel's check in data mode: nothing is uploaded; OPA must have this workflow's
 * committed guardrails active (they reach it on its next bundle download, 5–15 s).
 */
export async function verifyGuardrails(workflow: Workflow, opts: { waitMs?: number } = {}): Promise<GuardrailResult> {
  const compiled = compileGuardrails(workflow);
  const want = [...new Set(compiled.guardrails.map((g) => g.id))].sort();
  const { awaitKnowledgeCommits } = await import('@tabs/knowledge/lib/git/commit');
  await awaitKnowledgeCommits();
  const { recompileOsData } = await import('@core/policy/bundle');
  const compile = await recompileOsData('guardrails-verify');
  const end = Date.now() + (opts.waitMs ?? 20_000);
  let d = await decideGuardrails(workflow.id, []);
  while (d.reason !== 'policy_unreachable' && d.guardrails.join() !== want.join() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    d = await decideGuardrails(workflow.id, []);
  }
  const verified = d.reason !== 'policy_unreachable' && d.guardrails.join() === want.join();
  const detail = verified
    ? `OPA enforces the ${want.length} committed guardrail(s) of this workflow (platform policy os.guardrails, os-data bundle).`
    : d.reason === 'policy_unreachable'
      ? 'OPA is unreachable: guardrails are not enforced and every guarded call is denied.'
      : `OPA has ${d.guardrails.length} guardrail(s) active for this workflow, the committed rules have ${want.length}${compile.ok ? '' : ` (bundle not recompiled: ${compile.detail})`}.`;
  return {
    compiled,
    apply: { applied: verified, verified, status: verified ? 'ok' : 'fail', policy: 'opa-bundle', detail, ...(verified ? {} : { error: d.reason === 'policy_unreachable' ? 'policy_unreachable' : 'not active' }) },
  };
}
