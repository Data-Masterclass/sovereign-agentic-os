/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import {
  getAppByIdInternal,
  getEditableAppForUser,
  healAppRepo,
  persistApp,
  templateFiles,
  withStatus,
  latestMainSha,
  triggerOsBuild,
  GOVERNED_FRONTEND_TEMPLATES,
  type App,
} from '@/lib/software/apps';
import { vendorSdkForRepo } from './app-sdk-vendor.ts';
import type { CurrentUser } from '@/lib/core/auth';
import { generateAndCompile } from './auto-mcp.ts';
import { parseAppManifest, parseOpenApi, resolveSurface, reconcileKnowledgeConsumes } from './metadata.ts';
import type { PipelineBackend, AuthorInput, AuthorResult, FrontDoorKey } from './adapters.ts';
import type { AdapterStep, RunMode, ScaffoldFile } from './model.ts';
import { ungrantedDatasetWarningForApp } from './dataset-guard.ts';

/**
 * Software pipeline server boundary — the live/offline-mock DUAL exactly like
 * `lib/agents/build/server.ts`. When Forgejo is reachable (a cluster is up) the
 * effectful steps run against the real Forgejo/Argo plumbing and report
 * `mode: 'live'`; on a laptop with no cluster they fall back to the in-process
 * teaching mock, honestly labelled `mode: 'offline-mock'`. Either way the
 * GOVERNED logic (metadata parse, auto-MCP→OPA, the review gate) is identical.
 *
 * This module also hosts the FOUR front-door adapters (chat · platform-mcp ·
 * git-push · git-import). They author content differently but all converge on
 * `commitToApp`, which re-parses the metadata convention and recompiles the
 * auto-MCP on every commit — "whatever is committed is seen in the app".
 */

