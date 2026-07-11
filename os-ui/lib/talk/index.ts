/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Talk tab-module's PUBLIC API — the only surface routes / other tabs import.
 * Everything else (`metadata.ts`, `config.ts`'s retrieval internals, the LLM caller)
 * is an implementation detail behind this barrel.
 */
export { talkTo, type TalkTo, type TalkLlm, type ReasonedCompletion } from './talk.ts';
export { getTabMetadata } from './metadata.ts';
export { getTabConfig, talkTabIds, TALK_CONFIGS } from './config.ts';
export type {
  TalkTabId,
  TalkTurn,
  TalkResult,
  TalkCitation,
  TalkGrounding,
  TalkConfig,
  TabMetadata,
} from './schema.ts';
