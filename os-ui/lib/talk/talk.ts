/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * THE "Talk to <Tab>" ORCHESTRATOR (governed, read-only, run-AS-the-user).
 *
 * One turn, shared by every Context tab:
 *   1. METADATA  — the tab's entitled-scope overview (`getTabMetadata`, DLS-scoped) is
 *      built AS the caller. It is PINNED, so the model always knows the shape of what the
 *      user owns.
 *   2. GROUND    — the tab's EXISTING governed retrieval runs AS the caller (NL→SQL for
 *      data, hybrid retrieval for knowledge/files, …). Its evidence + the human-readable
 *      query it ran are captured. Read-only by construction — no tab retrieval writes.
 *   3. ASSEMBLE  — the pinned overview + the question go in as `pinned`; the retrieved
 *      evidence goes in as a `tool-result` candidate. The Context Assembler packs them
 *      within the reasoning model's INPUT BUDGET so a turn can never exceed the window.
 *   4. REASON    — the reasoning model (`roleModel('reasoning')`) answers, grounded ONLY
 *      in the assembled context. Its `reasoning_content` is captured SEPARATELY and
 *      returned as `reasoning` — NEVER concatenated into the answer.
 *
 * The whole turn is traced to Langfuse via the governed spine (`trace`). Citations are
 * real (only ids the caller was entitled to); no URLs are invented.
 *
 * Server-only (LiteLLM + the governed stores).
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { roleModel } from '@/lib/models/roles';
import { inputBudget } from '@/lib/models/context-windows';
import { type Candidate } from '@/lib/infra/context/context-assembler';
import { curateThenAssemble, type EmbedFn } from '@/lib/infra/context/librarian';
import { guardedEmbedder } from '@/lib/infra/context/librarian-live';
import { trace } from '@/lib/infra/governed';
import { getTabConfig } from './config.ts';
import { getTabMetadata } from './metadata.ts';
import type { TalkCitation, TalkResult, TalkTabId, TalkTurn } from './schema.ts';

const LLM_TIMEOUT_MS = 60_000;
/** The copilot answers concisely; the assembler already caps the (much larger) INPUT. */
const ANSWER_MAX_TOKENS = 1024;

/** Below this many characters an answer is treated as too short to be a real answer. */
const MIN_ANSWER_CHARS = 24;

/**
 * Low-confidence / "I don't know" markers a cheap model tends to emit when it can't
 * ground an answer. Matched case-insensitively as substrings. When the STANDARD tier
 * comes back empty, too short, or hedged like this, we escalate ONCE to reasoning —
 * so the hard questions still get the strong model, but the everyday ones don't.
 */
const WEAK_ANSWER_MARKERS = [
  "i don't know",
  'i do not know',
  "i'm not sure",
  'i am not sure',
  'i cannot answer',
  "i can't answer",
  'not enough information',
  'insufficient information',
  'unable to determine',
  'cannot determine',
  'no information',
] as const;

/**
 * Is a first-pass (cheap-tier) answer WEAK enough to warrant escalating to reasoning?
 * Weak = empty, too short, or hedged with a low-confidence marker. Pure + exported so
 * the escalation gate is unit-testable offline. An HONEST "nothing in your scope
 * answers this" is a legitimate outcome — but the reasoning tier reaches it far less
 * often, so escalating on the marker is the conservative, quality-preserving choice.
 */
export function isWeakAnswer(content: string): boolean {
  const a = content.trim();
  if (a.length < MIN_ANSWER_CHARS) return true;
  const lower = a.toLowerCase();
  return WEAK_ANSWER_MARKERS.some((m) => lower.includes(m));
}

/** A minimal LiteLLM chat message. */
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** What one LiteLLM call yields us: the answer text AND the reasoning_content, separately. */
export type ReasonedCompletion = { content: string; reasoning: string };

/**
 * The reasoning-model caller (injectable for tests). Unlike the shared `liteLlmCaller`,
 * this one KEEPS `message.reasoning_content` — the whole point of the copilot is to show
 * the model's thinking apart from its answer. Reasoning models on the gateway (Qwen) emit
 * it; a model that doesn't yields an empty string (the answer still stands).
 */
export type TalkLlm = (messages: ChatMessage[], model: string, maxTokens: number) => Promise<ReasonedCompletion>;

