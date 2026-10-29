/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  getAppByIdInternal,
  getEditableAppForUser,
  persistApp,
  templateFiles,
  withStatus,
  GOVERNED_FRONTEND_TEMPLATES,
  type App,
} from '@tabs/software/lib/apps';
import { vendorSdkForRepo } from '@tabs/software/lib/app-sdk-vendor';
import type { CurrentUser } from '@core/kernel/auth';
import { generateAndCompile } from '@tabs/software/lib/auto-mcp';
import { parseAppManifest, parseOpenApi, resolveSurface, reconcileKnowledgeConsumes } from '@tabs/software/lib/metadata';
import type { AuthorInput, AuthorResult, FrontDoorKey } from '@tabs/software/lib/adapters';
import type { AdapterStep, ScaffoldFile } from '@tabs/software/lib/model';
import { ungrantedDatasetWarningForApp } from '@tabs/software/lib/dataset-guard';

/**
 * Software commit server boundary. A commit writes the app's source tree to the
 * durable file mirror (`snapshot.ts` — the one home of a coded app's files; there is
 * no git backend) and then runs the GOVERNED logic every front door shares: compile
 * gate, metadata parse, auto-MCP→OPA, the dataset guard.
 *
 * This module also hosts the THREE front-door adapters (chat · platform-mcp ·
 * git-import). They author content differently but all converge on `commitToApp`,
 * which re-parses the metadata convention and recompiles the auto-MCP on every
 * commit — "whatever is committed is seen in the app".
 */

// ------------------------------------------------ Committed-file snapshot ------
//
// The latest committed files per app (moved to ./snapshot.ts so the editor save
// path in apps.ts can update it too, without an import cycle). Re-exported here
// for existing importers.
import { snapshotFiles, getSnapshot, hydrateSnapshot } from '@tabs/software/lib/snapshot';
import { ensureSectionsRegistered, unregisteredPageHints } from '@tabs/software/lib/sections-registry';
import { compileGate, formatGateError, gateActivityNote } from '@tabs/software/lib/compile-gate';
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
 * files to the durable source tree, then runs the metadata commit hook: re-parse the
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
  // Auto-wire epic story pages into the section registry BEFORE committing, so a
  // built page can never be left unregistered/invisible (sovereign-app only; a
  // no-op for other templates; fail-open). Then merge the changeset over the prior
  // tree and parse against the full tree.
  // Hydrate the prior tree from the DURABLE mirror on a cold-process miss so a
  // commit after a pod restart merges the changeset over the app's REAL last tree
  // (not the bare template seed) — the whole-tree metadata parse + scan stay honest.
  await hydrateSnapshot(app.id);
  const prior = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
  const toCommit = ensureSectionsRegistered(prior, files, app.template);
  const tree = mergeTree(prior, toCommit);
  // COMPILE GATE (verify-before-commit, redesign Week 1): the MERGED tree — including
  // the just-regenerated sections.tsx above — must COMPILE against the vendored
  // @sovereign-os/ui + @sovereign-os/app-sdk before ANY write (no mirror write, no
  // snapshot). A red gate throws the exact diagnostics as a typed, corrective tool
  // error, so the same build turn fixes them and re-commits; the rejection also counts
  // toward the bounded reasoning escalation like every other commit tool error.
  // Non-Vite/legacy shapes are honestly passed through ungated (`gated: false`,
  // recorded on the step) — the gate never blocks what it cannot check.
  const gate = await compileGate(tree);
  if (gate.gated && !gate.ok) {
    throw withStatus(new Error(formatGateError(gate)), 422);
  }
  // The commit lands in the durable file mirror below (snapshotFiles) — the step
  // records the gate outcome (audited surface) + a human line, so the activity feed /
  // MCP result / audit all see "compile check ✓" or the honest "skipped (ungated
  // shape)" — never silence.
  let step: AdapterStep = {
    ok: true,
    mode: 'live',
    detail: `${gateActivityNote(gate)}; committed ${toCommit.length} file${toCommit.length === 1 ? '' : 's'} to ${app.slug} — "${message}"`,
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
  app.chat.push({ role: 'assistant', content: `Committed: ${message}`, at: new Date().toISOString() });
  snapshotFiles(app.id, tree);
  await persistApp(app);
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
 * The three front doors. Each authors content its own way and returns a uniform
 * AuthorResult; `applyAuthor`/`commitToApp` then run the SAME governed pipeline.
 * An import arrives as a file tree like every other door.
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
