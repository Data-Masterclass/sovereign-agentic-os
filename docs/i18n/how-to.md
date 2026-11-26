<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# How to convert a tab to seven languages

Wave 1 built the foundation (design: `docs/superpowers/specs/2026-11-26-multilanguage-design.md`). A later wave
converts one tab module at a time. Waves run in parallel without merge conflicts because **each wave edits only
its own namespace's files**: the seven `os-ui/messages/<locale>/<namespace>.json`, its own entry in
`scripts/i18n-converted.json`, and its own module's code. Every namespace file already exists in every locale.

## 1. The namespace

One namespace per tab module, named after the **folder** (`admin` for Platform, `metrics` for KPIs):
`admin agents connections dashboards data files governance home knowledge metrics monitoring software workflows`.
Shared ones: `shell` (sidebar, account menu, top bar), `common` (buttons and texts of the shared `core/ui`
primitives), `settings` (My Settings), `server` (wave 4: server-side messages, errors, notifications).

A tab uses its own namespace plus `common`. It never reads another tab's namespace (the same rule as imports).

## 2. Key naming

Keys are nested JSON, addressed as `<namespace>.<area>.<thing>`:

```json
{ "list": { "title": "Datasets", "empty": "No datasets yet.", "count": "{count, plural, one {# dataset} other {# datasets}}" },
  "detail": { "promote": "Promote to Domain" } }
```

- `<area>` is the surface (`list`, `detail`, `wizard`, `quality`, …), `<thing>` what the text is (`title`,
  `empty`, `save`, `confirmBody`, `aria.close`). camelCase, no dots inside a key.
- One key per meaning, not per occurrence — but do not reuse a key across surfaces just because the English happens
  to match; translations often differ by context.
- Rich text uses tags: `"Type <code>{phrase}</code> to confirm."` → `t.rich('…', { phrase, code: (c) => <code>{c}</code> })`.
- Counts use ICU plurals and always have an `other` branch. Polish and Czech add `few`/`many` — the check allows
  different plural categories per language but the same placeholders.
- Never concatenate translated fragments into a sentence; put the whole sentence in one message with arguments.

## 3. The code

```tsx
'use client';                                   // or a plain server component — the hooks work in both
import { useTranslations, useFormat } from '@core/i18n/client';

export function DatasetList({ items }: { items: Dataset[] }) {
  const t = useTranslations('data');            // keys are type-checked against messages/en/data.json
  const f = useFormat();                        // date / dateTime / relativeTime / number / compact / currency / bytes
  return items.length === 0
    ? <p>{t('list.empty')}</p>
    : <p>{t('list.count', { count: items.length })} · {f.relativeTime(items[0].updatedAt)}</p>;
}
```

- **Async server component or route handler:** `const t = await getTranslations('data')` and `await getFormat()`
  from `@core/i18n/server`.
- **A `.ts` data module** (labels in arrays, as `core/ui/account-menu.ts` does): store the KEY (`labelKey`), keep
  the English `label` for non-UI readers, translate where it renders.
- **Formatting:** never `toLocaleString()` or a hand-built date — use `useFormat()` / `getFormat()`, or pass the
  locale to the shared helpers (`fmtCompact(n, locale)`, `relativeTime(iso, now, locale)`, `formatSize(b, locale)`),
  whose English output is unchanged.
- **AI-generated text** in your tab (a draft, a suggestion, a summary) is written in the user's language: wrap the
  prompt with `withAnswerLanguage(messages, await getUserLocale(user.id), 'generated')` (or `'chat'` for prose)
  from `@core/i18n/server`. English adds nothing. User content is never translated; MCP tool descriptions and typed
  error codes stay English.
- A missing key falls back to English at run time — but CI fails it first.

## 4. All seven locales, consistently

Write `en` first, then `de fr es it pl cs` in the same pull request — every key in every file, no empty strings.
Use the fixed terms in [`glossary.md`](glossary.md) and informal address (du / tu / tú / tu / ty / ty). Write
natural, concise product copy, not a word-for-word translation; keep it about as long as the English so layouts
hold. Placeholders (`{count}`, `{name}`) and tags (`<code>`) must stay exactly as in English.

## 5. Register the module in the ratchet

Add the converted files — or a whole folder — under your namespace in `scripts/i18n-converted.json`:

```json
"data": [
  "os-ui/tabs/data/ui",
  "os-ui/app/(build)/data"
],
```

**The check is a ratchet over the LISTED paths only.** A file or folder that is not in `scripts/i18n-converted.json`
is not checked at all — hard-coded English there passes CI silently until its wave registers it. So register every
file you convert in the same pull request, register whole folders where you can, and never remove an entry (that
would switch the check off for it; it shows up in review as a deleted line).

From then on `node scripts/check-i18n.mjs` fails on any JSX text, `{'string'}` / `{cond ? 'A' : 'B'}` in JSX, or
literal `aria-label` / `title` / `placeholder` / `alt` / `label` with words in those files. Numbers, punctuation,
symbols and brand names pass. A deliberate exception carries `i18n-ignore` in a comment on the same or the
previous line — rare, and say why.

## 6. Check locally

```bash
node scripts/check-i18n.mjs                         # parity + ICU + layout + ratchet
node --test scripts/tests/check-i18n.test.mjs
cd os-ui && npx tsc --noEmit -p tsconfig.json       # a mistyped key fails here
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test core/i18n/i18n.test.ts
```

Then switch your own language under **My Settings → Language** and walk the tab in German and Polish (the longest
and the most inflected) before opening the pull request.
