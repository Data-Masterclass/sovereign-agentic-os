<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# Multilanguage OS — design (2026-11-26)

Status: wave 1 (foundation) implemented in `feat/i18n-foundation`. Waves 2–4 follow in parallel.

## Owner decisions (final)

1. **Seven languages** for the whole OS UI: `en` (default and source language), `de`, `fr`, `es`, `it`, `pl`, `cs`.
2. **Each user picks** under My Settings (account menu → My Settings). Default English for everyone. **No
   Accept-Language auto-switch.**
3. **Informal address** everywhere: de *du*, fr *tu*, es *tú*, it *tu*, pl *ty*, cs *ty*. Natural, concise product
   copy, not literal translation. The owner reviews wording after the fact, not up front.
4. **Option A — the AI answers in the user's language**: Ask the OS / Home chat, agent runs a user starts, and
   AI-generated texts (dataset documentation, DQ explanations, metric suggestions, stage drafts, chat memory
   summaries). **Existing user content is never translated** (dataset names, knowledge, files). Scheduled and API
   agent runs use the **agent owner's** language. MCP tool descriptions and typed MCP error codes stay English
   (machine-facing).
5. Licence policy applies: permissive only.

## Architecture

| Concern | Decision | Where |
|---|---|---|
| Library | **next-intl 4.14.10** (MIT; runtime deps `use-intl` MIT, `intl-messageformat` BSD-3-Clause — attributed in `licenses/ATTRIBUTIONS.md`, `@formatjs/*` MIT; the extractor's `@swc/core` Apache-2.0, `@parcel/watcher` MIT). Licence gate passes. | `os-ui/package.json` |
| Routing | **None.** No `[locale]` segment, no `/de/` URLs, no next-intl middleware. `createNextIntlPlugin('./core/i18n/request.ts')`. | `os-ui/next.config.mjs` |
| Source of truth | Per-user preference, server-side, in the shared `os-user-prefs` index (doc `locale-<userId>`), beside view-surface and tile-order. Awaited write (`writeConfirmed`). | `core/prefs/locale.ts` |
| SSR without flash | The preference is **mirrored into a cookie** `soa-locale=<locale>.<userId>` (httpOnly, same options as the session). The **saved preference wins** whenever it is known (it is also the AI's language); this user's cookie is the fast fallback (store unreachable / nothing saved yet), then English. When the cookie lags the saved preference (changed on another device) the layout mounts `LocaleCookieSync`, which re-sets it via `GET /api/prefs/locale`. Signed-out pages read the cookie's locale only; **logout clears the cookie** so a shared browser's sign-in page does not keep the previous user's language. | `core/i18n/config.ts` (`resolveRequestLocale`, `localeCookieStale`), `core/i18n/request-state.ts`, `core/i18n/request.ts` |
| `<html lang>` | From `getLocale()` in the root layout. | `app/layout.tsx` |
| Catalogs | `os-ui/messages/<locale>/<namespace>.json`; one namespace per tab module (folder name) + `shell`, `common`, `settings`, `server`. **All 7 × 17 files exist from wave 1**, so later waves only edit their own files. Imported statically (glue rule GLUE-1: no unverifiable dynamic import). | `core/i18n/catalog.ts` |
| Missing key | Catalogs are deep-merged over English (`withEnglishFallback`); a key missing everywhere renders `''` and is logged — never a raw key. | `core/i18n/fallback.ts` |
| Type-safe keys | next-intl `AppConfig.Messages = typeof EN_MESSAGES` (the English catalogs); a typo fails `tsc`. | `core/i18n/en-messages.ts`, `core/i18n/next-intl.d.ts` |
| Formatting | Intl-based helpers bound to the locale: date, date-time, relative time, number, compact, currency, bytes. The three pre-existing shared formatters (`fmtCompact`, git `relativeTime`, `formatSize`) delegate here and keep their exact English output. | `core/i18n/format.ts`, `useFormat()` / `getFormat()` |
| Picker | My Settings → Language: native `<select>` with a `<label>`, each language in its own name; PUT `/api/prefs/locale` then `router.refresh()` — no reload, no logout. My Settings is now `creator`-visible; its deployment sections render for builder+ only (server-checked), so nothing is widened. | `core/ui/LanguagePicker.tsx`, `app/(entry)/settings/page.tsx`, `core/ui/account-menu.ts` |
| AI language | One helper: `answerLanguageInstruction(locale, 'chat' \| 'generated')` / `withAnswerLanguage(messages, …)`. English returns `''` (prompts byte-for-byte unchanged). `runLocaleSubject(trigger, runner, owner)` picks the runner for manual runs, the owner for `schedule`/`api` (`run_jobs.input.trigger`). | `core/i18n/answer-language.ts` |
| CI | `scripts/check-i18n.mjs` (+ fixture tests) in the `test-ui` job: layout, key parity, ICU parse + placeholder/kind parity, `other` branches, no empty strings, and the **hard-coded text ratchet** over `scripts/i18n-converted.json`. | `.github/workflows/ci.yml` |

### AI call sites wired in wave 1

- Ask the OS / Home chat: `app/api/assistant/chat/route.ts` → `runOsAssistant({ locale })` → `osAssistantSystem(tab, page, locale)`.
- Chat memory summary: `scheduleMemoryUpdate({ locale })` (`core/runtime/conversation-memory.ts`).
- Tab stage assistants (dataset docs/define stages, metrics, dashboards, agents, apps): `core/runtime/stage-route.ts` (`runStageAssistant`).
- Agent runs: `executeJob` resolves `getUserLocaleFresh(runLocaleSubject(trigger, runner, owner))` in the worker → `executeTeamRun({ locale })` → `runOsTeam` appends the instruction to every agent's preamble (v1 engine and the module engine).
- Dataset auto-docs after ingest: `tabs/data/lib/ingest.ts` → `autoDocumentAfterIngest({ locale })` → `docsPromptMessages(g, locale)`.
- DQ fix proposals: `proposeFixes({ locale })` from the route and the `propose_quality_fixes` MCP tool.
- Metric suggestions: `runSuggest` (`tabs/metrics/lib/suggest-server.ts`).

Wired in wave 2: Files auto-description — `buildDescribeMessages({ locale })` (`tabs/files/lib/auto-docs.ts`), in the
file OWNER's language read fresh (`LIVE_DESCRIBE_DEPS.locale` → `getUserLocaleFresh`), for upload, Regenerate and the
admin backfill alike; knowledge authoring — `/api/agent-chat` (agent `knowledge`, the only LLM path that writes
knowledge; the knowledge tab otherwise calls the model only for embeddings) → `runTabAgent({ locale })` →
`tabAgentSystem`.

Wired in wave 3 (Data, KPIs, Dashboards): the Metric Agent proposal — `metricAgentMessages(columns, goal, locale)` from
`/api/metrics/agent` ('generated'); the grounded plain-language answer of NL→SQL — `runAsk({ locale })` →
`answerMessages(…, locale)` from `/api/data/ask` ('chat'; the SQL-generation prompt stays English). Verified already
wired: the data, metrics and dashboards stage assistants (`runStageAssistant`), dataset auto-docs, DQ fix proposals,
metric suggestions. The Dashboards tab has no other model call.

Not yet wired (wave 3+, besides the agents wiring below): the software builder loop and app-spec generator, connection catalog classification
(machine-facing — likely stays English).

## Converted in wave 1

Sidebar (navigation, groups, tab labels, account menu, sign in/out, domain line), top bar (Live pill, Studio | Run
toggle), notifications bell, domain switcher and first-login domain prompt, toasts, ActionButton, GuardedConfirm,
lifecycle ConfirmDialog, SourceUnavailable, BusyProgress, StackStatus, ThemeToggle, technical-details switch, and
My Settings — all 7 locales.

Deferred to the owning wave: the MCP drawer button in the top bar (`tabs/admin/ui/McpDrawer`, Platform), the
Ask-the-OS drawer and `ConfirmCard` (Home/Ask), the onboarding wizard, sign-in page, `OsAssistant`.

## Converted in wave 2 (Home, Files, Knowledge)

Home page and launcher, HomeChat, the Ask-the-OS drawer, launcher, `ConfirmCard`, chat attachments and artifacts
(core/ui, `home` namespace — also rendered by the software builder), sign-in, recover and onboarding pages; the Files
tab; the Knowledge tab. Pure view-models (`chat-view`, `chat-session`, `chat-launcher`, `ask-artifacts`,
`chat-attachments-view`) return keys + arguments, rendered through the catalog. Left English on purpose: server-sent
error text (wave 4), the workflow PDF body (jsPDF's built-in Helvetica cannot draw Polish/Czech glyphs — needs an
embedded Unicode font first), and the shared core components that are not Home's (`FolderTree`, `LifecycleActions`,
`PasswordStrengthMeter`, the admin encryption forms on the onboarding page).

## Converted in wave 3 (Agents, Governance, Monitoring, Workflows)

Agents tab (`agents`: systems list, system view and rail, the six-stage builder incl. the stage rail, agent editor,
canvas, Monaco, recurrence, runtime, grants and routing, the build/run panel with approvals and diagnostics, run
outputs, the stage assistant), Governance (`governance`: inbox, review card, policies, cost limits, repositories,
egress, roles, audit log), Monitoring (`monitoring`: page, panels, detail view, spend) and the Workflows page
(`workflows`; its components are Knowledge's). Pure view-models return keys + arguments (`run-view`, `run-checks`,
`cron-friendly`, `agent-editor-view`, `agent-capabilities`, `builder-labels`, `grant-messages`, `stage-labels`,
`repositories`, monitoring `status-labels`); their tests render through `core/testing/catalog-text.ts`.

AI language wired in wave 3: the agent-system stage assistant (all six stages), the team proposer and the run judge
(`app/api/agents/systems/[id]/assistant` and `/evaluate` → `withAnswerLanguage`, proven in
`tabs/agents/lib/build/assistant-language.test.ts`). Agent runs already answered in the runner's (manual) or
owner's (schedule/API) language since wave 1. Left English on purpose: the legacy `{ instruction }` scaffold mode
of the assistant route (its MCP callers depend on it unchanged), the "Test invocation" run prompt (model input),
server-sent text (wave 4), the agent PDF reports (shared English builders in `agent-pdf.ts`), and the shared core
chrome these tabs render (`StageShell` "Step N —"/"done", `ChooseContextShell`, `LifecycleActions`, `FolderTree`,
`SCOPE_GROUPS` labels) — a core/ui pass.

## Converted in wave 3 (Data, KPIs, Dashboards)

The Data tab (`tabs/data/ui`: datasets home, the staged dataset builder and its developer view, refine, gold join,
quality fixes, explore, sync, adopt, warehouse import, connected source, versions, lineage, personal-data
certification), the KPIs tab (`tabs/metrics/ui`) and the Dashboards tab (`tabs/dashboards/ui`), with their pages.
Lib modules gain keys beside their English exports (`stages`, `dq-rule-form`, `dq`, `friendly-error`,
`dataset-scopes`, `sync-schedule-view`, metrics `formula` errors, dashboards `report-copy` and `shared`); tests render
them through the English catalog via `core/testing/catalog-text.ts`. Left English on purpose: server-sent errors,
reasons, warnings and Trino messages, `TransformError` and model validation messages (thrown server-side too),
dashboard report/alert notification bodies — all wave 4.

## Wave plan

| Wave | Scope | Namespaces |
|---|---|---|
| 1 | Foundation: library, prefs, cookie, catalogs, types, CI, formatters, picker, AI language helper, shell + My Settings + core/ui primitives | `shell`, `common`, `settings` |
| 2 | Shell-adjacent tabs: Home / Ask the OS, Files, Knowledge, Connections, Platform | `home`, `files`, `knowledge`, `connections`, `admin` |
| 3 | Data, KPIs, Agents, Dashboards, Software, Governance, Monitoring, Workflows | `data`, `metrics`, `agents`, `dashboards`, `software`, `governance`, `monitoring`, `workflows` |
| 4 | Server-side messages, API errors shown to people, notifications, e-mails | `server` |

Each wave follows `docs/i18n/how-to.md` and `docs/i18n/glossary.md`, edits only its namespaces' files and its own
key in `scripts/i18n-converted.json`, and provides all seven locales in the same pull request.

## Risks and notes

- The root layout now reads cookies (via the request config), so every route renders dynamically. Pages were
  already session-bound (`force-dynamic` almost everywhere); no static page relied on prerendering.
- All seven catalogs are bundled on the server; the client receives only the active locale's messages.
- `PUT /api/prefs/locale` is governed like every write (GLUE-7): OPA's new `agentic.authz.user_pref_write` rule
  allows a user their OWN preference only, for a named preference (`locale`). It fails closed — with OPA down the
  language cannot be changed (the current one keeps working).
