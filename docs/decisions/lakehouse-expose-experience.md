# Lakehouse Expose Experience — approved design (2026-08-05)

Elevates the Phase-1 ExposePanel into a staged, Apple-grade, AI-assisted experience.
Companion to [lakehouse-import-exposure.md](lakehouse-import-exposure.md). Persona:
platform admin (Expose); the shared browse tree also serves the domain admin (Adopt).

## Approved decisions

1. **Taxonomy seed is a setup choice** (owner-designed): on first entering Organize, a
   "How should folders be organized?" chooser with four sources —
   (a) **Mirror the source catalog's structure** (folders from source schemas/databases;
   shines when the source is well-managed), (b) **Mirror the Sovereign OS domains**
   (folders = the tenant's domains; makes Assign near-automatic: expose folder Commerce
   → domain Commerce), (c) **Starter set** (Financial, Customer, Product, Orders &
   Transactions, Logistics, HR, Marketing, Reference & Lookup, Operational & Logs,
   Unsorted), (d) **Empty** (admin builds folders; AI classifies only into them).
   **Smart default**: several meaningfully-named source schemas → pre-select (a); else
   pre-select (c). Invariants regardless of seed: categories stay admin-extensible; the
   AI only places tables into the CURRENT taxonomy (never invents folders); admin moves
   are stored as overrides and permanently win; Unsorted always exists.
2. **Column-enriched second pass: ON, capped** — up to 50 lazy DESCRIBEs + 1–2 extra
   LLM calls per run for low-confidence tables; shown honestly in the run detail.
3. **Run timing: on demand + auto-delta** — explicit "Organize with AI" first run;
   snapshot-refresh deltas (prevDiff.added) auto-classified (typically one cheap call);
   no background whole-catalog cron.

## The staged flow (StageShell, pattern: components/science/stages.ts)

`Catalog → Organize → Assign → Review`, new `components/connections/expose/stages.ts`.
Selection = ONE Set<'schema.table'> shared by Catalog+Organize; persistent "N selected"
badge in the rail aside. Organize is enterable-but-skippable (AI never blocks exposure).
Exposure-set list stays ABOVE the rail as the landing collection; New → Catalog,
Edit → enters at Review and walks back.

- **Catalog**: snapshot health + Refresh + drift chip (click filters to added/removed);
  schema-grouped browser (tri-state checkboxes); instant name search persisting across
  Catalog/Organize; row click → lazy columns via NEW `GET /api/connections/[id]/describe`
  (wraps describeTable; extend it to return the Comment column). Empty/refreshing/
  unreachable states honest (promoted "Take a snapshot" primary action).
- **Organize**: toggle **By category (AI)** | **By schema**. Category view = light
  `CategoryTree` (NOT core/FolderTree — wrong shape): one folder level sorted by count,
  Unsorted last, tri-state folder checkboxes feed the selection; per-row "⋯ → Move to ▸"
  + bulk move (no drag-and-drop in v1 — no codebase precedent). Search also matches
  category names and per-table "why" text. Simple: categories/counts/AI chips;
  Developer: confidence, model id, raw JSON, re-run controls.
- **Assign**: name auto-suggested from selection (editable), domain chips, mode Live/Sync
  (default Live), tier, note; Simple hides cron (hourly default), Developer shows
  cron+fullRefresh; selection summary strip with "edit selection" jump.
- **Review**: human impact card ("14 tables become readable by Commerce, live, silver.
  Everyone else stays at zero rows."), grouped read-only list, drift warnings, Developer
  shows compiled governance preview + policy push result; one primary Create/Update.

## AI classification engine

New `lib/connections/warehouse/catalog-classification.ts` + `os-catalog-classifications`
mirror, per connection:
`{ taxonomy[{id,name}], seed: 'source'|'os-domains'|'starter'|'empty', entries{fqn→
{category,confidence,why,model,classifiedAt}}, overrides{fqn→{category,by,at}},
lastRunAt?, lastRunDetail }` — read = override ?? entry ?? Unsorted(not-classified).

- Pass 1: names only (schema.table lines), batch 100/call, concurrency 2 → ~10 calls per
  1k tables. `completeWithEscalation` (standard model first, validated, one reasoning
  escalation per malformed batch); models via roleModel(), never hardcoded.
- Pass 2 (capped 50): DESCRIBE-enriched retry of low-confidence tables.
- Parsing: `parseJsonArrayReply`; validator rejects unknown tables (hallucination guard)
  and unknown category ids (→ Unsorted, never invented); absent tables retried once then
  Unsorted `not-classified`.
- Confidence < 0.7 → Unsorted with "low confidence — <why>". Every AI placement shows an
  "AI" chip + hover why; admin move removes the chip (human fact). Header: "Organized by
  AI — suggested, not verified".
- Incremental: refresh classifies only prevDiff.added ∪ missing entries; overrides never
  touched by re-runs. Audit: `catalog_classified` trace; admin-gated.
- Failure honesty: 503/402/gateway → schema view + plain notice; partial run → "312 of
  950 organized — resume" (resume = missing entries only). Never blocking, never broken.

Routes: `GET/POST /api/connections/[id]/classification` (POST actions run|run-new|
override + taxonomy PATCH), GET domain-visible, mutations admin-only.

## Shared browse component (adopt-side handoff)

`components/connections/CatalogBrowser.tsx` — props `{tables, classification?, selection,
onSelection, mode:'schema'|'category', search, renderRowExtras?, readOnlyCategories?}`.
Expose mounts it in Catalog+Organize; the Data-tab adopt browser mounts it over
exposed-only tables with `readOnlyCategories` (domain admins see folders + AI labels;
corrections remain platform-admin-side), reading the same classification GET.

## Assistant

- **ExposeChat** (primary): ScienceChat pattern, mounted across all four stages, one-turn
  route `app/api/connections/[id]/expose-assistant` on `runStageAssistant`; grounding =
  snapshot summary + classification counts + selection + real domains + existing sets.
  Cards (server-validated; hallucinated tables/domains refused with reason): classify →
  run; selection → merge + jump to Organize; exposure → prefill Assign + jump to Review —
  the admin always clicks Create. Starters: "Organize this catalog with AI", "Expose
  everything in Customer and Orders to Commerce as gold, live", "What changed since the
  last snapshot?"
- **MCP**: `get_catalog_snapshot`, `classify_catalog` (admin), `get_catalog_classification`,
  plus the exposure CRUD set (`list/create/update/revoke_exposure_set`) executing through
  the same lib paths (front-door invariant); `lib/tabs/connections.context.md` updated.

## Phases (disjoint from the adopt wave's components/data + lib/data territories)

- **A** Staged shell + shared CatalogBrowser + describe route (no AI).
- **B** Classification engine + Organize stage + taxonomy seed chooser.
- **C** ExposeChat.
- **D** MCP parity + adopt-browser handoff (swap adopt list to CatalogBrowser) +
  connections.context.md.

No new infra flags; classification is on-demand (auto-delta rides the existing
catalogRefresh sweep only if later wanted — nil-safe, default off).