export function liteLlmReasoner(): TalkLlm {
  return async (messages, model, maxTokens) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.litellmMasterKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`LiteLLM ${res.status}: ${text.slice(0, 300)}`);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`LiteLLM returned non-JSON: ${text.slice(0, 200)}`);
    }
    const choices = (data.choices ?? []) as Array<Record<string, unknown>>;
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
    return {
      content: String(message.content ?? '').trim(),
      reasoning: String(message.reasoning_content ?? '').trim(),
    };
  };
}

// ------------------------------------------------------------------- prompting --

function systemPrompt(tabId: TalkTabId): string {
  return [
    `You are the read-only copilot for the ${tabId} tab of a governed data platform.`,
    'Answer the user GROUNDED ONLY in the CONTEXT provided below — the entitled-scope',
    'overview of what THIS user can access, plus any evidence the governed retrieval found.',
    'Rules:',
    '- Use nothing outside the CONTEXT. Never invent datasets, files, numbers, ids or URLs.',
    '- If the CONTEXT does not answer the question, say so plainly and suggest what the user',
    '  could look at from their scope — do not guess.',
    '- When the EVIDENCE is a query result with rows, PRESENT THE ACTUAL VALUES: render the',
    '  returned rows as a compact markdown table (its first line is the tab-separated header,',
    '  each following line a row). Do not just describe the columns — show the data.',
    '- If the EVIDENCE says the data query could not run, be honest: tell the user you tried',
    '  to query the data but hit that reason, and ask them to clarify or name the dataset —',
    '  never claim no data exists.',
    '- Be concise: a few sentences. Refer to artifacts by the names shown in the context.',
  ].join('\n');
}

/** Fold prior turns into a compact history block (bounded; the assembler caps it anyway). */
function historyText(history: TalkTurn[]): string {
  return history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n');
}

// ---------------------------------------------------------------- orchestrator --

export type TalkTo = (
  tabId: TalkTabId,
  question: string,
  user: CurrentUser,
  history?: TalkTurn[],
) => Promise<TalkResult>;

/**
 * Run one governed "Talk to <tab>" turn. `llm` and `now` are injectable for tests; the
 * live path uses the reasoning-model caller and the current clock.
 */
