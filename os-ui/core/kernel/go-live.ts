/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    go_live / retire — the ONLY two verbs that change what runs
 * USER STORY: As a builder I want one button that says "this version is the one that runs", and
 *             I want the OS to refuse if something it depends on is still a draft — naming it,
 *             so I know exactly what to fix. And I want editing afterwards to be safe: a new
 *             draft, with what Run serves completely unchanged until I go live again.
 * ARCHITECTURE:
 *   - ONE service behind BOTH doors: the MCP tools (`core/mcp/lifecycle-tools.ts`) and the UI
 *     route call exactly these functions, so the two can never drift. There is no other way to
 *     change a lifecycle: no setter that takes a word, no MCP field, no UI shortcut (V-R3.2/V7).
 *   - The guard is `goLiveGuard` from the pure model; this file only RESOLVES the dependency
 *     list (through the kind's adapter) and the dependencies' own lifecycles (through the pin
 *     index), then hands both to the one implementation.
 *   - Lives in the kernel, not in `tabs/governance/lib`, because the MCP tool module must not
 *     import a tab (CORE-INDEPENDENCE is a hard structural ratchet) and the tool module must
 *     reach this. The per-kind knowledge lives in each tab's adapter instead — deviation V-4.
 *   - Identity: every adapter call takes the acting user and the store re-gates. Nothing here
 *     reads or writes under a service principal.
 *   - Honest refusals: a kind with no adapter, an object the caller may not operate, and a
 *     non-live dependency are three DIFFERENT typed errors, each naming the thing at fault.
 */

import {
  goLiveGuard,
  lifecycleOf,
  lifecycleWordOf,
  goLiveConfirmCopy,
  retireConfirmCopy,
  isLifecycleKind,
  type Lifecycle,
  type LifecycleDependency,
  type LifecycleKind,
  type LifecycleWord,
} from '@core/kernel/object-lifecycle';
import {
  lifecycleAdapterFor,
  registeredLifecycleKinds,
  type LifecycleActor,
  type LifecycleObject,
} from '@core/kernel/lifecycle-adapters';
import {
  lifecycleIndex,
  setLivePin,
  clearLivePin,
  type PinWriteDeps,
} from '@core/infra/lifecycle-pins';

/** A typed failure the MCP layer maps to `bad_request` / `forbidden` / `not_found` / `conflict`. */
export function lifecycleError(message: string, status: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/**
 * A bad `kind` is a bad ARGUMENT (400); a `kind` nobody has wired up yet means the object
 * cannot be resolved at all, which is a NOT FOUND (404) whose reason says why — honest about
 * the gap rather than pretending the object is missing for some other reason.
 */
function requireAdapter(kind: string, id: string) {
  if (!isLifecycleKind(kind)) {
    throw lifecycleError(
      `'${kind}' is not a lifecycle kind — use one of: dataset, metric, dashboard, agent, app, knowledge, connection`,
      400,
    );
  }
  const adapter = lifecycleAdapterFor(kind);
  if (!adapter) {
    const wired = registeredLifecycleKinds().join(', ');
    throw lifecycleError(
      `no ${kind} '${id}' you can take live: going live is not wired up for ${kind} yet (today: ${wired || 'none'})`,
      404,
    );
  }
  return adapter;
}

/** The lifecycle + audience of one object, resolved as the caller. */
export async function lifecycleStatus(
  actor: LifecycleActor,
  kind: string,
  id: string,
): Promise<{
  object: LifecycleObject;
  lifecycle: Lifecycle;
  word: LifecycleWord;
  tier: string;
}> {
  const adapter = requireAdapter(kind, id);
  const object = await adapter.resolve(actor, id);
  const index = await lifecycleIndex();
  const lifecycle = lifecycleOf(object.kind, object.id, object.head, index);
  return { object, lifecycle, word: lifecycleWordOf(lifecycle), tier: object.tier };
}

/** The resolved dependency list with each dependency's OWN lifecycle attached. */
export async function goLiveDependencies(
  actor: LifecycleActor,
  object: LifecycleObject,
): Promise<LifecycleDependency[]> {
  const adapter = lifecycleAdapterFor(object.kind);
  const refs = (await adapter?.dependencies?.(actor, object)) ?? [];
  const index = await lifecycleIndex();
  return refs.map((r) => ({
    kind: r.kind,
    id: r.id,
    name: r.name,
    // A dependency's draft ref is irrelevant to the guard — only whether it has a pin is.
    lifecycle: lifecycleOf(r.kind, r.id, 'unversioned', index),
  }));
}

export type GoLivePreview = {
  object: LifecycleObject;
  /** The ref go-live WOULD pin (the head, unless the caller named one). */
  ref: string;
  dependencies: LifecycleDependency[];
  /** The one confirm dialog's text, stating what starts running. */
  confirm: { title: string; body: string; confirmLabel: string };
  /** Why it would be refused, already naming the offending dependency. */
  blocked: string | null;
};

/**
 * Everything the ONE confirm dialog needs, with no side effect — so the UI shows the same
 * sentence the MCP would act on, and the guard is evaluated before the user commits.
 */
export async function previewGoLive(
  actor: LifecycleActor,
  kind: string,
  id: string,
  ref?: string,
): Promise<GoLivePreview> {
  const adapter = requireAdapter(kind, id);
  const object = await adapter.resolve(actor, id);
  const target = (ref ?? '').trim() || object.head;
  const dependencies = await goLiveDependencies(actor, object);
  const decision = goLiveGuard(dependencies);
  const consequences = (await adapter.consequences?.(actor, object)) ?? [];
  return {
    object,
    ref: target,
    dependencies,
    confirm: goLiveConfirmCopy(object.kind, object.name, target, consequences),
    blocked: decision.ok ? null : decision.reason,
  };
}

export type GoLiveResult = {
  kind: LifecycleKind;
  id: string;
  name: string;
  domain: string;
  lifecycle: Lifecycle;
  /** The pinned ref — what Run serves from now on. */
  live: string;
  /** The git tag the pin carries, and whether it was actually written. */
  tag: { name: string; written: boolean };
  /** The commit that recorded the pin in the domain repo, when the repo was writable. */
  commit: { sha: string; changed: boolean } | null;
  /** What now runs, in the tools' own words. */
  starts: string[];
};

/**
 * Pin a version as what runs. `ref` defaults to the object's current head — "go live with what
 * I am looking at". Refuses, with a reason that names the offending dependency, when anything
 * this object depends on is not itself live.
 */
export async function goLive(
  actor: LifecycleActor,
  kind: string,
  id: string,
  ref?: string,
  deps: PinWriteDeps = {},
): Promise<GoLiveResult> {
  const adapter = requireAdapter(kind, id);
  const object = await adapter.resolve(actor, id);
  const permission = await adapter.canGoLive(actor, object);
  if (!permission.ok) throw lifecycleError(permission.reason, 403);

  const target = (ref ?? '').trim() || object.head;
  if (!target || target === 'unversioned') {
    throw lifecycleError(
      `${object.kind} “${object.name}” has no saved version to pin yet — save it once, then go live`,
      409,
    );
  }

  const dependencies = await goLiveDependencies(actor, object);
  const decision = goLiveGuard(dependencies);
  if (!decision.ok) throw lifecycleError(decision.reason, 409);

  const written = await setLivePin(object.kind, object.id, target, actor, object.domain, deps, object.path);
  const index = await lifecycleIndex();
  const starts = (await adapter.consequences?.(actor, object)) ?? [];
  return {
    kind: object.kind,
    id: object.id,
    name: object.name,
    domain: object.domain,
    lifecycle: lifecycleOf(object.kind, object.id, object.head, index),
    live: written.pin.ref,
    tag: written.tag,
    commit: written.commit ? { sha: written.commit.sha, changed: written.commit.changed } : null,
    starts,
  };
}

export type RetireResult = {
  kind: LifecycleKind;
  id: string;
  name: string;
  lifecycle: Lifecycle;
  /** True when a pin was actually removed; false when it was not live to begin with. */
  unpinned: boolean;
  commit: { sha: string; changed: boolean } | null;
  /** Said out loud because the word "retire" frightens people: nothing was deleted. */
  deleted: never[];
};

/** Unpin. Run stops showing the object; the draft, its history and every version stay. */
export async function retire(
  actor: LifecycleActor,
  kind: string,
  id: string,
  deps: PinWriteDeps = {},
): Promise<RetireResult> {
  const adapter = requireAdapter(kind, id);
  const object = await adapter.resolve(actor, id);
  const permission = await adapter.canGoLive(actor, object);
  if (!permission.ok) throw lifecycleError(permission.reason, 403);

  const cleared = await clearLivePin(object.kind, object.id, actor, object.domain, deps);
  const index = await lifecycleIndex();
  return {
    kind: object.kind,
    id: object.id,
    name: object.name,
    lifecycle: lifecycleOf(object.kind, object.id, object.head, index),
    unpinned: cleared.removed,
    commit: cleared.commit ? { sha: cleared.commit.sha, changed: cleared.commit.changed } : null,
    deleted: [],
  };
}

/** The retire confirm dialog's text — the UI's twin of the MCP verb. */
export async function previewRetire(
  actor: LifecycleActor,
  kind: string,
  id: string,
): Promise<{ object: LifecycleObject; confirm: { title: string; body: string; confirmLabel: string } }> {
  const adapter = requireAdapter(kind, id);
  const object = await adapter.resolve(actor, id);
  return { object, confirm: retireConfirmCopy(object.kind, object.name) };
}