async function reachable(url: string, path: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${url}${path}`, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function forgejoReachable(): Promise<boolean> {
  return reachable(config.forgejoUrl, '/api/v1/version');
}

// --------------------------------------------------------- Pipeline backends ---

function mockBackend(): PipelineBackend {
  const mode: RunMode = 'offline-mock';
  return {
    mode,
    async scaffoldRepo(slug, files) {
      return { ok: true, mode, detail: `mock: scaffolded ${slug} (${files.length} files)` };
    },
    async commit(slug, files, message) {
      return { ok: true, mode, detail: `mock: committed ${files.length} files to ${slug} — "${message}"` };
    },
    async preview(slug) {
      return {
        step: { ok: true, mode, detail: `mock: ephemeral preview for ${slug}` },
        url: `https://preview--${slug}.sandbox.local`,
      };
    },
    async deploy(slug) {
      return { ok: true, mode, detail: `mock: Harbor → Argo CD → live for ${slug}` };
    },
  };
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.forgejoUser}:${config.forgejoPassword}`).toString('base64');
}

function liveBackend(): PipelineBackend {
  const mode: RunMode = 'live';
  const owner = config.forgejoRepoOwner;
  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${config.forgejoUrl}/api/v1${path}`, {
        method,
        headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const raw = await res.text();
      let data: unknown = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = raw;
      }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * WHY a single write failed — so the commit summary can name the true cause and
   * `commitToApp` can tell the ONE self-healable case (the whole repo vanished)
   * apart from a per-file problem it must NOT paper over with a re-provision:
   *   • 'unreachable'  — Forgejo did not answer (status 0). Never guess.
   *   • 'sha-conflict' — a PUT was rejected (422/409): stale blob sha, not repo loss.
   *   • 'backend'      — any other non-2xx (perms, validation, 5xx).
   * The repo-missing case is NOT decided here (one file's 404 is ambiguous — it is
   * a brand-new file just as often as a gone repo); `putAll` confirms it once, for
   * the whole changeset, against a repo-existence probe.
   */
  type WriteFail = { kind: 'unreachable' | 'sha-conflict' | 'backend'; status: number };
  type WriteResult = 'committed' | 'unchanged' | WriteFail;
  const isFail = (r: WriteResult): r is WriteFail => typeof r === 'object';
  /**
   * Create-or-update ONE file as its own commit — the sha dance Forgejo requires.
   * The contents API needs the current blob `sha` on UPDATE: a PUT without it
   * fails request binding with 422 before Forgejo even looks at the file. The
   * old code sent no sha and treated 422 as success ("already exists"), so every
   * post-seed commit to an existing file silently became a no-op — no commit, no
   * push, NO CI RUN, while the step still reported ok. Identical content is
   * skipped honestly (no empty commit → no phantom Actions task).
   */
  async function put(slug: string, f: ScaffoldFile, message: string): Promise<WriteResult> {
    const enc = f.path.split('/').map(encodeURIComponent).join('/');
    const cur = await api('GET', `/repos/${owner}/${slug}/contents/${enc}?ref=main`);
    if (cur.status === 0) return { kind: 'unreachable', status: 0 };
    const d = cur.ok
      ? (cur.data as { type?: string; sha?: string; content?: string; encoding?: string } | null)
      : null;
    const sha = d?.type === 'file' && typeof d.sha === 'string' && d.sha ? d.sha : null;
    if (sha) {
      const existing =
        typeof d?.content === 'string'
          ? d.encoding === 'base64'
            ? Buffer.from(d.content, 'base64').toString('utf8')
            : d.content
          : null;
      if (existing === f.content) return 'unchanged';
      const res = await api('PUT', `/repos/${owner}/${slug}/contents/${enc}`, {
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        message,
        branch: 'main',
        sha,
      });
      if (res.ok) return 'committed';
      // A rejected UPDATE with a sha in hand is a sha conflict (422/409), not a
      // gone repo — the blob moved under us. Distinguish it so heal never fires.
      const kind = res.status === 422 || res.status === 409 ? 'sha-conflict' : 'backend';
      return { kind, status: res.status };
    }
    const res = await api('POST', `/repos/${owner}/${slug}/contents/${enc}`, {
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      message,
      branch: 'main',
    });
    if (res.ok) return 'committed';
    return { kind: res.status === 0 ? 'unreachable' : 'backend', status: res.status };
  }
  /** Does the repo itself exist? A repo-level 404 is the one heal-able cause. */
  async function repoMissing(slug: string): Promise<boolean> {
    const probe = await api('GET', `/repos/${owner}/${slug}`);
    return probe.status === 404;
  }
  async function putAll(slug: string, files: ScaffoldFile[], message: (f: ScaffoldFile) => string) {
    let committed = 0;
    let unchanged = 0;
    const failed: { path: string; fail: WriteFail }[] = [];
    for (const f of files) {
      const r = await put(slug, f, message(f));
      if (r === 'committed') committed++;
      else if (r === 'unchanged') unchanged++;
      else if (isFail(r)) failed.push({ path: f.path, fail: r });
    }
    // Classify the changeset ONCE: only a genuine repo-level 404 is repo-missing.
    // A write that saw a 404/backend error while the repo still exists is a file/
    // backend problem heal must NOT mask. Probe only when something failed and no
    // failure was a definite non-repo cause (sha-conflict/unreachable are decisive).
    let missing = false;
    if (failed.length > 0 && failed.every((x) => x.fail.kind === 'backend')) {
      missing = await repoMissing(slug);
    }
    return { committed, unchanged, failed, missing };
  }
  /** One human line per failed file naming the cause (so build agent + human can act). */
  const reason = (kind: WriteFail['kind'], status: number, missing: boolean): string =>
    kind === 'unreachable'
      ? 'Forgejo unreachable'
      : kind === 'sha-conflict'
        ? `sha conflict (HTTP ${status}) — the file changed under this commit; re-read and retry`
        : missing
          ? 'the repository is missing (HTTP 404)'
          : `backend error (HTTP ${status})`;
  const failList = (
    failed: { path: string; fail: WriteFail }[],
    missing: boolean,
  ): string => failed.map((x) => `${x.path} (${reason(x.fail.kind, x.fail.status, missing)})`).join(', ');
  return {
    mode,
    async scaffoldRepo(slug, files) {
      const { committed, unchanged, failed, missing } = await putAll(slug, files, (f) => `seed ${f.path}`);
      const n = committed + unchanged;
      const detail =
        `live: seeded ${n}/${files.length} files into ${slug}` +
        (failed.length > 0 ? ` — FAILED: ${failList(failed, missing)}` : '');
      return { ok: n > 0, mode, detail, repoMissing: missing };
    },
    async commit(slug, files, message) {
      const { committed, unchanged, failed, missing } = await putAll(slug, files, () => message);
      const parts = [`live: committed ${committed}/${files.length} files to ${slug}`];
      if (unchanged > 0) parts.push(`${unchanged} unchanged (skipped)`);
      if (failed.length > 0) parts.push(`FAILED: ${failList(failed, missing)}`);
      else if (committed === 0) parts.push('nothing changed — no push, so no CI run');
      return { ok: failed.length === 0, mode, detail: parts.join('; '), repoMissing: missing };
    },
    async preview(slug) {
      // Argo CD ApplicationSet PR/branch generator spins this up on a cluster;
      // here we report the deterministic sandbox URL it would expose.
      return {
        step: { ok: true, mode, detail: `live: preview Application requested for ${slug}` },
        url: `https://preview--${slug}.${config.appsBaseDomain}`,
      };
    },
    async deploy(slug) {
      return { ok: true, mode, detail: `live: Argo CD sync requested for ${slug}` };
    },
  };
}

