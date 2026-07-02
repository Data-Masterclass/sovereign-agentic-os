/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Turn a raw agent-chat HTTP response into EITHER a clean assistant reply OR a
 * clean, human-readable error message — never a thrown exception.
 *
 * Why: when the model backend is dead (the create-agent/chat flow hitting a wedged
 * or budget-exhausted model), the gateway can return a NON-JSON body — an empty
 * body, an HTML error page, or a proxy blob. Calling `res.json()` on that throws
 * the raw browser DOMException "The string did not match the expected pattern.",
 * which then surfaced verbatim in the chat error area. Reading the body as text and
 * parsing DEFENSIVELY here means the UI always shows a readable message instead.
 *
 * PURE + unit-tested (no DOM) so it runs under the repo's `node --test` runner.
 */
export type AgentChatParsed = { content: string } | { error: string };

export function parseAgentChatResponse(ok: boolean, status: number, rawBody: string): AgentChatParsed {
  let data: Record<string, unknown> | null = null;
  const body = (rawBody ?? '').trim();
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      data = null; // non-JSON body (dead model / error page) — handled below
    }
  }

  if (!ok) {
    const err = data && typeof data.error === 'string' ? data.error.trim() : '';
    return {
      error: err || `The assistant is unavailable right now (error ${status}). Please try again in a moment.`,
    };
  }

  if (data && typeof data.content === 'string') {
    return { content: stripThinking(data.content) };
  }

  // 200 but no usable JSON payload — the model returned an unexpected/empty body.
  return {
    error: 'The assistant returned an unexpected response. It may still be starting up — please try again in a moment.',
  };
}

/**
 * Strip any residual chain-of-thought scaffolding from assistant text before it
 * is shown. Belt-and-suspenders: the model-side fix (asking Qwen not to emit its
 * reasoning) is separate — this guarantees the UI never displays a "thinking"
 * chain even if some leaks through. PURE (unit-tested).
 *
 * Removes, in order: matched <think>…</think> blocks anywhere; a leading
 * "Here's a thinking process: … </think>" preamble that has a close tag but no
 * open tag; and finally a dangling unclosed <think> tail.
 */
export function stripThinking(content: string): string {
  let out = content ?? '';
  // 1) matched blocks anywhere in the text
  out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  // 2) a leading prose preamble that ends at a stray </think> (no open tag).
  //    Requires the close tag, so a normal reply starting with "Here's" is safe.
  out = out.replace(/^\s*(?:here'?s|here is)\b[\s\S]*?<\/think>/i, '');
  // 3) any dangling unclosed <think> … (to end of string)
  out = out.replace(/<think\b[^>]*>[\s\S]*$/i, '');
  return out.trim();
}
