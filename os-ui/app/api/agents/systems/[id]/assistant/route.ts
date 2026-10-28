/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { withRoute } from '@/lib/core/route-server';
import { getSystem, readFile, writeFile } from '@/lib/agents/store';
import { serializeSystem, SystemError, type System } from '@/lib/agents/system-schema';
import { applyInstruction, scaffoldSystem, type InstructionResult } from '@/lib/agents/assistant';
import { buildCatalog } from '@/lib/agents/tool-catalog';
import { assistantComplete } from '@/lib/assistant/complete';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { roleModel } from '@/lib/models/roles';
import { failResponse } from '@/lib/assistant/stage-route';
import { proposeTeam } from '@/lib/agents/propose-team';
import { resolveSystemGrounding } from '@/lib/agents/grounding';
import {
  normalizeAgentAssistantReply,
  AGENT_GRANT_KINDS,
} from '@/lib/agents/assistant-suggestions';
import type { Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/**
 * POST → the agent-system helper. THREE modes, dispatched by body shape:
 *
 *  1. legacy `{ instruction }` — the original one-shot scaffold: it edits the SAME
 *     system.yaml the canvas/Monaco edit and commits it through the store's whitelisted,
 *     sha-checked write, so the result is identical to the manual path (MCP callers
 *     depend on this — UNCHANGED).
 *
 *  2. chat `{ stage, messages }` — the per-stage assistant (Define · Grant · Design ·
 *     Build · Run · Evaluate). Runs the ONE governed model (`assistantComplete`:
 *     Langfuse-audited, cost-cap enforced → honest 503 no-model / 402 cap), READ-ONLY over
 *     the system, GROUNDED in its REAL granted context. Returns `{ message, suggestions }`;
 *     the model only SUGGESTS — applying is a client-confirmed governed write.
 *
 *  3. proposal `{ stage: 'design', propose: true }` — the auto-team-proposer. Calls
 *     `proposeTeam` (grounded superset of the scaffolder) and returns `{ proposedSystem }`
 *     WITHOUT writing — the client commits it through the existing governed path.
 *
 * Every mode uses the SAME role gate as today (owner, or an in-domain domain_admin /
 * platform admin on a Shared/Marketplace system — the store's view/edit scope). The
 * proposal + grant grounding only ever reference GRANTED context (via the DLS-scoped
 * grounding resolver), never the caller's whole catalog.
 */

// ------------------------------------------------------------------ legacy ----

/**
 * Resolve the instruction into a system mutation: the deterministic
 * {@link applyInstruction} fast-path for the well-defined structured phrases, or
 * the governed-LLM {@link scaffoldSystem} fallback for a free-form description.
 */
async function resolve(system: System, instruction: string, role: Role): Promise<InstructionResult> {
  try {
    return applyInstruction(system, instruction);
  } catch (e) {
    const unrecognised = e instanceof SystemError && /could not turn that into a system edit/i.test(e.message);
    if (!unrecognised) throw e;
    const catalog = buildCatalog(role).map((t) => t.name);
    return scaffoldSystem(system, instruction, {
      complete: (sys, user) => assistantComplete([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ]).then((r) => r.content),
      catalog,
    });
  }
}

/** The legacy `{ instruction }` mode — UNCHANGED: edits + commits system.yaml. */
const LEGACY = withRoute<{ id: string }, { instruction?: unknown }>(async ({ user, params, body }) => {
  const { id } = params;
  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  if (!instruction.trim()) return NextResponse.json({ error: 'An instruction is required.' }, { status: 400 });

  const view = getSystem(id, user);
  const { system, summary } = await resolve(view.system, instruction, user.role);
  const yaml = serializeSystem(system);

  const current = readFile(id, user, 'system.yaml');
  writeFile(id, user, { path: 'system.yaml', content: yaml, sha: current.sha });

  return NextResponse.json({ summary, system });
}, { parse: true, defaultStatus: 500 });

// -------------------------------------------------------------- chat stages ---

type Stage = 'define' | 'grant' | 'design' | 'build' | 'run' | 'evaluate';
const STAGES = new Set<Stage>(['define', 'grant', 'design', 'build', 'run', 'evaluate']);
function coerceStage(v: unknown): Stage | null {
  return typeof v === 'string' && STAGES.has(v as Stage) ? (v as Stage) : null;
}

type Turn = { role: 'user' | 'assistant'; content: string };

/** Coerce a request `messages` field into a clean, bounded turn list (mirrors Software). */
function readTurns(body: Record<string, unknown>): Turn[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const turns: Turn[] = [];
  for (const m of raw.slice(-12)) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content: content.slice(0, 4000) });
    }
  }
  return turns;
}

/** Whether a stage returns structured suggestions (JSON) or plain prose. */
function isStructured(stage: Stage): boolean {
  return stage === 'define' || stage === 'grant' || stage === 'design' || stage === 'evaluate';
}