export async function talkTo(
  tabId: TalkTabId,
  question: string,
  user: CurrentUser,
  history: TalkTurn[] = [],
  deps: { llm?: TalkLlm; now?: () => number; embed?: EmbedFn } = {},
): Promise<TalkResult> {
  const q = question.trim();
  const cfg = getTabConfig(tabId);
  const llm = deps.llm ?? liteLlmReasoner();
  const now = deps.now ?? Date.now;
  // Self-guarding embedder for the Context Librarian: it curates by relevance ONLY
  // when the pool exceeds the budget AND the embedding is genuinely semantic; on the
  // offline hash (or under budget) it passes through to the existing deterministic
  // packer, so behaviour is unchanged on the common path.
  const embed = deps.embed ?? guardedEmbedder();

  // (1) Entitled-scope metadata overview (DLS-scoped, AS the caller) — always PINNED.
  const meta = await getTabMetadata(tabId, user);

  // (2) The tab's OWN governed retrieval, run AS the caller (read-only).
  // A retrieval failure is tolerated: we still answer from the pinned entitled-scope
  // overview (honestly noting we found no evidence), rather than 502 the whole turn.
  let grounding: Awaited<ReturnType<typeof cfg.retrieval>> = { kind: 'none', citations: [] };
  try {
    grounding = await cfg.retrieval(q, user);
  } catch {
    grounding = { kind: 'none', citations: [] };
  }

  // Real citations: metadata pool + retrieval hits, de-duplicated by id.
  const citations = dedupeCitations([...grounding.citations, ...meta.citations]);

  // (3) Assemble within the SMALLER of {primary tier, reasoning tier} input budgets —
  // a HARD ceiling that fits BOTH, so the SAME assembled context can be replayed on
  // an escalation without re-assembling. The primary tier is admin-configurable
  // (`config.talkCopilotTier`, default `standard`); escalation retries once on
  // `reasoning` when the cheap answer is weak.
  const primaryModel = roleModel(config.talkCopilotTier);
  const reasoningModel = roleModel('reasoning');
  const budget = Math.min(inputBudget(primaryModel), inputBudget(reasoningModel));
  const candidates: Candidate[] = [
    { kind: 'pinned', id: 'system', text: systemPrompt(tabId) },
    { kind: 'pinned', id: 'scope', text: `SCOPE — what you can access:\n${meta.text}` },
    { kind: 'pinned', id: 'question', text: `Question: ${q}` },
  ];
  if (grounding.evidence) {
    candidates.push({
      kind: 'tool-result',
      id: 'evidence',
      text: `EVIDENCE from the tab's governed retrieval${grounding.query ? ` (ran: ${grounding.query})` : ''}:\n${grounding.evidence}`,
      priority: 10,
      at: now(),
    });
  }
  if (history.length > 0) {
    candidates.push({ kind: 'history', id: 'history', text: `Recent conversation:\n${historyText(history)}`, at: now() });
  }
  // NEED = the question + the tab's role — the relevance anchor for curation.
  const assembled = await curateThenAssemble({
    need: `Talk to the ${tabId} tab. Question: ${q}`,
    budget,
    candidates,
    embed,
  });

  // (4) Answer — STANDARD-FIRST, escalate to reasoning ONLY on a weak first answer.
  // The cheap tier handles the everyday questions; the reasoning tier is reserved
  // for the ones the cheap tier can't ground (empty / too short / hedged). Both calls
  // reuse the SAME assembled messages, so escalation costs one extra call, no re-work.
  const messages: ChatMessage[] = [
    { role: 'system', content: assembled.texts[0] ?? systemPrompt(tabId) },
    { role: 'user', content: assembled.texts.slice(1).join('\n\n') },
  ];
  const canEscalate =
    config.talkEscalateToReasoning && primaryModel !== reasoningModel;
  let completion: ReasonedCompletion;
  try {
    completion = await llm(messages, primaryModel, ANSWER_MAX_TOKENS);
    // Weak cheap answer → one retry on the reasoning tier. A retry FAILURE keeps the
    // (weak-but-real) primary answer rather than 502-ing the whole turn.
    if (canEscalate && isWeakAnswer(completion.content)) {
      try {
        completion = await llm(messages, reasoningModel, ANSWER_MAX_TOKENS);
      } catch {
        /* keep the primary answer — an escalation hiccup must not lose a real answer. */
      }
    }
  } catch (e) {
    // The primary tier itself was unreachable. If we can escalate, try reasoning once
    // as a fallback before giving up — otherwise report the honest model failure.
    if (canEscalate) {
      try {
        completion = await llm(messages, reasoningModel, ANSWER_MAX_TOKENS);
      } catch {
        return await failModel(tabId, user, q, e as Error, citations, grounding);
      }
    } else {
      return await failModel(tabId, user, q, e as Error, citations, grounding);
    }
  }

  const result: TalkResult = {
    ok: true,
    answer: completion.content || 'I could not produce an answer from what you can access.',
    reasoning: completion.reasoning, // SEPARATE — never merged into answer
    citations,
    grounding: {
      kind: grounding.kind,
      query: grounding.query,
      evidence: grounding.evidence,
      citations: grounding.citations,
    },
  };
  await audit(tabId, user, q, result);
  return result;
}

// ---------------------------------------------------------------------- helpers --

/** The tab's grounding shape (the return of a `TalkRetrieval`). */
type Grounding = { kind: 'sql' | 'retrieval' | 'none'; query?: string; evidence?: string; citations: TalkCitation[] };

/** Build + audit the honest "model unreachable" result (both tiers failed). */
async function failModel(
  tabId: TalkTabId,
  user: CurrentUser,
  question: string,
  err: Error,
  citations: TalkCitation[],
  grounding: Grounding,
): Promise<TalkResult> {
  const result: TalkResult = {
    ok: false,
    kind: 'model_failed',
    answer: `The model was unreachable: ${err.message}`,
    reasoning: '',
    citations,
    grounding: { kind: grounding.kind, query: grounding.query, evidence: grounding.evidence, citations: grounding.citations },
  };
  await audit(tabId, user, question, result);
  return result;
}

function dedupeCitations(cs: TalkCitation[]): TalkCitation[] {
  const seen = new Set<string>();
  const out: TalkCitation[] = [];
  for (const c of cs) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Audit the turn to Langfuse via the governed spine (best-effort; the answer stands regardless). */
async function audit(tabId: TalkTabId, user: CurrentUser, question: string, result: TalkResult): Promise<void> {
  try {
    await trace({
      principal: user.domains[0] ?? user.id,
      tool: 'talk',
      input: { tab: tabId, question },
      output: {
        ok: result.ok,
        kind: result.kind ?? null,
        citations: result.citations.map((c) => c.id),
        groundingKind: result.grounding.kind,
      },
    });
  } catch {
    /* audit is best-effort — never fail the answer on a trace hiccup. */
  }
}
