/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    An app DECLARES its actions, and an agent may call one only through the four-layer
 *             fail-closed intersection — capability ∩ declaration ∩ ADOPTION ∩ grant
 * USER STORY: As a domain admin I must consent before my domain's agents can be granted a
 *             vibe-engineered app's actions, and an app action must execute as the CALLING RUN's
 *             principal inside the app's declared scopes, held under the read-only preset when it
 *             writes (night-2 S8, decision D21).
 * ARCHITECTURE:
 *   - AUDIT FIRST, stated plainly (S-R7.6). What exists today:
 *       · `tabs/software/lib/app-tool-call.ts` `callAppTool` runs the governed spine for an
 *         app-MCP tool call: `authorizeConnectionCall` over the app's compiled capability profile
 *         → fallback `authorizeAppTool` (the app-registry grant) → a WRITE is HELD (202) in the
 *         Governance inbox → deny is 403 → allow executes → Langfuse trace. That is layers
 *         1 (capability) and 4 (grant), and the hold, and they already work.
 *       · `tabs/connections/lib/action-adoptions.ts` `adoptActions` / `adoptionCovers` is the
 *         DOMAIN ADOPTION layer — a `domain_admin` of the TARGET domain consents, the record is
 *         soft-revocable, and the intersection recomputes per call so a revoke bites immediately.
 *         It governs CONNECTION exposures (`exposureId` + entity keys) and is reached over MCP by
 *         `list_adoptable_actions` / `adopt_entity_actions`.
 *       · There is NO declaration layer for apps at all: an app's agent-callable surface is
 *         derived from its committed OpenAPI by `auto-mcp.ts`, with no author-declared scope and
 *         no consent step.
 *   - WHAT CHANGES HERE, exactly: this module adds (a) the DECLARATION — `actions.yml` (or an
 *     AppSpec `actions:` block) parsed into typed `AppAction[]` with a name, an input schema, the
 *     scopes it may touch and whether it writes — and (b) the explicit four-layer intersection as
 *     a PURE function, with the adoption layer read through an injected port.
 *   - WHAT DOES NOT CHANGE: `adoptActions` itself. A tab may not import another tab
 *     (`CONTRIBUTING.md`), so the software tab cannot call the connections store directly; the
 *     port is how the SAME store is wired in (by the route/composition layer) without growing a
 *     parallel one. Moving `action-adoptions.ts` to `@core` is the follow-on that completes it,
 *     and it is a CONNECTIONS-tab change — recorded as a cross-stream need, not done here.
 *   - FAIL-CLOSED, AND ONLY FOR THE NEW SURFACE: a DECLARED action with no adoption is refused.
 *     Existing auto-MCP tools keep today's behaviour exactly, so nothing that works today
 *     regresses — the adoption gate arrives with the surface it governs.
 *   - Pure: parsing + the intersection are plain functions, no I/O, unit-testable alone.
 */
import type { ScaffoldFile } from '@tabs/software/lib/model';

/** The scopes an app action may declare. An action may never touch what it did not declare. */
export const ACTION_SCOPES = ['records', 'data', 'knowledge', 'metrics', 'files'] as const;
export type ActionScope = (typeof ACTION_SCOPES)[number];

export type AppAction = {
  /** The governed tool name agents see (snake_case, the app-MCP convention). */
  name: string;
  description: string;
  /** Does it mutate? A write is NEVER auto-enabled under the reads-on/writes-off preset. */
  write: boolean;
  /** The scopes it may touch — declared by the author, enforced on every call. */
  scopes: ActionScope[];
  /** The input schema, as declared. Shallow on purpose: an honest pass-through. */
  input: Record<string, string>;
};

export type ActionParseIssue = { path: string; reason: string; fix: string };
export type ParsedAppActions = { actions: AppAction[]; issues: ActionParseIssue[] };

/** The file an app declares its agent-callable actions in. */
export const ACTIONS_FILE = 'actions.yml';

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;

