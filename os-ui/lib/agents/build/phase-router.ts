/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { AgenticResult } from '@/lib/assistant/agentic';

/**
 * THE PHASE ROUTER — the interactive brain of the Software Delivery Team.
 *
 * The old executor walked ALL SIX agents on EVERY turn (`agentic-graph.ts`
 * `runAgenticGraph`), so one turn was up to ~42 sequential LLM calls — far past
 * the 90s-per-call abort — and the builder ALWAYS ran, so the team could never
 * ask before building. This router replaces that with a persisted, per-user
 * state machine that runs EXACTLY ONE role-agent per turn and genuinely gates
 * building on a plan the user approved.
 *
 * It is TRANSPORT-FREE and side-effect-free apart from a globalThis-pinned
 * session map (the same durability pattern the review gate uses) so it is
 * trivially unit-testable. The server wiring that runs the selected node lives
 * in `agentic-graph-server.ts` (`runPhaseTurn`).
 *
 * The flow realises the yaml's `when`-guarded edges deterministically:
 *   intake  → planner asks ≤5 questions (only what the brief misses) OR emits a
 *             plan ([[PLAN_READY]]); NOTHING is created here (ask-before-build).
 *   plan    → the user reviews; an approval routes to build, edits re-plan.
 *   build   → builder create_software (once) + commit real files (committed edge).
 *   feedback→ builder diff-commits the changed files only; loops until "ship it"
 *             (the tester→builder loop the old visited-once walk could not do).
 *   deploy  → deployer request_deploy → a Builder review card (never self-approve).
 */

export type Phase = 'intake' | 'plan' | 'build' | 'feedback' | 'deploy' | 'done';

/** The one role-agent that runs in each phase (node ids in the 6-agent yaml). */
export const ROLE_BY_PHASE: Record<Phase, string> = {
  intake: 'planner',
  plan: 'planner',
  build: 'builder',
  feedback: 'builder',
  deploy: 'deployer',
  done: 'communication',
};

/** Persisted per-conversation state — never re-derived from chat prose. */
export type TeamSession = {
  phase: Phase;
  appId: string | null;
  planApproved: boolean;
  updatedAt: string;
};

export function newSession(): TeamSession {
  return { phase: 'intake', appId: null, planApproved: false, updatedAt: new Date().toISOString() };
}

// --- User-intent detection (deterministic, phase-scoped) -----------------------

/** Does the user's latest message approve the proposed plan? (plan → build). */
export function isApproval(text: string): boolean {
  return /\b(approve|approved|lgtm|looks good|go ahead|proceed|build it|yes,?\s*build|ship it)\b/i.test(text);
}

/** Does the user want to go live now? (feedback → deploy). */
export function isShip(text: string): boolean {
  return /\b(ship it|ship this|go live|request\s+deploy|deploy it|that'?s it,?\s*(ship|deploy)|ready to (ship|deploy))\b/i.test(
    text,
  );
}

// --- Routing (pure) ------------------------------------------------------------

/**
 * Pick the phase + role to run THIS turn, applying the transitions that gate on
 * the user's reply (approval, ship). Everything else stays in its phase until the
 * agent's output advances it (see {@link postRoute}).
 */
export function preRoute(session: TeamSession, userText: string): { phase: Phase; role: string } {
  let phase = session.phase;
  if (phase === 'plan' && isApproval(userText)) phase = 'build';
  else if (phase === 'feedback' && isShip(userText)) phase = 'deploy';
  else if (phase === 'done') phase = 'feedback'; // a new message after a deploy request → keep iterating
  return { phase, role: ROLE_BY_PHASE[phase] };
}

export type TurnSignals = { planReady: boolean; committed: boolean; appId: string | null };

const APP_ID_RE = /app_[a-z0-9]+/i;

/** Read the machine signals out of a finished agent run (control tag + tool steps). */
export function extractSignals(run: AgenticResult): TurnSignals {
  const planReady = /\[\[\s*PLAN[_ ]?READY\s*\]\]/i.test(run.finalText);
  let committed = false;
  let appId: string | null = null;
  for (const s of run.steps) {
    if ((s.tool === 'create_software' || s.tool === 'commit') && !s.isError) committed = true;
    if (!appId && !s.isError) {
      // create_software / commit return the app JSON — capture its id once.
      const m = s.result.match(/"id"\s*:\s*"(app_[^"]+)"/i) ?? s.result.match(APP_ID_RE);
      if (m) appId = m[1] ?? m[0];
    }
  }
  return { planReady, committed, appId };
}

/** Advance the phase after the turn ran, from the agent's signals. */
export function postRoute(phase: Phase, signals: TurnSignals): Phase {
  switch (phase) {
    case 'intake':
      return signals.planReady ? 'plan' : 'intake'; // asked questions → stay and wait for answers
    case 'plan':
      return 'plan'; // wait for the user to approve next turn
    case 'build':
      return signals.committed ? 'feedback' : 'build';
    case 'feedback':
      return 'feedback'; // loop until the user says "ship it"
    case 'deploy':
      return 'done';
    default:
      return phase;
  }
}