/** Choose the backend by reachability — the honest live/offline-mock switch. */
export async function pickBackend(): Promise<PipelineBackend> {
  return (await forgejoReachable()) ? liveBackend() : mockBackend();
}

// ------------------------------------------------ Committed-file snapshot ------
//
// The latest committed files per app (moved to ./snapshot.ts so the editor save
// path in apps.ts can update it too, without an import cycle). Re-exported here
// for existing importers.
import { snapshotFiles, getSnapshot, hydrateSnapshot } from './snapshot.ts';
import { ensureSectionsRegistered, unregisteredPageHints } from './sections-registry.ts';
import { compileGate, formatGateError, gateActivityNote } from './compile-gate.ts';
export { snapshotFiles, getSnapshot, hydrateSnapshot };

/**
 * A commit is a CHANGESET, not the whole tree. Merge the changed files over the
 * app's current tree (its prior snapshot, or the template seed on the first
 * commit) so the metadata parse + surface detection + security scan/diff see the
 * WHOLE repo — a partial `git push` must not make the untouched app.yaml/openapi/
 * .app files "disappear", nor hide the rest of the repo from the scanner.
 */
function mergeTree(prior: ScaffoldFile[], incoming: ScaffoldFile[]): ScaffoldFile[] {
  const byPath = new Map(prior.map((f) => [f.path, f]));
  for (const f of incoming) byPath.set(f.path, f);
  return [...byPath.values()];
}

// ----------------------------------------------------- Commit (convergence) ----

/**
 * The ONE convergent commit step every front door flows through. Writes the
 * files (live or mock), then runs the metadata commit hook: re-parse the
 * app.yaml/OpenAPI convention and recompile the auto-MCP (reads-on/writes-off →
 * OPA) so the app page + the governed MCP reflect exactly what was committed.
 */