function isScope(s: string): s is ActionScope {
  return (ACTION_SCOPES as readonly string[]).includes(s);
}

/**
 * Parse `actions.yml` from a committed tree. The format is the flat, indentation-light subset the
 * OS already uses for `app.yaml`, so no YAML dependency is needed and the parse cannot execute
 * anything:
 *
 *   actions:
 *     - name: list_invoices
 *       description: List invoices the caller may see.
 *       write: false
 *       scopes: [records, data]
 *       input:
 *         status: string
 *
 * A malformed entry becomes an ISSUE and is DROPPED — never a half-declared action, and never a
 * silent drop: the issues ride back to the commit step and the review card.
 */
export function parseAppActions(files: ScaffoldFile[]): ParsedAppActions {
  const file = files.find((f) => f.path === ACTIONS_FILE);
  if (!file) return { actions: [], issues: [] };
  const actions: AppAction[] = [];
  const issues: ActionParseIssue[] = [];
  let cur: Partial<AppAction> & { input?: Record<string, string> } | null = null;
  let inInput = false;
  let index = -1;

  const flush = () => {
    if (!cur) return;
    const at = `${ACTIONS_FILE}#actions[${index}]`;
    const name = String(cur.name ?? '').trim();
    if (!NAME_RE.test(name)) {
      issues.push({ path: at, reason: `'${name || '(missing)'}' is not a valid action name`, fix: 'Use snake_case, 3–48 chars, starting with a letter (e.g. `list_invoices`).' });
      cur = null;
      return;
    }
    if (actions.some((a) => a.name === name)) {
      issues.push({ path: at, reason: `the action '${name}' is declared twice`, fix: 'Give each action one declaration with one name.' });
      cur = null;
      return;
    }
    const scopes = (cur.scopes ?? []).filter(isScope);
    if (scopes.length === 0) {
      issues.push({ path: at, reason: `'${name}' declares no valid scope`, fix: `Declare at least one of: ${ACTION_SCOPES.join(', ')}.` });
      cur = null;
      return;
    }
    actions.push({
      name,
      description: String(cur.description ?? '').trim(),
      write: cur.write === true,
      scopes,
      input: cur.input ?? {},
    });
    cur = null;
  };

  for (const raw of file.content.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^actions:\s*$/.test(trimmed)) continue;
    if (/^-\s/.test(trimmed)) {
      flush();
      index++;
      inInput = false;
      cur = { input: {} };
      const rest = trimmed.replace(/^-\s*/, '');
      if (rest) applyField(cur, rest, issues, index);
      continue;
    }
    if (!cur) continue;
    if (/^input:\s*$/.test(trimmed)) {
      inInput = true;
      continue;
    }
    if (inInput && /^[A-Za-z_][A-Za-z0-9_]*:\s*\S/.test(trimmed)) {
      const [k, ...v] = trimmed.split(':');
      cur.input![k.trim()] = v.join(':').trim();
      continue;
    }
    inInput = false;
    applyField(cur, trimmed, issues, index);
  }
  flush();
  return { actions, issues };
}

function applyField(
  cur: Partial<AppAction> & { input?: Record<string, string> },
  text: string,
  issues: ActionParseIssue[],
  index: number,
): void {
  const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text);
  if (!m) return;
  const [, key, value] = m;
  const v = value.trim().replace(/^['"]|['"]$/g, '');
  if (key === 'name') cur.name = v;
  else if (key === 'description') cur.description = v;
  else if (key === 'write') cur.write = v === 'true';
  else if (key === 'scopes') {
    const list = v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !isScope(s));
    if (bad.length > 0) {
      issues.push({
        path: `${ACTIONS_FILE}#actions[${index}].scopes`,
        reason: `unknown scope(s): ${bad.join(', ')}`,
        fix: `Use only: ${ACTION_SCOPES.join(', ')}.`,
      });
    }
    cur.scopes = list.filter(isScope);
  }
}

// ------------------------------------------------- the four-layer intersection ---

