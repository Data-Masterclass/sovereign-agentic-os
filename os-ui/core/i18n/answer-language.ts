/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The AI answers in the user's language (owner decision 2026-11-26, option A) — the ONE helper
 * USER STORY: As a German-speaking user I ask the OS in German and get German answers, German dataset docs and
 *             German metric suggestions, while my own dataset names, files and knowledge stay exactly as I wrote them.
 * ARCHITECTURE:
 *   - Pure and import-free apart from the config contract, so every call site (the Ask-the-OS chat, the agent
 *     runtime, the AI generators, the chat memory summary) is unit-testable against it.
 *   - English adds NOTHING: `answerLanguageInstruction('en')` is the empty string, so an English user's prompts are
 *     byte-for-byte what they were before i18n.
 *   - Two shapes: `chat` (a conversation / agent run — reply in the language, keep identifiers verbatim) and
 *     `generated` (a JSON draft — only the human-readable text values are in the language; keys, ids, column names,
 *     SQL and code are untouched). Either way existing user content is NEVER translated.
 *   - Machine-facing text stays English and never passes through here: MCP tool descriptions, typed MCP error
 *     codes, classifier and routing prompts.
 *   - WHOSE language: an interactive turn or a manual agent run uses the person running it; a scheduled or API run
 *     uses the agent's OWNER (`runLocaleSubject`). The preference itself lives in `core/prefs/locale.ts`.
 */
import { LOCALE_ENGLISH_NAMES, toLocale, type Locale } from '@core/i18n/config';

export type AnswerLanguageKind = 'chat' | 'generated';

/** The system-prompt block that makes the model answer in `locale`; '' for English (or anything unknown). */
export function answerLanguageInstruction(locale: Locale | string | null | undefined, kind: AnswerLanguageKind = 'chat'): string {
  const loc = toLocale(locale);
  if (loc === 'en') return '';
  const name = LOCALE_ENGLISH_NAMES[loc];
  const lines = ['', `--- ANSWER LANGUAGE: ${name} ---`];
  if (kind === 'generated') {
    lines.push(
      `Write every human-readable text value (descriptions, explanations, names you propose, notes) in ${name}.`,
      'Keep the JSON structure, keys, ids, dataset and column names, SQL and code exactly as specified — never translate them.',
    );
  } else {
    lines.push(
      `Always answer the user in ${name}, using informal address, in natural, concise wording.`,
      'Do NOT translate existing content: dataset, column, file, knowledge and artifact names, ids, SQL, code and quoted',
      'user text stay exactly as they are. Tool names and tool arguments stay as the tools define them.',
    );
  }
  return lines.join('\n');
}

type Msg = { role: string; content: string };

/**
 * Return `messages` with the instruction appended to the FIRST system message (or a system message prepended when
 * there is none). English returns the SAME array, untouched. Never mutates its input.
 */
export function withAnswerLanguage<M extends Msg>(messages: M[], locale: Locale | string | null | undefined, kind: AnswerLanguageKind = 'generated'): M[] {
  const block = answerLanguageInstruction(locale, kind);
  if (!block) return messages;
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: block.trimStart() } as M, ...messages];
  return messages.map((m, j) => (j === i ? { ...m, content: m.content + '\n' + block } : m));
}

/** Who an agent run speaks for: the runner when started by hand, the agent's owner for a schedule or the API. */
export function runLocaleSubject(trigger: string | undefined, runnerId: string, ownerId: string | undefined): string {
  if ((trigger === 'schedule' || trigger === 'api') && ownerId) return ownerId;
  return runnerId;
}