export async function commitToApp(
  appId: string,
  user: { id: string },
  files: ScaffoldFile[],
  message: string,
): Promise<{ app: App; step: AdapterStep }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const backend = await pickBackend();
  // Auto-wire epic story pages into the section registry BEFORE committing, so a
  // built page can never be left unregistered/invisible (sovereign-app only; a
  // no-op for other templates; fail-open). Then push only the changeset (correct
  // for live Forgejo) and parse against the full tree.
  // Hydrate the prior tree from the DURABLE mirror on a cold-process miss so a
  // commit after a pod restart merges the changeset over the app's REAL last tree
  // (not the bare template seed) — the whole-tree metadata parse + scan stay honest.
  await hydrateSnapshot(app.id);
  const prior = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
  const toCommit = ensureSectionsRegistered(prior, files, app.template);
  const tree = mergeTree(prior, toCommit);
  // COMPILE GATE (verify-before-commit, redesign Week 1): the MERGED tree — including
  // the just-regenerated sections.tsx above — must COMPILE against the vendored
  // @sovereign-os/ui + @sovereign-os/app-sdk before ANY write (no Forgejo PUT, no
  // mirror write, no snapshot). A red gate throws the exact diagnostics as a typed,
  // corrective tool error, so the same build turn fixes them and re-commits; the
  // rejection also counts toward the bounded reasoning escalation like every other
  // commit tool error. Non-Vite/legacy shapes are honestly passed through ungated
  // (`gated: false`, recorded on the step) — the gate never blocks what it cannot check.
  const gate = await compileGate(tree);
  if (gate.gated && !gate.ok) {
    throw withStatus(new Error(formatGateError(gate)), 422);
  }
  let step = await backend.commit(app.slug, toCommit, message);
  // AUTO-HEAL the ONE self-healable failure: the app's Forgejo repo VANISHED (a
  // repo-level 404, distinguished from a per-file 404/sha conflict by the backend's
  // `repoMissing` flag). Re-provision it from the scaffold + any surviving snapshot
  // (`healAppRepo`, audited + idempotent), then RETRY the commit ONCE against the
  // fresh repo. Both are audited. A sha conflict / backend error / unreachable
  // Forgejo is NOT healed — heal must never paper over a per-file problem. If heal
  // or the retried commit still fails, we throw naming the TRUE state below.
  if (!step.ok && step.repoMissing) {
    const heal = await healAppRepo(app);
    if (!heal.ok) {
      throw withStatus(
        new Error(`the app's repository is missing and could not be re-provisioned: ${heal.detail} — commit unchanged (${step.mode}).`),
        502,
      );
    }
    step = await backend.commit(app.slug, toCommit, message);
    if (!step.ok) {
      throw withStatus(
        new Error(`the app's repository was re-provisioned but the retried commit still did not land: ${step.detail} (${step.mode}). The app is unchanged.`),
        502,
      );
    }
  }
  // HONESTY GATE: a commit the backend REJECTED (live Forgejo unreachable, a 404/422
  // on the repo, or a partial write with failures) must NOT masquerade as success — we
  // do NOT snapshot or persist it, and we THROW so the caller/agent-loop sees a real
  // tool error (which feeds the corrective loop + bounded escalation). Persisting a
  // rejected commit was the root of "story shows built but nothing landed": the diff
  // read the phantom snapshot even though the repo got nothing. A no-op (nothing
  // changed) is NOT a failure — `ok` stays true there, so this only fires on real loss.
  // The per-file reasons in `step.detail` now name WHY each file failed (repo missing /
  // sha conflict / backend error) so both the build agent and the human can act.
  if (!step.ok) {
    throw withStatus(
      new Error(`commit did not land: ${step.detail} (${step.mode}). Nothing was written — fix the error and retry; the app is unchanged.`),
      502,
    );
  }
  // Record the gate outcome ON the commit (audited surface): the step carries a typed
  // `gate` field + a human note in `detail`, so the activity feed / MCP result / audit
  // all see "compile check ✓" or the honest "skipped (ungated shape)" — never silence.
  step = {
    ...step,
    detail: `${gateActivityNote(gate)}; ${step.detail}`,
    gate: gate.gated ? { gated: true, ok: true } : { gated: false, reason: gate.reason },
  };

  // UNGRANTED-DATASET GUARD (0.6.97): the merged tree that just committed must only
  // reference datasets in the app's grants. A reference outside `app.grants.data` is
  // the root of the live `Forbidden: … not granted ds_…`. We WARN (never block — the
  // scanner reads text conservatively; a hard block could false-positive on an id in a
  // comment): the warning rides on the commit's audited `detail` so the reference can't
  // land silently, and the same warning re-surfaces on the deploy review card.
  const datasetWarning = await ungrantedDatasetWarningForApp(app, tree);
  if (datasetWarning) step = { ...step, detail: `${step.detail}\n⚠ ${datasetWarning}` };

  // SECTION-REGISTRATION HINT (0.6.115): `ensureSectionsRegistered` fail-opens, so a page
  // that violates the depth-4 / PascalCase / one-per-folder / not-general rule is committed
  // but INVISIBLE with no error ("builds but the feature never shows"). Surface those
  // near-misses as an audited hint on the commit detail (sovereign-app only) — the generator
  // stays correct; this only turns the silent drop into a visible, actionable note.
  if (app.template === 'sovereign-app') {
    for (const hint of unregisteredPageHints(tree)) step = { ...step, detail: `${step.detail}\n⚠ ${hint}` };
  }

  // Metadata fidelity: parse the convention over the WHOLE tree on every commit.
  const manifest = parseAppManifest(tree, { name: app.name, owner: app.owner, description: app.description });
  app.manifest = manifest;
  // A committed `surface:` in app.yaml is a fresh declaration; keep the app's
  // declaration in sync with it (intent recorded on the record too).
  if (manifest.declaredSurface) app.declaredSurface = manifest.declaredSurface;
  // Consumes fidelity: `declares.knowledge` is AUTHORITATIVE for the app's KNOWLEDGE
  // consumes/lineage edges. Reconcile them to exactly match the committed declares —
  // ADD newly-declared refs AND PRUNE refs no longer declared — so a re-commit that
  // drops a knowledge ref drops its stale edge (which otherwise blocks deleting the
  // now-unreferenced knowledge, since the delete is lineage-aware). Data/connection
  // consumes are recorded through other governed paths and are left untouched here.
  app.consumes = reconcileKnowledgeConsumes(app.consumes, manifest.knowledge);
  // Surface fidelity: re-resolve the UI/API surface from the whole committed tree
  // so the monitor view adapts to what the agent actually built — but a declaration
  // (committed `surface:` or the app's recorded intent) WINS over the heuristic.
  app.surface = resolveSurface(tree, app.declaredSurface);
  // Recompile the auto-MCP from the committed OpenAPI when present.
  const openapi = parseOpenApi(tree);
  if (openapi) {
    const tools = generateAndCompile(app.mcpPrincipal, { openapi });
    app.mcpTools = tools.map((t) => ({ name: t.name, description: t.description, write: t.write }));
    app.mcpProfileCompiled = true;
  }
  app.chat.push({ role: 'assistant', content: `Committed: ${message} (${step.mode})`, at: new Date().toISOString() });
  snapshotFiles(app.id, tree);
  await persistApp(app);
  // PHASE B — DIRECT BUILD SERVICE: on a LIVE commit, take the serving image off Forgejo
  // Actions by submitting an in-cluster Kaniko build for the just-landed head commit.
  // Fire-and-forget (best-effort: it must never block or fail the commit); it no-ops
  // unless the build service is enabled (flag + chart RBAC). The Forgejo Actions path
  // stays in the scaffold as the export/CI-confirmation path either way.
  if (step.mode === 'live') {
    void latestMainSha(app)
      .then((sha) => { if (sha) triggerOsBuild(app, sha); })
      .catch(() => { /* best-effort — a poll/next commit re-covers it */ });
  }
  return { app, step };
}