/** Layer 3, read through a port so the SAME connections-tab adoption store can be wired in. */
export type AdoptionPort = {
  /**
   * Has `domain` adopted this app's actions? `app-<slug>` is the exposure key an app adoption
   * record carries, so the existing `{exposureId, domain, entities}` shape fits unchanged.
   */
  adopted: (appExposureId: string, domain: string, actionName: string) => boolean;
};

/** Everything the intersection needs. All four layers are REQUIRED — there is no default-allow. */
export type ActionCallContext = {
  /** The app's declared actions (layer 2) — from `parseAppActions` over the COMMITTED tree. */
  declared: AppAction[];
  /** The tool names the app's compiled capability profile exposes (layer 1). */
  capability: string[];
  /** The tools this agent run was GRANTED (layer 4). */
  granted: string[];
  /** The domain whose agents are calling (adoption is per domain). */
  domain: string;
  /** `app-<slug>` — the app's principal, used as the adoption/exposure key. */
  appExposureId: string;
  /** Is the calling run under the reads-on/writes-off preset? (the default for every app) */
  readsOnWritesOff?: boolean;
};

export type ActionAuthz =
  | { effect: 'allow'; action: AppAction; reason: string }
  | { effect: 'requires_approval'; action: AppAction; reason: string }
  | { effect: 'deny'; layer: 'declaration' | 'capability' | 'adoption' | 'grant'; reason: string };

/**
 * The fail-closed intersection, in the order that gives the most useful refusal:
 *   1. DECLARATION — the app must declare the action (otherwise it is not an action at all).
 *   2. CAPABILITY  — the app's compiled profile must expose it.
 *   3. ADOPTION    — a `domain_admin` of the calling domain must have adopted it.
 *   4. GRANT       — this run must have been granted it.
 * A WRITE under the reads-on/writes-off preset is never allowed outright: it is
 * `requires_approval`, which `callAppTool` turns into the 202 hold in the Governance inbox.
 *
 * Pure. Every layer is re-checked on EVERY call, so a revoked adoption or a narrowed grant bites
 * immediately — nothing is cached past the decision.
 */
export function authorizeDeclaredAction(tool: string, ctx: ActionCallContext, adoption: AdoptionPort): ActionAuthz {
  const name = String(tool ?? '').trim();
  const action = ctx.declared.find((a) => a.name === name);
  if (!action) {
    return {
      effect: 'deny',
      layer: 'declaration',
      reason: `'${name}' is not one of this app's declared actions (declare it in ${ACTIONS_FILE} and commit)`,
    };
  }
  if (!ctx.capability.includes(name)) {
    return { effect: 'deny', layer: 'capability', reason: `'${name}' is not exposed by the app's compiled capability profile` };
  }
  if (!adoption.adopted(ctx.appExposureId, ctx.domain, name)) {
    return {
      effect: 'deny',
      layer: 'adoption',
      reason: `the domain '${ctx.domain}' has not adopted this app's actions — a domain administrator must adopt them before this domain's agents may use them`,
    };
  }
  if (!ctx.granted.includes(name)) {
    return { effect: 'deny', layer: 'grant', reason: `this run was not granted '${name}'` };
  }
  if (action.write && ctx.readsOnWritesOff !== false) {
    return {
      effect: 'requires_approval',
      action,
      reason: `'${name}' writes, and this run is under the reads-on/writes-off preset — the write is held for human approval`,
    };
  }
  return { effect: 'allow', action, reason: `'${name}' passed capability ∩ declaration ∩ adoption ∩ grant` };
}

/** The declared actions an app exposes as governed tools, newest declaration order preserved. */
export function declaredActionTools(actions: AppAction[]): { name: string; description: string; write: boolean }[] {
  return actions.map((a) => ({ name: a.name, description: a.description, write: a.write }));
}

/** Does this action stay inside its declared scopes? Used by the executor, never skipped. */
export function withinDeclaredScopes(action: AppAction, touched: readonly string[]): boolean {
  return touched.every((s) => (action.scopes as readonly string[]).includes(s));
}