/** The stage-scoped system prompt. Structured stages demand strict JSON. */
function systemFor(stage: Stage): string {
  switch (stage) {
    case 'define':
      return [
        'You are the Define-stage assistant for a governed AGENT SYSTEM a business user is building.',
        'Your jobs: (1) SHARPEN the system goal (its description / success criteria) into one crisp sentence, and (2) SUGGEST declared OUTPUTS — where the team should store its results (a File, Dataset or Knowledge item in a folder).',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to accept.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; a short, friendly explanation),',
        '  "improvedDescription"?: string (a single crisp goal sentence — omit if the current one is already good),',
        '  "suggestedOutputs"?: [ { "kind": "files"|"data"|"knowledge", "name": string, "folder": { "path": string, "scope": "personal"|"domain" } } ] }',
        'Keep "message" to a few sentences.',
      ].join('\n');
    case 'grant':
      return [
        'You are the Grant-stage assistant for a governed AGENT SYSTEM. You SUGGEST which governed context (data, knowledge, files, connections, metrics, plan items) the team should be granted — chosen ONLY from the caller\'s "Grantable context" list below, referenced by their exact id.',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to accept.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown),',
        '  "suggestedGrants"?: [ { "kind": "data"|"knowledge"|"files"|"connections"|"metric"|"operating-manual", "id": exact id from the grantable list, "access"?: "read-only"|"read-propose"|"read-write", "reason": short why } ] }',
        'Only propose grants whose id appears in the grantable list. Prefer read-only unless the goal clearly needs writes. If nothing fits, omit the field.',
      ].join('\n');
    case 'design':
      return [
        'You are the Design-stage assistant for a governed AGENT SYSTEM. You help the user shape a TEAM of agents. Ground everything in the Context block below — the system goal, the declared outputs, and the GRANTED assets (data / knowledge / connections / metrics / plan). Reference ONLY granted assets — never invent a dataset, metric or connection the team was not granted.',
        'You can SUGGEST: a whole proposed TEAM (a short ordered pipeline of agents, each with a kebab-case id, a one-line role and a one-line instruction), and/or refined per-agent INSTRUCTIONS for named agents.',
        'Do NOT mention tools, models, credentials or permissions — the OS assigns tools automatically and safely.',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to create/update.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; what you propose and the single next step),',
        '  "proposedTeam"?: [ { "id": kebab-case string, "role": one line, "instruction": one line } ],',
        '  "suggestedInstructions"?: [ { "agentId": exact id of an existing agent, "instruction": refined markdown guidance } ] }',
        'Omit a field when you have nothing for it.',
      ].join('\n');
    case 'build':
      return 'You explain, in plain language, what a part of an in-progress agent system does, or what to ask next. Two or three sentences, markdown, no jargon dumps. The build orchestrator is what actually wires the system — you only clarify. Return your answer as markdown prose.';
    case 'run':
      return 'You help a non-technical operator RUN the team and read its result — explaining a run step, a governance HOLD (a write awaiting approval), or a denial. Governed agents run as the user under OPA + row/document security, so a denial is usually a missing grant, not a bug. Explain the likely cause and the single next step. Return your answer as markdown prose.';
    case 'evaluate':
      return [
        'You are the Evaluate-stage assistant for a governed AGENT SYSTEM. You read the last run and the team against the system goal and honestly assess whether each agent did its job. For an agent that fell short, draft ONE concrete refined INSTRUCTION tied to that agent.',
        'You NEVER mutate anything — you only report + suggest; the user turns a suggestion into an edit.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; the honest per-agent assessment),',
        '  "suggestedInstructions"?: [ { "agentId": exact id of an existing agent, "instruction": refined markdown guidance } ] }',
        'Only reference agent ids present in the Context. Omit suggestedInstructions when everything looks good.',
      ].join('\n');
  }
}

/** A compact digest of the system's declared agents (id · role) for the Design/Evaluate prompt. */
function agentsDigest(system: System): string {
  if (system.agents.length === 0) return '(no agents yet)';
  return system.agents.map((a) => `- ${a.id}: ${a.role || '(no role)'}`).join('\n');
}

/** A compact digest of the granted context NAMES for the chat prompt (grounded). */
function groundingDigest(ctx: Awaited<ReturnType<typeof resolveSystemGrounding>>): string {
  const lines: string[] = [];
  if (ctx.description) lines.push(`Goal: ${ctx.description}`);
  if (ctx.outputs?.length) lines.push('Outputs: ' + ctx.outputs.map((o) => `${o.kind}·${o.name}`).join(', '));
  const named = (label: string, list?: { name: string }[]) => {
    if (list?.length) lines.push(`${label}: ${list.map((x) => x.name).join(', ')}`);
  };
  named('Granted data', ctx.data);
  named('Granted knowledge', ctx.knowledge);
  named('Granted connections', ctx.connections);
  named('Granted metrics', ctx.metrics);
  named('Granted plan', ctx.plan);
  if (ctx.tools?.length) lines.push('Granted tools: ' + ctx.tools.join(', '));
  return lines.length ? lines.join('\n') : '(no goal, outputs or grants set yet)';
}