/**
 * Re-vendor the OS-client SDK into an EXISTING governed-frontend app so it picks up
 * a newer `lib/app-sdk` (e.g. the `os.records.*` write surface) without a full
 * re-scaffold. New scaffolds get it automatically; existing apps froze a copy under
 * `vendor/@sovereign-os/app-sdk/` at seed time, so this commits the CURRENT source
 * over it through the SAME governed commit path (`commitToApp`) — which re-runs the
 * compile gate, so the refresh can never land a tree that does not build. Edit-scoped
 * (owner / in-domain admin) via `getEditableAppForUser`. Returns the commit outcome.
 *
 * This is the cheap path the app-detail "refresh" wires to. A non-governed-frontend
 * template has no vendored SDK to refresh, so it is a no-op (honest, not an error).
 */
export async function refreshVendoredSdk(
  appId: string,
  user: CurrentUser,
): Promise<{ app: App; step: AdapterStep } | { skipped: true; reason: string }> {
  // Edit-scope gate (throws 403/404 as the other edit paths do).
  const app = await getEditableAppForUser(appId, user);
  if (!GOVERNED_FRONTEND_TEMPLATES.has(app.template)) {
    return { skipped: true, reason: `template '${app.template}' has no vendored SDK to refresh` };
  }
  const files = vendorSdkForRepo(); // fresh vendor/@sovereign-os/app-sdk/* from disk
  return commitToApp(app.id, user, files, 'chore: refresh vendored @sovereign-os/app-sdk (os.records.* write surface)');
}

// ------------------------------------------------------- Front-door adapters ---

function deriveManifest(input: AuthorInput, files: ScaffoldFile[]) {
  return parseAppManifest(files, { name: input.name, owner: input.owner, description: input.description });
}

/**
 * The four front doors. Each authors content its own way and returns a uniform
 * AuthorResult; `applyAuthor`/`commitToApp` then run the SAME governed pipeline.
 * Git is the bridge: git-push and git-import both arrive as a file tree.
 */
export async function authorThroughFrontDoor(door: FrontDoorKey, input: AuthorInput): Promise<AuthorResult> {
  switch (door) {
    case 'chat': {
      // The in-app OpenCode chat writes the metadata convention as it builds.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'build via chat', missing: manifest.missing };
    }
    case 'platform-mcp': {
      // The Platform MCP captures/requires the metadata alongside the code, so an
      // external client (Claude Code) cannot silently drop it.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'commit via Platform MCP', missing: manifest.missing };
    }
    case 'git-push': {
      // A raw push gives code; the commit-hook convention backstops the metadata.
      const files = input.files ?? [];
      const manifest = deriveManifest(input, files);
      return { door, files, manifest, message: input.message ?? 'git push', missing: manifest.missing };
    }
    case 'git-import': {
      // Mirror an external repo in + wrap as a governed app. We derive what we can
      // (OpenAPI/README/structure) and PROMPT for the rest via `missing`.
      const files = input.files ?? [
        { path: 'README.md', content: `# ${input.name}\n\nImported from ${input.repoUrl ?? 'an external repo'}.\n` },
      ];
      const manifest = deriveManifest(input, files);
      return {
        door,
        files,
        manifest,
        message: `import ${input.repoUrl ?? 'external repo'}`,
        missing: manifest.missing,
      };
    }
    default:
      throw withStatus(new Error(`Unknown front door: ${door}`), 400);
  }
}
