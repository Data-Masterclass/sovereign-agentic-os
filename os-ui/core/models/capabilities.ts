/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AREA:       models
 * FEATURE:    Model capabilities — the explicit, admin-controlled list of models that may be sent images
 * USER STORY: As a platform admin I decide exactly which models may ever be sent an image, and a
 *             model I did not list — however it is named — is never sent one.
 * ARCHITECTURE:
 *
 * MODEL CAPABILITIES — the single source of truth for "may this model be sent an image?".
 *
 * WHY A LIST AND NOT A GUESS. Sending an image to a model is a data-egress decision, not a
 * feature probe: the picture leaves the OS for whatever endpoint the gateway alias points at.
 * So the answer is an EXPLICIT allowlist of gateway aliases that an admin controls — never a
 * heuristic. `tabs/agents/lib/routing.ts` `tierOf` labels any name containing "qwen", "vl" or
 * "vision" as the `vision` TIER; that is a display guess and it must never authorise an image.
 * Here a name is allowed only when it is EXACTLY on the list. Everything else — an unknown
 * model, a look-alike, a different casing, a role name, a prototype key — is `false`.
 *
 * THE DEFAULT LIST is the four aliases the shipped STACKIT profile points at Qwen3-VL-235B on
 * STACKIT model serving (EU): see `values.stackit-managed.yaml` `litellm.proxy_config.model_list`.
 * `sovereign-default` / `sovereign-mock` (gpt-oss-20b, text-only) and `sovereign-embed`
 * (embeddings) are deliberately absent.
 *
 * ADMIN OVERRIDE (same mechanism as `context-windows.ts`: an env var holding JSON, read lazily
 * on every lookup). `MODEL_IMAGE_ALLOWLIST` is a JSON ARRAY of model names, e.g.
 * `["sovereign-vision","my-eu-vlm"]`. Chart key: `osUI.imageAllowlist` (rendered into both the
 * `os-ui` and the `os-ui-worker` env). The override REPLACES the default list — it is not
 * merged — so an admin can remove a model as well as add one:
 *   • unset or blank            → the default list.
 *   • `[]`                      → NO model may receive images (an explicit, valid choice).
 *   • a non-empty array         → exactly those names (trimmed, de-duplicated; case is kept,
 *                                 because gateway aliases are case-sensitive).
 *   • anything else (not JSON, not an array, or an array with no usable name)
 *                               → the default list, with a logged warning. Never "allow all":
 *                                 there is no wildcard, and `"*"` is just a name nothing has.
 * Entries that are not non-empty strings are skipped with a warning; the rest still apply.
 *
 * WHICH STRING CALLERS MUST PASS: the FINAL LiteLLM `model_name` that is about to be sent to
 * the gateway in the request's `model` field — i.e. AFTER role resolution
 * (`roleModel('reasoning')` → `'sovereign-reasoning'`) and AFTER any per-agent pin. A role name
 * (`'reasoning'`), a display name (`'Qwen3-VL-235B'`) or an upstream model id
 * (`'openai/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8'`) is not on the list and returns `false`.
 *
 * WHAT THIS DOES NOT KNOW. The list names ALIASES; where an alias points is gateway
 * configuration this module cannot see. Whoever re-points a listed alias at a different
 * endpoint, or adds a router fallback from a listed alias to an unlisted one, must update the
 * list in the same change. And a file's sensitivity is a separate, earlier gate: this module
 * says nothing about WHICH files may be shown, only which models may be shown any at all.
 *
 * Pure and IO-less apart from the lazy env read. Nothing in the model call path consults this
 * yet — it is the capability map only.
 */

import { ROLE_STRONG, strongAliases } from '@core/models/role-names';

/** What a model may be sent. One field today; a typed home for the next capability. */
export type ModelCapabilities = {
  /** True only when the model is on the effective image allowlist. */
  images: boolean;
};

/** The env var that carries the admin override (a JSON array of model names). */
export const IMAGE_ALLOWLIST_ENV = 'MODEL_IMAGE_ALLOWLIST';

/**
 * The built-in allowlist: the `strong` role, which sees images, and the old names that still resolve
 * to it for one release (the shipped mapping points `strong` at a vision model — Platform → Models). Frozen — the only way to change the effective list at runtime
 * is the admin override.
 */
export const DEFAULT_IMAGE_MODELS: readonly string[] = Object.freeze([ROLE_STRONG, ...strongAliases()]);

/** The effective allowlist, where it came from, and anything an admin should be told. */
export type ImageAllowlist = {
  models: readonly string[];
  /** `default` = the built-in list is in force; `override` = the admin's list replaced it. */
  source: 'default' | 'override';
  /** Plain-language problems with the override value (empty when there are none). */
  warnings: string[];
};

const fallback = (warning?: string): ImageAllowlist => ({
  models: DEFAULT_IMAGE_MODELS,
  source: 'default',
  warnings: warning ? [warning] : [],
});

/**
 * Parse the `MODEL_IMAGE_ALLOWLIST` value. Pure (no logging, no env) so it is testable; the
 * rules are the table in the file header. It can only ever return the default list or a list
 * of exact names taken from the value — there is no input that yields "every model".
 */
export function parseImageAllowlist(raw: string | undefined): ImageAllowlist {
  if (raw === undefined || raw.trim() === '') return fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback(`${IMAGE_ALLOWLIST_ENV} is not valid JSON; the built-in image list is in use.`);
  }
  if (!Array.isArray(parsed)) {
    return fallback(`${IMAGE_ALLOWLIST_ENV} must be a JSON array of model names; the built-in image list is in use.`);
  }
  if (parsed.length === 0) return { models: [], source: 'override', warnings: [] };
  const names: string[] = [];
  let skipped = 0;
  for (const entry of parsed) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!name) {
      skipped += 1;
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) {
    return fallback(`${IMAGE_ALLOWLIST_ENV} contains no usable model name; the built-in image list is in use.`);
  }
  return {
    models: Object.freeze(names),
    source: 'override',
    warnings: skipped > 0 ? [`${IMAGE_ALLOWLIST_ENV}: ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} not a model name and ${skipped === 1 ? 'was' : 'were'} ignored.`] : [],
  };
}

/** The last raw value we warned about, so a bad value logs once rather than on every lookup. */
let warnedFor: string | undefined;

/**
 * The effective image allowlist right now: the admin override when it is valid, else the
 * built-in list. Reads `process.env` on every call (like `modelContext`), so there is no
 * cached copy to go stale. For display — to DECIDE, call {@link canReceiveImages}.
 */
export function imageAllowlist(): ImageAllowlist {
  const raw = process.env[IMAGE_ALLOWLIST_ENV];
  const result = parseImageAllowlist(raw);
  if (result.warnings.length > 0 && warnedFor !== raw) {
    warnedFor = raw;
    for (const w of result.warnings) console.warn(`[models] ${w}`);
  }
  return result;
}

/**
 * May this model be sent an image? THE one decision point — nothing else in the codebase may
 * answer this question. `model` is the final LiteLLM `model_name` sent to the gateway (see the
 * file header). Exact, case-sensitive match against the effective allowlist; anything else,
 * including a non-string, is `false`.
 *
 * Deliberately takes no allowlist argument: a caller must not be able to bring its own list.
 */
export function canReceiveImages(model: string): boolean {
  if (typeof model !== 'string' || model.length === 0) return false;
  return imageAllowlist().models.includes(model);
}

/** The capability record for a model, for listings and badges. Built on {@link canReceiveImages}. */
export function modelCapabilities(model: string): ModelCapabilities {
  return { images: canReceiveImages(model) };
}