/** The grantable-context digest for the Grant stage — the caller's DLS-scoped grantable set, by id. */
async function grantableDigest(systemId: string, user: Parameters<typeof resolveSystemGrounding>[1]): Promise<string> {
  const { listGrantableForKinds } = await import('@/lib/agents/grantable');
  const groups = await listGrantableForKinds(systemId, user, AGENT_GRANT_KINDS);
  const lines: string[] = [];
  for (const kind of AGENT_GRANT_KINDS) {
    const items = groups[kind] ?? [];
    if (items.length === 0) continue;
    const shown = items.slice(0, 40).map((i) => `${i.id} — ${i.name} [${i.scope}]`);
    lines.push(`${kind}:\n  ${shown.join('\n  ')}`);
  }
  return lines.join('\n') || '(no grantable artifacts visible to you yet)';
}

/** Build the user-turn context block for a chat stage. */
async function contextBlockFor(
  stage: Stage,
  systemId: string,
  system: System,
  user: Parameters<typeof resolveSystemGrounding>[1],
): Promise<string> {
  const head = `Agent system "${system.system.name || '(unnamed)'}".`;
  if (stage === 'grant') {
    return [
      head,
      'Grantable context (id — name [scope]) — propose grants ONLY from this list, by exact id:',
      await grantableDigest(systemId, user),
    ].join('\n');
  }
  // define / design / build / run / evaluate all ground in the system's own state + grants.
  const grounding = await resolveSystemGrounding(system, user);
  const parts = [head, groundingDigest(grounding)];
  if (stage === 'design' || stage === 'evaluate' || stage === 'run' || stage === 'build') {
    parts.push('Current agents:', agentsDigest(system));
  }
  return parts.join('\n');
}

// -------------------------------------------------------------- dispatcher ----

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.clone().json().catch(() => ({}))) as Record<string, unknown>;

  // Legacy mode: a plain `{ instruction }` with no stage → the UNCHANGED scaffold path.
  if (typeof body.instruction === 'string' && body.stage === undefined) {
    return LEGACY(req, ctx);
  }

  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const stage = coerceStage(body.stage);
    if (!stage) {
      return NextResponse.json(
        { error: 'A valid stage is required (define|grant|design|build|run|evaluate), or send { instruction } for the legacy scaffold.' },
        { status: 400 },
      );
    }

    // Scope gate (throws 403/404): same as the legacy path — the caller must be able to
    // view this system (owner, in-domain on a Shared/Marketplace one).
    const view = getSystem(id, user);

    // ---- proposal mode: { stage: 'design', propose: true } → { proposedSystem } ----
    if (stage === 'design' && body.propose === true) {
      const description =
        typeof body.description === 'string' && body.description.trim()
          ? body.description
          : (view.system.system.description ?? '');
      if (!description.trim()) {
        return NextResponse.json(
          { error: 'A description of what the team should do is required to propose a team.' },
          { status: 400 },
        );
      }
      // Grounded ONLY in the system's real granted context (never the whole catalog).
      const context = await resolveSystemGrounding(view.system, user);
      const catalog = buildCatalog(user.role).map((t) => t.name);
      const { system: proposedSystem, summary } = await proposeTeam({
        system: view.system,
        description,
        context,
        complete: (sys, u) =>
          assistantComplete(
            [{ role: 'system', content: sys }, { role: 'user', content: u }],
            { user: { id: user.id, domains: user.domains }, model: roleModel('reasoning') },
          ).then((r) => r.content),
        toolCatalog: catalog,
      });
      // NOT persisted — the client commits via the existing governed system.yaml write.
      return NextResponse.json({ proposedSystem, summary });
    }

    // ---- chat mode: { stage, messages } → { message, suggestions } ----
    const turns = readTurns(body);
    if (turns.length === 0) {
      const opener =
        stage === 'define' ? 'Help me sharpen the goal and suggest where results should be stored.'
        : stage === 'grant' ? 'Suggest which governed context to grant this team.'
        : stage === 'design' ? 'Propose a team of agents from the goal.'
        : stage === 'evaluate' ? 'Assess the last run and suggest instruction improvements.'
        : 'Help me with this stage.';
      turns.push({ role: 'user', content: opener });
    }

    const contextBlock = await contextBlockFor(stage, id, view.system, user);
    const messages = [
      { role: 'system' as const, content: systemFor(stage) },
      { role: 'user' as const, content: contextBlock },
      ...turns,
    ];

    // Design + Evaluate are reasoning-heavy (team planning / honest assessment) → reasoning tier.
    const stageModel = stage === 'design' || stage === 'evaluate' ? roleModel('reasoning') : undefined;
    const { content } = await assistantComplete(messages, { user: { id: user.id, domains: user.domains }, model: stageModel });

    if (!isStructured(stage)) {
      return NextResponse.json({ message: content, text: content, suggestions: {} });
    }

    const parsed = parseJsonReply(content);
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json({ message: content || 'The assistant did not return a usable result — try rephrasing.', suggestions: {} });
    }
    const reply = normalizeAgentAssistantReply(parsed, AGENT_GRANT_KINDS);
    return NextResponse.json({ message: reply.message || content, suggestions: reply.suggestions });
  } catch (e) {
    return failResponse(e);
  }
}