/** Strip the internal control tags before the narration is shown to the user. */
export function stripControlTags(text: string): string {
  return text.replace(/\[\[\s*(PLAN[_ ]?READY|QUESTIONS)\s*\]\]/gi, '').trimEnd();
}

/** Phase-specific guidance appended to the running node's system prompt. */
export function phaseGuidance(phase: Phase, appId: string | null): string {
  const app = appId ?? '(the current app)';
  const honesty =
    'Preview and deploy are REAL: start_preview (and an approved deploy) provision the in-cluster runner ' +
    '(Deployment + Service + Ingress) and the served URL appears once the pod is actually ready. ' +
    'Never fabricate a URL — report the runner state the tools return (an unreachable cluster stays honestly pending with no URL).';
  switch (phase) {
    case 'intake':
      return [
        'PHASE: INTAKE. Decide if the brief already answers: purpose, users, data model, key screens,',
        'integrations, and deploy target. If it does, output a SHORT numbered build plan (routes, tables,',
        'the files to commit, and which granted resources to consume by reference) and END your reply with',
        'the exact tag [[PLAN_READY]]. If it does NOT, ask ONLY the missing questions (max 5, numbered,',
        'each answerable in one line) and END with the exact tag [[QUESTIONS]]. Do NOT create or commit',
        'anything in this phase — no tools.',
      ].join(' ');
    case 'plan':
      return [
        'PHASE: PLAN. The user is reviewing your plan. If they asked for changes, revise the plan and END',
        'with [[PLAN_READY]]. Do not build yet — an approval is routed to the build phase automatically.',
      ].join(' ');
    case 'build':
      return [
        `PHASE: BUILD. ${appId ? `Reuse the existing app ${appId} — do NOT call create_software again.` : 'Call create_software once (template nextjs-supabase).'}`,
        'Then commit complete, runnable files (never placeholders) with a clear message. State your design decisions.',
        honesty,
      ].join(' ');
    case 'feedback':
      return [
        `PHASE: FEEDBACK. Apply the user's requested changes to app ${app} as a commit of the CHANGED files`,
        'ONLY — do NOT call create_software again. Report what changed.',
        honesty,
      ].join(' ');
    case 'deploy':
      return [
        `PHASE: DEPLOY. Call request_deploy for app ${app} to open the Builder review card, report the card`,
        'id, and stop. You cannot approve it — that is a human Builder decision. Approval records the governed',
        'go-live decision and rolls the app onto the in-cluster runner; the served URL appears once the pod is ready.',
      ].join(' ');
    default:
      return 'PHASE: DONE. Summarise the status honestly and say what happens next.';
  }
}

// --- Honest, typed error classification ----------------------------------------

export type TeamErrorKind = 'timeout' | 'budget' | 'model' | 'offline' | 'error';
export type TeamError = { kind: TeamErrorKind; message: string };

/**
 * Map a thrown error to an HONEST, typed cause — replacing the old catch-all
 * "Software Delivery Team offline". A weekly-budget 429, a model error, a timeout
 * and a genuinely-unreachable gateway are now DISTINCT and truthful.
 */
export function classifyTeamError(e: unknown): TeamError {
  const name = (e as Error)?.name ?? '';
  const raw = (e as Error)?.message ?? String(e);
  const msg = raw.toLowerCase();

  if (name === 'AbortError' || /aborted|timeout|timed out/.test(msg)) {
    return { kind: 'timeout', message: 'A model did not respond in time. Send your message again in a few seconds.' };
  }
  if (/\b429\b|budget|rate limit|quota/.test(msg)) {
    return {
      kind: 'budget',
      message: 'The weekly model budget has been reached. Ask an Admin to raise the cap, or continue next week.',
    };
  }
  if (/econnrefused|enotfound|fetch failed|network|unreachable|econnreset/.test(msg)) {
    return { kind: 'offline', message: 'The model gateway is unreachable right now. Try again once the cluster is up.' };
  }
  if (/litellm\s+\d{3}|model|completion|non-json/.test(msg)) {
    return { kind: 'model', message: `A model error occurred: ${raw.slice(0, 200)}` };
  }
  return { kind: 'error', message: raw.slice(0, 200) || 'The delivery team hit an unexpected error.' };
}

// --- Session store (globalThis-pinned, survives a fresh call / hot reload) ------

const SESSIONS_KEY = Symbol.for('soa.software.team-sessions');
function sessions(): Map<string, TeamSession> {
  const g = globalThis as unknown as Record<symbol, Map<string, TeamSession> | undefined>;
  if (!g[SESSIONS_KEY]) g[SESSIONS_KEY] = new Map();
  return g[SESSIONS_KEY]!;
}

export function getSession(key: string): TeamSession {
  return sessions().get(key) ?? newSession();
}

export function saveSession(key: string, session: TeamSession): TeamSession {
  const next = { ...session, updatedAt: new Date().toISOString() };
  sessions().set(key, next);
  return next;
}

export function resetSession(key: string): TeamSession {
  sessions().delete(key);
  return newSession();
}

/** The last user-authored message text in a running conversation. */
export function lastUserText(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}
