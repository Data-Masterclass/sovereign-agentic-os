/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { normaliseFolderPath } from '@/lib/core/folders';
import { setGrant, contextAccessCap } from '@/lib/core/context-grants';
import { setAgentGrant } from '@/lib/software/app-agent-grants';
import { getAppForUser, patchAppDesign, type App } from '@/lib/software/apps';
import { createDataset, moveDataset, type Principal } from '@/lib/data/store';
import { createFile } from '@/lib/files/store';
import { createPersonalKnowledge } from '@/lib/knowledge/personal-store';
import { createSystem } from '@/lib/agents/store';

/**
 * CONTEXT-PROVISION — the Phase-4b "create new context IN the App folder, then grant it"
 * orchestration behind the six-type Choose-Context surface (DESIGN.md "Choose Context").
 *
 * For a data/metrics/files/knowledge type, "Create new" makes a FRESH, possibly-EMPTY
 * governed artifact via that type's EXISTING governed create fn, drops it into the app's
 * own `App «Name»` folder under that tab, and adds the app grant — so the new context
 * appears cleanly in the normal tab to fill later. Agents/Connections "Create new"
 * deep-links into their own tab builders instead (they have their own creators); this
 * module only handles the artifact kinds it can create in place, PLUS the agents grant
 * once an agent id is chosen there.
 *
 * Everything is GOVERNED + fail-soft:
 *   • The artifact is created AS the caller (their create rights; every kind is born
 *     Personal/owner-only — a governed PROMOTION to Domain is a separate step, so the
 *     0.6.115 personal-in-shared warning applies and is surfaced by the caller).
 *   • The grant is added through `patchAppDesign` — the SAME edit-scoped governed door
 *     the grant PATCH uses (a non-owner/-admin caller is rejected 403 there).
 *   • The folder placement is best-effort (a folder-registry hiccup never rolls back a
 *     successful create — mirrors the stores' own `upsertFolderRow` pattern).
 */

/** The context types this module can CREATE in place (agents/connections deep-link elsewhere). */
export type ProvisionableType = 'data' | 'files' | 'knowledge';

/** The app-owned folder path a created artifact is placed in, e.g. `App «Renewals»`.
 *  A DISPLAY organiser under the type's tab; the name is sanitised into a single safe
 *  path segment (folder segments cannot contain `/`), so odd app names never break the
 *  path or escape into a nested folder. Empty/whitespace names fall back to `App`. */
export function appContextFolder(appName: string): string {
  const safe = String(appName ?? '')
    .replace(/[\\/]+/g, ' ') // slashes would split into extra segments
    .replace(/\s+/g, ' ')
    .trim();
  return normaliseFolderPath(`/App «${safe || 'Untitled'}»`);
}

/** The user's identity as the stores' {@link Principal}. */
function principalOf(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}

/** The outcome of a create-and-grant: the created artifact + the folder + the updated app. */
export type CreateAndGrantResult = {
  type: ProvisionableType | 'agents';
  /** The created artifact's id (for agents: the granted agent id). */
  id: string;
  name: string;
  /** The App folder the new artifact was placed in (create kinds only). */
  folder?: string;
  app: App;
};

/** The input for a create-and-grant, per type. Agents pass an EXISTING agent id to grant
 *  (its creation happens in the Agents tab); the create kinds pass at least a name. */
export type CreateAndGrantInput =
  | { name: string }            // data | files | knowledge → create empty + grant
  | { agentId: string; name?: string }; // agents → grant an existing agent id

/**
 * Create a fresh, empty artifact of `type` in the app's `App «Name»` folder and grant it
 * to the app — or, for `agents`, grant an already-created agent. Returns the created id +
 * the updated app. Edit-scope + create rights are enforced by the underlying governed fns
 * (`patchAppDesign` gates the grant; the store create fns gate the artifact). Fail-soft on
 * the folder placement only.
 */
export async function createAndGrant(
  appId: string,
  type: ProvisionableType | 'agents',
  input: CreateAndGrantInput,
  user: CurrentUser,
): Promise<CreateAndGrantResult> {
  // Edit-scope FIRST (a viewer can't scaffold context onto someone else's app). This throws
  // 403/404 exactly like the grant PATCH; the grant itself re-checks in patchAppDesign.
  const app = await getAppForUser(appId, user);
  const p = principalOf(user);

  // Agents: no artifact is created here — the agent already exists (built in the Agents tab);
  // we only ADD the grant. `agentId` is required.
  if (type === 'agents') {
    const agentId = 'agentId' in input ? input.agentId : '';
    if (!agentId) throw Object.assign(new Error('an agent grant needs an agentId'), { status: 400 });
    const next = setAgentGrant(app.agents, agentId, 'read-only');
    const updated = await patchAppDesign(appId, user, { agents: next });
    return { type, id: agentId, name: 'name' in input && input.name ? input.name : agentId, app: updated };
  }

  const name = ('name' in input && input.name ? input.name : '').trim();
  if (!name) throw Object.assign(new Error('a new artifact needs a name'), { status: 400 });
  const folder = appContextFolder(app.name);
  // Reference/scaffold context is READ (never a write target): read-only is the correct,
  // non-regressing grant default (a builder can raise it later in the grant surface).
  const cap = contextAccessCap('read-only');

  let id: string;
  let createdName: string;
  if (type === 'data') {
    // Create in the APP'S domain so a later promotion lands in the schema the app resolves
    // against (same as the data-plan resolve); then place it in the App folder (best-effort).
    const ds = createDataset(p, { name, domain: app.domain });
    id = ds.id;
    createdName = ds.name;
    try { moveDataset(ds.id, p, folder); } catch { /* folder placement is best-effort */ }
  } else if (type === 'files') {
    // Files accept a folder AT create (createFile normalises input.folder), so no move needed.
    const f = createFile(p, { name, folder });
    id = f.id;
    createdName = f.name;
  } else {
    // Personal knowledge accepts a folder at create too.
    const k = createPersonalKnowledge(p, { title: name, folder, domain: app.domain });
    id = k.id;
    createdName = k.title;
  }

  const grants = setGrant(app.grants, type, id, 'read-only', cap);
  const updated = await patchAppDesign(appId, user, { grants });
  return { type, id, name: createdName, folder, app: updated };
}

/** Create a fresh EMPTY agent in the Agents tab AS the caller and grant it to the app — the
 *  server twin used when the Agents "Create new" flow scaffolds an agent inline rather than
 *  deep-linking (kept here so both paths share the one governed orchestration). The heavy
 *  Agents-builder authoring stays in the Agents tab; this is only the empty create + grant. */
export async function createAgentAndGrant(
  appId: string,
  name: string,
  user: CurrentUser,
): Promise<CreateAndGrantResult> {
  const app = await getAppForUser(appId, user);
  const sys = createSystem(principalOf(user), { name: name.trim() || 'Untitled agent', domain: app.domain });
  const next = setAgentGrant(app.agents, sys.id, 'read-only');
  const updated = await patchAppDesign(appId, user, { agents: next });
  return { type: 'agents', id: sys.id, name: sys.name, app: updated };
}
