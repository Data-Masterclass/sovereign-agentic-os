<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Changelog

All notable changes to **Sovereign Agentic OS** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is **pre-beta** software: APIs, values, and surfaces may change between
`alpha`/`beta` pre-releases without notice.

## [Unreleased]

## [os-ui 0.6.81] — 2026-08-06

### Fixed
- **Connections integrity wave — the functional-audit CRITICAL/MAJOR fixes.** Security-
  and honesty-critical corrections to the Connections tab's governed action surface:
  - **Delete/archive full teardown (C1).** Deleting a connection now tears down everything
    it GRANTED before forgetting the record: its exposure sets are revoked + propagated
    (freeze/notify/trace + OPA withdraw), the action adoptions bound to them are revoked,
    and a live-registered warehouse connection has its Trino catalog key + its
    `trino-ext-<catalog>` credential-copy Secret removed and Trino rolled — each outcome
    appended honestly to the delete report (the report previously falsely implied the
    credential copy was purged). Called from both delete paths + the folder-cascade delete.
  - **Labelled offline-mock results + legacy SF preset removed (C2).** Every `executeMock`
    envelope is now stamped `mode:'offline-mock'` + an honest note, carried through the
    tool-result UI and the agent tool-result path. The legacy per-object Salesforce preset
    (`read_account`/`read_opportunity`/`update_opportunity_amount` — the last auto-allowed
    mocked write) is deleted; the entity-generic `sf_*` tools replace it. SAP-OData/OData-V4
    and Workday RaaS reads now run through REAL thin executors; Kajabi `tag_contact` defaults
    Off (no live writer wired).
  - **Inbox approvals execute the held write (C3).** Approving a held `connection_write` in
    Policies & Approvals now EXECUTES it through the governed `approveOnce` path AS the
    approver (profile re-checked server-side, so the payload can't smuggle a wider write) and
    returns the executor's honest `{ok, reason}` — never "applied (mock)".
  - **Cross-domain action adoption fixed (C4).** The four-layer intersection now keys the
    exposure-grant + adoption layers on the CALLER's domains (`e.domains ∩ callerDomains`),
    not the connection's — so a Sales connection exposed to Commerce actually arms a Commerce
    caller (the flagship consent flow was dead). A Sales caller / un-adopted domain is denied.
  - **Slug uniqueness (C5).** Two same-named connections no longer share a slug → principal →
    vault secret name (credential clobber / OPA cross-talk / cross-delete); the record-id
    suffix de-dupes on create.
  - **Archive disables tools (M3); approveOnce handles `sf_*` (M6); action arming only where
    tools exist (M9); action-adoptions route DLS (M10); registry-driven discover (M11); honest
    approval previews (M12).** An archived connection denies every tool call and its exposures
    drop to the OPA floor; approveOnce re-checks `sf_*` via the four-layer intersection; the
    expose panel offers action toggles only for templates with a registered action-tool set;
    the action-adoptions GET is DLS-scoped and verifies the exposure belongs to the connection;
    discover dispatches through the operational registry (SAP/Workday no longer mis-routed to
    Salesforce); and the Write-approval preview shows a REAL read where one exists, else an
    explicit "unavailable" — never a fabricated before-state.

## [os-ui 0.6.79] — 2026-08-06

### Added
- **OKF v0.2 compatibility — Knowledge + Marketplace interchange.** Knowledge artifacts,
  domain operating manuals, and certified Marketplace knowledge products export to and import
  from Open Knowledge Format (OKF v0.2, Apache-2.0; `github.com/GoogleCloudPlatform/knowledge-catalog`).
  Boundary interchange only — the OpenSearch hybrid retrieval engine is untouched.
  - **Export** — an artifact/manual/product becomes an OKF bundle (directory of `.md` + YAML
    frontmatter, spec-correct `index.md`, internal links rewritten relative, zipped). Our five
    kinds ride OKF's open `type` field; owner/domain/tier/workflow structure travels in a
    namespaced `sovereign_os:` extension block; certification maps to `verified` events and tier
    to `status`. Round-trip is lossless for our own artifacts (workflow steps/actors/rules/tacit
    survive). Certified Marketplace products carry a bundle **frozen at certify time**.
  - **Import** — a bundle is validated (the three OKF conformance rules; unknown fields/types are
    accepted per spec, not rejected) then lands as **Personal-tier** artifacts owned by the
    importer, through the normal author→index→publish ladder — never a governance bypass. Foreign
    frontmatter preserved; re-import matches on the `resource` URI to create a version, not a
    duplicate. Extraction is **zip-slip-safe** with size/file-count caps.
  - **Link navigation** — markdown links between Knowledge artifacts resolve to first-class refs
    (`get_knowledge` returns them) so an agent can deterministically walk a certified bundle
    (workflow → rule → term) as the governed alternative to probabilistic retrieval.
  - **MCP twins** — `export_okf_bundle` (writes a Files artifact, returns its ref) and
    `import_okf_bundle`, both OPA-gated as the signed-in user. A vendored Google sample bundle
    imports successfully in CI.

## [os-ui 0.6.80] — 2026-08-05

### Changed
- **Connections tab — visual redesign (presentation-only, zero behavior change).**
  The crown-jewel connectors feature reads like one now: business-power-user first,
  jargon demoted (never deleted). Every action, gate, role floor and flag behaves
  byte-identically — routes, stores and payload shapes are untouched.
  - **Create doors.** The two-path "New connection" chooser (formerly the plain "Door A /
    Door B" cards) is now two generous, distinct choice cards — **Bring a connector**
    (gold cast) and **Wire up your own** (teal cast) — each with a monogram mark, a
    plain-language headline and a one-line business-value subline, real hover/focus
    affordance, and accessible focus rings. Copy killed the techy framing ("Use a
    connector" → "Bring a connector", "Build a custom connector" → "Wire up your own").
  - **Connector gallery as a showcase.** Tiles now lead with a refined **monogram mark**
    (per-service accent hue, consistent geometry — *no trademarked logos*) and the
    connector's business value; protocol/auth detail is demoted to a quiet mono meta line.
    Polished search field, scannable vendor-stack headers (accent bar + count, collapsible),
    a calm "ready" signal, and a density tuned for scanning 30–50 connectors. New shared
    identity vocabulary (`lib/connections/connector-identity.ts`: curated monograms/accents/
    value lines with an honest label-derived + hashed fallback) and a token-driven stylesheet
    (`app/styles/connections.css`, `.conn-*`). The list tiles and the detail header adopt the
    same monogram so the whole tab is one visual voice — still one elevation, no cards-in-cards.
  - **Copy pass.** List lead, tile meta ("personal OAuth" → "signs in as you", "service creds"
    → "service account"), gallery card meta and the wizard endpoint step now read business-first.
    Terminology contracts (My/Domain/Company, Certified, promote/propose, health vocabulary)
    are unchanged.

### Fixed
- **Connector wizard — paste-the-key footgun (live incident).** Adding a connector whose
  endpoint is a known fixed host (Kajabi, GitHub, Slack, …) now **prefills** that endpoint
  from the template's hint (editable) instead of showing an empty box — so a credential can't
  be pasted into the address field. Generic/placeholder templates stay empty as before. Both
  create paths (the wizard and the custom-connector door) now run a **client-side URL-shape
  check** before submit: an obviously-non-URL value is stopped with the plain message *"That
  doesn't look like a URL — did you paste a credential here? The API key goes in the next
  step."* — never shipped to the egress path where the error could echo it back.
  (`lib/connections/connector-identity.ts`, `components/connections/shared.ts`,
  `ConnectorWizard.tsx`, `ConnectionBuilder.tsx`; server-side redaction handled separately.)

## [os-ui 0.6.78] — 2026-08-05

### Changed
- **Docs truth-sync — the guide + tutorials caught up to 0.6.63–0.6.77.** The end-user manual
  (`docs/Sovereign-Agentic-OS-Guide.md`, regenerated to `.pdf` via `scripts/build-docs.sh`) and
  the in-product tutorials now describe what actually shipped, not the pre-redesign product:
  - **Science redesign.** The guide's Science surface is now **Design · Launch · Monitor**
    (was "Define · Train · Deploy · Predict · Monitor"): chat-first, granted-dataset-grounded
    Design; one fused **"Train & launch"**; a Monitor that scores real rows with honest health,
    usage and score-distribution (no fabricated metrics/drift). Honest capability statement
    (classification + regression on CPU; algorithm/metric/split chosen automatically; no
    forecasting/clustering). The Science tutorial is rewritten to the same three-stage journey
    (the stale "model-as-a-service — define · predict · promote" framing removed).
  - **Lakehouse import & exposure.** New guide chapter *Lakehouse — bringing external tables in,
    governed*: the admin **Connect → Snapshot → Organize → Expose** flow (Catalog · Organize ·
    Assign · Review, the four-way taxonomy seed chooser, AI "suggested, not verified") and the
    domain-admin **Adopt** via **＋ New → 🔗 From a connection** (curated Domain-tier, live/sync,
    fail-closed floor, honest frozen-copy revocation, MCP parity). "Pull from a product" is gone
    from the Data narrative (ingest = upload). The Data + Connections tutorials cover the
    "From a connection" adopt path and the expose→adopt journey (honestly flagged where it needs
    an admin-registered warehouse).
  - **Operational systems.** New guide chapter *Operational systems — Salesforce, SAP, Workday as
    a source and a surface*: sync-only expose→adopt, per-entity cursor honesty, and the action
    surface (four-layer fail-closed intersection, two-layer write approvals, service-account
    labels, `OPERATIONAL_ACTIONS_ENABLED` **off by default**; SAP/OData/Workday data-only this
    wave, with their honest v1 caveats).
  - **Apps least-privilege.** The Software chapter now documents the app-origin data plane —
    reads capped at (user ∩ app grants), the honest **Granted context** panel + members directory
    in the Admin section, grant-scoped "ask", the `os.records` write surface, and the **Refresh
    SDK** action.
  - **Simplified domains.** The Science/ML layer is described as a plain per-domain toggle
    (domain templates were retired in 0.6.68 and were never documented, so no stale claim
    remained to remove).

## [os-ui 0.6.77] — 2026-08-05

### Added
- **Operational system connections — Phases 4–6 (final wave)**
  (operational-system-connections.md). SAP (generic OData core), Workday RaaS, and
  the MCP/assistant/quota parity that finishes the operational journey.
  - **Generic OData core** (`lib/connections/odata/`) — a pure, heavily-tested EDMX
    `$metadata` parser (V2 + V4: entity sets, entity types, properties with
    name/type/nullable/keys, and SAP annotations `sap:label`/`sap:creatable`/
    `sap:updatable`/`sap:pageable` where present; nav properties, complex/enum types,
    functions and non-Nullable facets deliberately ignored — a catalog reader, not a
    full CSDL); V2/V4 dialect objects (`$inlinecount=allpages`/`__next` vs
    `$count=true`/`@odata.nextLink`, date literals); a server-only client (Basic
    communication-user or OAuth2 client-credentials, `fetchMetadata`, dialect-honoring
    `pullPage`, all through `fetchWithBackoff`); and a page-streaming slice runner that
    lands to `/ingest-rows` with timestamp-cursor support ONLY where a change-timestamp
    property is detected in `$metadata` (never guessed), else full-refresh-only.
  - **Two OData templates** — branded `sap-odata` (S/4HANA Cloud communication
    arrangement; honest v1 caveat: cloud-reachable only, on-prem behind the SAP Cloud
    Connector NOT supported) and unbranded `odata-v4` (Dynamics 365 / Business
    Central) — both registered in the operational registry (discover from `$metadata`
    with `sap:label` labels, cursorFor from detection), with a real `$metadata`
    health probe, install guides, and egress-allowlist hosts. NO action tools this
    wave (SAP actions are a later decision).
  - **Workday RaaS** (`lib/connections/workday-raas.ts` + `workday-raas` template) —
    reports-as-entities (the admin registers report URLs; there is no cheap global
    describe, said plainly), fields inferred from a sampled first page and labeled
    "inferred from a sample", record counts omitted; full-refresh-only by default with
    an optional incremental window on an admin-configured report date prompt; ISU Basic
    auth. Install guide states the SOAP WWS punt (true incremental = v2) plainly.
  - **MCP action-adoption parity** — `adopt_entity_actions { exposureId, entities[] }`
    + `list_adoptable_actions` (domain_admin; thin delegates over `action-adoptions.ts`,
    governance re-resolved server-side); exposure CRUD tools (`create_exposure_set` /
    `update_exposure_set`) gain the `actions` arg validated exactly like the routes
    (write actions trigger the same `exposure_action_enable` approval).
  - **ExposeChat** grounding gains operational-source + action-scope + cursor honesty,
    a new starter ("Expose Accounts and Opportunities to Commerce, with read actions
    for agents"), and exposure cards may carry `actions` (validated server-side; write
    actions render with "requires admin approval to enable").
  - **Salesforce quota surfacing** — a `/limits` (DailyApiRequests) pre-flight in the
    sync path: near quota, the run skips honestly ("throttled — resuming next window")
    with the real numbers in the Developer view and the cursor unadvanced — never a
    hard 429 mid-slice. Nil-safe: absent `/limits` data changes nothing.

## [os-ui 0.6.76] — 2026-08-05

### Added
- **Operational system connections — Phase 3, the action surface**
  (operational-system-connections.md). Salesforce operational connections gain
  real, entity-generic action tools behind a four-layer fail-closed intersection,
  two-layer write approvals, and domain action adoption — all inert behind
  `OPERATIONAL_ACTIONS_ENABLED` (default OFF, nil-safe).
  - **Entity-generic Salesforce tools** (`lib/connections/salesforce-tools.ts`)
    replace the hardcoded per-object preset: `sf_get_record` /
    `sf_search` (Read; `sf_search` bounded to LIMIT ≤ 200 with a `truncated`
    flag), `sf_create_record` / `sf_update_record` (Write-approval; bounded
    variant via the connection's `argConstraints`), `sf_delete_record` (Blocked).
    SOQL is built server-side from validated parts only (`buildSearchSoql` +
    `safeSObjectName` + record-id validation) — raw user input is never
    interpolated into SOQL (single-quoted, escaped, control-char-stripped).
  - **Real executor** in `CONNECTION_EXECUTORS['salesforce-api']` (was the
    `executeMock` gap): never throws (`{ ok:false, reason }`), secret injected
    server-side, `fetchWithBackoff` for honest 429/503, and every result envelope
    carries the service-account identity label ("as the integration account —
    records it cannot see are absent").
  - **The four-layer intersection**, recomputed FRESH per call (no cache outlives
    a revoke): capability profile ∩ non-revoked exposure actions (write needs
    admin approval) ∩ non-revoked domain adoption ∩ agent/app grant. No exposure /
    no adoption / flag off ⇒ the tool is invisible AND uncallable (fail closed).
  - **Two-layer write approval.** Enable-time: create/update on an exposure's
    `actions` enqueue an admin `exposure_action_enable` approval; write scopes stay
    compiled-out (`writeApproved`) until approved; read/search activate
    immediately; a broadening edit re-triggers approval. Runtime: writes flow
    through the existing held-with-preview `Write-approval` gate.
  - **Domain action adoption** (`lib/connections/action-adoptions.ts`,
    `os-action-adoptions` mirror + `POST /api/connections/[id]/action-adoptions`):
    a `domain_admin` adopts an exposure's entity actions into their domain — the
    consent step that keeps an exposure from silently arming another domain's
    agents; audit `entity_actions_adopted`; soft revoke kills the tools at once.
  - **UI**: the Expose "Assign" stage gains a collapsed "Agent actions (optional)"
    section (per-entity read/search/create/update, all off by default; Developer
    shows the compiled tool names); the Review impact card states the action grant
    plainly; the Adopt panel gains an "Adopt actions" affordance; agent run results
    render the service-account label.

## [os-ui 0.6.75] — 2026-08-05

### Added
- **Operational system connections — Phases 0–2** (operational-system-connections.md):
  operational (Salesforce/Kajabi) API connections become a snapshot/expose/adopt data source
  alongside warehouses.
  - **Registries (Phase 0, no behavior change).** New `lib/connections/operational-registry.ts`
    (with pure, client-safe `operational-platform.ts` + `operational-cursor.ts`) replaces the
    two hardcoded seams: the `liveApiPlatform` `salesforce|kajabi` switch in
    `sync-run-server.ts` (now `platformForTemplate` + `pullOperationalSlice`) and the
    warehouse-only discovery in `buildCatalogSnapshot` (now dispatched per template). Existing
    warehouse/Salesforce/Kajabi syncs + snapshots stay byte-identical.
  - **Salesforce entity catalog (Phase 1).** A `salesforce-api` connection gets a real catalog
    snapshot through the registry (honest "snapshot from <takenAt>"; unreachable never
    fabricated). The `describe` route dispatches per template — Salesforce returns
    `{name, type, label}` per field (business label alongside the API name); a new on-demand
    `count` route surfaces a REAL `SELECT COUNT()` only on row expand (absent, never estimated).
    Browse rows carry a cursor-honesty chip ("Incremental (SystemModstamp)" / "Full refresh
    only") derived from the registry, never guessed. Smart-seed already defaults to Starter for
    a single-schema source.
  - **Operational expose + adopt (Phase 2).** `exposed-tables.ts` widens past warehouse to
    operational templates (`catalog:null`, `operational` flag, per-entity cursor honesty); an
    operational exposure is forced to sync and an explicit `live` is refused ("Operational
    sources sync; there is no live mode"). The staged ExposePanel + adopt dialog work for a
    `salesforce-api` connection with Sync locked on; adopt records `connected.source` with the
    platform pseudo-catalog (byte-consistent with the snapshot + api-batch sync source) and
    locks cursor options to what the registry says the entity supports (full-refresh-only
    entities refuse an incremental mode honestly; merge is unavailable). Landing/schedule/
    quarantine/freshness/revocation reuse the existing sync engine verbatim.

## [os-ui 0.6.74] — 2026-08-05

### Added
- **Lakehouse finale — Expose Phase C+D + lakehouse Phase 4** (lakehouse-expose-experience.md,
  lakehouse-import-exposure.md): the AI assistant across the Expose flow, MCP parity for the
  whole expose/adopt journey, and the shared classified folder tree on the adopt side.
  - **ExposeChat** (`components/connections/expose/ExposeChat.tsx`) — ONE persistent, governed,
    multi-turn assistant mounted across all four Expose stages (Catalog · Organize · Assign ·
    Review), following the ScienceChat `.sac-*` pattern. Its one-turn route
    (`app/api/connections/[id]/expose-assistant`, on the shared model — honest 503/402
    passthrough, admin-gated like the mutations) grounds each turn in the REAL snapshot summary
    (schema/table counts, takenAt, drift), the classification state (category counts +
    lastRunDetail), the current selection, the REAL domain list, and the existing exposure sets.
    Suggestion cards are VALIDATED SERVER-SIDE before an Apply renders: `classify` runs the
    classifier; `selection {tables[]}` merges real tables into the selection Set and jumps to
    Organize; `exposure {name, domains[], mode, tier, tables[]}` prefills Assign and jumps to
    Review — the admin still clicks Create. A hallucinated table/domain is refused with the
    honest reason and no card (only the prose stands). Starters: "Organize this catalog with
    AI", "Expose everything in Customer and Orders to Commerce as gold, live", "What changed
    since the last snapshot?".
  - **MCP parity** (`lib/mcp/exposure-write-tools.ts`) — the expose/adopt journey through the
    front door, each tool a thin adapter over the EXACT lib the UI calls: exposure CRUD
    (`list_exposure_sets`, `create_exposure_set`, `update_exposure_set`, `revoke_exposure_set`
    — admin); catalog (`get_catalog_snapshot`, `refresh_connection_catalog` — admin,
    `get_catalog_classification`, `classify_catalog` — admin, returning honest counts +
    lastRunDetail); adopt (`list_exposed_tables` — domain-scoped read, `adopt_exposed_table` —
    roleAtLeast domain_admin, live and sync). `get_dataset` gains a `connected` block (mode,
    tier, status, source, real freshness — null for live, last successful sync landing else).
    `import_warehouse_table` stays; its description now points at expose→adopt.
  - **Shared seams (front-door invariant)** — the revoke propagation (recompile OPA → freeze
    bound datasets → tear down each sync CronJob → notify each owner → trace per dataset) is
    factored into `lib/connections/exposure-propagation.ts` and the adopt validation/creation
    into `lib/data/adopt-connected.ts`, so the UI routes (`/exposures/[exposureId]` DELETE/PATCH,
    `/api/data/adopt`) and the MCP tools run byte-identical logic instead of duplicating it.
  - **Adopt browser shares the classified tree** — `AdoptConnectionPanel` now mounts the shared
    `CatalogBrowser` with `readOnlyCategories` + the classification GET, so a domain admin sees
    the same AI folders/labels as the platform admin (corrections stay admin-side). All adopt
    behaviour (gating, sync config, required description) is unchanged.
- **Docs truth-sync** — `lib/tabs/connections.context.md` + `connections.guide.md` document the
  full journey (connect → snapshot → organize → expose per domain → adopt → live/sync → honest
  revocation); `lib/tabs/data.context.md` documents the from-a-connection ingestion path
  (pull-from-product retired); `lib/mcp/prompts.ts` points the connect pathway at expose→adopt.

## [os-ui 0.6.73] — 2026-08-05

### Added
- **Lakehouse Expose experience — Phase B** (lakehouse-expose-experience.md): AI catalog
  classification + the Organize category tree. The Organize stage now groups the same
  selection by an admin-owned folder taxonomy the AI fills — never a fabricated placement.
  - **Taxonomy seed chooser** (owner-designed) — on first entering Organize, a "How should
    folders be organized?" chooser with four sources: **mirror the source structure** (folders
    from the snapshot's schemas), **mirror the OS domains** (folders from the tenant's real
    non-archived domains), **starter set** (the 10 categories), or **empty** (admin builds
    folders, AI classifies only into them). Smart default: ≥3 meaningfully-named source schemas
    → pre-select "source", else "starter". Invariants regardless of seed: taxonomy stays
    admin-extensible (add/rename via a taxonomy PATCH); the AI only ever places into the CURRENT
    taxonomy (never invents a folder); a human move is stored as an override that permanently
    wins; Unsorted always exists.
  - **Classification engine** (`lib/connections/warehouse/catalog-classification.ts`) — Pass 1
    names-only, batched 100 tables/call at concurrency 2, run standard-first with one reasoning
    escalation per malformed batch (`completeWithEscalation`; models via the role resolver,
    never hardcoded). A validator drops hallucinated table keys (counted), degrades unknown
    category ids to Unsorted (never invented), and rejects out-of-range confidence; a table no
    batch answered is retried once, then lands in Unsorted `not-classified`. Pass 2 (capped 50
    lazy column DESCRIBEs + one enrichment call) re-places sub-threshold tables (threshold 0.7).
    `run-new` classifies only added/missing tables; overrides are never touched by any run.
  - **Honest degradation** — a 503/402/gateway failure stops the run and is reported in the
    run detail ("132 classified, 12 unsorted, 3 of 8 batches escalated, stopped early after 144
    of 200 (Cost cap reached)"); the Organize UI falls back to the schema view with a plain
    notice and never blocks exposure. Every AI placement carries an "AI" chip + hover-why; a
    moved table shows no chip (a human fact). Header: "Organized by AI — suggested, not verified".
  - **`GET/POST/PATCH /api/connections/[id]/classification`** — merged read (override ?? AI ??
    Unsorted) under the same visibility gate as the snapshot route; POST actions
    `run | run-new | override | seed` and the taxonomy PATCH are admin-only and audit-traced
    (`catalog_classified`). The run executes server-side; progress is the polled run detail.
  - **Organize category tree** — one folder level, count-sorted with Unsorted last, tri-state
    folder checkboxes feeding the shared selection Set, per-row "⋯ → Move to" and bulk
    "Move N selected to", search matching names + folder names + why text, and Simple/Developer
    (Developer surfaces confidence, model id, and re-run controls).

## [os-ui 0.6.72] — 2026-08-05

### Added
- **Lakehouse Expose experience — Phase A** (lakehouse-expose-experience.md). The admin-only
  Expose surface on a warehouse connection is now a staged flow on the OS-wide StageShell:
  **Catalog → Organize → Assign → Review**. The exposure-set list stays the landing
  collection above the rail — New enters at Catalog, Edit loads the set and enters at Review
  (all gated stages reachable to walk back), Revoke keeps its confirm. Selection is one
  `Set<'schema.table'>` shared across Catalog + Organize with a persistent "N tables selected"
  badge in the rail aside.
  - **Shared `CatalogBrowser`** — one browse component (schema mode fully implemented:
    schema-grouped, tri-state schema checkboxes, instant client-side search over ≤ ~1k rows;
    category mode falls back to schema grouping with a quiet "AI organization arrives with the
    next release" note in Phase A). Row click expands → **lazy governed column DESCRIBE** with
    honest loading/error states (an unreachable catalog shows the real error — never fabricated
    columns).
  - **`GET /api/connections/[id]/describe`** — wraps the governed `describeTable` (same
    auth/visibility gate as the sibling snapshot route). `describeTable` now returns Trino's
    per-column **Comment** additively (empty when the metastore carries none) for the Phase-B
    classifier.
  - Catalog stage: snapshot health line, Refresh / "Take a snapshot", a drift chip that filters
    to added/removed tables, honest refreshing/unreachable/empty states. Assign stage: name
    auto-suggested from the selection (editable), domain chips, Live/Sync (default Live), tier,
    note — Simple hides cron with a one-line hourly note; Developer shows cron + full-refresh.
    Review stage: a human-impact card, a grouped read-only list, drift warnings for selected
    tables removed since the last snapshot, and (Developer) the compiled governance preview.
  - No AI in this phase (Organize's AI classification + the ExposeChat assistant ship in
    Phases B–C).
## [os-ui 0.6.71] — 2026-08-05

### Added
- **Adopt "From a connection" — Sync mode** (lakehouse import & exposure, Phase 3).
  Sync-mode exposures are now adoptable: scheduled incremental replication of an exposed
  table into the adopting domain's schema at the curated tier
  (`iceberg.<domain>.<tier>_<slug>`), running as the domain principal (entitled by the
  Trino-OPA write floor). The proven sync engine — watermark-before-write, `_batch_id`
  idempotency, quarantine, Iceberg maintenance — is retargeted verbatim from the personal
  bronze lane to the domain copy; the tier version lights (earned) only after the first
  successful landing verifies. Preview / profile / DQ / Talk / metrics read the local copy
  through the one FQN seam with no special-casing.
- **Metrics on synced copies.** The Phase 2 metric-source exclusion now applies only to
  LIVE connected datasets; a synced copy with a built Gold defines metrics like any native
  gold dataset (Cube handover via the normal governed registration path).
- **Adopt dialog sync setup.** When the exposure is sync-mode, the adopt dialog shows sync
  configuration prefilled from the exposure's `syncDefaults` (mode, cursor, schedule) in the
  SyncPanel vocabulary — Simple keeps it minimal (defaults + schedule), Developer exposes
  the full config. Full-refresh of a large table is warned honestly (15 s governed-statement
  ceiling) and steered to a cursor.
- **Source stage for synced datasets.** The connected Source card gains a Sync face:
  mode badge, freshness = last successful sync run (real, from sync-runs), next-run schedule,
  run-history summary, and drift flags — with the SyncPanel available to adjust cadence /
  "Sync now".

### Changed
- **Frozen-copy revocation.** Revoking an exposure now freezes bound SYNC datasets instead
  of blanking them: sync is disabled, the per-dataset CronJob is removed
  (`reconcileSyncCron(id, null)`), but the last-landed copy is KEPT (sovereign data) and
  stays fully queryable — the Source stage banners "copy frozen as of <last successful run>".
  Live datasets keep the Phase 2 behavior (no data shown until re-adopted).

## [os-ui 0.6.70] — 2026-08-05

### Added
- **Adopt "From a connection" — Live/federated datasets** (lakehouse import & exposure,
  Phase 2). A domain admin can now adopt a table a platform admin exposed to their
  domain into a governed dataset. `+ New dataset` gains a third card ("From a
  connection", `components/data/AdoptConnectionPanel.tsx`) — visible only when
  `EXTERNAL_CONNECTORS_ENABLED` and the caller is `roleAtLeast domain_admin` and a table
  is actually exposed. A new server helper (`lib/connections/exposed-tables.ts`) resolves
  the exposures whose domains intersect the caller's, grouped connection → exposure set,
  served by `GET /api/data/exposed-tables`; adoption (`POST /api/data/adopt`) re-resolves
  governance server-side, requires a short description, and creates the dataset at
  **Domain tier** with `origin:'connected'`.
- **Connected datasets read live through one FQN seam.** The `connected` block on the
  dataset schema (`{ connectionId, exposureId, source:{catalog,schema,table}, mode, tier,
  status }`, byte-stable/back-compat) drives `versionTarget`/`builtLayerFqn`: a live
  connected dataset resolves to the verbatim `<catalog>.<schema>.<table>` read as the
  viewer's domain principal (never a personal lane); only `versions[tier].built` is true
  and bronze never exists. Preview/profile/DQ/Talk/`query_data` inherit through that seam.
- **Source stage** (`components/data/ConnectedSourcePanel.tsx`) replaces Ingest/Refine for
  connected datasets in `DataBuilder`: connection link, source FQN, Live/tier badges,
  snapshot freshness ("snapshot from <takenAt>"), drift flag, and the honest guardrail
  notes (preview LIMIT; profile sampled).
- **Honest sampling labels.** A live profile computes stats/top-values over a bounded
  sample subquery (`lib/data/profile.ts sampledSource`) and the payload is labeled
  "sampled, approximate — computed on ~N rows"; executable DQ on a live table now asks for
  explicit confirmation and recommends a synced copy.
- **Revocation & drift propagate honestly.** Revoking an exposure flips every bound
  dataset to `connected.status='source-revoked'` (no data shown, preview/Talk disabled with
  an explicit banner), notifies each owner, and traces `dataset_source_revoked`; a catalog
  snapshot that removes a bound table flags the dataset `drifted` and notifies its owner.
- **Metrics are excluded on live connected datasets** (v1): `metricSqlReady` and the metric
  source picker steer to "define metrics on a synced copy".

## [os-ui 0.6.69] — 2026-08-05

### Changed
- **Data ingestion is upload-only** (lakehouse import & exposure, Phase 0). Retired
  the Data tab's "Pull from a product" free-SQL Trino extract from the Ingestion
  stage (`components/data/BronzePanel.tsx`) and its tutorial copy
  (`lib/tutorials/content/data.ts`): the section now only uploads a file, and the
  guidance says external lakehouse data arrives governed, via a connection. The
  governed `pull-extract` server action (`/api/data/sandbox`) is unchanged and stays
  for Developer/personal-lane use.

### Added
- **Exposure sets + catalog snapshot + fail-closed external-catalog policy floor**
  (lakehouse import & exposure, Phase 1 — security-critical, shipped as one unit).
  - **Fail-closed floor** (`charts/sovereign-agentic-os/policies/trino.rego`): a table
    in a NON-internal catalog (not `iceberg`/`system`) with no `data.governance.tables`
    entry now reads zero rows for everyone and cannot be written — closing the gap
    where a live-registered external warehouse catalog was readable by every
    authenticated principal. Additive; iceberg/internal access unchanged. Rego-bundle
    tests in `tests/policies/trino_test.rego`.
  - **Exposure sets** (`lib/connections/exposures.ts`): admin-only CRUD
    (`roleAtLeast 'admin'`), persisted via the registry mirror (`os-exposures`),
    audit-traced (`exposure_set_created/updated/revoked`). Each non-revoked set
    compiles to a `data.governance.tables` shared-with entry per table
    (`compileExposures` in `lib/data/policy/compiler.ts`), pushed per-key to OPA
    (`lib/connections/exposure-policy.ts`) so it is additive to dataset governance and
    durable across a pod roll; create/update/revoke recompile immediately.
  - **Catalog snapshot** (`lib/connections/warehouse/catalog-snapshot.ts`): per-connection
    cached listing built by looping the governed `discoverWarehouse`
    (`SHOW SCHEMAS` + per-schema `SHOW TABLES`) as the connection's domain; columns
    served lazily via a governed `DESCRIBE`; consecutive-snapshot drift diff; honest
    `live`/`stale`/`unreachable` status; never fabricated freshness.
  - **API + UI**: `GET/POST /api/connections/[id]/exposures`, `PATCH/DELETE
    …/exposures/[exposureId]`, `GET/POST …/snapshot`, and a service
    `POST /api/connections/catalog-refresh` sweep. Admin-only Expose section on the
    warehouse connection detail (`components/connections/ExposePanel.tsx`): snapshot
    browser (search, group-by-schema, multi-select, select-whole-schema, Refresh) +
    exposure form (name, domains, mode Live/Sync, tier silver/gold, note) + existing
    sets with Edit/Revoke and a Developer view of the compiled governance entries.
  - **Chart**: optional `connections.catalogRefresh` CronJob
    (`templates/connections/catalog-refresh-cronjob.yaml`) — nil-safe under
    `--reuse-values`, default OFF.

## [os-ui 0.6.68] — 2026-08-05

### Removed
- **Domain templates.** Dropped the create-domain template dropdown
  (Blank / Analytics / Data Science / Big Data) and all its plumbing: the
  `DomainTemplate` type + `TEMPLATES` array, the `template` provenance field on
  the `Domain` type, and the `template` param on `createDomain` /
  `hydrateDomains` and the `POST /api/platform-admin/domains` route
  (`lib/platform-admin/domains.ts`, `app/(govern)/platform/domains/page.tsx`,
  `app/api/platform-admin/domains/route.ts`). The concept was dead — a template
  only ever preset one flag (`layers.ml`), which is already an independent
  per-domain Science-layer toggle. A new domain now starts with the Science
  layer off; enable it per domain in Admin → Domains as before. The per-domain
  Science gate (`layers.ml`, `requiresLayer: 'ml'`, policy-compiler `ml` grant)
  is unchanged. Legacy persisted domain records that still carry `template` load
  silently — the stale field is ignored, never migrated.

## [os-ui 0.6.67] — 2026-08-05

### Added
- **Science Phase D — MCP parity for the full model journey.** Three new governed write tools
  (`lib/mcp/science-write-tools.ts`, `minRole: 'creator'`, same edit-scope + Langfuse tracing as
  every sibling write tool) let an external agent carry a model from data to live predictions
  WITHOUT the UI: `create_model { name, goal?, dataset, target, features?, taskType? }` applies the
  Simple defaults and VALIDATES the dataset/target/features against the caller's real, RLS-scoped
  data (a hallucinated dataset/column is refused by name via `validateDefinition`, never invented);
  `train_model { model }` is the fused "Train & launch" (submits training, auto-deploys on success)
  returning a run handle + the read→train→publish `LaunchStatus`; `get_model_status { model }` is
  the poll that ADVANCES the same state machine the UI does (training→trained→deploying→deployed),
  returning the phase, a plain-language reason and the real trained metric once produced. Honest:
  all 404 when `ml.enabled=false`; a metric is stated only once a run actually produced it; an
  unreachable cluster is a real error, never a fake success.

### Changed
- **Richer `get_model` card** (MCP): now includes `buildState`, real `usage` (count/denied/
  lastCalledAt), `lastErrors` (training/deploy), and the headline metric NAME + value (auc/rmse,
  never a mislabeled AUC) — previously omitted.
- **Science guide + context truth-sync** (`lib/tabs/guides/science.guide.md`,
  `lib/tabs/science.context.md`, `lib/mcp/prompts.ts`): rewritten from score-and-wire only to the
  full Simple-first journey (goal → create_model → train_model → get_model_status → science_predict
  → promote), with the honest capability statement (classification + regression on CPU; algorithm,
  metric and split chosen automatically; no forecasting/clustering).
- **Shared MLflow metric reader** (`readMlflowMetric` extracted to `lib/science/training.ts`): the
  train route and the new MCP status poll now read the real trained metric through ONE function, so
  both front doors record the same honest (or honestly-untracked) value.

### Monitoring
- No new Monitoring wiring: model health is ALREADY surfaced there via the real `model_train` /
  `model_deploy` / `predict` Langfuse traces the science paths emit (which `list_runs` /
  `get_run_trace` read). The Monitoring overview spine reads traces, not the `ModelUsage` histogram,
  so feeding that histogram in would be a new signal source rather than a thin, real fit — skipped.

## [os-ui 0.6.66] — 2026-08-05

### Changed
- **Science Phases B+C — Design·Launch·Monitor Simple UI + a persistent, grounded assistant.**
  The Science tab's 5-stage builder (Define·Train·Deploy·Predict·Monitor) collapses to three
  plain-language stages a business user reads: **Design** (a prompt-first chat is the primary
  surface; the manual form — dataset browser + target/features as COLUMN PICKERS from the real
  dataset profile — is progressive disclosure; the free-text FQN override / algorithm / metric /
  split are gone from Simple, and forecast/clustering are dropped), **Launch** (one "Train &
  launch" button rendering the fused `LaunchStatus` timeline verbatim; the real trained metric is
  phrased in business language — auc → "ranked positives above negatives NN%", rmse → "typical
  error ±NN" — computed only from the real value and hidden when absent; `deploy_failed` retries
  the deploy route; the plain-language failure explanation auto-fetches), and **Monitor** (a
  governed-preview ROW PICKER to try the model on a real example → plain verdict; live health;
  the real `ModelUsage` count/denied/last-called + a score-distribution chart from `buckets`
  (honest empty state when nothing has been scored; no fabricated drift badges); Govern
  unchanged). Developer mode re-exposes everything that exists today (algorithm/metric/split, the
  raw feature-vector predict + JSON + traceId, job/ISVC/MLflow handles, the spec+policy JSON).
- **AI-first Science assistant.** ONE persistent, governed, multi-turn chat (`ScienceChat`)
  replaces the five one-shot StageAssistant buttons, mounted across all three stages. Each turn
  is grounded in the model's real state, the caller's VISIBLE datasets + the selected dataset's
  real column profile, and the honest capability statement. Structured **one-click Apply**
  suggestion cards (Design → create a draft; Launch → start training & launch; Monitor → score a
  real example) — the assistant only proposes; every mutation runs through the existing governed
  routes on explicit click. A Design suggestion naming a dataset/column is VALIDATED server-side
  against the real feed (`validateDefinition`) and refused-with-reason if hallucinated, so no
  Apply card can reference a dataset/column the user can't see or that doesn't exist. Honest
  503/402 surfacing preserved. Removed the Science DevConsole's Featureform tile (not wired) and
  the "model-as-a-service" jargon crumb.
- **`parseJsonReply` fix for ALL stage assistants.** `lib/assistant/stage-route.ts`'s
  `parseStageJson` now delegates to the tolerant `parseJsonReply` (object stages) and a new
  `extractJsonArray`/`parseJsonArrayReply` (array stages), so a reasoning model that wraps its
  JSON in preamble prose or a ```json fence still yields structured suggestions instead of an
  empty result across Data · Metrics · Dashboards · Science · Software. The object/array shape
  guard contract is unchanged.

### Removed
- **The inert `monitored` build state.** Dropped the `monitored` `ModelBuildState` union member
  (types + UI mirror) and every `=== 'monitored'` comparison (`computeLaunchStatus`, the stages,
  the predict/launch surfaces) — `deployed` is terminal-live and monitoring rides on the deployed
  model. Deleted the old `builder/TrainStep`, `builder/DeployStep` (absorbed by `LaunchStep`) and
  the one-shot `StageAssistant` (replaced by `ScienceChat`).

## [os-ui 0.6.65] — 2026-08-05

### Changed
- **Science Phase A — fused "Train & launch" orchestration (server).** On a successful
  training run the train poll route now auto-submits the deploy (`trained → deploying`),
  so "Train & launch" is ONE action (auto-deploy is the Simple default). The deploy poll
  carries `deploying → deployed` honestly. Both train and deploy routes expose ONE coherent
  `launch` status a timeline renders: ordered steps (reading data → training → publishing),
  each with a coarse `state` plus the real underlying `detail` (job name / ISVC phase+reason)
  for the Developer view (`computeLaunchStatus`, `LaunchStatus`/`LaunchStep` in
  `lib/science/types.ts`). The standalone two-step Deploy route + `deploy_failed` retry path
  are unchanged. If the cluster refuses the fused deploy submit, training's success stands and
  the model rests at `trained` with the deploy error recorded — never a faked deploy.
- **Science Simple-mode server defaults + honest algorithm refusal.** `algorithm`,
  `optimizeMetric` and `trainTestSplit` are now OPTIONAL in the create/spec input
  (`ModelSpecInput`); when omitted the server fills task defaults (classification: the real
  default learner + auc; regression: linear/rmse; split 0.8) via `normalizeSpec`. An algorithm
  the runtime cannot actually train is REFUSED (400) naming the supported set — fixing the old
  lie where typing "xgboost" silently trained logistic.
- **Metric-name-correct model versions.** `ModelVersion` now carries `metric` + `metricName`
  (e.g. `rmse 12.3`), so a regression version is no longer mislabeled "AUC". The old `auc`
  field is retained as a deprecated back-compat mirror of the value (Phase B removes it).

### Added
- **Real per-model prediction usage.** `servePredict` records usage on EVERY predict (allow
  AND deny): `count`, `denied`, `lastCalledAt`, and a day×band score histogram (score deciles
  for classification, coarse value bands for regression) — enough for a
  score-distribution-over-time chart later. Persisted on the model registry record through the
  existing durable mirror; exposed on each model in `GET /api/science/model`. Cheap and real,
  no new infra (`recordUsage`, `ModelUsage`).

### Removed
- **Science fabrications removed (honesty).** Deleted the churn SEED model that planted invented
  facts a fresh tenant never earned (`auc 0.871`, `runId 'mlf-run-2a9c'`, `kserveService
  'churn_model'`) — fresh tenants start EMPTY; existing persisted seed records are left alone
  (no migration). Removed `monitoringAdapter.triggerRetrain()` (it fabricated a
  `dagster-retrain-<ts>` runId without ever calling Dagster) and the `op:'retrain'` route path
  (now an honest 410 "not wired"). Removed the placeholder `drift()`/`DriftPoint`/`driftSeed`
  plumbing and the dead `drift` payload on the model GET (no UI consumed it; the Monitor stage
  already renders an honest "not yet monitored" placeholder from `model.metrics`). Removed the
  orphan `lib/science/agent-control.ts` (exported but unconsumed) + its barrel export + tests.
  Gutted the dead-in-Science `featuresAdapter` to an honest `probe(): false` stub (Featureform
  is not wired — training reads Gold through Trino; the DevConsole tile is Phase B's deletion).

## [os-ui 0.6.64] — 2026-08-05

### Security
- **Grant-scoped "ask your data" for app origins (replaces the 0.6.63 blanket deny).**
  0.6.63 denied the free-form NL→SQL surface (`/api/data/ask`) to any app origin outright,
  because it scoped to every dataset the user could see with no way to cap it. It now
  NARROWS the askable set to (user access ∩ the app's `grants.data` ids) instead: the same
  filtered list is used for BOTH the model's prompt context AND — since the only tables the
  model is shown are the ones it can target — the executable SQL scope. An app origin with
  ZERO dataset grants gets an honest 403 ("no dataset grants — grant one in the OS Software
  tab → <app> → Context"); an unknown slug fails closed (empty grant set → the same 403);
  non-app (OS UI) requests are completely unchanged (`appSlugFromRequest` → null, no I/O).
  This fixes the live incident where a Software-tab BUILD-generated app Search page hit the
  deny when querying its single granted dataset via the ask surface.

### Changed
- **BUILD assistant grounded in granted-dataset schemas + a spec-vs-schema rule.** The
  build directive already injects each granted dataset's REAL columns via the grants-context
  block; 0.6.64 adds explicit SDK ground rules to the data-plane contract: the dataset schema
  is AUTHORITATIVE over story-spec field names (do NOT invent `status`/`tenant`/`SKU` fields
  the schema lacks — build with the real columns and note the gap); read granted datasets via
  `os.datasets.query('<id>', { limit })` (returns `{ columns, rows }` where rows are ARRAYS in
  column order — zip before use); `os.datasets.query(id, { nl })` is scoped to THIS app's
  granted datasets only; and the app can only reach artifacts in its grants (never list the
  user's full catalog). This closes the other half of the incident, where the generated page
  re-invented columns the dataset (`northpeak-products`) does not have because the spec text
  mentioned them.

## [os-ui 0.6.63] — 2026-08-04

### Security
- **Least-privilege data plane for app origins (governed reads).** Generated apps run
  under the user's ambient `soa_session`, so an app could read ANY dataset / knowledge /
  file / metric the USER can see — regardless of what the app was granted. A new helper
  (`lib/software/app-origin.ts`) attributes a request to an app by its `Origin`/`Referer`
  (`<slug>.<domain>.<appsBaseDomain>`, reusing the SAME `isAllowedAppOrigin` source of
  truth as CORS) — and, for the same-origin runtime serve mode, by the
  `/api/apps/runtime/<slug>` referer path. When a governed read comes from an app origin
  it is capped at (user access ∩ app grants):
  - list routes (`/api/data/datasets`, `/api/metrics`, `/api/knowledge/docs`,
    `/api/files`) FILTER to the app's granted ids (the `total` count follows suit);
  - single-artifact routes (`/api/data/datasets/[id]`, `…/preview`,
    `/api/metrics/explore`, `/api/files/[id]`) return **403** with an honest, actionable
    reason naming the app + artifact and pointing at the Software tab grant flow;
  - the free-form NL→SQL surface (`/api/data/ask`) spans every dataset the user can see
    with no dataset-id to scope it, so it is **denied outright for app origins** (the
    simplest safe behavior) — apps query a specific granted dataset via
    `os.datasets.query` instead;
  - an unknown slug from an app origin fails **closed** (denied). Requests with NO app
    origin (the OS UI itself) are COMPLETELY unaffected — the helper does no I/O on the
    non-app path.

### Fixed
- **Honest app "Granted context".** The scaffold surfaced `os.context()`, whose SDK
  composed from `/api/context/available` — which returns everything the SIGNED-IN USER
  can see, not what the APP was granted; labelling that "Granted context" was a lie. New
  app-scoped route `GET /api/apps/by-slug/{slug}/context` returns ONLY the app's actual
  grants (`app.grants`) resolved to display names from the same canView/RLS-scoped stores
  the grant picker uses (an artifact that no longer resolves is kept honestly as
  `name: id`, never dropped). The vendored SDK's `context()` now hits this endpoint when
  an `appSlug` is set (the scaffold sets it), and keeps its legacy five-feed behavior when
  it is not (the OS UI). The `OsClient` interface is unchanged (its closed-interface
  regression stays green).
- **Scaffold nginx cache bug — stale bundle after every deploy.** The Vite scaffold's
  `nginx.conf` set no cache headers, so browsers heuristically cached `index.html` and
  users kept running an old bundle after a deploy. It now sends `Cache-Control: no-cache`
  for `/index.html` (via the `= /index.html` location the SPA `try_files` redirects into)
  and `public, max-age=31536000, immutable` for the content-hashed `/assets/`.

### Changed
- **Granted context moved from Overview → Admin (scaffold).** The starter Overview page
  is now a plain honest landing (app name + the OS-delegated signed-in user); the
  app-scoped "Granted context" panel now lives in the Admin section below "App members"
  (zero grants → "No context granted yet — grant datasets, knowledge or metrics to this
  app in the OS Software tab.").
- **"Refresh SDK" action in the Software tab.** The `POST /api/apps/{id}/refresh-sdk`
  route (re-vendors `@sovereign-os/app-sdk` into an existing app) had no UI. A small
  owner/in-domain-admin "Refresh SDK" button now sits in the app-detail header with honest
  result feedback (re-vendored / no-op for a non-frontend template / gate rejection).

## [os-ui 0.6.62] — 2026-08-04

### Added
- **Generated-app WRITE SDK — `os.records.*` (the bridge, not an invention).**
  The vendored app SDK (`lib/app-sdk`) was read-only, so the build assistant kept
  hallucinating `os.datasets.update` / `os.files.create` — methods that never
  existed. It now has the real write door: `os.records.list/get/add/export`, the
  SECOND door onto the SAME governed store the app's MCP tools already reach.
  New governed routes `GET/POST /api/apps/by-slug/{slug}/records`,
  `GET …/records/{id}`, `POST …/records/export` run AS the signed-in user, gated on
  (a) the app's visibility/entry rule (404 when not visible) and (b) the app's
  Builder-APPROVED deploy envelope's `writeTools` (403 with an honest, governance-
  naming reason when a write is not approved; reads are always-on). Both the MCP
  tool route and these routes call ONE shared executor (`executeAppTool`,
  `app-records.ts`) — one store, two doors. Datasets/metrics/knowledge/files stay
  read-only; the `OsClient` interface is closed, so a hallucinated `os.datasets.update`
  is a TS2339 the compile gate catches. Existing apps pick up the new SDK via
  `refreshVendoredSdk` (`POST /api/apps/{id}/refresh-sdk`) or the next re-scaffold;
  new scaffolds get it automatically. The BUILD directive now names the true surface.

### Fixed
- **The compile gate no longer fails OPEN on a missing esbuild wasm.** The
  `esbuild-wasm` binary is loaded at runtime (never require()'d), so standalone
  packaging dropped it — the bundle pass threw and the WHOLE gate skipped
  ("gate error — skipped, fail-open") on real commits, letting bad trees through.
  The image now ships `esbuild.wasm`; when it is ever missing again, the
  authoritative **tsc** pass STILL gates (catching hallucinated members / import
  depth) and only the bundle net is skipped, honestly ("bundle check skipped —
  asset missing"), instead of the whole gate failing open.

## [os-ui 0.6.61] — 2026-08-04

### Added
- **Direct build service + digest-pinned runners (redesign Phase B).** The
  serving image comes off the Forgejo-Actions critical path. After a gated live
  commit, os-ui submits an in-cluster **Kaniko** `batch/v1` Job (daemonless —
  no DIND, passes the apps namespace's `baseline` PSS) that builds the app's
  committed Dockerfile straight from its Forgejo git tree at the exact commit
  SHA (Kaniko's native git context — no tarball, no ConfigMap size limit),
  pushes an immutable `:sha12` tag to the in-cluster registry, and writes the
  pushed **digest** to the pod's termination message, where os-ui captures it
  with plain pod reads. The runner Deployment then serves that app
  **digest-pinned**: a new digest IS the pod-template change, so Kubernetes
  rolls honestly — the `deployed-at` roll-on-same-tag hack and the
  `imagePullPolicy: Always` reliance are deleted for pinned images (`:latest`
  fallback keeps both, unchanged). The pipeline's `harbor` (image-build) stage
  now narrates WHICH system built, truthfully: "OS build service" submit /
  build / digest-pin notes vs the Forgejo-Actions notes, and
  `get_software_status` reports `builtBy` + an `osBuildNote`. Feature-flagged
  end-to-end: chart `softwareBuild.enabled` grants the build-Job RBAC
  (namespaced batch Jobs + pod/log reads, nil-safe under `--reuse-values`) and
  sets `SOFTWARE_BUILD_SERVICE`; when OFF — or when the submit hits missing
  RBAC/namespace — the pipeline says so specifically and Forgejo Actions keeps
  building exactly as before. `ci.yml` stays in every scaffold as the
  export/CI-confirmation path (demoted, not deleted), and the Phase C repair
  loop keeps riding its unchanged Actions detection.

### Fixed
- **The compile gate no longer false-rejects in production.** The deployed
  standalone image was missing the TypeScript lib .d.ts files and @types/react
  (never require()'d, so packaging dropped them) — every tree looked like
  hundreds of errors and GOOD commits were rejected ("342 compile errors" on a
  one-page change). The image now ships the type assets, and the gate
  self-checks its environment first — if the assets ever go missing again it
  skips honestly ("compile check skipped, CI will verify") instead of
  fabricating diagnostics.

### Added
- **Runtime serving (beta, redesign Phase D — opt-in per app).** Flip
  "Runtime serving" on a Vite-shaped app and the OS serves it directly from
  the committed tree in a sandboxed, strict-CSP iframe — no image build, no
  CI, no pod. Only compile-green trees serve; a red tree shows its
  diagnostics honestly. The status card says "OS runtime serving — no image
  build required" with image stages marked n/a. Image serving stays the
  default.

## [os-ui 0.6.60] — 2026-08-03

### Added
- **Bounded CI auto-repair (redesign Phase C).** The compile gate (Phase A)
  stops compile errors pre-commit, but a build can still go red in CI for a
  build-env-only reason (a missing asset, a dependency that won't install, an
  imported-repo dep the gate honestly skips). Those failures used to just sit
  there — honest but inert. Now, when the pipeline records a FAILED run, the OS
  fetches the failing run's log tail (timestamps + docker layer noise stripped,
  error-dense tail capped) plus the failing commit's changed-file list, and
  opens exactly ONE bounded REPAIR build turn (reasoning model) instructed to
  fix ONLY what the log names, then commit — the compile gate still applies and
  the commit is prefixed `repair(ci):`. Bounds are strict: at most one
  auto-repair per failed run, and if the repaired commit fails CI again it does
  NOT loop — the surface says so plainly ("auto-repair attempted, CI still
  failing — needs a human/build turn"). Every surface labels the spend
  honestly ("auto-repair turn (reasoning model)"); an app-level opt-out
  (default on) turns it off. Detection rides the existing status refresh (any
  app view) plus a best-effort in-process one-shot check ~2.5 min after a build
  commit — no cron, so a pod restart simply defers to the next on-load refresh.

## [os-ui 0.6.59] — 2026-08-03

### Added
- **Verify-before-commit (redesign Phase A).** Every build commit is compiled
  IN-PROCESS before anything is written: TypeScript against the real vendored
  @sovereign-os/ui + app-sdk types, then an esbuild bundle pass — ~0.4-0.7s.
  A red check rejects the commit with exact file:line diagnostics fed back
  into the same build turn (and counts toward the bounded reasoning
  escalation). Non-compiling app code can no longer be committed, from the UI
  or MCP. CI becomes confirmation, not discovery.
- **App membership (least-privilege).** The generated app's Admin page listed
  the entire domain directory as if it belonged to the app. Apps now carry
  explicit membership: the creator is the sole implicit admin; app admins add
  users by name (admin | member) through a governed route. Entry to deployed
  apps remains domain-wide by design — now stated honestly.

## [os-ui 0.6.58] — 2026-08-03

### Fixed
- **"Repository missing" banner clears after a recovery.** The pipeline's
  forgejo flag downgraded honestly on a 404 but nothing upgraded it back when
  the repo answered again — Publish kept claiming the repo was missing while
  commits, CI and the live app were all green. The status refresh now flips
  the flag symmetrically.

## [os-ui 0.6.57] — 2026-08-03

### Added
- **Suggested quality checks arrive documented.** Accepting an AI-suggested
  rule persists a plain-language description derived deterministically from
  the profile evidence ("Every row must have a value in <col> — the profile
  found no missing values."). No model call, no extra step; the ✨ describe
  stage remains for custom rules.
- **Datasets document themselves after ingestion.** On the first successful
  Bronze, an AI draft (grounded in the real landed schema + preview) fills the
  EMPTY description and column notes in the background — never overwriting
  human words, marked "✨ AI-drafted from the data — review to confirm" until
  a human save clears it; an unreachable model skips silently.

### Fixed
- **Heal adopts orphaned repositories.** When a repo's files exist on
  Forgejo's disk but its database record is gone (disk/DB desync), Heal now
  ADOPTS the repo — preserving every commit — instead of failing to create
  over the existing files; re-scaffold only when truly absent; specific
  errors for credential or unadoptable states. Auto-heal-on-commit and the
  durable file mirror inherit this.

### Changed
- **Build progress lives under the button.** The live stepper (Plan →
  Generate → Commit → Preview), current-step line and STOP moved to a fixed
  panel under the Build button — no longer scrolling away with the chat; the
  transcript keeps the messages, plan and activity feed.

## [os-ui 0.6.56] — 2026-08-03

### Added
- **Context grants are now real.** Granting data, knowledge, files, metrics or
  connections to a software app finally does what the panel implies: the
  Design assistant and every Build agent receive a "Granted context" block
  with the ACTUAL content — dataset schemas and measures, knowledge text,
  file bodies, metric definitions, connection descriptors (never secrets) —
  resolved as you, DLS-scoped, token-budgeted with loud truncation, and the
  directive to build against the real names instead of inventing fields. At
  deploy, grants compile into the app's OPA tool access (read-only data-plane
  tools added to the template baseline; recompiled the moment grants change;
  fail-closed with no grants).

### Fixed
- **App source code is now durably mirrored — a lost repo is fully recoverable.**
  Previously an app's file tree lived only in Forgejo plus an in-process
  `globalThis` snapshot that died on every pod restart; the app record stored
  file NAMES only, so a vanished repo meant unrecoverable source (two built
  stories were lost live on northpeak-products). Every verified commit now
  write-throughs the app's FULL current tree (path + content) to a durable
  OpenSearch mirror (`os-app-files`, one doc per app), on the SAME best-effort
  mirror infrastructure the app record uses. The offline `read_app_files` tree,
  the deploy security scan's offline fallback, the instant preview and
  `healAppRepo`'s restore source all hydrate from this mirror, so a pod restart
  no longer loses the tree. `healAppRepo` now restores every mirrored file on top
  of the scaffold — a lost repo comes back with its real code, even after the
  process that built it is gone. Legacy apps with no mirror doc are lazily
  backfilled from the next successful live-tree read or commit; an app whose repo
  AND mirror are both gone stays honestly template-only (no fabrication). Respects
  the honest-commit contract: a rejected commit persists no mirror doc.

## [os-ui 0.6.55] — 2026-08-03

### Fixed
- **A commit into a vanished repository heals itself.** Per-file write failures
  are now classified (sha-conflict / unreachable / backend); only when the
  whole changeset failed on plain backend errors is the repo probed — a
  repo-level 404 triggers one audited re-provision (full scaffold incl. the CI
  workflow, even with an empty snapshot) and one retry. Sha conflicts and
  outages can never be papered over by a heal. Errors now name the cause per
  file instead of a bare FAILED list.
- **"Heal repository" button** on the Publish surface when the pipeline
  reports the repo missing — the manual fallback for the same governed heal.

## [os-ui 0.6.54] — 2026-08-03

### Fixed
- **Story "built" status is now EARNED, never self-reported.** A story flips to
  done only on an app with real committed code; a backend-rejected commit
  throws instead of phantom-persisting; a reconcile demotes existing
  phantom-built stories to their true state on load. The disabled Test button
  was the honest signal all along — the badges now match it.
- **Build turns can no longer end as an apology essay.** A file-less commit
  gets a corrective error carrying the exact call template; the BUILD directive
  shows the commit signature and forbids the "here's a plan you can copy"
  wrap-up — if the agent cannot commit, the turn fails plainly with Retry.

### Added
- **Bounded reasoning escalation in Build.** If the standard model keeps
  shape-erroring on tools or exhausts its step budget, the turn retries ONCE
  on the reasoning model — labelled honestly in the activity feed, never
  silent, never on the happy path.

## [os-ui 0.6.53] — 2026-08-03

### Fixed
- **Orphaned deploy-approval cards self-clear.** "Approve & go live" on a card
  whose app no longer exists (deleted/re-created across sessions) returned a
  bare "App not found" — it now answers with an actionable message and retires
  the stale card and its governance approval.
- **Pipeline status can't claim "ok" on a missing repo.** A 404 repo downgrades
  both the Forgejo and Actions stages to failing (the note said 404 while the
  stage stayed green).

### Added
- **Repo heal + delete guard.** `POST /api/apps/[id]/deploy?action=heal-repo`
  re-provisions a vanished Forgejo repo from scaffold + snapshot (edit-gated,
  audited, idempotent); repo deletion now refuses to remove a repo that is
  still the home of another active app record.

## [os-ui 0.6.52] — 2026-08-03

### Fixed
- **Orphaned app runners self-heal.** If `deployApp` ran while the cluster was
  transiently unreachable, the app stayed image-built + approved but WITHOUT a
  runner forever ("runner unreachable"). The status reconcile now re-applies
  the deployment idempotently when the runner is absent and the cluster is
  reachable — never touching a running/deploying/failed runner, and never
  "healing" what is actually offline.

## [os-ui 0.6.51] — 2026-08-03

### Fixed
- **Build-stage tool ergonomics (three live failures, one root class).**
  (1) `commit({})` no longer answers "App not found": the run's app id is now
  BOUND server-side into every build tool call (empty → filled, mismatched →
  rejected loudly), and a commit without files gets a corrective error the
  agent can act on. Cross-replica ruled out (single replica + durable-mirror
  re-hydration). (2) `read_app_files` on a directory returns the directory
  listing (files + subdirs) instead of a dead-end rejection; empty path lists
  the root. (3) The app's Repo link is now always built from the external
  Forgejo URL — the API's `html_url` carried the cluster-internal host, which
  404s in a browser; persisted apps heal on load. The repos were always there.
- **Publish surface says why there is no app link.** The "open app" link is
  gated on a served preview; when the app's image/runner isn't serving yet the
  surface now states that honestly instead of showing nothing.

## [os-ui 0.6.50] — 2026-08-03

### Changed
- **Creating a software app shows honest progress.** The create form now mounts
  the core BusyProgress the moment you click — one live step naming the real
  work (Forgejo repo provisioning, scaffold seeding, MCP profile compile) with
  an elapsed counter — instead of a silently disabled button. The request stays
  a single round-trip, so no fabricated checkmarks; streamed per-file
  milestones would need an SSE create route (noted, not done).

## [os-ui 0.6.49] — 2026-08-03

### Added
- **Demote everywhere.** Metrics, Dashboards and Science models gained the way
  back down the governance ladder (every other tab already had it): "Unshare"
  on Domain artifacts (owner / in-domain Domain admin) and "Revoke from
  Company" on certified ones (Admin). A metric shares its tier with its
  dataset, so demoting a metric moves the dataset and every metric on it — the
  confirm dialog says so explicitly.
- **Metric creation type chooser.** ＋ Metric first asks "Simple metric or
  Complex metric?" on the same two-card picker the Data tab uses. The complex
  path is a first-class formula editor: the dataset's existing metrics as
  clickable [name] chips, live validation, honest empty state. The formula
  option left the aggregation dropdown (it was buried third and undiscoverable).
- **Dashboard panels expand.** Every panel opens full-screen (title or ⤢) —
  the chart large, and below it the same rows as a table with ⬇ CSV. The table
  appears only for graph panels; a table panel renders once, large.
- **Notification bell.** In-app notifications now have a real surface: a bell
  with an unread badge in the sidebar foot, newest-first panel, mark-read.
  This is the single delivery surface for metric alerts, DQ alerts and
  scheduled reports.

### Changed
- **Alerts and scheduled reports deliver in-app only.** Email and Slack options
  removed — Slack never had a delivery path (the checkbox was fiction) and
  email silently depended on a mailer. Legacy rules/configs coerce safely.
  "Trigger a governed agent on breach" renamed to "Trigger an Agent".
- **Talk-to always on top of View, never in Edit.** Metric View's duplicate
  Talk-to removed; every context-tab View leads with its Talk-to; Edit keeps
  only stage-assist AI.
- **Lifecycle from View.** Promote/Demote/Archive/Version history are reachable
  from an artifact's View (like Knowledge) — Data no longer hides them in Edit.
- **Context tabs de-cluttered.** ~40 explanatory paragraphs removed and ~40
  compressed to one clause across Data, Metrics, Files, Knowledge and
  Connections; headings normalized to short sentence-case.

### Fixed
- **Raw Trino errors translated.** "Cannot apply operator: varchar * integer"
  now reads "This calculation mixes text and numbers — cast the column or fix
  its type in Transformation", raw error behind Show details; wired at every
  Data-tab query-error site. Derived fields state "Numeric columns only" upfront.
- **Curated quality suggestions: silence explained.** The DQ pipeline was
  correct (live repro produced 9 suggestions on the curated dataset) — but a
  failed/unbuilt Gold returned an empty list with the reason swallowed. The
  route now reports why and the Checks section says it honestly.
- **Outdated metric hint corrected.** A metric serves from any dataset with
  built Gold — even personal, no promotion needed; the old "promote to Shared
  first" hint misdescribed the system.

## [os-ui 0.6.48] — 2026-08-02

### Added
- **Metric descriptions.** Every metric can carry a plain-language "what does
  this metric mean?" sentence — written right under the name when creating,
  proposed by ✨ Suggest-with-AI, editable any time, shown as the lead line in
  the metric's View and as a quiet line on its tile.
- **Human-readable data-quality rule descriptions.** Each rule has an editable
  description; one "✨ Describe checks with AI" drafts descriptions for every
  rule missing one (always a draft you review — never auto-saved). The View
  quality scorecard leads with them.
- **Dataset demote is back**: "Demote to My" on Domain datasets (edit-scoped)
  and "Demote to Domain" on certified products (admin) — with confirmation;
  the store's protection gates (named grants, domain imports) still apply.

### Changed
- **Dataset detail's technical strip moved to a bottom "About this dataset"
  footer** — owner, ids, table name, and status chips; the top keeps just the
  name, tier badge and the ✎ Edit dataset button.
- **Tile polish**: metric names truncate before the domain/tier badges;
  the dataset select-checkbox no longer overlays the title.

### Fixed
- **Composite metrics no longer lose their formula on reload** — the source
  formula now round-trips through the store (the Edit box re-hydrated empty
  before; the compiled SQL was never affected).

## [os-ui 0.6.47] — 2026-08-02

### Changed
- **Dataset Edit speaks plain language: Ingestion → Documentation →
  Transformation → Checks** (curated: Composition → Documentation → Checks),
  each section closing with its own action — Save Data, Save Documentation,
  Save Transformations, Save Data Quality Checks, Save Composition. No
  Bronze/Silver/Gold words in Edit; no layer previews or stats (View owns
  those); no "Continue to …" remnants. Lineage moves to the Developer view.
  Keep-columns + derived fields live only in curated Composition; legacy
  datasets with stored joins keep their join editor.
- **Gold materializes automatically for ingested datasets** — after every
  successful ingest or transformation build, the governed pass-through runs
  behind the scenes ("…served for metrics automatically"); the manual button
  is gone. Failures surface loudly.
- **Checks unifies Default checks** (freshness/volume/schema monitors) **and
  Custom checks** (authored rules + AI suggest + Run) in one section.
- **Opening a file is a full-page reading surface** — the half-screen overlay
  with its own scrollbar is gone; long text flows with the page (CSV keeps
  horizontal scroll only). Knowledge and Connections verified already correct.
- **Tile lists group by kind**: "Ingested Data" / "Curated Data" and
  "Simple Metrics" / "Complex Metrics" (headers only when both kinds exist).
- **Nav order**: Context = Data, Metrics, Files, Knowledge, Connections;
  Build = Agents, Dashboards, Software, Science, Console.
- **MCP guides, tutorials and the user guide are truth-synced** to the whole
  0.6.40→0.6.47 redesign — golden paths describe ingested-vs-curated with
  auto-gold, tutorials anchor only to UI that exists, the guide's journeys
  use the same vocabulary as the screens.

## [os-ui 0.6.46] — 2026-08-02

### Changed
- **Dataset View reads in usage order: Talk to Data → data preview →
  statistics → data quality → configuration.** The Talk box drops its example
  chips; the bronze·silver·gold layer toggle moves into the preview heading
  (Gold default).
- **The data-quality section is a scorecard**: pass-rate hero + colored bar +
  one bordered card per rule with ✓/✗ and real violation counts — unrun rules
  show as unrun, never as passing.
- **Dataset View header is calm: one big "✎ Edit dataset" button.** The
  promote/certify, archive and version-history controls move to the EDIT
  header — governance itself is unchanged, it just lives where changing
  things is the point.
- **The dataset header chip "not published" is renamed "not certified"** — it
  reports certification (the Company-tier trust badge), not whether the data
  is built or shared; the tooltip now says so.

## [os-ui 0.6.45] — 2026-08-02

### Changed
- **Dataset Edit is calm: layer previews are opt-in.** The Bronze/Silver/Gold
  statistics and previews no longer render inline in Edit — each stage shows a
  "👁 Preview …" button that fetches the governed rows on demand.
- **Dataset View shows Gold by default** (the highest built layer) with a
  bronze · silver · gold toggle at the top of the data preview; only built
  layers are offered.

### Fixed
- **Domain datasets/metrics no longer appear under "My folders".** The folder
  tree renders any item without an explicit scope under BOTH roots; Data and
  Metrics were the last two tabs passing unpinned items (the same leak fixed
  for the other tabs in 0.6.40). Every item is now pinned to its own root.

## [os-ui 0.6.44] — 2026-08-02

### Changed
- **Every context tab now speaks ONE artifact language: create with a type →
  land in Edit; tiles in folders; click a tile → View; ✎ Edit to change.**
  Metrics and Dashboards already worked this way — Knowledge, Files,
  Connections and Data now join them.
- **Knowledge**: ＋ New offers *General knowledge* (opens the markdown editor)
  or *Workflow* (routes to the Business Processes editor). A tile opens the
  RENDERED markdown in View; ✎ Edit (edit-scope gated) opens the editor.
  Promote/demote, Move and lifecycle live in the detail header.
- **Files**: ＋ New offers *Upload a file* or *New note (markdown)*. A tile
  opens the inline preview (text/markdown/CSV/media rendered; honest
  "no inline preview" + Download for binaries); ✎ Edit gives a real text
  editor for text files (saving a proper new version) or Replace/rename/move
  for binaries.
- **Connections**: ＋ New offers the two doors — *Use a connector* (the
  grouped, searchable template gallery) or *Build a custom connector*. A tile
  opens View: live health, Test connection, what it connects to and the
  capabilities it exposes; ✎ Edit opens configuration (secrets stay
  write-only).
- **Data — the ingested vs curated split lands.** An INGESTED dataset's Edit
  is the full journey in one surface: ingest → clean into Silver → bring to
  Gold as a single-table projection (columns + derived fields) → quality
  rules — the "Join to" section is gone; combining datasets is now
  exclusively a curated-dataset capability. A CURATED dataset's Edit picks an
  EXPLICIT base dataset and composes: joins, kept/renamed columns, derived
  fields, then documentation and quality. Both open in View (talk ·
  statistics · preview · quality). Legacy datasets with stored joins keep
  their join editor — nothing breaks. The staged walk retires for Data.

### Fixed
- **File text edits no longer leave stale bytes behind.** Editing a text file
  previously updated the reader but left `/raw` and `/download` serving the
  old content; a version rewrite now keeps bytes, extracted text and the
  search index consistent.

## [os-ui 0.6.43] — 2026-08-02

### Changed
- **Curated datasets walk their own path: Compose (Gold) · Document · Validate ·
  View.** A dataset born curated (composed from existing governed datasets) no
  longer shows the Ingest stage or the Silver cleaning tooling — there is
  nothing to ingest, and cleaning belongs to the source datasets. It opens
  straight in Compose (the join builder, now billed as the curated build
  itself), then Document (describe the composed output — still required for
  promotion), quality checks, View. Ingested datasets keep the full 5-stage
  medallion path unchanged.
- **Composite metrics are findable.** *Formula — combine other metrics* moves
  up to third in the aggregation dropdown, and the metric-name step carries a
  one-line signpost to it.

### Added
- **Derived fields in the Gold builder.** Define new row-level columns computed
  from the joined data — `margin = price − cost`, `total = price × quantity`
  (column-op-column or column-op-constant; division is null-safe). Compiled
  through the same guarded SQL compiler as everything else (no free-text SQL),
  persisted with the dataset spec, re-editable on reopen, and the new columns
  flow into the metric builder and dashboard palettes automatically.
- **Transparency badges on tiles**: curated datasets show a quiet *curated*
  badge; composite metrics show *formula* instead of the opaque "number" type.

## [os-ui 0.6.42] — 2026-08-02

### Added
- **Viewer-side time drilling.** Any panel that trends over time gets a quiet
  day · week · month · quarter · year switcher in its header — drill the time
  hierarchy up and down without editing the dashboard; every re-query runs
  under your row-level security.
- **Panel sizes.** Each panel can be ⅓, ½ or full width (12-column grid) —
  a KPI tile can sit beside a full-width trend, the Power BI/Tableau layout
  feel without a drag canvas. Dashboards saved before this keep their layout
  until a panel size is touched.
- **Default filters that survive reload.** Saving a dashboard with active
  filter chips persists them as its defaults; View opens with them applied.
- **Filter chips in the Metrics explorer** (same vocabulary as dashboards) and
  an **"Open in Metrics ↗"** link from the drill drawer.
- **Live formula validation.** The composite-metric editor validates as you
  type: position-anchored errors inline, resolved `[metric] ✓` chips when
  valid. The server stays authoritative.
- **⬇ CSV on every table panel** — downloads exactly the rendered rows (your
  governed, row-level-secured result), including the drill drawer's table.
- **BusyProgress — the OS-wide progress surface for long saves.** The ~30 s
  metric save and the dashboard save now show the shared progress bar with a
  plain-language sentence naming what the server is doing and a live elapsed
  counter — never a silently disabled button, never fabricated step progress.

### Changed
- **Viz dropdown order: pie · bar · table first.**
- **Panel queries are resilient**: a panel's measures now query the governed
  engine in parallel, and a query that exceeds 30 s shows an honest
  "engine may be busy — Retry" state instead of an infinite spinner (never a
  stale or mock fallback).

### Removed
- **Connected tools (dashboards View) and Connect Power BI (metric View)** are
  unmounted until each connection is verified working; the components stay in
  the tree for one-line restoration.

### Fixed
- **Talk-to-Data cited datasets from every domain while one domain was
  active.** Its dataset enumeration applied only the entitlement gate (which
  the owner passes for their other domains' datasets, and certified products
  pass tenant-wide); it now applies the same active-domain narrowing as the
  catalog and JOIN picker, with regression tests across all three tiers.

## [os-ui 0.6.41] — 2026-08-02

### Added
- **Cross-filtering (the Power BI page interaction).** Clicking a bar, pie
  slice or table row filters the WHOLE dashboard: a chip bar appears above the
  grid (`region = DE ×`) and every panel re-queries with the filter pushed into
  its governed SQL `WHERE` — same viewer identity, same row-level security.
  One value per member (slicer behavior); click the same value again to clear;
  `▸` on a chip opens the drill drawer for that slice; a KPI click opens its
  breakdown directly.
- **Metrics ⇄ Dashboards are one system now.** Every panel's measure label
  links to the metric's definition (`/metrics?focus=`), and a metric's View
  gains **"On dashboards"** — tiles of every visible dashboard charting this
  metric's view, plus **＋ Add to a dashboard**, which opens the builder with
  the metric pre-selected. Dashboards now supports the `?focus=<id>` deep-link.

### Fixed
- **Two panels charting the same metrics DIFFERENT ways no longer silently
  collapse into one on save.** The panel identity key now includes dimensions,
  time grain and filters — "revenue by region" and "revenue by product" are
  two panels, as designed.
- **The dashboard's live/mock badge is honest about mixed states.** It now
  aggregates every panel's resolution mode and shows a loud
  `mixed · N live / M mock` instead of whichever panel happened to resolve last.

## [os-ui 0.6.40] — 2026-08-02

### Changed
- **Metrics builder is now a plain View/Edit surface too — the 5-stage flow is
  gone.** A NEW metric opens in **Edit** (source dataset → name → AI-fillable
  form → Save); an EXISTING metric opens in **View**: the definition in plain
  terms, the governed Trino SQL it compiles to, the data underneath, the
  dimensions it can slice by, the live explorer preview, Talk to Metrics and
  Alerts. Promote moves into the detail header left of Archive, with a
  View⇄Edit toggle. Editing an existing metric hydrates the saved definition
  (new tested `formFromMeasure` inverse) and re-saves **onto the same member**
  — dashboards and alerts keep working.
- **Data tab: the Publish stage becomes View.** Talk to Data on top, then
  statistics, the (layer-named) data preview, and a data-quality dashboard
  built from the dataset's rules; Promote moves to the header. Stage previews
  are framed per layer (Bronze/Silver/Gold Data Preview) and Harmonize no
  longer shows the preview twice.
- **Metrics Define reads naturally: pick the dataset first, then the name;
  ✨ Suggest with AI moves to the form it fills** (it needs the dataset's
  columns, so its old placement was always disabled).

### Added
- **Composite metrics — formulas over other metrics (the Power BI
  "measures reference measures" pattern).** A new *Formula (other metrics)*
  option defines e.g. `([revenue] - [cost]) / [orders]` over the dataset's
  existing basic metrics, with click-to-insert metric chips. Compiled to the
  same governed serve path as every metric; division is null-safe
  (÷0 → empty, DAX-DIVIDE style) and integer counts divide correctly. The
  grammar is a strict DAX subset, so a future one-way Power BI export can
  compile these metrics to DAX measures.
- **Dashboards drill-down.** Click a bar, pie slice or table row to drill into
  that category — the same governed metrics narrowed to the clicked value
  (pushed into the SQL `WHERE`, under your row-level security) and broken down
  by another dimension of your choice; click a KPI number for its breakdown.
  A filter on a member the governed view doesn't expose is dropped LOUDLY,
  never a silently unnarrowed number.

### Fixed
- **Dashboard charts no longer overlap themselves.** Multi-measure legends get
  their own scrolling band above the plot, the pie sits clear of a one-line
  scrolling bottom legend with overlap-hiding slice labels, and long bar
  category labels rotate + truncate instead of colliding.

### Changed
- **Dashboards builder is now a plain View/Edit surface — the 5-stage flow is
  gone.** A NEW dashboard opens in **Edit** (name + panel builder + Save); an
  EXISTING dashboard opens in **View** — the native ECharts grid — with a clear
  **✎ Edit** button that switches to Edit, and Save returns to View. Save stays
  an **upsert under the existing id** (editing updates in place, never
  duplicates). The `StageShell`/`DASH_STAGES` machinery (and its unit tests) is
  deleted; the per-stage assistant slot is removed with it.
- **The Govern stage is dropped.** Its two real actions move to sensible homes:
  **Promote** now sits in the detail **header** next to the Archive/lifecycle
  controls (mirrors the Metrics builder), and **Reports** + **Connected tools**
  (Power BI / Tableau / Superset) fold into a calm section **below the grid** in
  View — reachable, but no longer a whole stage.

### Removed
- **The "View as" viewer-region dropdown (DE/FR/US) is gone from the dashboard
  view.** It was a Cube-era per-viewer-region RLS demo affordance; on the
  governed-SQL path RLS comes from OPA identity, so the dropdown was misleading.
  The panel-query request no longer sends `viewerRegion` (the server stays
  tolerant of the field).

### Added
- **Existing panels are editable, not just deletable.** In Edit, each panel has
  an **Edit** button that loads its spec (metric, viz, group-by, time) back into
  the panel builder — the add button reads **"Update panel"** — and replaces the
  panel in place on confirm.
- **Table panels can group by a dimension (and optionally time).** The panel
  builder's group-by/time controls now apply to `table` too; the governed-SQL
  resolution path already handled a dimensioned slice and the table renders the
  dimension column.

### Fixed
- **Folder-tree scope leak on the new foldered tabs.** `FolderTreeItem.scope` is
  optional; when omitted an item rendered under BOTH "My folders" and "Domain
  folders" roots. Every nav list rail now pins each item to its own root:
  Dashboards, Agents, Connections and Science (models → domain-only) pass an
  explicit `scope`, so a root-level item shows in exactly one tree.

## [os-ui 0.6.39] — 2026-08-01

### Added
- **Folders + rename across EVERY artifact tab (parity rollout).** Dashboards,
  Science, Agents, Software, Connections, Big Bets, Pillars and Business
  Processes/Workflows now have the same governed folders Files and Data already
  had — a per-domain My/Domain folder tree in the list header, a "Move to
  folder…" picker on each artifact, and the folder surviving serialization —
  all through the ONE shared `ArtifactAdapter` registry (`lib/folders`), so the
  move/archive/restore/delete cascade is written once and can't drift per tab.
  Folders stay **domain-scoped**: a folder in domain A never shows in domain B.
- **Rename for Metrics, Dashboards, Science, Agents, Software, Connections, Big
  Bets, Pillars and Business Processes.** Each artifact's detail header gains a
  labelled **✎ Rename** button (inline input, Enter/blur to commit, error shown
  inline) — the same affordance the Data tab has. Rename is **display-name only**
  and edit-scoped to the same authority as editing the artifact; every rename is
  snapshotted to the artifact's version log where it has one.

### Changed
- **Physical identity is frozen across every rename.** Renaming never moves an
  artifact's derived/physical identity: a dataset's slug, a dashboard's Cube
  view, a software app's image/repo slug, a connection's Trino catalog + K8s
  secret name, a science model's serving key, and an agent/bet/pillar/workflow's
  stable id all stay pinned — so no live table, image, secret or member is ever
  orphaned by a rename. A **metric** is `dataset.measure`, so renaming writes a
  new measure **`label`** and freezes the Cube member `${View}.${name}` (the
  honest analogue of the dataset slug-freeze), keeping its sql/member identity
  stable everywhere the metric is served.

## [os-ui 0.6.37] — 2026-08-01

### Changed
- **Metrics builder: AI in the natural flow (the Data-tab pattern).** Define opens
  with **Metric name** on top and a ✨ **Suggest metric** button right beside it —
  the name doubles as the goal, and the AI fills aggregation/column/dimensions for
  review. The separate "Suggest metrics" box, the goal textarea and the boxed
  Define/Refine assistants are gone; Refine carries one big ✨ **Refine with AI**
  action at the top instead.
- **Dashboards: the false "Cube is not serving …" warning is gone.** Panels serve
  as governed SQL resolved through the registry (Phase 2), so the design-time Cube
  probe was checking something that no longer decides anything. The panel palette
  is now registry-only — what it offers is exactly what the executor computes —
  and the two dashboard meta routes no longer call Cube at all.

## [os-ui 0.6.36] — 2026-08-01

### Added
- **Central build-result popup (Data tab).** Silver/Gold build outcomes announce
  as a centered modal with a big **Continue to next stage →** confirmation —
  replacing the easy-to-miss bottom-right toasts. Failures show the honest error
  large and central.

### Changed
- **Pass through Gold** is a top action in the Harmonize stage, same style and
  left of ✨ **Propose a clean/join** (the bottom pass-through box is gone).

### Fixed
- **Store writes can no longer vanish across a deploy.** The durability mirror
  silently dropped writes while marked unhealthy — a freshly defined metric was
  lost on the next pod rollout. Writes now queue during unhealthy windows and
  replay on recovery (bounded; overflow drops oldest loudly).

## [os-ui 0.6.34] — 2026-07-31

### Changed
- **Dashboards read via governed SQL — Cube is off EVERY read path now.** A native
  ECharts panel resolves its numbers through the **same compiled-SQL metrics path**
  the Metrics tab uses (`exploreMetric`), not Cube: each panel measure is resolved
  to its governed metric (RLS-scoped registry) and served as one governed `SELECT`
  over the physical Gold mart, run **as the viewer** (Trino/OPA row & column
  security). A chart's number is therefore **the explorer's number by
  construction** — same measure member, same slice, same viewer identity, same
  honesty gate — so the BI layer and the Metrics tab can never disagree. The panel
  API response shape is unchanged (rows / mode / pending / warning / missingMembers
  / securityContext / sql), so the UI is untouched — a pure backend resolution swap.
- **Alerts evaluate via governed SQL, as the rule's owner.** An alert now resolves
  its metric value through `exploreMetric` (Cube off the read path) evaluated **as
  the rule's OWNER** — an owner-delegated token minted from the governed user
  directory (never a service account, never the cron-triggerer's identity) — so the
  threshold fires on exactly the number the owner sees under their own RLS. This
  also fixes the prior broken lookup that assumed a member's prefix was the dataset
  id (it is the cube view name); the member is now resolved through the metrics
  registry, the same way dashboards resolve it.
- **Window metrics are served as SQL.** Rolling-window and running-total measures —
  which used to return "pending, serves via Cube after Publish" — now compile to a
  faithful Trino window query: the base measure is aggregated per time bucket, then
  a window accumulator runs over the bucketed series (`SUM(…) OVER (ORDER BY bucket
  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` for a running total; a trailing
  `ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW` frame for a last-n window; a group-by
  dimension `PARTITION`s the series). A window measure **requires a time dimension +
  granularity**; without one (or when the trailing unit doesn't match the
  granularity) it returns the honest pending/unusable answer with a clear reason —
  never a wrong number. The frame counts existing buckets, not calendar units
  (documented), and the executed SQL carries no comments.

### Fixed
- **Alert honesty: an unreachable lakehouse SKIPS, never fires.** When Trino is
  unreachable, alert evaluation returns status **`unavailable`** and is skipped —
  never a fabricated value and never a false alarm; an un-computable/empty metric is
  **`pending`** (skipped, retried next tick). Only a genuinely computed number is
  compared to the threshold.

## [os-ui 0.6.33] — 2026-07-31

### Fixed
- **Builds ALWAYS run in the owner's personal lane — the promoted-dataset rebuild
  hole is closed.** Rebuilding a promoted dataset's Silver targeted the domain
  schema, whose Bronze never physically exists (promotion copies only the top
  built layer) → TABLE_NOT_FOUND. The personal lane is now the build workspace
  for every tier; the governed domain copy is written exclusively by the
  publish/re-materialize CTAS. A Builder+'s Silver rebuild auto-refreshes the
  domain copy when Silver is the published layer; with a Gold on top it stays
  honestly STALE until the Gold rebuild republishes. Seeded governed datasets
  whose only physical table is the domain copy are still adopted honestly.
- **A disabled Silver Build button always says why** ("Can't build yet — …") —
  the reason used to hide inside the collapsed "Show the code" section.
- **Client preview FQNs match the server exactly** (hyphenated domains map to
  underscored physical schemas; personal-lane rule mirrored client-side).
- AI Clean-it-up renames are sanitized to identifier-safe names on apply.
- The Silver type dropdown's no-op reads **text** (Bronze is all-text) instead
  of the opaque "keep".

## [os-ui 0.6.32] — 2026-07-31

### Added
- **Silver stage: type autodetect with approval.** The Silver panel reads the
  governed 50-row Bronze preview and deterministically infers each column's
  likely type from the ACTUAL values (integer/bigint/double/date/timestamp/
  boolean — including yes/no → boolean, the original Bronze-honesty case). A
  calm banner shows the detections; **Apply suggested types** fills the type
  dropdowns — the user approves, then builds. Never auto-applied; columns the
  user already typed are left alone.

### Fixed
- **Boolean cast accepts yes/no.** The Silver cast op maps yes/y/no/n
  explicitly; other values still fall through to the strict Trino cast, so
  genuine garbage keeps failing loudly.
- **avg/sum on text-typed numeric columns.** Metric aggregations cast their
  operand to double explicitly — a Gold column that skipped a Silver cast now
  aggregates instead of failing with FUNCTION_NOT_FOUND; non-numeric values
  still fail loudly naming themselves.

## [os-ui 0.6.31] — 2026-07-31

### Changed
- **Metrics are served by direct governed Trino SQL — Cube is off the metric read
  path.** A metric is now a **virtual declaration** compiled to one governed
  `SELECT` over the physical Gold mart, run **as the viewer** (Trino/OPA row &
  column security applies — the same governed path the working "live (sql)"
  preview already used). Both saved metrics (`/api/metrics/explore`) and unsaved
  drafts (`/api/metrics/preview`) resolve through this SQL path; every result is
  honestly labelled `live (sql)`. The **honesty gate is preserved**: if the query
  backend is unreachable on a real deployment, the metric returns the honest
  *unavailable* answer — never a fabricated number. Cube stays running for
  **dashboards only** (Phase 2 migrates those; dashboard/Cube-registration code is
  untouched — this is a dual-run).

### Added
- **Metrics on PERSONAL datasets.** Defining, previewing and exploring a metric now
  require only a **built Gold of any tier** — no promotion. A personal dataset's
  metric reads the owner's private lane (`iceberg.personal_<owner>.gold_<slug>`) as
  the owner (OPA `is_owned_personal`); a governed dataset reads the domain mart as
  before. The gate is split into **`metricSqlReady`** (built Gold, any tier — the
  define/serve rule) and **`metricCubeReady`** (built Gold **and** a governed tier
  — the Cube-registration rule); `metricGoldReady` remains a back-compat alias for
  the Cube rule, so no broken cube is ever registered on personal Gold.
- **MetricFlow-style semantic declarations.** Defining a metric now emits a
  portable dbt-MetricFlow YAML (`semantic/<slug>.yml`: `semantic_models:` with the
  Gold-mart `ref`, primary-key entity, join-aware dimensions with time grains, and
  measures + `metrics:`) alongside the (Cube-only) cube artifact. It is the
  tool-agnostic contract our compiler serves as Trino SQL. Rolling-window / running-
  total measures stay honest: no SQL form yet — they serve via Cube post-Publish
  (Phase 2).

## [os-ui 0.6.30] — 2026-07-31

### Changed
- **Gold stage (Data tab): no more Measures section.** Measures are defined once,
  in the **Publish** stage (and the Metrics tab) — Gold is now a pure row-level
  projection/join. A Gold rebuild **never wipes** measures already defined in
  Publish (guarded in the store + regression-tested).
- **Gold "Keep columns" starts full.** All columns are kept by default — remove
  the ones you don't want, or **Remove all** and hand-pick. **Add all columns**
  fills every column of the base *and* any joined datasets in one click.
- **One clear build flow on Bronze, Silver and Gold.** Each build stage now has
  exactly one main action (upload / **Build Silver version** / **Build Gold
  version**); the result and a big **Continue →** appear only after the work
  actually succeeded. The always-visible bottom "next stage →" shortcut on those
  three stages — which looked primary but built nothing — is gone. Stages remain
  voluntarily skippable via the stage rail on top.

## [os-ui 0.6.29] — 2026-07-31

### Security
- **Gold "JOIN TO" picker leaked datasets across domains.** The join picker was
  gated only on `canView`, which passes for an owner's assets in their *other*
  domains and for every certified product tenant-wide — so e.g. Kiekert datasets
  were offered while operating in agentic-leader. The picker now applies the same
  active-domain narrowing as the main Data list (My/Domain/Company of the
  operating domain only; the Marketplace catalog stays the only cross-domain
  surface). Covered by a regression test that fails on both bypasses.

### Changed
- **Friendlier duplicate dataset names.** Creating a dataset whose name is taken
  in this domain no longer just refuses: an inline note explains the clash and
  offers a one-click **Open** of the existing dataset, or suggests picking a
  distinguishing name (e.g. "Sales (EMEA)").

## [os-ui 0.6.28] — 2026-07-31

### Changed
- **Data tab: AI is built into each stage's natural flow — the bottom "Assistant"
  box is gone.** Every stage now carries big, clear ✨ actions at the top instead
  of a collapsible helper at the bottom:
  · **Define (Silver):** "✨ Draft documentation" (fills the description, column
    notes and quality rules) and "✨ Clean it up" — a NEW structured assistant
    stage that proposes casts/trim/rename/primary-key/drop/dedupe constrained to
    the real columns and **fills the guided Silver cleaning controls directly**
    (the user reviews, then builds — the AI never builds on its own).
  · **Ingest:** "✨ Explain this error" — appears only when an ingest/preview
    error actually exists, right next to it.
  · **Harmonize:** "✨ Propose a clean/join" in the section-title row.
  · **Validate:** "✨ Explain suggested checks" (with profile suggestions) or
    "✨ Suggest quality rules".
  · **Publish:** "✨ Suggest measures" before the Sharing section.
  Same governed, audited, cost-capped assistant model underneath — only the UX
  moved into the flow.

### Added
- **Two-path dataset creation.** "+ New dataset" now opens a calm chooser first:
  **📥 Ingest new data** (bring a file/extract in — raw Bronze) or **🔗 Create a
  curated dataset** (combine existing governed datasets you can read into one new
  joined dataset — names it, then guides you to the Harmonize join builder). The
  long-planned split, finally first-class; `origin: 'curated'` is recorded
  nil-safely (no migration, byte-stable yaml for existing records).
- **Dataset rename is now discoverable** — the bare ✎ pencil glyph next to the
  name is a labelled "✎ Rename" button (the physical table slug stays stable, as
  before).

## [os-ui 0.6.27] — 2026-07-31

### Added
- **Business Processes: link Data & Metrics to a process.** The workflow detail
  gains a "Data & Metrics" tab (count badge): link governed datasets and metrics
  as calm chips (name + My/Domain/Company scope badge) that deep-link to the
  artifact (`?focus=<id>`), with a viewer-scoped picker; owner/editor manages,
  viewers read. Ids are re-resolved through the same canView guards as the
  Data/Metrics tabs (non-visible ids silently dropped — no existence leak);
  stored nil-safe (`links: {datasets, metrics}`, no migration) and included in
  the PDF export (fail-soft name resolution).

### Changed
- **Business Processes renames (display only):** "Tacit" → **"Expert
  Knowledge"** and "Rules" → **"Business Rules"** across the tab (detail tabs,
  panels, step inspector, empty states, PDF export). Internal enums/fields/MCP
  params (`tacit`, `rules`) stay stable per the OS display-rename convention.

### Fixed
- **Metric Preview no longer fails with "SQL comments are not allowed on the
  query path".** The pre-save preview (`previewTrinoSql`) prepended a two-line
  `--` comment header to the generated SQL, which the governed query guard
  rightly rejects — so every pre-save preview (even a plain count) failed. The
  executed SQL is now comment-free; the guard is untouched; the "Drop to SQL"
  display keeps its explanatory comment. Test-pinned (the preview SQL must
  contain no `--`/`/*` and equal the SQL that actually ran).

## [chart+ops] — 2026-07-31 (afternoon)

### Fixed
- **Cube memory revert closed for good:** Helm v4 SSA upgrades conflicted with
  the live kubectl hot-fixes and one upgrade reverted Cube to 768Mi (OOM
  crash-loop again). Cube's 1Gi/4Gi is now pinned in the RELEASE's user values
  (`--set`, persisted) as well as the chart, and PVC sizes match live reality.
- **Forgejo cleanup cron actually live:** Helm v4 `--reuse-values` did not
  surface the new chart-default `cron.cleanup_packages` into the release;
  applied explicitly via `deploy/forgejo-cron.values.yaml` (`-f`, persisted) —
  verified in the running pod's `app.ini` (reclaim on boot + nightly, >7d).
- Re-materialized cohort dataset gold repair path documented: a Builder+ opens
  the dataset → Edit data stages → Harmonize → Rebuild (auto-refreshes the
  domain table); the MCP `rematerializeOnly` arg needs a fresh MCP connection
  (stale-manifest landmine).

## [os-ui 0.6.26] — 2026-07-31

### Added
- **App-build registry prune — the Forgejo registry stays near-flat instead of
  growing forever.** Every generated CI workflow (both the `apps.ts` template
  seeder and the vite-os/sovereign-app scaffolds) now ends with a FAIL-OPEN
  "Prune old registry versions" step: after a successful image push it lists the
  app's container versions via Forgejo's packages REST API (same host + same
  `REGISTRY_PASS` as the push) and deletes everything older than the **newest 2
  immutable SHA tags**, never touching the protected `latest` the runner pulls.
  JSON is parsed with `node` (the ci-builder job image is node:20 — jq is not
  installed there), and any failure only warns — a prune failure can never fail
  a green build. The pure policy (`containerVersionsToPrune`, keep-N=2) is
  unit-tested, and both generated steps are executed end-to-end in tests against
  a stubbed registry. This is the app-side half of the fix for the Forgejo
  volume filling up (the accumulated `/data/packages` images that broke all
  Software-tab builds); the chart-side half is the `cron.cleanup_packages`
  below. Existing app repos keep their old workflow until their next scaffold;
  the Forgejo cron covers them.

### Verified
- **Domain isolation re-audited across Agents · Software · Dashboards ·
  Science:** all four tabs already narrow My + Domain tiers to the ACTIVE domain
  (`session.domains` via `resolveDomainScope`) for every role including admin,
  with Company/Marketplace intentionally tenant-wide; 17/17 domain-scope tests +
  737/737 tab tests pass. No leak found; no code change needed.

## [chart] — 2026-07-31

### Added
- **Forgejo package-cleanup cron** (`[cron.cleanup_packages]`: daily @midnight +
  at start, reclaim blobs unreferenced >7 days) so the in-cluster registry
  self-manages — the durable chart-side fix for the registry filling
  `gitea-shared-storage` (95% full → docker-push 500s → every app build red).
  Takes effect on the next Forgejo pod restart.
- **Forgejo disk-usage alert CronJob** (`forgejoDiskAlert.*`, default off):
  hourly read-only `df` on the Forgejo pod's `/data`; ≥80% → WARN log + email
  via the in-cluster mail smarthost (log-only when no mail host). Turns the
  silent disk-full failure mode into a heads-up.
- PVCs expanded live (recorded here for ops history): `gitea-shared-storage`
  2→20Gi, `ci-runner-data` 1→5Gi.

## [chart] — 2026-07-30

### Fixed
- **Cube memory raised 768Mi → 4Gi (limit) / 1Gi (request) — the real cause of the
  "wrong metric numbers".** On the live cluster the Cube pod was `OOMKilled` in a
  CrashLoopBackOff (884 restarts over 3.5 days) at the old 768Mi limit, so
  `/cubejs-api/v1/meta` never came up and EVERY metric silently fell back to the
  fabricated offline-mock (the ~286,936 hash noise). Cube.js (Node) holds the whole
  schema + query plans in-heap, so 768Mi is far too small for a real cohort schema;
  the node has ~107 GiB allocatable. Patched live and persisted in
  `charts/sovereign-agentic-os/values.yaml` so a future `helm upgrade` can't
  re-introduce the OOM. After recovery a Northpeak metric resolved to a real number
  with `mode:"live"`. (Pairs with the os-ui 0.6.24 honesty gate, which independently
  guarantees an unreachable Cube can never again show a fabricated number.)

## [os-ui 0.6.25] — 2026-07-30

### Changed
- **Data stages are now voluntarily skippable, each clearly described, with a data
  preview on every stage.** (1) No stage hard-gates navigation any more — you can jump
  straight from Bronze to Publish without building Silver/Gold first (a single-table or
  pass-through Gold is legitimate; not every dataset needs cleaning or a join). The ✓
  stays honest: `completed()` still reads real layer state, so a skipped stage is simply
  left unchecked, never faked. (2) Each stage's description says plainly what it does and
  flags the refinement stages as optional. (3) The governed 50-row **Data preview**
  (the one that was only on Bronze/Silver) now appears on **Gold, Validate and Publish**
  too — one reusable block reading the highest built layer through the governed Trino
  path. (`lib/data/stages.ts`, `components/data/DataBuilder.tsx`; stages test updated.)
- **A published dataset opens in a calm PREVIEW + TALK-TO-DATA landing**, not the
  builder. A dataset shared to the Domain (asset) or certified to the Company (product)
  now lands on a preview + Talk-to-Data view (with its connected metrics/dashboards/agents)
  — because most people want to USE it, not rebuild it — behind a prominent **"✎ Edit
  data stages"** button (top-right) that opens the full 5-stage builder, with a "← Done
  editing" way back. Personal/unpublished datasets open in the builder as before.

## [os-ui 0.6.24] — 2026-07-30

### Fixed
- **Metrics never fabricate a number again — an unreachable Cube is an honest
  outage, not a made-up KPI.** Diagnosed from the "metrics return absurd values"
  report (a count on a 40-row Product table returned ~286,936). Root cause: it was
  NOT a join fan-out — the generated Cube schema is correct (`COUNT(*)` over one
  table, no joins) and real Trino counts 40. The metric explorer's resolver
  (`exploreMetric`, `lib/metrics/build/explore-server.ts`) probes Cube via
  `liveMetricsReachable()`, and when Cube is unreachable it fell back to an
  **offline-mock that fabricates the value by hashing** the member+region
  (`hash % 90000 + 10000` per region, summed over DE/FR/US → the ~287k figure).
  On the live cluster Cube was unreachable, so every metric showed hash noise
  presented as real. Now, on a real deployment (`OS_PROFILE ≠ local`), an
  unreachable Cube returns `mode: 'unavailable'` with **no number** (rows: []) and
  a clear "metric temporarily unavailable — the semantic layer is unreachable"
  notice, wired through the client `ExploreResult` type and the explorer UI. The
  offline-mock stays ONLY on the local/laptop teaching flow (no cluster), where a
  demo value is legitimate and clearly labelled. (The separate infra task — why
  Cube is unreachable on the cluster — is tracked apart; this change guarantees a
  fabricated number can never be shown as a KPI regardless.)

## [data-runner] — 2026-07-30

### Changed
- **DuckDB removed from the ingest service — one query engine (Trino) for the whole
  sovereign stack.** The data-runner was the last place DuckDB lingered (it read the
  uploaded file to infer the Bronze schema). The reader is now **PyArrow** (already a
  PyIceberg dependency), and `duckdb` is dropped from `requirements.txt` and the image.

### Fixed
- **Bronze is now truly RAW — no automatic type coercion on CSV upload.** A CSV
  column of `yes`/`no` was being auto-converted to boolean `true`/`false` in the
  Bronze Iceberg table (also `40`→bigint, `2024-01-01`→date), silently rewriting the
  user's data — DuckDB `read_csv_auto()` inferred types from the text. The PyArrow
  reader forces **every delimited-text (CSV/TSV/TXT) column to string** (raw landing;
  values preserved literally), while Parquet/JSON keep their real embedded types
  (typed source formats). Type conversion becomes an explicit, opt-in step in Silver,
  never guessed in Bronze. (`images/data-runner/app.py` `_read_to_arrow`;
  `test_bronze_raw.py` proves yes/no stays string and DuckDB is absent, against the
  real PyArrow engine.)

## [os-ui 0.6.23] — 2026-07-28

### Fixed
- **A failing CI is now loud in Test + Publish — no more "looks complete" while the
  app is frozen on an old release.** The honest-pipeline derivation force-greened
  EVERY stage for a live app (a fix for stale/cached CI status) — but it also
  force-greened a genuinely `failing` "Build image (CI)" stage, so an app whose
  latest build broke still showed "Build & deploy complete," all green, in both
  stages (the exact "looks good until I open the app" trap). Now a live app's
  stages are still shown complete when the CI status is merely pending/stalled
  (benign reconcile-lag), but a genuinely **failing** stage stays red and both
  Test and Publish show: "The latest build FAILED — the app is live on an EARLIER
  release, so your recent changes are NOT deployed. Fix the build error and
  re-commit: Build image (CI)." Shared derivation, so the two surfaces still agree.

## [os-ui 0.6.22] — 2026-07-28

### Changed
- **A built story page can no longer be left unwired — the section registry is now
  auto-generated.** A `sovereign-app`'s nav is driven by `src/template/sections.tsx`;
  previously the build agent had to hand-edit that central file per story and did so
  unreliably, so a written-but-unregistered page was invisible ("builds fine, no
  feature shows"). Now, on every commit, the OS deterministically regenerates
  `sections.tsx` from the committed page files under `src/epics/<epic>/<story>/`
  (`lib/software/sections-registry.ts`, wired into `commitToApp`) — one top-level
  PascalCase page component per story folder becomes one nav section. Sovereign-app
  only; a no-op for other templates; fail-open (never blocks a commit). The build
  directive now tells the agent to just write the page (registration is automatic;
  don't hand-edit the generated file).

## [os-ui 0.6.21] — 2026-07-28

### Fixed
- **The intermittent "commit → App not found" (and the same class of false
  not-found across every durable-mirror-backed store) is fixed.** The mirror's
  by-id read (`osMirror.getDoc`, `lib/infra/os-mirror.ts`) treated a TRANSIENT
  OpenSearch failure (5xx / auth blip / timeout-with-response) the same as a
  genuine 404 — so a momentary hiccup on an app lookup surfaced as "App not
  found," blocking a real `commit` mid-build (seen in the Software build log).
  `getDoc` now distinguishes: a genuine 404 or an unreachable cluster returns
  null immediately (offline-degrade, unchanged), but a transient non-404 error is
  retried a few times before giving up. Still never throws — the module's
  graceful contract is preserved. Benefits apps, data, connections, bigbets, and
  every other store on the shared mirror.

### Fixed
- **Generated apps no longer fail to build when the agent uses common UI
  components.** Diagnosed on a live app whose Forgejo CI was silently failing —
  the build had written a story page importing `Alert` and `Spinner` from
  `@sovereign-os/ui`, but the vendored package didn't export them, so the app
  never compiled and the live URL stayed frozen on an old release (the app looked
  "live" but showed no stories). Fixes:
  - **Ship `Alert` + `Spinner` in the vendored `@sovereign-os/ui`** (`lib/app-ui/`,
    now vendored into every generated app) so agent-written pages that use them
    compile. Added the `sb-spin` keyframe to the theme.
  - **The build directive now enumerates the EXACT `@sovereign-os/ui` exports**
    and forbids importing anything else (Modal/Dialog/Tabs/… → a compile break),
    with the correct patterns for Alert/Spinner/Textarea/Select — so the agent
    stops inventing components.
  - **The build directive now requires registering each new story page in
    `src/template/sections.tsx` in the SAME build run** — an unregistered page is
    invisible ("builds fine but no feature shows"), which was the other half of
    the "no user stories in the UI" report.

## [os-ui 0.6.19] — 2026-07-28

### Fixed
- **Agent graph: supervise arrows between agents can now be removed.** The graph
  canvas let you delete explicit handoff/supervise edges, but a *derived* supervise
  arrow (auto-drawn from a supervisor's `members`) had no remove control and ignored
  the Delete key, so there was no way to un-wire a supervisor from a member on the
  canvas. Editable graphs now show the `×` on every arrow (and honor Delete) —
  removing a derived supervise arrow drops that membership (the `edges[]` entry AND
  the `members[]` entry, via the existing `removeEdge`). View-only graphs are
  unchanged (no remove control).

## [os-ui 0.6.18] — 2026-07-28

### Fixed
- **Generated-app SSO to the OS now actually completes** (was still failing with
  "The OS could not be reached … Load failed"). Root cause: the OS middleware
  applied credentialed CORS to `/api/*` — but `/api/auth/me`, the endpoint the app
  SDK's `os.whoami()` hits FIRST, sits in the always-public early-return that ran
  BEFORE the CORS block, so that one response carried no `Access-Control-Allow-Origin`
  and the browser blocked the cross-origin whoami. CORS is now computed first and
  applied to every governed surface including the public auth routes (preflight
  answered uniformly). Server-side fix — existing deployed apps start working after
  this rolls out, no rebuild required.

### Changed
- **#146 — governed datasets now enroll in the analytics-as-code mono-repo on
  promotion.** Promoting a dataset (Personal→Domain) marks it `gitBacked`, so the
  existing promote hook records its **dbt model + `schema.yml`** in the `analytics`
  Forgejo repo alongside the Cube model + dbt exposures it already wrote. The runtime
  governed CTAS is unchanged — these are the version-controlled, review-able mirror
  (the source OpenMetadata ingests for lineage).

## [os-ui 0.6.17] — 2026-07-28

### Added
- **Delete controls across the Software Design stage**, each behind the OS-standard
  confirm dialog (matching the archive/delete UX everywhere else):
  - **Delete EPIC** — a whole epic (cascading its user stories + specs) was
    previously impossible to remove in the one-epic detail view; now a danger
    button in the epic's Edit mode, gated by a confirmation.
  - **Delete user story** — the existing remove now confirms first (names the
    story + warns its spec goes with it).
  - **Delete feature / requirement / rule** — each spec item's remove now confirms
    (names the item) instead of deleting on a single click.

## [os-ui 0.6.16] — 2026-07-28

### Fixed
- **Design-stage assistant now creates EPICs & user stories again** (was returning
  a wall of "poorly formatted markdown" with no suggestion cards). Root cause: the
  Design/Test assistant runs on the reasoning model, which routinely wraps its JSON
  in a sentence of preamble or a trailing note; the route's parser only stripped a
  code fence then did a naive `JSON.parse`, so any surrounding prose failed the
  parse and the whole reply fell back to the raw blob with zero structured
  suggestions. Added a tolerant `parseJsonReply` (shared `lib/assistant/json-reply.ts`)
  that recovers the first balanced `{…}` object from within prose — the "Create
  EPICs" / "Add stories" / spec cards fire again and the visible message is the
  model's own clean markdown.

### Changed
- **App context grants now default to Read (read-only)** — a newly granted
  connection/data/knowledge/file/metric starts read-only (the safe default); the
  user raises an individual item to Read+propose / Read+write when it actually
  needs write access. The write ceiling is unchanged (builders may still grant
  writes), only the starting value is safer.

## [os-ui 0.6.15] — 2026-07-28

### Fixed
- **Archiving or deleting a software app now tears down its MCP/API connection**
  — no more orphaned connection lingering in the Connections tab (e.g. "KIEKERT
  NACHVERHANDLUNGS-COCKPIT MCP" surviving its app). The cascade already dropped
  the grant on `archiveApp`/`deleteApp`, but two gaps kept the connection alive:
  (1) the boot **re-hydrate re-registered every app's connection without checking
  status**, so an archived app's MCP (and its OPA grant) came back on the next pod
  restart — `rehydrateConnection` is now the single authoritative guard and never
  resurrects an archived app; (2) `/api/connections/apps` **listed archived apps'
  connections**, now filtered out. Restore is symmetric: `unarchiveApp`
  re-registers the connection so it reappears immediately (not only after a
  restart). Deleted apps already drop out of the list. Security-relevant: an
  archived app is no longer silently callable again after a restart.

## [os-ui 0.6.14] — 2026-07-28

### Fixed
- **Generated-app SSO to the OS now works** (was failing with "The OS could not
  be reached: JSON Parse error: Unrecognized token '<'"). Root cause: nothing
  baked the OS URL into app builds, so the app's `whoami` hit its own origin and
  got HTML. End-to-end fix: (1) the app image build now receives
  `--build-arg OS_API_URL=<OS_PUBLIC_URL>` (injected server-side into the seeded
  CI at scaffold time); (2) the OS **session cookie is scoped to the shared
  parent domain** so app subdomains carry it (host-only fallback when there's no
  safe shared parent — never a bare TLD, OS login unaffected); (3) **CORS** now
  allows the OS origin + `*.<appsDomain>` with credentials (never `*`); (4) the
  app SDK **fails honestly** on a non-JSON/HTML response (clear "sign in to the
  OS" instead of a `JSON.parse` crash), with a runtime OS-origin fallback derived
  from the app host. **Existing apps must be rebuilt** to bake the URL; until
  then they fail honestly rather than crash.

## [os-ui 0.6.13] — 2026-07-28

### Fixed
- **Strict domain isolation across every tab.** Each artifact tab now groups by
  visibility (Personal→My, Shared→Domain, Certified→Company) and narrows ALL
  three tiers to the domain you're acting in — for every role including owner
  and admin (previously `canView`/ownership and some admin special-cases
  bypassed the narrowing, leaking agentic-leader datasets/metrics/big-bets into
  kiekert, and grouping an owned Shared agent under "My" instead of "Domain").
  A domainless/unassigned artifact still shows (assign it via the domain-move
  tool). The **Marketplace catalog stays cross-domain** — it is the single
  adoption surface: publish to Company → it lists in the Marketplace → another
  domain adopts it → it appears under that domain's Company tier. Fixes span
  agents, data, metrics, dashboards, files, knowledge (workflows + personal),
  science, connections, big bets, and software.

### Added
- **Metrics tab: multi-select + bulk archive.** Per-row checkboxes + a bulk
  action bar to archive the selected metrics (confirm-gated, honest per-item
  result). Bulk cross-domain move is intentionally not offered — a metric
  inherits its dataset's domain (move the dataset in Data).
- Test coverage for the Operating Model MCP write tools (`update_operating_manual`
  et al. already shipped; a stale MCP connection is why they weren't visible —
  reconnect the connector to pick them up).

## [os-ui 0.6.12] — 2026-07-28

### Added
- **Superadmin cross-domain artifact move** (Admin only, audited). Platform
  admins can reassign an artifact's domain and bulk-assign every UNASSIGNED
  artifact to a chosen domain, from the Domains admin page (type-to-confirm on
  the bulk op). Covers all primary artifact kinds — datasets, dashboards,
  files, workflows, personal knowledge, agents, science models, pillars, big
  bets, connections, apps, and the base artifact store — persisting through each
  store's durable mirror (datasets/files also update the yaml-embedded domain
  and repoint the domain read-grant). Metrics move transitively with their
  dataset. Creator/builder/domain_admin are denied (403); every move is written
  to the OS audit log.

## [os-ui 0.6.11] — 2026-07-28

### Changed
- **Software tab — refinement lifecycle across Test · Design · Build.** A Test
  "Verify & Improve" finding is now a tracked refinement with a visible
  **Proposed → Designed → Built** state, shown as the SAME list in all three
  stages (dimension-tagged). Per-item **Design** (reasoning drafts the spec and
  shows it), then **Build** (standard) → Built (stays visible), with the
  design-before-build gate; plus **Design all** / **Build all** (8-cap) and a
  **Design & Build** accelerator. Fixes the old dead-end where refinements never
  reached Design.
- **Generated apps are structured by epic/story.** Scaffolds emit
  `src/template/` (fixed), `src/core/` (shared), `src/epics/<epic>/<story>/`
  (per-story code), with thin entrypoints; the build writes each story's code
  into its folder. Build now injects **5 build principles** (aligned to the Test
  dimensions), and **Test verifies across 5 dimensions** — Functionality · User
  Experience · Code Structure · Security · Documentation.
- **Build/Deploy show live progress** via the core `ProgressStepper` (Plan →
  Generate → Commit → Preview for build; Scaffold → … → Live for deploy), so a
  running build/go-live is visible, not a silent flip. Developer view moves the
  BUILD/DEPLOY console to the top full-width, code below.
- **"Connect your AI Tool via MCP" button** is now a prominent gold pill in the
  topbar (was near-invisible).

### Added
- **Software MCP mirrors the five governed stages** — `create_software`
  (Define) · `design_software` (Design) · `build_software` (Build, enforces the
  design-before-build gate + standard tier + epic/story folders) ·
  `verify_software` (Test, 5-dimension) · `request_deploy`/`decide_deploy`/
  `promote` (Publish). Every tool wraps the same governed server function the UI
  uses. Raw `commit` becomes a **developer-mode escape hatch, role-gated to
  builder+** and labeled as bypassing the staged governance.

### Fixed
- **Domain-scoping is now universal.** "My" (and Shared) artifacts narrow to the
  domain you're acting in across dashboards, science, agents, Strategic Pillars,
  Big Bets, Connections, the base artifacts store, and software; Company/
  Marketplace stays tenant-wide; "All Domains" shows everything. (Folders +
  data/files/metrics already did; Operating Manual + Workflows were already
  correct.) Display/scoping only — no artifact ever crossed a domain boundary.

## [os-ui 0.6.10] — 2026-07-28

### Fixed
- **Folders are now domain-scoped.** Switching the active domain diverges the
  folder tree across every tab (files · knowledge · data · metrics). The
  personal read path now honours the existing `FolderNode.domain` (list, path
  lookup, and cascade key on `(owner, domain)`); new folders are stamped with
  the domain you're operating in; "All" (no active domain) shows everything, as
  the artifact lists do. Knowledge's personal "mine"/"domain" lists are narrowed
  the same way (Marketplace stays tenant-wide). This was a display-only issue —
  artifact CONTENTS were already correctly domain-filtered, so no data crossed a
  domain boundary. Migration-free: existing folders keep their stamped domain.
- **Consistent, honest pipeline status across Test and Publish.** Both stages now
  read ONE shared derivation (`derivePipelineView`): a live, serving app (deploy
  state `live` + a shipped release) shows every upstream stage complete in BOTH
  surfaces — a running pod provably built, published and deployed — so a live app
  no longer shows "Build image (CI) did not complete" in Test while Publish is
  green. A genuine failure now surfaces the SAME marked, named stage in both
  (Publish no longer hides a real failure behind a green badge). Non-live apps are
  never force-greened.

## [os-ui 0.6.9] — 2026-07-28

### Changed
- **Software tab redesigned into five single-purpose stages** — Define ·
  Design · Build · Test · Publish, each owning exactly ONE function and ONE
  assistant. Define carries a 4-template picker (Sovereign **Application** —
  OS-session sign-in + Admin section + user directory — as the default).
  Design is the reasoning-tier home of ALL planning: one epic at a time
  (prev/next), read-first with an Edit toggle, assistant-left / epic-right,
  each user story expanding to its Features · NFRs · Rules spec.
- **Build is standard-model execution only.** A hierarchical Epics › Stories ›
  Features tree with capped batch selection (8 features), a selection checkbox
  distinct from a green done-✓ status, an always-visible spec with an honest
  built-vs-pending detail (an item is built only once its story commit lands —
  never fake-ticked), and a design-before-build gate (unspecced features are
  not buildable). Full Define context grounds every generation.
- **Test replaces Preview**: one "Verify & Improve" action (reasoning tier)
  verifies each built story against its spec and turns shortfalls into pending
  Build to-dos (missed-spec → rebuild; scope change → routed back to Design),
  while keeping the live-pod preview. **Publish replaces Operate** (deploy,
  review card, promote/demote, MCP surface, lifecycle).
- **Per-stage model tiers**: reasoning for Design and Test, standard for Build
  code generation (never auto-escalated). Honest tier badge per stage.

### Added
- **Agents tab — in-tab Trigger for API-mode systems.** Systems whose trigger
  mode is `event` get a first-class "Trigger now" affordance (optional input +
  result), available to in-domain consumers of a Shared system — driven by a
  server-computed `canRun` so authorization stays server-authoritative.
- **Connect your AI tool — Codex is now a first-class path** (above ChatGPT):
  short copy-paste setup (`launchctl setenv` + `codex mcp add
  --bearer-token-env-var`) with the full setup, verification and
  troubleshooting in an expandable detail. Token stays out of the config and
  out of any Codex chat.

## [os-ui 0.6.8] — 2026-07-27

### Changed
- Software tab is now one coherent conversational product: the StageConversation
  primitive (context header · structure twin · scoped thread · outcome sink)
  now composes Define, Design, Preview, and Operate — each stage owns exactly
  ONE scoped assistant, redundant shell-level assistants removed. Completes the
  "the assistant is the flow, not a stapled-on addon" recomposition begun in
  the Build stage.

## [os-ui 0.6.7] — 2026-07-27

### Added
- Agents: writes whose target is the owner's own "My" scope now execute
  DIRECTLY (no approval) under both read+write and Write-approval — approval is
  reserved for Domain/Company targets; another user's personal space stays
  unreachable by construction. Metrics is now an agent-grantable write
  capability (define_metric). Run reports state write outcomes prominently
  ("wrote N to My Data" / "N awaiting approval → Governance → Inbox").
- Standard-first cost routing: validated LLM surfaces (suggest_metrics, DQ
  propose, NL→SQL, structured stage assistants) run the standard tier first and
  escalate to reasoning only on validation failure — one admin toggle; traces
  attribute to the model that answered.
- Admin Models & Providers: catalog split into "Managed AI (STACKIT)"
  (not removable) and "Added by administrators" (removable, with reference
  safety listing role-pin/fallback usages before deletion). Master key never
  leaves the server.
### Changed
- Software Build stage recomposed as a one-epic-at-a-time journey: an ordered
  epic checklist with honest per-epic state, a single conversational surface
  (new reusable StageConversation primitive) replacing three stapled-on
  assistant boxes, epic-scoped and human-readable (markdown) chat, visible
  build outcomes, and the real deployed-pod preview (esbuild-wasm InstantPreview
  removed).
### Fixed
- LiteLLM now has a fallback chain (sovereign-default/mock → premium, reasoning
  → reasoning-fast) so a provider rate limit fails over instead of failing a
  student's agent run.

## [os-ui 0.6.6] — 2026-07-27

### Added
- Repair mode for materialization drift: `rematerializeOnly: true` on the gold
  build (route + build_gold_join MCP tool) re-runs just the publish CTAS for an
  already-promoted dataset — heals missing/stale domain tables without
  re-specifying the gold spec. Builder+ only.

## [os-ui 0.6.5] — 2026-07-27

### Fixed
- Promotion materialization (the "single-column dashboard" bug): approving a
  promotion now ALWAYS materializes the physical domain table, and rebuilding
  a promoted dataset's gold re-materializes the domain copy automatically
  (Builder+; creators get an honest "stale" state instead). Pre-existing
  promotions whose CTAS never landed can be healed by re-running the gold
  build. New domainTableStale flag tracks drift honestly.
- Silent dimension loss is gone everywhere: panels whose group-by dimension is
  missing from the served Cube model now show an inline warning naming the
  member and remedy (never a silently un-grouped single bar); chart creation
  with unknown members creates-with-flag or reports rejection (never silent
  discard); the Design assistant can propose dimensions; the dashboard palette
  falls back to the dataset's real gold dimensions when Cube isn't serving the
  view yet; metrics explorer surfaces dropped slice members.

## [os-ui 0.6.4] — 2026-07-27

### Added
- Data Validate stage: run all defined quality checks directly, see per-rule
  pass/fail with sampled failing rows, and get AI-PROPOSED REMEDIATIONS —
  batch fixes (one previewed transformation for a whole failure class) or
  per-row fixes, in a table with per-row Accept / manual edit / Skip plus
  "Apply AI recommendations" and "Apply N accepted changes". Fixes apply via
  governed MERGE under the caller's identity with a remediation batch id and
  pre-apply snapshot recorded; the rule re-runs after apply and stays red if
  the fix didn't fix. LLM-generated expressions pass a strict scalar-expression
  validator — never raw SQL. MCP parity: propose_quality_fixes /
  apply_quality_fixes. Per-row fixes require a documented key column (never a
  guessed one).
- Metrics Define: a real free-text goal input (the assistant previously
  received a hardcoded goal), a grouped dataset picker with layer badges and
  deliverability warnings, an assistant that finally sees column types + docs,
  and "Suggest metrics" — candidates grounded in Strategic Pillars, the
  Operating Model, and Business Processes, each pre-filling the editor with
  the narrowest right dataset. Honest grounding banner when pillars/OM are
  undefined. MCP parity: suggest_metrics.
- Row/column statistics now shown identically on raw, silver, AND gold data
  previews (one shared implementation).
- MCP discoverability: approved synonym aliases on every tool family's primary
  verbs (KPI/measure→metric, BI/report→dashboard, SOP/business workflow→
  business process, project→big bet, north star→pillar, Google/Microsoft/AWS/
  Snowflake/Databricks→connection, ETL/refresh→sync, …) + a collision lint
  test guarding alias uniqueness across families.
### Changed
- "Workflows" is now displayed as "Business Processes" everywhere user-facing
  (nav, pages, guides, tutorials, PDF export, MCP descriptions). Internal
  routes, ids, and MCP tool names unchanged.

## [os-ui 0.6.3] — 2026-07-27

### Added
- MCP parity for the scheduled-sync engine: `set_dataset_sync` (configure
  "keep in sync" with the same per-source mode/cursor locking the panel
  enforces — Kajabi/Salesforce cursors auto-locked, cursorless resources
  honestly refuse incremental), `sync_dataset_now` (manual/reset trigger,
  verbatim run record, honest lease-skip), and `get_sync_status` (config,
  run history, watermark, quarantine, next scheduled run) — all through the
  same governed store gates as the HTTP routes. Data tab MCP context/guide
  now teach the keep-in-sync path.

## [os-ui 0.6.2] — 2026-07-26

### Fixed
- Metric Preview (#142 close-out): the live diagnosis proved the metric→Cube
  sidecar sync WORKS (~10s end-to-end); the real gap was the pre-save Preview
  querying Cube for a member that cannot exist yet. Unsaved drafts now preview
  via a governed Trino SQL query under the viewer's own identity (honestly
  labelled "live (sql)"); the Cube-served value takes over after Publish.
  Rolling-window shapes state honestly that they have no pre-save preview.
- Metric build `reload()` no longer pings /meta and calls it done — it awaits
  actual schema delivery (bounded ~12s) so builds report delivered vs syncing
  truthfully.
- Cube schema refresh (`schemaVersion`) no longer silently disappears when the
  SQL API is disabled; the model-sync sidecar now prunes models for deleted
  datasets (after successful fetches only) and logs a heartbeat.
- Views for measure-less datasets expose the promised `count` fallback.

## [os-ui 0.6.1] — 2026-07-26

Deferred-hardening release: everything the 0.6.0 audit consciously postponed,
plus same-day fixes for user-reported issues.

### Security
- query-tool and data-runner accept an optional shared service-bearer token
  (chart-generated Secret, constant-time check, opt-in `serviceBearer.enabled`,
  health endpoints open) — network reach alone no longer equals identity.
- User-app pod manifests now assert `runAsNonRoot`; scaffolds emit numeric
  image UIDs (kubelet can't verify names); the live app was rebuilt through
  the governed pipeline and the apps namespace targets Pod Security
  `restricted`.
### Changed
- ~276 API route handlers migrated onto one `withRoute()` wrapper (auth →
  parse → error envelope; per-route status defaults preserved byte-identically;
  ~2,900 lines of hand-rolled boilerplate removed). The security tripwire now
  sweeps the whole route tree: every route must be guarded or on an explicit
  unauthenticated-by-design list. Streaming/OAuth/auth-boundary/protocol routes
  deliberately stay hand-rolled.
- `globals.css` (6,629 lines) split into `app/styles/*` with byte-identical
  emitted CSS (proven by build-output diff).
- Science tab now honors the domain's Science layer (hidden when explicitly
  off; fail-open on unknown); "ML layer" renamed to "Science layer" in the UI
  (internal keys unchanged).
### Fixed
- LLM Gateway "Budget (weekly)" no longer shows a fake $0: it reports real
  7-day EUR spend from the same traces and prices as Monitoring, with honest
  states for unpriced models, unreachable telemetry, and unset budgets.
- Embedded tools: consoles whose SPAs load root-absolute assets (Langfuse and
  Dagster are Next.js apps whose `/_next/*` chunks collided with os-ui's own
  `/_next` behind the `/tools/<key>` prefix and 404'd → blank iframe under the
  overlay header) no longer render an empty frame. The tool registry now carries
  per-tool `ownTab` metadata; such tools (Langfuse, Superset, Dagster,
  Featureform, and WebSocket-bound JupyterHub — previously raw 501 JSON) show
  the Tier-2 "opens in its own tab" card with the tool's own console link.
  Verified-working embeds (MLflow, Cube — relative asset URLs — plus Forgejo and
  LiteLLM) are untouched. New `GET /api/tools/[tool]` reports the embed mode,
  guarded identically to the proxy route (session + per-tool role gate).

## [os-ui 0.6.0] — 2026-07-26

Whole-codebase audit + refactor release (six parallel audits: architecture, security,
dependencies, dead code, docs, tests). No feature changes; structure, security and honesty.

### Security
- Connector egress is deny-by-default for in-cluster targets (bare hostnames, `*.svc`,
  `*.cluster.local`, `localhost`, `::1`, `fe80::/10`) — closes a server-side request
  forgery path from user-supplied connector endpoints; internal hosts now require an
  explicit allowlist entry.
- User-deployed app pods hardened (caps-drop, no privilege escalation, seccomp) and the
  apps namespace gets Pod Security `baseline` + default-deny NetworkPolicies; app scaffolds
  now build non-root images (`nginx-unprivileged`, `USER node`).
- query-tool and data-runner accept ingress only from os-ui; query-tool `/query` enforces
  read-only single statements.
- Client-supplied `viewerRegion` is honored only for admin view-as; live RLS context
  otherwise derives from the session.
- Removed a stale tracked script copy that carried a hardcoded exercise credential
  (credential rotated).
### Changed
- Shared auth boundary (`requirePrincipal`/`errorResponse`), `edit-scope`, and `cron-util`
  lifted to `lib/core` (re-export shims keep all imports working); dataset-schema consumed
  via the `lib/data` index; the two 2k-line MCP tool files split into 19 per-domain modules;
  `app/` pages organized into route groups mirroring the sidebar (URLs unchanged);
  scope/tier/folder helpers consolidated into `lib/core`.
- ARCHITECTURE.md rewritten to the four-ring model (core · infra · tabs · shared services)
  with a verified module and API-directory map.
### Removed
- ~3,700 lines of dead code: 30 unreferenced files (old monitoring drawer, pre-redesign
  panels, retired workbench/tool-embed surfaces), 26 dead exports, the orphaned
  workbench-session route and its config keys, unreferenced brand bitmaps, dead Helm values
  keys, unused pip/npm dependencies.
### Fixed
- dbt-ingestion S3 endpoint pointed at removed SeaweedFS; now MinIO.
- `ML_TRAINER_IMAGE` is actually wired from Helm values into the os-ui deployment.
- The `/agents` route no longer eagerly ships a 298 KB font payload (lazy-loaded on PDF export).
### CI / tests
- GitHub CI now runs the full TypeScript suite, all Python image test suites and the
  license gate (previously build-only). +43 targeted tests: session-crypto verification,
  governance approvals route, role floors, sync tenant scoping, connector error paths
  (401/malformed/429 mid-pagination), web-fetch's first tests, data-runner failure modes.
- Broker images get committed lockfiles (`npm ci`); Docker build context slimmed ~50 MB.

## [os-ui 0.5.99] — 2026-07-26

### Added
- **Kajabi connector with scheduled sync** — a new `kajabi-api` connection template (Supported
  Connectors gallery, own vendor stack, install guide) over Kajabi's public API
  (`api.kajabi.com/v1`, OAuth client-credentials from **Settings → Public API**; the ONE vaulted
  credential is `client_id:client_secret`, never on the record). Mirrors the Salesforce shape:
  hand-built never-throw typed client (`os-ui/lib/connections/kajabi.ts`), real health probe
  (token grant + `GET /v1/sites`), resource discovery (curated documented-resource map — the API
  has no describe endpoint), and the **api-batch sync strategy**: JSON:API pages stream to the
  data-runner `/ingest-rows` with `_loaded_at`/`_batch_id` lineage; first load replaces (creates
  Bronze), incrementals delete-by-batch-id + append with deterministic retry windows. HONEST
  per-resource cursors (`os-ui/lib/connections/kajabi-resources.ts`, enforced in SyncPanel + the
  slice runner): only `purchases` has a true update cursor (`updated_at`);
  contacts/customers/orders/form_submissions are created-at-only (new records; edits need a full
  refresh); transactions/offers/products/courses/forms/tags are full-refresh only; deletes never
  detected; Kajabi publishes no rate-limit contract (429s surface honestly). `api.kajabi.com`
  added to the egress allowlists (lib, chart, connector overlay).

## [os-ui 0.5.98] — 2026-07-26

### Fixed
- **CI status now reads the real run outcome.** Software CI badges read the most-recent run result
  from the Forgejo Checks API; a re-run updates the badge without a pod restart.
- **Repo-secret self-heal.** If a required repo secret is missing it is written on the next build,
  removing a class of silent build failures that required manual operator intervention.

## [os-ui 0.5.97] — 2026-07-26

### Fixed
- **Software commits were silent no-ops.** The Forgejo contents-API `PUT` requires the blob's
  current sha for updates; previous writes omitted it, so every commit after the first returned
  422 and nothing was persisted. Writes are now sha-aware (fetch current sha, pass it on update);
  the pipeline surface is honest about the outcome; and a self-heal pass reconciles any apps left
  in a stale state.

## [os-ui 0.5.88–0.5.96] — 2026-07-25

Batch of features shipped across merge commits `fb9b8ae`, `baf0636`, `1a2e54c`, `83f97fb`, `56c4549`
(see individual commit messages for detail).

### Added
- **Native ECharts dashboards (Tier-1).** Replaces the Superset iframe embed with server-rendered
  ECharts panels queried directly from Cube via the governed SQL API (per-user RLS, no `<iframe>`).
  Tier-2 keeps Power BI / Tableau / Superset as external "open in own tab" links. Dashboard build is
  a 5-stage flow (Define · Design · Build · View · Govern) with a per-stage AI assistant.
- **Monitoring truth.** Agent-run token/cost accounting is now hydrated from the live Langfuse trace
  on read (not a cached estimate); detail expands in the main window with rich agent diagnosis;
  per-model EUR/1M pricing is admin-editable in Models & Providers; real STACKIT pricing wired for
  cost display.
- **FiveTran-style scheduled incremental sync (Wave 1 + Wave 2).** Connectors support full-refresh,
  append (`_loaded_at`/`_batch_id` lineage), and cursor-based incremental modes. A durable sync-runs
  store tracks cursor watermarks and quarantines after 10 consecutive failures. Per-dataset CronJob
  provisioning; sync history and stale-downstream hints in the UI; data-runner append mode. Wave 2
  adds query-tool concurrency guards (schema-gated INSERT-SELECT / MERGE / DELETE-by-batch-id /
  expire_snapshots / optimize).
- **Sovereign app template** — the default scaffold for new Software apps: `AppShell` +
  OS-delegated identity + multi-domain scoping + admin/user-directory + MCP link +
  `build-contract` README. Four template options in the Define picker: Application / Website /
  APIs only / Empty.
- **Software Build-stage epic/story tree.** Epics panel left, build chat right, a General
  super-epic; Design · Build · Test · Review actions per story; honest preview shapes
  (no fake "deployed" state); deployed-rollout fix.

## [os-ui 0.5.46] — 2026-07-19

### Added
- **Analytics backfill** (`POST /api/admin/analytics/backfill`, admin-gated) — writes every live
  governed-dataset Cube model + dbt model into the `analytics` git repo and returns exactly what
  landed. This is the prerequisite that makes the #146 "Cube-serves-from-git" cutover safe: git can
  now be verified to hold *all* live cube models (including runtime ones) before the source is flipped.
- **Metrics alert CronJob** (chart, gated `metrics.alerts.cron.enabled`, default off) — schedules the
  builder+ alert-evaluator via a governed service-principal login (no auth bypass), so metric alerts
  actually fire on a cadence.

### Fixed
- **Analytics repo seed reliability** — the seed hook was `post-install` only, so `--set`-only helm
  upgrades never re-fired it, and its `put_file` calls swallowed non-2xx responses (`curl -o /dev/null`
  without `-f`) — the repo silently stayed empty. Now `post-install,post-upgrade`, fail-loud on any
  non-2xx, and idempotent (201/409-tolerant) repo-create.

## [os-ui 0.5.45] — 2026-07-19

### Changed
- **Refactor (#171, behavior-preserving):** the five per-stage tab assistant routes now share a
  `lib/assistant/stage-route.ts` helper (the cost-capped `assistantComplete` wrapper + honest
  503/402 + defensive JSON parse), removing ~90 lines of duplication while keeping each tab's stage
  set and prompts local. Response shapes, status codes, and errors are unchanged. Also swept two
  grep-proven-dead components superseded by the staged-UX rebuild.

## [os-ui 0.5.44] — 2026-07-19

### Changed
- **Every build tab now shares the staged UX** (the Agent-tab 5-stage pattern, via the
  `lib/core/stages` + `StageShell` core primitive) — a consistent numbered-stage flow with
  per-stage guidance, gated navigation, ✓ on genuine completion, and a **per-stage Sovereign-OS
  AI assistant** focused on that stage:
  - **Data** — Define · Ingest · Refine · Publish · Use (the 1114-line single scroll is gone;
    4 dead files retired).
  - **Metrics** — Define · Refine · Preview · Publish · Monitor (NL-first define, promote folded in).
  - **Dashboards** — Define · Design · Build · View · Govern (shipped in 0.5.43).
  - **Science** — Define · Train · Deploy · Predict · Monitor (gated on real `buildState`;
    trainable-task guard; honest drift placeholder).
  - **Software** — Describe · Build · Preview · Publish · Operate (delivery-team chat + build chat +
    editor unified into Build; real scan/review at Publish; live tool surface at Operate).
  Each tab's create→manage screens are now one continuous flow that opens at the stage matching an
  artifact's real state. Existing behavior and the audited P0 fixes are preserved; this is a
  consistent re-skin over correct engines, not a rewrite.

## [os-ui 0.5.43] — 2026-07-19

### Added
- **Staged-builder core primitive.** The Agent tab's 5-stage pattern is now a reusable OS primitive
  (`lib/core/stages.ts` + `components/core/StageShell.tsx`): numbered stepper, entry-gated navigation,
  ✓ on genuine completion (never faked, clears if invalidated), and a per-stage AI-assist slot. The
  Agent tab consumes it with byte-identical behavior; every other tab adopts it next.
- **Dashboards staged UX** — Define · Design · Build · View · Govern, with a per-stage assistant
  (NL→view/charts, embed-failure explainer). Create→view is now one continuous flow.
- **GCP Admin SDK (Workspace directory) connector** — read-only users/groups/org-units/roles/domains
  via domain-wide delegation (companion to the GCP identity connector).

### Fixed (audit-driven P0 wave — verified against the code, not assumed)
- **Software (security):** the deploy security scan now scans the **live repo tree** — editor commits
  and direct git pushes were previously invisible to it, so a pasted secret could ship behind a clean
  "scan passed" card. Also: app tool calls proxy the live app (or are honestly labeled demo data), the
  promised per-app build chat is now mounted, and review cards survive a pod restart (one builder gate).
- **Data:** phantom Bronze (dot lit with no physical table) now lands through the real verify pipeline;
  warehouse import creates a real dataset (its CTAS never actually worked live before); MCP
  `list_datasets` name collision fixed; transform liveness no longer mislabels a Cube outage.
- **Metrics:** alerts are a real monitor (durable rules + live-value resolution + evaluator) instead of
  a hand-typed demo; explore slices derive from the real dataset; honest sync copy + auto-poll; MCP
  gains `preview_metric` + `promote_metric` and `define_metric` surfaces the sync-pending state.
- **Dashboards:** Cube SQL host/port threaded into the bundle (was hardcoded → empty charts); embed
  guest token now refreshes (embeds no longer blank after 5 min); build report is visible; delete
  cleans up the Superset side.

## [os-ui 0.5.42] — 2026-07-18

### Added
- **#146 analytics-as-code, Phases 3–6 (all flagged, defaults = today's behavior).**
  - *Phase 3:* the Cube model-sync sidecar can read models **from the `analytics` git repo**
    (`cube.modelSync.source: git`; default `os-ui`). Fail-soft: Forgejo unreachable → keeps
    last-written models.
  - *Phase 4:* the dbt build Job (and, documented, the Dagster user-code deployment) can
    **clone the repo** instead of using the baked project (`dbt.projectSource: git`; default
    `image`, byte-for-byte fallback on clone failure).
  - *Phase 5:* the seeded CI workflow now **publishes dbt artifacts** (`manifest.json` +
    `catalog.json`) to S3 on push-to-main — exactly where the OpenMetadata dbt ingestion
    expects them (its flip stays off until artifacts flow).
  - *Phase 6:* a promoted dataset **also becomes a git-backed dbt model** — `.sql` (the
    governed CTAS SELECT) + `schema.yml` (column docs) — behind an additive `gitBacked`
    marker (byte-stable for existing datasets; fire-and-forget; the runtime CTAS remains
    the materialization path).
- **#176 connector egress go-live (config).** The cluster egress allowlist
  (`egressProxy.allowlist`) now mirrors the app-side authoritative list — 29 hosts covering
  every built connector (GitHub, Supabase, Atlassian, Slack, Google, Microsoft Graph/Purview/
  AI-Foundry, SageMaker, GCP identity, Snowflake) — mirrored into `values.stackit-managed.yaml`
  plus a self-contained apply overlay (`deploy/egress-connectors-overlay.yaml`). FQDN
  enforcement is tinyproxy-allowlist-based on this cluster, so one values change covers the chain.

### Fixed
- Removed a stray untracked copy of the deleted `admin-console` template that broke
  `helm template` on fresh checkouts.

## [os-ui 0.5.41] — 2026-07-18

### Added
- **Two read-only cloud key-service connectors (#174 Wave 2).**
  - **GCP identity/IAM governance** — lists projects, IAM policy, and service accounts (the Google peer
    of the Microsoft Entra connector). Auth is a GCP service-account JSON key signed into an RS256 JWT
    (dependency-free, Node `crypto`) and exchanged for a short-lived read-only OAuth2 bearer.
  - **Snowflake governance** — reads `SNOWFLAKE.ACCOUNT_USAGE` (users, roles, grants, login/access
    history) via a key-pair JWT to the SQL REST API; distinct from the existing Snowflake *data*
    connector. Honest caveats surfaced: ACCOUNT_USAGE views lag up to ~2h and queries consume warehouse
    credits.
  - Both keep secrets fully server-side (the private key only ever signs — never on the wire), wire into
    the shared `CONNECTION_HEALTH` registry + executors, and ship install guides. **Going live needs the
    cluster egress allowlist mirrored** (`cloudresourcemanager`/`iam`/`admin.googleapis.com`,
    `<account>.snowflakecomputing.com`) — an operator step; connectors fail-closed until then.

## [os-ui 0.5.40] — 2026-07-18

### Changed
- **Strategic Pillars now use the OS's core promotion/demotion mechanic.** Pillars are **created in My**
  by default and promote **My → Domain → Company** via the same shared `PromoteButton` used by Metrics,
  Dashboards, and Science — with **unshare/demote** back down. This engrains demotion as a **core
  mechanic**: a new shared `components/lifecycle/DemoteButton` + `demoteVerb()` in `lib/core/scopes.ts`
  (Strategy is the first adopter; other tabs can converge on it). Server-side `demotePillar` mirrors the
  core artifact ladder (fail-closed; can't demote below My; Company→Domain is admin-only). MCP gains a
  `demote_pillar` tool and defaults `create_pillar` to My. Big Bets are unchanged — a bet inherits its
  parent pillar's tier by containment, so promoting/demoting the pillar moves its bets.

## [os-ui 0.5.39] — 2026-07-18

### Added
- **OpenMetadata ingestion is live.** The native `metadata ingest` CronJob now crawls the bundled
  Trino/Iceberg lakehouse hourly and populates the Catalog (verified: 14 tables + 2 schemas ingested,
  zero auth errors). Fixed the job's securityContext (the `openmetadata/ingestion` image runs as the
  non-numeric `airflow` user, so a numeric `runAsUser: 50000` is required or the pod fails
  `CreateContainerConfigError`). The buggy query-lineage sub-pass is disabled by default (OM 1.13.0
  `DatabaseServiceQueryLineagePipeline` is missing `includeTags`/`overrideMetadata`).
- **Science tab — source dataset is now a file explorer.** Picking the source data product for a model
  is a `FolderTree` browser over all DLS-scoped datasets (reuses the shared primitive), with a manual
  FQN override kept as a fallback — instead of typing the FQN by hand.
- **#146 analytics-as-code monorepo (Phase 1+2, default-off).** Chart seeds an `analytics` Forgejo repo
  (dbt + Cube + Dagster + validate-only CI), and os-ui dual-writes generated Cube/exposure YAML to it
  fire-and-forget (byte-identical to what the Cube sidecar consumes; nothing reads the repo yet — zero
  behavior change).

### Changed
- **#174 connector hardening.** `testConnection` refactored into a `CONNECTION_HEALTH` registry (mirrors
  the executor registry — new connectors append one line instead of editing a 200-line if-chain), plus a
  per-call egress re-check in `runAllow`. Notion gained a real health probe, in-module secret handling,
  bounded cursor pagination, and 429 backoff. A shared `retry.ts` (capped exponential backoff + jitter,
  honoring `Retry-After`) + bounded cursor-follow pagination applied across Supabase, Atlassian, Gmail,
  Google Calendar, Outlook, and Teams.

## [os-ui 0.5.38] — 2026-07-18

### Added
- **Domain-namespaced Cube identity (back-compatible, zero migration).** Two domains can now each
  name a dataset "Sales" without their Cube models, views, or access policies colliding. A new
  opt-in per-dataset marker (`cubeNamespaced`) selects the identity scheme: **new** datasets get a
  domain-prefixed identity (`<domain>__<slug>` cube name, `<domain>__<View>` view, matching model
  file), while **existing** datasets (no marker) keep their legacy bare-slug identity **byte-for-byte**.
  All identity flows through one central place (`lib/data/metrics.ts`), the access-policy compiler key
  is derived the same way (so a cube never ships without its policy), and legacy resolvers keep any
  stored/hand-written reference working. Cross-domain same-name is now allowed; within-domain
  same-name is still rejected. Verified live against the deployed Cube — the existing Northpeak model
  is untouched.

### Removed
- **Dead component pruned: `admin-console`.** It was chart-only, default-off, already absent from the
  Components registry (superseded by the native Components tab that reads the live Kubernetes API), and
  nothing depended on it. Its Helm template and `values` blocks are gone. A normal apply prunes nothing
  new (it never rendered). Audited alongside it and **kept** (all verified live/used): the STACKIT
  external-secret, Argo CD (software deploy stage), Harbor (image pipeline), and Haystack (RAG
  retrieval) — the registry is now fully honest.

## [os-ui 0.5.37] — 2026-07-17

### Fixed
- **Embedded dashboard charts now render real data.** A chart's dataset was built against Trino's
  iceberg catalog with a `cube` schema, but the Cube semantic views live behind the **Cube SQL API**
  and require a **domain-scoped `bi_<domain>` principal**. Dashboard imports now point the Superset
  dataset at the Cube SQL API as that principal (same one Power BI uses), so an embedded chart
  returns real rows — verified end-to-end against live Cube/Trino. Per-viewer RLS in the guest token
  still applies on top. (Requires the `CUBE_SQL_PASSWORD` env, now wired from the existing
  `cube-sql-secrets` Secret.)
- **OpenMetadata native ingestion is now available (off by default).** A CronJob runs OpenMetadata's
  own `metadata ingest` over the Trino `iceberg` catalog (schemas/tables/columns) plus optional dbt
  models + lineage, so the catalog stops being hollow. Enable via `openmetadata.ingestion.enabled`
  after minting a fresh ingestion-bot token (see `docs/components/openmetadata.md`).

## [os-ui 0.5.36] — 2026-07-17

### Fixed
- **Software apps now have a visible Archive button.** The archive/restore/delete control was
  rendered with `surface="tile"` (which shows nothing) on the cards and was otherwise buried inside
  the detail "Manage" accordion — so there was no discoverable archive button. Archive (or Restore +
  Delete when archived) now sits in the app detail **header**, matching the other tabs; owner or
  domain-admin+ (server-enforced).

## [os-ui 0.5.35] — 2026-07-17

### Fixed
- **Creating a dashboard no longer fails with "only the owner … can edit this dashboard."** New
  dashboards took their id from the name slug, so two dashboards sharing a name (across users)
  collided on one id — "creating" the second was treated as editing the first's (often another
  owner's) record, tripping the fail-closed edit-scope check even for an admin. Each new dashboard
  now gets a unique id.

## [os-ui 0.5.34] — 2026-07-17

### Changed
- **MCP surface + in-product guides brought fully up to date.** The MCP server instructions, tool
  descriptions, and every in-product guide now reflect the current model: **"My" artifacts are yours
  — full rights, no approval** (for builders and their agents); Domain needs domain-admin approval,
  Company needs tenant-admin; the agent write-gate is scope-aware; agents inherit the full Define
  grant set by default; dashboards embed live; `create_software` takes a `surface` (ui/api/both);
  Console + Admin are builder-visible. Corrected the `create_dashboard` schema and role/approver
  wording throughout.
- **Official end-user guide refreshed + PDF regenerated** to match — governance model, agents
  capability model, live dashboards, Console/Admin, software surface + archive.

## [os-ui 0.5.33] — 2026-07-17

### Added
- **Software apps get a "Show archived" toggle** and full archive → restore/delete lifecycle on the
  list, matching every other tab (the backend was already there; the list affordance was missing).
- **Apps can declare their surface.** An app can set `surface: ui | api | both` in `app.yaml` (or via
  `create_software`), and that declaration wins over auto-detection.

### Changed
- **A UI app is no longer mislabelled "API."** Surface auto-detection now recognizes many more UI
  shapes — Streamlit/Gradio/Dash/Flask+templates/FastAPI static mounts, `templates/`/`static/` dirs,
  a top-level `index.html`, and Dockerfiles that expose a web port and run a serve command.
- **Lower LLM cost on the "Talk to…" copilots.** They now run on the standard model first and only
  escalate to the reasoning model when an answer looks weak — cutting the reasoning tier's share of
  token spend substantially while keeping answer quality. Admin-configurable (`TALK_COPILOT_TIER`,
  `TALK_ESCALATE_TO_REASONING`, `TALK_KNOWLEDGE_TOPK`).

## [os-ui 0.5.32] — 2026-07-17

### Fixed
- **Agents (and builders) have full rights over their own "My" artifacts — no admin approval.** The
  agent write-gate held EVERY write for review at the common `read-propose` preset, ignoring scope,
  so an agent creating a personal dataset/file/knowledge/metric/connection was wrongly queued. The
  hold is now scope-aware: **My → direct** (run as the builder, whose rights + ownership are the
  authority), **Domain → domain-admin approval**, **Company → tenant-admin approval**. Human create
  paths across all nine types were verified already ungated for builders.
- **Software apps no longer get stuck on "Awaiting review" after approval.** Apps approved before the
  0.5.30 write-back were orphaned (approval decided, app never transitioned). They now self-heal on
  load — an app in review whose approval is already decided flips to live (or preview if rejected),
  durably — which also prevents any future orphan.

### Deploy
- Live Superset now runs with `ENABLE_PROXY_FIX` so embedded dashboards render inside the OS
  same-origin proxy instead of a blank frame (applied to the running cluster).

## [os-ui 0.5.31] — 2026-07-17

### Added
- **A consistent "needs approval" experience across the whole OS.** Whenever an action files an
  approval request (promote/certify Files, Data, Knowledge, Metrics, Dashboards, Science; software
  deploy), you get one calm confirmation — "Request filed — awaiting approval to Domain/Company" —
  with a **Go to Policies & Approvals →** button that deep-links to and highlights the exact request.
  If you're an admin who can approve it, an **Approve now** button approves it inline (fail-closed:
  non-approvers never see it; the server re-checks).

### Changed
- **The Agent-tab PDF reports are now on-brand.** The Run "Results Report" and Evaluate "Evaluation
  Report" are fully redesigned to the datamasterclass style — embedded Marcellus/Rubik/Oswald/Fraunces
  fonts, a gold-lotus cover, gold section rules, styled tables, and a running footer. Same content,
  far better looking.

## [os-ui 0.5.30] — 2026-07-17

### Fixed
- **Agents added from a template now inherit datasets granted afterwards.** Root cause of "granted
  in Define but the agent still gets denied `query_data`/`get_dataset`": adding a template agent
  froze its tool set to a snapshot of the grants at that moment, so any dataset granted *later* in
  Define never reached it. Template agents now inherit the growing grant pool like blank agents do —
  every agent defaults to the full set of the system's Define grants, with per-agent narrowing still
  available. (The data-authorization layer itself was verified healthy end-to-end.)
- **Approving a software release in Policies & Approvals now clears "awaiting review."** The
  governance effect had no handler for software deploys, so an approval updated the queue but never
  the release. Approve now takes the release live; reject returns it to preview — durably, from
  either entry point.

### Changed
- **The Software builder uses the shared progress stepper** (same as Agents Build/Run): the real
  pipeline stages — Scaffold → Build image → Publish → Deploy → Live — light up in turn.

## [os-ui 0.5.29] — 2026-07-17

### Fixed
- **Dashboards now embed live instead of falling back to the offline mock.** Creating/opening a
  dashboard imported it into Superset via a bundle whose `extra` and chart `params` were emitted as
  JSON strings; the deployed Superset version needs those as objects, so every import 500'd and the
  dashboard was never created ("… not found in Superset"). Both are now emitted as YAML mappings —
  verified end-to-end against live Superset (import → embedded UUID → guest token). Existing
  dashboards self-heal on next open (the build-on-open now succeeds). Also made the offline-mock
  hint honest (it no longer always claims Superset is unreachable).

## [os-ui 0.5.28] — 2026-07-16

### Fixed
- **Write access granted in Define now actually reaches the agents (and Files can be granted write).**
  Previously, setting a capability to read+write in Define — even system-wide — still left every
  agent read-only in Design, so writes like uploading a file or creating a dataset were denied at
  run time. Now each agent **inherits exactly the rights the team was granted** (read+write as
  granted) by default, and a per-agent capability carries its write tools; narrowing per agent is
  still possible. **Files** also gained the Read / Read+propose / Read+write selector in Define, so
  file-writing agents (e.g. `upload_file`) work. A hard invariant guarantees an agent can never
  exceed the team's grants.

## [os-ui 0.5.27] — 2026-07-16

### Added
- **A shared, elegant progress indicator across the OS.** The polished progress stepper from the
  Agents Build phase (a determinate bar with each step lighting up — gold while active, teal when
  done, red on failure, with live commentary) is now a reusable primitive, and the **Run** phase
  uses it: a team run shows each agent progressing in turn instead of a bare spinner. This is the
  new house style for long-running operations; other slow surfaces will adopt it next.

## [os-ui 0.5.26] — 2026-07-16

### Changed
- **Simplified the Agents Design stage:** removed the separate "Short name (optional)" field per
  agent. An agent's **Name / Role** is now its label everywhere — the Run and Evaluate node cards,
  the multi-agent graph, and both PDF reports. One name, no duplication.

## [os-ui 0.5.25] — 2026-07-16

### Changed
- **Console is now available to builders** — they get the governed Query surface (Lakehouse SQL
  runs through Trino with the caller's OPA row/document-level security). The raw Shell and the
  unscoped Cube query mode remain admin-only, in both the UI and the API.
- **The Admin tab is now visible to builders, filtered to what they can actually use.** Every
  tenant-admin tile (Users, Security, Models, Backups, Cost, tenant Settings, …) stays admin-only
  and hidden; a builder sees a single tidy "My Settings" self-service tile. Deeper Admin sub-pages
  redirect non-admins back to the overview. Tile visibility is fail-closed (default-deny).

### Security
- **The raw terminal shell is admin-only by default** (`terminal.allowedRoles: ["admin"]`, env
  `TERMINAL_ALLOWED_ROLES`). Previously the token endpoint accepted builders; now that Console is
  builder-visible, the operator shell is locked to admins by default and remains admin-configurable.

## [os-ui 0.5.24] — 2026-07-16

### Added
- **Optional short name per agent.** In Design you can give any agent a friendly short name; it
  carries through the Run and Evaluate node cards, the multi-agent graph, and both PDF reports.
  The agent's identity/id is untouched and `system.yaml` stays byte-for-byte identical when no
  short name is set.
- **Build-phase progress indicator.** Building a team now shows a determinate progress bar that
  walks the real provisioning phases (scaffold → tools & grants → wire graph → traces → commit)
  with live commentary, then settles on the actual outcome — every stage ticked on success, or the
  failing step marked, straight from the build report.
- **Run — "Download PDF Results Report":** exactly what's on the Run screen (summary, final output
  with real tables, per-agent results), nothing else.
- **Evaluate — "Download PDF Evaluation Report":** opens with the multi-agent graph, then the
  on-screen evaluation content, then Appendix 1 Results, Appendix 2 Define-stage settings, and
  Appendix 3 each agent's description. Both reports reuse the Workflow-export PDF engine.

## [os-ui 0.5.23] — 2026-07-16

### Fixed
- **A Define grant is now automatically a usable capability, for every type.** Granting a resource in
  "What your team can use" surfaces its capability chip on the agent card by default and provisions
  the matching tools — this fixes Files and goals (which never surfaced), and a latent Connections
  case (the chip vanished when external connectors were off). Runtime authorization, folder/plan
  grant resolution, and access-level caps were already correct.
- **Files search reliability:** the file embeddings now enforce the index's vector dimension (a
  mis-pointed embeddings model could otherwise make files silently unsearchable) — matching the
  knowledge pipeline. Added end-to-end retrieval + grant-scoping tests for Knowledge and Files, and
  a test that Data surfaces the real table name to agents (no guessed FQNs).

## [os-ui 0.5.22] — 2026-07-16

### Added
- **Every action now visibly confirms itself.** A new OS-wide feedback pattern (a tasteful toast +
  a busy/disabled button state) makes button presses *feel* like they did something: async buttons
  show a spinner and disable while working (no double-submit), then a clear success — or error —
  confirmation. The agent-builder **"Add to my team"** (which stored silently) now confirms and
  takes you to Design; and promote/certify, create-system, approve/reject, save-metric, and
  compile-guardrails all confirm on press.

## [os-ui 0.5.21] — 2026-07-16

### Fixed (governance)
- **A builder can propose promoting an artifact to Domain, and it's reviewed by a domain admin** —
  not by another builder. The Files and Data promote requests were routing approval to the wrong
  role (defaulting to builder), and a personal Knowledge entry could be self-promoted by a builder;
  all now correctly require **domain admin+** approval. The Files action reads "Propose to Domain →"
  with a clear "awaiting a domain admin's approval" pending state. (Owner still proposes their own
  artifact regardless of role; only the approver gate changed.)

## [os-ui 0.5.20] — 2026-07-16

### Changed
- **Tenant admin can manage all Domain and Company artifacts, across every domain** — view, edit,
  archive, restore, delete — via one scope-aware permission rule applied to every tab.

### Fixed (governance / privacy)
- **Personal ("My") artifacts are strictly owner-only.** A platform admin or domain admin can no
  longer view or manage another user's personal datasets, files, dashboards, connections, agent
  systems, knowledge, workflows, science models, pillars, or **personal folders**. (Previously an
  admin could reach some of these.)
- **Creating a Domain folder now requires domain admin (or platform admin).** A builder/creator can
  no longer create domain-scoped folders (server-enforced 403), and the "New folder" affordance for
  the Domain root is hidden from them in Files/Data/Metrics. Personal folders are unchanged.
- Promotion/approval paths are unaffected (a builder still proposes; domain admin+ approves).

## [os-ui 0.5.19] — 2026-07-16

### Changed
- **MCP surface synced to the current product.** Tool descriptions, prompts, instructions, and the
  per-tab briefs now consistently use My/Domain/Company (promote→Domain, certify→Company), name the
  **Operating Model** (7 sections), and teach the agent **grant schema** (`commit_agent_files`:
  Context vs Plan items, per-item access levels, folder grants). Connector templates and
  `create_big_bet`'s required pillar were already correct. No tool identifiers changed.
- **Agent grant-picker Plan Items** now read "Operating Model" (matching the tab rename).

## [os-ui 0.5.18] — 2026-07-16

### Changed
- **Official guide refreshed** (`docs/Sovereign-Agentic-OS-Guide.md` + PDF) to the current product:
  My/Domain/Company vocabulary, the Operating Model, the shared folder UX, the full connector
  catalogue, the interactive agent-grants surface, per-agent Evaluate context, and Big-Bets-under-a-pillar.

### Internal
- **Refactor (#171 phases C–D, behavior-preserving):** cross-tab imports routed through public tab
  barrels; two barrels widened for genuinely-public server-side symbols. No behavior change; client
  bundles kept free of server-only modules (verified by the production build). tsc + tests + build green.

## [os-ui 0.5.17] — 2026-07-16

### Added
- **Strategy pillars and Big Bets can now be granted to an agent team** as read-only context,
  completing the Plan Items group in "What your team can use" (alongside Workflows and the
  Operating Model). Granting a pillar or bet provisions its governed read tools
  (`get_pillar`/`get_big_bet`), DLS-scoped to what the caller may view — the same governance the
  Strategy and Big Bets tabs use.

## [os-ui 0.5.16] — 2026-07-16

An interactive agent-grants surface, four cloud governance/ML connectors, and an honest
Components registry.

### Added
- **"What your team can use" is now interactive.** Per item, choose **read-only ·
  read + propose · read + write** (a clear labelled selector — no more ambiguous toggle),
  capped by the agent system's overall access setting (locked at read-only or full-in-scope;
  otherwise downgrade-only, explained inline). Grants are grouped into **Plan Items** (Strategy ·
  Big Bets · Operating Model · Workflows) and **Context** (Knowledge · Files · Data · Connections ·
  Metrics), with prominent category headings. **Workflows and the Operating Model are now genuinely
  grantable** to a team (Strategy and Big Bets remain labelled for a later pass).
- **Cloud governance / ML connectors — Microsoft Entra · Purview · Azure AI Foundry · AWS
  SageMaker.** Read-only, governed (identity, catalog/lineage, model deployments, ML endpoints/jobs).
  SageMaker uses a dependency-free, test-verified AWS SigV4 signer; secrets are write-only. Setup
  (Azure app registration / read-only AWS IAM keys) is documented as the operator's step.

### Fixed
- **Files folders now appear in the agent grant picker** (the Files feed returns its scoped folders).
- **Components tab tells the truth.** Trino (not DuckDB) as the query engine, the real runtimes
  (agent-runtime, data-runner) added from what the chart actually deploys, mock-model marked
  local-dev-only, and versions corrected.

## [os-ui 0.5.15] — 2026-07-16

Consistent folder UX across every context tab, deep links that open the actual item, five
messaging/calendar connectors, and Big Bets that always sit under a pillar.

### Added
- **Messaging & calendar connectors — Slack · Gmail · Google Calendar · Outlook · Teams.** Real,
  governed, hand-built (reads auto; sending a message/email is approval-gated and never automatic;
  deletes blocked; secrets write-only). Each ships an install guide; creating the Slack app /
  Google OAuth client / Azure app registration is the operator's step, and OAuth token-refresh is
  a documented follow-up.
- **Evaluate deep links open the real item.** The per-agent "context used" links now open the
  actual dataset / doc / file / metric / connection (via `?focus`), switching scope so it's visible.

### Changed
- **One folder UX on every context tab.** Data, Metrics and Knowledge now use the same shared
  layout as Files (a factored `FolderLayout`): a scope segment + one active-scope folder rail +
  the grid. Knowledge's redundant three-lane view is gone — the scope tabs alone drive it.

### Fixed
- **Folder rail no longer overlaps the tiles** on Data and Metrics (a min-width overflow in the
  grid layout).
- **A Big Bet must sit under a Strategic Pillar.** Creation now requires a pillar from both entry
  points (the Big Bets "New" panel and "New bet under this pillar" from Strategy) and via MCP;
  existing unlinked bets are grandfathered.

## [os-ui 0.5.14] — 2026-07-16

One consistent scope vocabulary, a clearer Operating Model, sharper folder handling, and a
per-agent view of the context each agent actually used.

### Added
- **One scope vocabulary across the whole OS: My · Domain · Company.** "Shared" → **Domain**,
  "Marketplace" → **Company**, everywhere, driven from one place in core (`lib/core/scopes.ts`).
  Promote reads "Promote to Domain"; certify "…to Company". Display + verbs only — no stored
  value, policy key, or route changed. (The Marketplace *storefront* keeps its name.)
- **Operating Manual → Operating Model.** The tab and its three scopes are now "My / Domain /
  Company Operating Model", and each holds a fixed set of sections: **General · Strategy ·
  Business · Organization · Architecture · Data · Glossary** (existing content migrated into the
  closest new section; nothing lost).
- **Evaluate shows what each agent actually used, per agent.** The "context used" panel now
  attributes artifacts per agent, each a clickable deep link, and shows how it was used
  (tool + read/retrieved/written + a short args hint). Errored/inferred items stay honestly marked.
- **Folder Rename.** A "Rename…" action on the folder ••• menu (in-place leaf rename), across
  Files · Data · Knowledge · Metrics.

### Fixed
- **Folders show only the root that matches the active scope.** No more empty "Shared folders"
  section under My (or vice-versa) — the rail and pickers render just the active-scope root, the
  same way on every tab.
- **Archive is available on every folder you see** — implicit folders (made only by moving items
  in) now materialise a registry row on demand so Archive/Rename/Move always appear.
- **Big Bets: Archive is easy to find** — moved from the bottom of the detail page into the detail
  header, next to Edit (Restore/Delete when archived; owner/admin only).
- **Data explore: the Bronze/Silver/Gold picker is colour-coded per tier** with a clear selected
  state; the highest available layer stays selected by default.

## [os-ui 0.5.13] — 2026-07-16

Folders + lifecycle become one shared core primitive across the context tabs; four real
service connectors; and a batch of Agents-builder and Big Bets fixes.

### Added
- **One shared folder + archive/restore/delete primitive across Files · Data · Knowledge ·
  Metrics.** A core `ArtifactAdapter` registry + a single folder-lifecycle orchestrator (mirrors
  the warehouse-provider registry): folder logic and the archive→delete/restore lifecycle are
  written once in core and each tab registers a thin adapter — no per-tab divergence. Metrics gain
  folders too. Moving a folder now carries its contents; archiving a folder cascades to the items
  inside (with a clear warning; move items out first to keep them active); physical delete is
  archived-only, per-item permission-checked.
- **Four real, governed service connectors — GitHub · Supabase · Notion · Atlassian.** Hand-built
  typed API clients on the Airflow reference pattern (reads auto; writes approval-gated;
  destructive ops blocked; secrets write-only). Notion's tool execution is now real (was a mock).
  `runAllow` moves from an Airflow-only branch to an executor registry.

### Fixed
- **Moving a file now lands it in the destination folder.** The folder rail + move picker are tied
  to the active My/Domain scope, so a move can only target a valid (tier-bound) root — the moved
  file no longer vanishes. The folder "Move" action is a tree picker, not a text field.
- **Big Bets: "Show archived" toggle** — archived bets were unreachable; they now appear (dimmed)
  with Restore + Delete via the shared lifecycle controls.
- **Agents Simple builder:** always opens on Define with no pre-set phase checkmarks; "What your
  team can use" lists each item once (no My/Shared duplication); an agent's editable role is its
  name and templates prefill it; Simple mode auto-connects agents linearly (Developer rewiring
  still wins); rebuilt capability picker — recommended capabilities prefilled, a described
  per-domain picker, selected chips shown in a box (click to explain, ✕ to remove).

## [os-ui 0.5.12] — 2026-07-16

Connector wave (batch 1): operational databases, a grouped/searchable Connections tab, and a
proper folder picker.

### Added
- **Operational-database connectors via Trino — PostgreSQL · MySQL · SQL Server · MongoDB.**
  Real, governed, federated (reuse the warehouse framework). Deep-researched per engine (Trino
  476 catalog config, identifier rules, discovery, type mapping, pushdown notes); credentials
  vaulted via `${ENV:}` (Mongo's whole connection URL is the secret — nothing inlined); one
  Installation Guide each. Meets the CONNECTOR-STANDARD Definition of Done.
- **Connections tab: grouped by type + search.** Supported Connectors now group into 11
  categories (Messaging · Calendar · Code & DevOps · Docs & Knowledge · Operational databases ·
  Data warehouses · Data ingest · Enterprise apps · Orchestration · Catalog · LLM providers)
  with a live search bar; the 4-section IA intact.

### Fixed
- **"Move to folder…" is now a folder-tree picker, not a text field** (Data · Knowledge ·
  Files) — browse and click the destination folder, with inline New-folder, like a file explorer.

## [os-ui 0.5.11] — 2026-07-16

Folders, end to end — the agent-builder folder-grant browse-tree (completes #175).

### Added
- **Agent builder: grant folders or items via a browse-tree.** In "What your team can use",
  Data · Knowledge · Files now render a `FolderTree` with tri-state checkboxes — tick a
  **folder** to grant everything in it (and future contents), or tick individual **items**.
  A folder grant (`ArtifactGrant.folder`) resolves to the folder's contents at run time
  (late-binding — add an item later and the team gets it next run), capped by a budget, and
  **every resolved item is still per-item DLS/OPA-checked** — so a folder grant is provably a
  *subset* of what the owner could grant, never a widening. `system.yaml` stays byte-stable
  when no folder grant is present.

This closes the full folder feature: create folders on Data/Knowledge/Files → file items into
them → grant folders or items to agents by checkbox.

## [os-ui 0.5.10] — 2026-07-16

Folder management for Data/Knowledge/Files + "context actually used" in Evaluate.

### Added
- **Folders on Data · Knowledge · Files.** Create folders, move items into them (single +
  multi-select), and navigate a folder tree per tab. Governed (`canManageArtifact`), folders
  persist even when empty, and Files' old implicit rail is reconciled to explicit folders with
  zero migration. Built on a shared primitive (`lib/core/folders.ts` pure algebra +
  `lib/folders/` governed store + `components/core/FolderTree.tsx`). *(The agent-builder
  folder-grant browse-tree — checkbox folders or items — is the next wave.)*
- **Evaluate: "Context actually used" per run.** Each agent's Evaluate/Run view now shows the
  real artifacts it consumed — data · files · knowledge · metrics · connections — with
  read/retrieved/written, per-agent and a run-level roll-up, each chip deep-linked to its tab.
  Plus a **granted-vs-used** strip flagging "dead grants" (granted but never used). Derived
  from the already-persisted tool-call trace; honest about inferred (`query_data`) vs captured.

## [os-ui 0.5.9] — 2026-07-16

Internal refactor — **no user-facing change** (behavior-preserving; 2417 tests green).

### Changed (structure/docs/heal)
- **Documented** 13 previously-undocumented `lib/` modules (READMEs) + refreshed
  `ARCHITECTURE.md` to the actual state.
- **Contract barrels** — added `index.ts`/`schema.ts` to the 13 tab modules that lacked
  them (off the `connections` reference template), so every module exposes a clean public
  API (additive; no importers changed yet).
- **Layering fix** — moved the Forgejo client type to `lib/infra`, removing the one
  `core → tab` upward-import violation.
- Removed the orphaned `ContextPanel.tsx` (dead after the workflow Context sub-tab removal).

_(The deeper structural moves — routing cross-tab imports onto the barrels, extracting
shared code to core, relocating external clients into `lib/infra`, and the components
folder reorg — continue incrementally under #171, gated by the test suite + `next build`.)_

## [os-ui 0.5.8] — 2026-07-16

Big Bet solution wizard, self-service model providers, simpler agent tooling, and a real
Superset embed fix.

### Added
- **Big Bet solution wizard (Phase 3).** A 3-step wizard (Anchor workflow · Components ·
  Context) with attach-existing / create-new deep-links, plus **connect-mode** on the
  interplay canvas (click source → target → relation). New governed write API + MCP tools
  (`set_bet_workflow`, `attach_bet_component`, `wire/unwire_bet_components`,
  `get_bet_solution`). (software/connection are attachable by id today; the browsable
  picker for those two is a follow-up.)
- **Models & Providers — self-service (MVP).** Durable model persistence
  (`store_model_in_db`), a provider-grouped catalog, and an "Add provider" wizard
  (OpenAI-compatible + STACKIT live; Azure/Bedrock scaffolded). Credentials are write-only
  secrets. Model list pruned to the STACKIT set.
- **Connector Design Standard** — `docs/CONNECTOR-STANDARD.md`, the high quality-bar every
  new connector must meet (governance, write-only secrets, federate-first-party-MCP rule,
  lifecycle, tests, DoD checklist).

### Changed
- **Agent builder: per-agent tooling simplified.** Each agent defaults to **Auto** (the OS
  picks tools from its job + the team's resources); optional plain **capability chips**
  (Read data · Search knowledge · Use a connection · …) that only appear for what the team
  was granted; Developer view keeps the raw tool list.

### Fixed
- **Superset dashboards now embed same-origin.** They failed because Superset sends
  `X-Frame-Options: SAMEORIGIN` (cross-origin iframe blocked) and the dashboard was looked
  up by title. The embed now routes through the OS's same-origin `/tools/superset` proxy
  (no CSP/CORS/cookie issues), matches the exact title only (no wrong-dashboard fallback),
  and enables Superset ProxyFix so prefixed URLs resolve. (Needs a published dashboard in
  Superset + a browser check to confirm the render.)

## [os-ui 0.5.7] — 2026-07-16

Big Bet solution canvas, a real "members-only" fix, and Governance consolidation.

### Added
- **Big Bet solution-design canvas (Phase 2).** The bet detail now opens on a **Design**
  view: a banded **interplay canvas** (Anchor workflow ▸ Components ▸ Context) with typed,
  labeled edges (dashed for `triggers`/`monitors`), click-through to each artifact's tab,
  and a read-only anchor-workflow swimlane. Value tracking moves under a **Value** tab,
  untouched. (Wizard + write path come in Phase 3.)

### Fixed
- **Big Bet components no longer show "🔒 members only" for everyone.** They were resolved
  through an in-memory registry that resets on every pod restart; after any redeploy all
  components (even for an admin) fell back to "members only". They now resolve from the
  **durable per-tab stores** with the real viewer gate — real titles across restarts, admin
  sees all, genuine cross-domain restrictions preserved — plus an honest **"unavailable"**
  state for a truly-missing artifact.

### Changed (Governance → Policies & Approvals consolidation)
- Deleted the orphaned duplicate **Users** panel (Admin owns user administration).
- **Audit** now writes through to the persistent `os-audit` store (one durable trail that
  survives restart), keeping the hash-chain integrity check.
- **Egress** allowlist consolidated onto Admin → Security's real store.
- **Cost caps now actually enforce** — checked at the assistant-completion chokepoint
  (over-cap → 402, model never runs); honest caveat that self-hosted spend reconciles via
  live LiteLLM accounting.

## [os-ui 0.5.6] — 2026-07-16

MCP surface brought up to date with this session's capabilities; workflow-detail tidy.

### Added
- **MCP: Operating Manual tools** — read/update/list-versions/restore the My · Domain ·
  Company operating manual, governed per scope.
- **MCP: pillar `personal` (My) scope + full pillar lifecycle** — `create_pillar` accepts
  the personal scope (creator-floored; per-scope create rights enforced in-lib); new
  `archive_pillar`/`unarchive_pillar`/`delete_pillar`/`promote_pillar`/`restore_pillar_version`.
- **MCP: Big Bet lifecycle** — `archive_big_bet`/`unarchive_big_bet`/`delete_big_bet`/
  `restore_big_bet_version`, plus `create_big_bet` now requires a real, viewable `pillarId`
  (containment; dropped the stub pillar/metric defaults).
- Refreshed the MCP orientation NAV line + strategy/knowledge guides to the current nav
  (Console, Govern, Policies & Approvals, Operating Manual tab, Workflows as its own tab).

### Changed
- **Workflow detail: removed the "Context" sub-tab** (the pinned/retrieved context layer) —
  trimming the detail toward the planned two-view layout.

## [os-ui 0.5.5] — 2026-07-15

Navigation restructure + Big Bet solution-blueprint foundation.

### Changed
- **Navigation is now five tabs per section.** **Console** (Terminal + Query merged into
  one admin page with a Shell | Query switch) joins **Build**; the **Admin group is
  dissolved** — the Admin tab moves into **Govern** (renamed from Monitor), and About /
  Licenses moves into **Entry** (readable by everyone, for transparency). The
  **Governance** tab is renamed **Policies & Approvals** (route unchanged; page content
  unchanged — the consolidation is separate). `/terminal` and `/admin-query` redirect to
  `/console`.
- The Operating Manual's personal scope now reads **"My Operating Manual."**

### Added (foundation, not yet surfaced)
- **Big Bet solution-blueprint model + store** (Phase 1) — typed interplay edges
  (`consumes/produces/triggers/feeds/monitors`, kept separate from build-order
  `dependsOn`), an anchor-workflow role, and governed store setters
  (`setBetWorkflow`/`wireComponents`/`getSolution`/…), versioned through the existing
  mirror. Stored on `blueprint` (the existing free-text `solution` field is untouched).
  The wizard + interplay canvas that use it come in later phases.

## [os-ui 0.5.4] — 2026-07-15

Operating Manual gets its own tab; Strategy/Big-Bet foundations; admin tidy-up.

### Added
- **Operating Manual is its own top-level tab** (Plan group, after Big Bets) with a
  **My · Domain · Company** switcher, governed per scope: My = owner-only; Domain =
  domain-admin+ edit / domain read; Company = admin-only edit / everyone read. Reuses
  the domain-knowledge card + version history for all three. Removed from the Workflows
  tab (Workflows is workflows-only again); Knowledge stays reference-only.
- **My/Domain/Company tiering for Strategic Pillars + Big Bets.** Pillars gain a personal
  **My** tier on top of Domain/Company (`personal|domain|tenant`); bets inherit their
  pillar's tier by containment. Both tabs get a My·Domain·Company segment. Governance:
  My=owner, Domain=Builder+/domain-admin, Company=Admin; promote My→Domain→Company.
- **Full lifecycle for pillars + bets** — archive → restore / physical-delete (confirm
  popups) + version history, via the shared lifecycle components. Deleting a pillar with
  linked bets is blocked (unlink first); bets are never cascaded.

### Fixed / Changed
- Removed the duplicate **Components** quick-link from the Admin overview (it has its own tab).

## [os-ui 0.5.3] — 2026-07-15

Workflows + builder polish (follow-up to 0.5.2).

### Changed
- **Domain Operating Manual moved to the Workflows tab.** The domain operating-manual
  card (overview/glossary/goals/context) now renders at the top of the Workflows tab,
  where it belongs — above the workflow list. The **Knowledge tab is now reference-only**:
  personal/certified markdown entries + Talk-to, for adding additional knowledge as needed.
  Pure relocation — same `/api/knowledge/domain` wiring, schema, and edit gate. (#164 Phase 2, Domain scope.)
- **Agent builder: "What your team can use" moved to the bottom of the Define phase**
  (from the top of Design). Define now reads goal → deliverable → resources, so the team's
  allowed context is the closing step of scoping the job, before you design the team.

## [os-ui 0.5.2] — 2026-07-15

Workflows: richer actors, a standalone tab, PDF export, and an MCP how-to guide.

### Added
- **Actors registry in workflows.** Five actor categories — Human · Software · Agent ·
  **Customer** · **Partner** — each a first-class described entity (name · category ·
  description) defined once in a new **Actors** tab and chosen per step from a dropdown
  (with an inline "＋ New actor"). Customer and Partner are *external* actors, rendered
  as dashed, muted swimlane lanes. Back-compat: existing workflows derive a registry
  from their steps. The `author_knowledge` MCP tool gained the 5 categories + a
  workflow-level `actors[]`.
- **Standalone Workflows tab.** Workflows moved out from under Knowledge into their own
  top-level tab (Plan group, right after Big Bets). Knowledge is now knowledge-only
  (domain manual + personal entries).
- **Workflow PDF export.** An "Export PDF" button (top-right of the workflow detail)
  produces a PDF that leads with the swimlane visual flow on page 1, then the full
  workflow — actors with descriptions, ordered steps (actor, inputs/outputs, rules,
  know-how), and handover/gaps. Reuses the OS's existing jsPDF pipeline.
- **"How to use this MCP" guidance.** `get_guide()` with no argument now returns a
  role-aware orientation (governance model, the three first moves, the pathway list,
  the role summary), also exposed as `sovereign-os://guide/how-to-use`.

## [os-ui 0.5.1] — 2026-07-15

Metrics-tab polish — two surgical fixes, no backend/chart change.

### Fixed
- **Newly-defined metric no longer shows "Cube failed".** During the ~5s window
  after Define, the model-sync sidecar hasn't yet pushed the measure to Cube, so a
  resolve returns "not found for path" — which `buildMetric` already fail-softs to
  `pending: true`. But `BuildRowsView` ignored that flag and rendered a hard
  `✗ Build failed` beneath the "saved, syncing" banner. It now shows `⟳ Build
  syncing` and per-row `⟳ … syncing — resolves shortly` while pending, never a hard
  ✗. The sync path itself was verified healthy end-to-end (sidecar → `.cube.yml` →
  Cube `/meta` → governed `/load` 200); this was purely a mislabel.
- **Metric tile domain chip no longer wraps across several lines.** The source-domain
  chip had no `nowrap`, so a long domain name broke mid-word and cramped the tile.
  It now stays on one line and ellipsizes (full name in the hover title), and tiles
  are slightly wider. CSS-only, so every tab's domain chip benefits.

## [os-ui 0.5.0] — 2026-07-15

Connectors deepened into real per-engine services, a real Science training runtime, and
OpenMetadata write-back. `tsc` clean; **2336 tests pass**. Pieces needing a live source /
cloud creds are labeled honestly, not faked.

### Feature — real per-engine warehouse connectors (not a generic template)
- Each warehouse provider is now genuinely engine-specific: **identifier casing/quoting** (Snowflake upper-folds + quotes; BigQuery/Databricks/Fabric preserve; Glue lower), **native discovery forms** (Snowflake `SHOW TERSE SCHEMAS IN DATABASE`, Fabric honestly *none* → operator-configured OneLake locations), **engine-aware import type-casts** (VARIANT/STRUCT/ARRAY/MAP/GEOGRAPHY → sane Iceberg types via `buildTypedImportCtas`, with lossy-cast warnings), and real **guardrail notes** (BigQuery bytes-scanned billing; Databricks Unity-is-Starburst-only → prefer Thrift/Glue; Glue IRSA/partition-projection; Fabric experimental).
- **Connections UI**: the single "External data warehouse" card is now **five real cards** — Snowflake · BigQuery · Databricks/Delta · AWS Glue/Athena · Microsoft Fabric/OneLake (experimental) — each Connect pre-set to its platform. **Every** connector (warehouses + Drive/OneDrive/Notion/Airflow/OpenMetadata) now has an **Installation Guide** button (prerequisites · steps · what the OS does).

### Feature — Airflow deepened (operate · observe · retrieve)
- From 3 tools to **12**: `list_dag_runs`, `get_task_instances`, `get_task_logs`, `get_xcom`, `list_datasets`/`get_dataset_events` (Read); `pause_dag`/`unpause_dag`/`clear_task` (Write-approval, honoring the DAG allowlist); plus the existing list/trigger/get-run. v2-first with v1 fallback. (Airflow's REST API operates *existing* DAGs — it cannot author DAGs; large outputs land in a warehouse the OS reads via its connectors, not XCom.)

### Feature — Science training runtime (Phase 2/3)
- A real, governed **on-platform training Job** (`images/ml-trainer` + a `batch/v1` Job builder + submit/poll state machine): ＋New model → Define → **▶Train** trains sklearn from a governed **Gold** product (read as a least-privilege Trino principal), MLflow-tracks, uploads a KServe-servable artifact, and a per-model InferenceService serves it. The os-ui RBAC now permits `batch/jobs` (gated on `ml.enabled`). Live train E2E needs a real Gold product + the deployed job (a cluster step); the code + chart are complete and unit-tested.

### Feature — OpenMetadata Phase-2: integrity-safe write-back (flag-gated off)
- Scoped **additive** write of OS-produced assets into a customer's existing OM, with all seven integrity guards enforced in code: namespace isolation (`sovereign_os` service + OS domain), **additive JSON-Patch only** (no `remove` is even representable in the type), `managedBy` markers, idempotency, optimistic-concurrency **yield** on a human edit, **preview-diff before write**, and an OM-side least-privilege writer bot. `preview_om_sync` (read) + `apply_om_sync` (**held for approval**, executed via the governance effect). Live verification needs a real OM instance.

### Fixes
- **Dataset Restore** now works from the detail view (the GET route wasn't returning the record-level `archived` flag, so it offered Archive instead of Restore/Delete).
- **Knowledge delete** genuinely fixed — the real cause was `deleteWorkflow` hard-blocking *any* published (`live`/Shared) workflow ("unpublish first", but there's no unpublish), so shared workflows could be archived but never deleted; now archive-first then delete regardless of tier, purging all three stores + the search index.

## [os-ui 0.4.0] — 2026-07-15

Integration + honesty release. `tsc` clean; **2262 tests pass**. Several features ship as
explicitly-labeled Phase-1 slices (their next phases need new infra or the customer's cloud
credentials — called out honestly, never faked).

### Feature — Science tab, reworked into an integrated lifecycle (Phase 1)
- The Science tab is no longer a launcher of four raw consoles. It's now an **integrated model-as-a-service tab** matching every other tab: All/My/Shared/Marketplace list + **＋New model**, detail-on-click with **Predict** ("Try it" against the live KServe model), tier ladder (promote), version history, and lifecycle — wrapping the live churn/KServe slice as the first model. The raw MLflow/Featureform/JupyterHub/KServe consoles move to a **Developer → Open console** escape hatch. `app/science/page.tsx` shrank from ~1000 lines to a thin shell. Honestly Phase-2+: guided train + a real on-platform **training runtime** (new infra) and inline eval/monitor charts render as labeled "coming" states.

### Feature — OpenMetadata as a Connection, read/discover (Phase 1, flag-gated off)
- A customer's existing OpenMetadata can be connected as a first-class **`om-catalog` Connection** (base URL + vaulted bot JWT) with **read-only** tools (`list_domains`/`list_data_products`/`list_tables`/`search_catalog`/`get_om_lineage`), a per-connection OM client with version detection, and a DLS-scoped fold of their catalog into OS discovery — **zero writes to OM** by construction. Behind `OPENMETADATA_CONNECT_ENABLED` (default off). Phase 2 (scoped additive JSON-Patch write into an OS-owned OM namespace, with a preview diff + approval) and Phase 3 (lineage/DQ + domain binding) are designed and scoped, not built.

### Feature — Connections page restructured (the approved 4-section IA)
- The Connections tab is now: **header** (All/My/Shared/Marketplace · Show archived · **＋New connector** wizard) → **Connections list** (App-MCP connections folded in by scope, badged "App", linking to their app) → **Supported Connectors** (a dynamic gallery that auto-lists every connector type — warehouses, Drive, OneDrive, Notion, Airflow, OpenMetadata — each **Connect** opening a guided wizard) → **Outbound access** → **Talk to Connectors**. A shared stepper (`ConnectorWizard`) drives both the supported-type and custom flows. *Honest carry-over:* a fully-arbitrary custom API/MCP endpoint still hits the backend's known-template gate (it errors honestly, doesn't fake success) — the generic custom-connector backend is a fast-follow.

### Feature — Apache Airflow as a Supported Connector
- Governed outbound connection to a member's Airflow REST API: `list_dags`/`get_dag_run` (Read) + `trigger_dag` (**Write-approval** — a DAG trigger is held for governance approval, honoring an optional DAG allowlist). Client tries Airflow **v2 then v1**, Basic or Bearer auth (vaulted). So a member who runs Airflow can drive + monitor their DAGs from the OS (and agents can). Live verification needs their real Airflow + token.

### Fix — deleting an ARCHIVED knowledge artifact now works
- Same UI-surface bug as archived datasets: archived knowledge tiles rendered `LifecycleActions surface="tile"` (which returns `null`), so the Restore/Delete controls were absent, and the "Show archived" toggle didn't reach the General/"My knowledge" view. Fixed both areas (Workflows + Personal); the delete route + physical OpenSearch purge were already correct.

### Polish — Agents tab
- Bigger **Judge this run** + **Download PDF report** buttons; the PDF report now contains **Run results** (final output + per-agent outputs) alongside the **Assessment** (diagnostics), so it's one complete shareable report.

## [os-ui 0.3.5] — 2026-07-15

### Feature — external-warehouse connectors usable end-to-end (no YAML / no helm)
- **One-click Register**: a warehouse connection now registers its Trino catalog **live** from the UI — merges the generated `<catalog>.properties` into the read-only `trino-catalog` ConfigMap, materializes the vaulted secret(s) + wires the Trino env (keyless IRSA/Workload-Identity for Glue/BigQuery; `${ENV}` secret-ref for Snowflake/Databricks/Fabric), and rolls Trino — governed (Builder+/edit-rights), audit-logged, credential never returned. The os-ui RBAC role gains `configmaps`+`secrets` (gated on the flag).
- **Discover + Import**: `discover_warehouse_tables` (governed `SHOW SCHEMAS`/`SHOW TABLES`) + a Data-tab "Import from warehouse" flow that CTAS-imports a federated table as a normal governed dataset (`iceberg.<domain>.<name>`). The connection UX is **Create → Register → Test → Browse → Import** — no catalog properties or YAML ever shown. (Fabric/OneLake honestly degrades to a manual table-path input — no metastore probe.)

### Feature — Power BI consumption via Cube's SQL API (per-domain principal)
- Cube's Postgres-wire **SQL API** (`cube.sqlApi.enabled`, port 15432) exposes the governed semantic layer to Power BI. Each domain gets a read-only **`bi_<domain>`** principal — Cube's `checkSqlAuth` parses the domain from the username and resolves that domain's `securityContext` → OPA/RLS, so a Power BI connection sees only its domain's governed metrics. A `/api/powerbi/connection-info` route advertises host/port/database/user (password stays in the `cube-sql-secrets` vault, never in the response) + `docs/powerbi-consumption.md`. Honest limit: **domain-level** scope (all viewers of a domain share it) — per-viewer RLS is a later phase. External Power BI needs the operator to publish a **TCP** LoadBalancer to `cube-sql:15432` (Postgres wire, not HTTP).

### Fix — "Show archived" toggle always solid
- Dropped the `opacity: 0.7` dimming on the "Show archived" toggle across all 7 tabs (Data, Connections, Metrics, Agents, Dashboards, Files, Artifacts) — it read as disabled even though it worked. Now always solid.

## [os-ui 0.3.4] — 2026-07-14

Live-QA fixes found by exercising the deployed OS tab-by-tab. `tsc` clean; 2195 tests pass.

### Fix — deleting an ARCHIVED dataset now works (was the blocker)
- Root cause was a UI gate divergence, not the route/purge (those were correct). The Data tab used a hand-rolled permission check that **omitted `domain_admin`** and wrongly required a platform admin to be a member of the dataset's domain; and archived tiles rendered `LifecycleActions surface="tile"` which returns `null`, so the **Restore/Delete buttons the copy promised were literally absent**. Now `components/data/DatasetTiles.tsx` uses the shared `canManageArtifact` (identical to the DELETE route + every other tab) and renders the real Restore/Delete cluster on archived tiles → archive→delete works for the owner/admin, 403 for a non-owner non-admin.

### Fix — Superset embed auto-heal (dashboards created before the embed fix)
- `mintEmbed` now takes the dashboard spec and, when the dashboard isn't yet in Superset, **builds it on the fly** then embeds — so a dashboard created before the build-on-create fix (e.g. "Contribution") self-repairs on first view instead of staying OFFLINE-MOCK. Idempotent for already-built dashboards.

### Fix — Science tab: Jupyter/KServe links (were `localhost`/404)
- The chart never emitted the Science **console URLs**, so they fell back to `localhost`. Now `os-ui.yaml` emits `JUPYTERHUB/MLFLOW/FEATUREFORM/KSERVE_CONSOLE_URL` via the `soa.consoleUrl` helper; a new `proxy-public` ingress (`jupyter.<domain>`, WebSocket-annotated) gives JupyterHub (which was already deployed + serving, just had no front door) a real browser entrance; KServe — which has no human UI — now shows an honest "No console" state instead of a dead localhost link. MLflow/Featureform keep opening via the in-cluster tool-proxy (why they already worked).

### Fix — Featureform comes up green (opt-in Layer 4)
- The all-in-one image assumes an embedded Postgres and never creates its metadata schema against our external PG (so its coordinator errored `ff_task_metadata does not exist`); and its :80 dashboard (the endpoint the OS probes) couldn't start because the hardened container dropped `CAP_CHOWN` that nginx needs. Added an `ff-migrate` init container that runs the image's own `goose` migrations against the external `featureform` DB, and restored just `CAP_CHOWN` on the main container. (Also: a `post-upgrade` reconcile hook now creates the `featureform` role+db that was missing on the long-lived volume.)

### Fix — Google Drive / OneDrive: `testConnection` is real, not a stub
- The OAuth authorization-code flow (authorize + callback routes, admin OAuth-app registry, token-in-Secrets-Manager, silent refresh, honest "not configured" UI) already existed; the one remaining "pretends to connect" gap was `testConnection` doing a generic HEAD poke that **always returned ok**. It now makes a real Drive `about.get` / Graph `/me/drive` call with the stored token — honest healthy / needs-reconnect / not-connected. (To actually connect, an admin must register a Google/Microsoft OAuth app under Platform → OAuth apps; the UI says so honestly until then.)

### Feature — external-warehouse connectors are now surfaceable
- `EXTERNAL_CONNECTORS_ENABLED` is wired into the chart (`osUI.externalConnectorsEnabled`), so the warehouse create-flow + MCP tools appear when an operator turns it on. Deployed **on** for this tenant.

## [os-ui 0.3.3] — 2026-07-14

### Fix — OS-built apps now serve a real UI (closes the Software image-build gap, #132)
- **Proven end-to-end:** a created app's CI now genuinely `docker build`s and pushes an image to the Forgejo registry, the node pulls it, and the runner deploys it (verified live — the first OS-built app image ever produced; the prior app-path CI was a no-op `echo` stub that reported success while pushing nothing).
- **Scaffold produces a runnable app:** the `nextjs-supabase` template now seeds a minimal Next.js **App Router** app (`app/page.tsx` + `app/layout.tsx`, no runtime Supabase calls so it boots without secrets) and a correct Dockerfile — `npm install` (no lockfile is seeded; the old `npm ci || true` silently produced no `node_modules` → `next: not found`), a real `next build`, and `PORT=8080`/`HOSTNAME=0.0.0.0`/`EXPOSE 8080` to match the runner's readiness probe. TS devDependencies are seeded so `next build` type-checks in the network-less DinD runner.

### Feature (flag-gated, default OFF) — external-warehouse connectors, integration layer
- Building on the provider registry (Glue/Athena · Snowflake · BigQuery · Databricks-Delta · Fabric/OneLake — all real `catalogProps` generators, secrets referenced via `${ENV:…}`/mounted files, never inlined), this wires the connectors end-to-end behind `EXTERNAL_CONNECTORS_ENABLED`: a generic Connections create-flow that renders each provider's `credentialFields` (secrets vaulted to Secrets Manager, never on the record); **live Trino catalog registration** via a new `values.trino.externalCatalogs` list rendered into the read-only `trino-catalog` ConfigMap with per-catalog secret-env / IRSA injection; a governed **import-to-Iceberg** CTAS (`import_warehouse_table`, reusing the materialize path); MCP `create_connection`/`test_connection` (honoring each provider's `testProbe`) + `warehouse_registration`/`import_warehouse_table`; and an OpenMetadata connector-hint stub. Default render is unchanged (empty catalog list); nothing activates until an operator sets the flag + adds a catalog. Live "returns rows" verification against a real AWS/Azure/Snowflake/GCP/Databricks account remains the operator's step.

## [os-ui 0.3.2] — 2026-07-14

Four-tab operability pass (Dashboards, Monitoring, Science, Software) plus a
medallion-layer choice on agent data grants. All code `tsc`-clean; 2120 tests pass.

### Fix — Dashboards embed actually mounts (was permanently OFFLINE-MOCK)
- **Guest-token mint no longer 403s.** The Superset service handshake now sends `X-Forwarded-Roles` on both the CSRF GET (the first request, which triggers `_sso_login`) and every service call, and the chart injects `SUPERSET_SERVICE_USER`/`SUPERSET_SERVICE_ROLES` — so the embed service user is `Admin`, not a role-less `Gamma` that the mint endpoint rejected.
- **Dashboards now import into Superset on create.** MCP `create_dashboard` calls `buildDashboard(...)` after save (delegated domain token), so a created dashboard exists in Superset to embed instead of only in the OS store.
- **The embed is mounted, not summarised.** `EmbedPanel` now mounts the real `@superset-ui/embedded-sdk` `embedDashboard(...)` against the embedded UUID with the OS-minted guest token, with clean unmount. `mintEmbed` now surfaces a `reason` when it can't embed (honest failure instead of silent mock).

### Fix — Monitoring shows real numbers, not placeholders
- **Cost lens reconciles live LiteLLM spend.** `collectCost` always reads LiteLLM `/spend/tags` (parsing the real `individual_request_tag`/`total_spend` shape, dropping `User-Agent:` transport noise), and `governance/cost.ts` seeds its cap ledger from that live read so cap-breach alerts fire on real usage. (On STACKIT the self-hosted models are free per-token, so spend is honestly `$0` — grouped, not mocked.)
- **Native trace drawer fills Context pack + Logs.** `fetchTrace` derives `contextPack` from the generation observation's `input.messages` (falling back to the governed trace input) and emits structured `logs` lines per observation — so the drawer shows the real packed context + `principal=… decision=allow`, not empty arrays.

### Fix — Science infra: predictor + feature store come up (Science tab was red)
- **Featureform's Postgres backend is provisioned on existing volumes.** A new `post-upgrade` reconcile Job idempotently creates the `featureform` role+db in the plain-engine Postgres (the init script only ran on first boot of an empty volume, so a database added later never existed — Featureform looped forever authenticating). 
- **KServe sample model is seeded.** A new `post-upgrade` Job trains + uploads the `churn_model` artifact to the path the InferenceService expects, so the predictor's storage-initializer stops crash-looping and the service goes Ready. Both hooks are chart-native and idempotent.

### Fix — Software: OS-built apps actually build + can deploy (#132)
- **The scaffolded CI is a real build, on both paths.** The legacy `POST /api/software` scaffolder emitted an `echo` stub with an external `actions/checkout` the sovereign runner can't run; it now emits the same real `runs-on: docker` in-pod `docker build && push` workflow the app path uses, and seeds a `REGISTRY_PASS` secret so `docker login` works.
- **Workflow is committed last.** `scaffoldRepo` now commits all source before `.forgejo/workflows/*`, so the CI-triggering push lands against a complete build context (matching the proven demo-app seed order).

### Feature — medallion-layer choice on agent DATA grants
- A data grant can now target **Bronze / Silver / Gold**. The Simple-builder selector shows **only the layers actually built** for that dataset and defaults to the **highest available** (Gold if built, else Silver, else Bronze); it hides entirely when a dataset has a single layer. The choice is enforced server-side for `get_dataset`/`profile_dataset` (the granted layer's physical FQN is injected, viewer-aware, with graceful fallback to the furthest built layer), and steers ad-hoc `query_data` via discovery. Backward-compatible: no layer = Gold; existing `system.yaml` stays byte-stable. Metrics/Dashboards remain Gold-locked.

## [os-ui 0.3.1] — 2026-07-14

### Hardening — Northpeak durability guards (belt-and-suspenders on the 0.1.99 fix)
- **CTAS won't zero-out populated data.** `assertNoZeroRowReplace` (in `lib/data/build/live-clients.ts`) runs before any `CREATE OR REPLACE TABLE <fqn> AS <select>` in the Silver/Gold build + promote-publish paths: if the target already has rows and the incoming SELECT would produce 0, it aborts instead of replacing. Fresh targets / >0-row results / transient probe errors proceed normally.
- **Post-upgrade OPA hook re-asserts domain self-principals.** A new `post-install,post-upgrade` Job re-`PUT`s each governed domain's self-principal into live OPA (the row-filter membership the governed query tool depends on), idempotent + non-blocking — so a stray UI policy push can never leave a domain's tables invisible across an upgrade.

### Repo hygiene
- Removed two stray tracked duplicate files (`* 2.*`); added a `.gitleaks.toml` allowlist for the obviously-fake unit-test password fixtures.

## [os-ui 0.3.0] — 2026-07-13

### Feature (Phase 1, behind a flag) — external-warehouse connector foundation
- First slice of "connect any lakehouse, govern it in one plane": a design (`docs/external-warehouse-connectors.md`) and the pure, unit-tested core under `lib/connections/warehouse/` — a typed `WarehouseSource` model, a `trinoCatalogProps()` generator (**AWS Glue** fully implemented, IRSA-only, provably no static keys; Snowflake/BigQuery/Databricks/Fabric are typed stubs), external-table FQN mapping, and a `FederatedDataset` shape + mapper. All gated behind `EXTERNAL_CONNECTORS_ENABLED` (**default off**), so nothing changes at runtime yet. Live catalog registration, OpenMetadata ingestion, cloud auth, and import-as-product are Phase 1b/2 (they need a real source to validate). Architecture: external sources federate through **central Trino** (one governed path + OPA); a *data product* = imported into the sovereign Iceberg lakehouse; OpenMetadata mirrors the estate for discovery.

## [os-ui 0.2.1] — 2026-07-13

### Fix — embedded Superset dashboards: "guest token mint failed" (4 stacked defects)
- **Embedding was never enabled.** Superset gates its guest-token API behind `FEATURE_FLAGS.EMBEDDED_SUPERSET`, which was off → 403 for everyone. Now set in `superset.configOverrides` (with `GUEST_ROLE_NAME = "Gamma"`, a 300s token TTL, and a **stable** `GUEST_TOKEN_JWT_SECRET` from `extraSecretEnv` — was the insecure 27-char default).
- **The mint call was unauthenticated.** `realEmbed().mint()` POSTed the guest-token endpoint with no CSRF/cookie/service-user headers (the source of the 400/403). It now runs the same authenticated handshake as every other Superset call — shared `lib/superset/auth.ts` (`csrf`/`serviceUser`/`serviceHeaders`).
- **Dashboards weren't registered as embeddable.** Guest tokens require a dashboard's *embedded UUID*, not the OS id. New `ensureEmbedded()` auto-registers a dashboard for embedding on first view and mints against that UUID; the embed API now returns `embeddedId` for the SDK.

## [os-ui 0.2.0] — 2026-07-13

### Feature — Simple agent-builder bundle: usable grants + clearer phases

The "What your team can use" section is now truthful and the 5-phase builder is clearer:

- **Grants that actually work.** The section grows from Data+Knowledge to **Data · Knowledge · Files · Connections**, each with a **Read / Can-write** toggle that **auto-provisions the matching governed tools** into the team (via `capability-tools`), so granting a resource makes it *usable* — not just listed. Writes run directly or need approval per the team-wide safety setting (one honest knob, noted inline).
- **Trigger moved to Define.** "How is this team triggered?" (Manual · On schedule · Called by another system) + the Outlook-style recurrence editor now live in **Define** (team setup, next to the safety preset). **Run** is execution-only.
- **Run leaner, Evaluate richer.** The per-agent status + output breakdown moved from Run into **Evaluate** (understanding the run = evaluating it); Run shows progress + the final result.
- **Runtime badge.** The builder header shows whether a team is **Graph (LangGraph)** or **Autonomous (Hermes)**.
- **Sharper AI judge.** Define's description is now persisted and feeds the Evaluate judge (which also auto-gathers granted-workflow tacit criteria, 0.1.100) — so it grades the real task, not a generic one.

## [os-ui 0.1.103] — 2026-07-13

### Change (UX consistency) — Metrics & Dashboards are single-view now, with the standard Promote button
- **Metrics detail** drops its Explore/Govern/Alert subtabs for one scrolling view: Explore → **Alerts inline** → a Lifecycle row (Promote + Archive/Delete/Version) at the bottom.
- **Dashboards detail** drops its subtabs the same way: View (Superset embed) → **Reports inline** → Lifecycle row.
- New shared `components/lifecycle/PromoteButton.tsx` gives every tab the **same Promote experience**: a non-approver owner's press *files a request* ("⏳ Requested — awaiting a domain admin's approval", persisted across reload) and an approver promotes directly; Certify runs behind a confirm. Backed by new `dashboards`/`metrics` `[id]/promote` routes (with GET status) on the 0.1.102 `promoteOrRequest` contract.

## [os-ui 0.1.102] — 2026-07-13

### Change (governance) — Promote = propose everywhere (no more "requires a Domain admin" dead-end)
- Pressing **Promote to Shared** on an artifact you OWN but can't yet approve (creator/builder) now **files a promotion request** that a domain-admin approves in Governance — consistent with the Data/Files/Knowledge tabs — instead of a hard 403. Approvers still promote directly. New shared `promoteOrRequest` ladder helper; the **Apps, Connections, Agent-systems and generic Artifacts** promote routes now route through it, each with a GET status endpoint so the UI can show "awaiting approval". Separation-of-duties is unchanged (only the owner may propose; a non-owner still can't publish someone's draft; certification stays admin-only).
- An OS-wide audit confirmed **Builders can already create/build in every tab** — the 0.1.95 edit-scope tightening only affected editing others' shared work, not creating your own. (The one exception, metric-define, was fixed in 0.1.101.)

### Polish — Users & Access
- The **Reset password** button (admin → edit user → set a new temporary password) is now a full-size, prominent button with a 🔑 label (was a tiny link).

## [os-ui 0.1.101] — 2026-07-13

### Fix (cohort blockers) — metric creation for Builders + the Cube "did not resolve" collision
- **Builders can define metrics again.** The 0.1.95 edit-scope tightening accidentally gated metric definition behind *structural dataset edit* (owner/domain_admin/admin), so a Builder defining a metric on a shared-in-domain gold mart got "Not permitted to edit this dataset". Defining a metric is additive semantic work (the Metrics tab is built for it), not a structural edit — `defineMeasure`/`removeMeasure` now use a dedicated scope: the dataset **owner** (any rank) or a **Builder+** who can use the data. Structural edits (silver/gold rebuild, docs, promote, delete) stay owner/admin.
- **"metric did not resolve" root cause fixed.** Two datasets with the SAME name map to the same Cube model file (`metrics/<slug>.cube.yml`) and the same domain gold table, so the model-sync sidecar overwrote one with the other every poll — a newly-defined measure silently vanished from live Cube. Now `createDataset` rejects a duplicate name within a domain (409, clear message), and `buildCubeModels` collapses any pre-existing duplicate to one entry per file (keeping the richest) so the delivered payload can never thrash.

## [os-ui 0.1.100] — 2026-07-13

### Builder — Build & Evaluate phases now show completion (first slice of the 0.2.0 bundle)
- The **Build** phase gets a green ✓ in the stepper once the team is built, the button reads **Rebuild** afterward, and a "Last built …" note shows when — no more guessing whether a build finished.
- The **Evaluate** phase gets a green ✓ once a run's deterministic checks all pass.
- **Sharper AI judge:** the Evaluate judge now scores against the REAL task — it uses a persisted team description when set and **auto-gathers the success criteria (tacit notes) from the granted knowledge workflows**, instead of a generic fallback. Groundwork also landed for capability→tool auto-provisioning (`lib/agents/capability-tools.ts`) surfaced in the next bundle slice.

## [os-ui 0.1.99] — 2026-07-13

### Fix (data governance) — a UI policy push could blank every domain-scoped table
- Root cause of "Northpeak Campaign Performance suddenly empty": the governed query tool runs **as the domain name** (`user.domains[0]`), so OPA must carry a **domain self-principal** (`agentic-leader-q3-2026 → domains:[agentic-leader-q3-2026]`) or the Trino row filter resolves the domain's membership to `[]` and injects `WHERE false` → **0 rows** (the data is untouched, just hidden on read). Two durable guards so a publish/promote can never blank a table again:
  - `lib/data/policy/compiler.ts` now **emits a domain self-principal for every governing/shared domain** on every compile — independent of whether the user directory lists it.
  - `lib/data/build/live-clients.ts` now pushes governance as an **upsert-per-key merge** (`PUT …/principals/<id>`) instead of a whole-object replace, so a push can never delete the statically-seeded self-principals it didn't recompute.
- Live remediation applied: re-pushed the `agentic-leader-q3-2026` / `sales` / `test` self-principals; the 14 Northpeak rows are visible again for the domain session user.

## [os-ui 0.1.98] — 2026-07-13

### Fix (blocker) — bounded / full-in-scope agent teams could not write or create artifacts
- An agent system's **safety preset** (Read-only · Read+propose · Read+bounded · Full-in-scope) was ignored by the run-time tool executor: **every** write tool (`upload_file`, `create_dataset`, `author_knowledge`, …) was unconditionally held for Governance approval, so even a team explicitly set to **Read+bounded** or **Full in-scope** could never create a new file/dataset — it reported "requires approval — enqueued to Governance" and stalled. The executor (`lib/agents/build/os-tools.ts`) now honours the preset, matching `governance.ts` `resolveAutonomous`: `read-only`/`read-propose` still HOLD writes for a human; `read-bounded`/`full-in-scope` run the write **directly as the acting user**. This is safe — the write still passes gate 2 (the runner's own OPA/DLS/role, exactly what they could do by hand in the UI), and promotion (Personal→Shared) keeps its own separate approval gate. Creating a Personal-lane artifact never needs approval, so a team acting as its runner no longer waits on one.

## [os-ui 0.1.97] — 2026-07-13

### Feature — business-friendly recurring schedule + run/build/deploy prominence
- The agent-system "On schedule" trigger now uses an **Outlook-style recurrence editor** (Daily · Weekly · Monthly + time + weekday picker, plain-language summary like "Every Monday at 09:00"), generating the cron under the hood; a raw-cron "Advanced" option remains for power users. The trigger TYPE is shown read-only in the header; changing it happens in the editor. Build / ▶ Run / Deploy are now consistently prominent primary buttons.

### Fix — a completed run no longer shows as still "running"
- The run route set the persistent running flag on COMPLETION (backwards), so a finished manual run lingered as "running" with a live Stop button. It now clears the flag when the run finishes.

### Change — DuckDB → Trino labels
- The query engine was Trino stack-wide since 2026-06-29, but the Components tab, the data-parity proof, a tutorial label, and the license list still said "DuckDB". Relabeled to Trino.

## [os-ui 0.1.96] — 2026-07-13

### Feature — the agent-system builder is now a clear 5-phase flow
- **Simple mode is reorganized into Define · Design · Build · Run · Evaluate.** Define (name, description, safety/rights preset up front); Design (the team, with a **template picker** on "+ Add agent": curated roles — blank/analyst/recommender/reviewer/researcher — plus marketplace-shared agents); **Build** (renamed from "Build & run", compile+verify only); **Run** (a separate step with three clear trigger modes — Manual · On schedule · Called from system — the schedule editor moved here, and a one-click **▶ Run** of the defined task replacing the confusing "What should the team do?" prompt, with an optional per-run input; results shown here); **Evaluate** (diagnostics + Langfuse + PDF report relocated here, plus deterministic **checks** — non-empty · no error/denial · within budget — and a one-click **LLM-judge** scoring Clarity/Grounding/Actionability). All phases still write the same `system.yaml` through the same commit path and reuse the existing run engine; Developer mode is unchanged.

### Fix — creating a metric no longer errors while Cube catches up
- **Defining a metric no longer shows a scary `Cube 400 … not found for path`.** Runtime-defined metrics reach Cube via a model-sync sidecar within a few seconds; the app used to query the new measure immediately and hard-fail. Now the define + live-preview paths **fail-soft**: the metric is always saved and the UI shows "✓ saved — its live value appears within a few seconds as Cube syncs" instead of an error. The sidecar poll interval was shortened (30s → 5s) for snappier convergence, and a hint nudges you to promote the dataset to Shared + build Gold if its metrics aren't reaching the query engine. (Corrected a stale code comment that wrongly claimed Cube schema was git-deployed.)

### Change — consistent artifact-tab headers
- **The All/My/Shared/Marketplace scope pills and the Show-archived / + New buttons now render at a consistent size and alignment across every tab**, and **Connections** gained the standard Show-archived + "+ New connection" header controls it was missing.

## [os-ui 0.1.95] — 2026-07-13

### Governance — shared artifacts are owner/admin-managed; sharing is admin-approved
- **A shared (domain/marketplace) artifact can now only be edited, archived, deleted, or un-shared by its OWNER (even if just a Builder), a domain admin of the owning domain, or a platform admin.** A non-owner Builder may view and use shared artifacts but can no longer modify or archive someone else's. Enforced fail-closed server-side via one `canManageArtifact` helper across every artifact type (data, files, knowledge, personal knowledge, connections, agents, software, dashboards, big bets, science models) — including the demote/revoke-sharing path — with the edit/archive/delete UI controls hidden from non-owners as defense in depth. (This also fixed a latent gap where domain admins could not manage in-domain artifacts, and where dashboards were owner-only.)
- **Approving a Personal→Shared promotion now requires a domain admin or platform admin** (a Builder can still press Promote to FILE the request; it just no longer self-approves). Shared→Certified/Marketplace stays platform-admin-only. MCP approval tools (`approve_promotion`, `publish_knowledge`, `promote_connection`) raised to domain-admin.

### Fix — creating a metric no longer 400s on an id column
- **Slicing a metric by a dataset's primary key (e.g. `campaign_id`) no longer throws a Cube 400.** The dimension picker offered the key column, but the Cube view intentionally excludes the key — so the query targeted a non-member. The picker and the query builder now reconcile requested dimensions against the view's real members (mirroring the region-RLS fix), dropping non-members fail-soft instead of erroring.

### Fix — Knowledge workflow step titles are fully readable
- **Workflow step boxes now wrap the full title onto multiple lines** instead of truncating past ~3 words; the box grows to fit so nothing is clipped.

## [os-ui 0.1.94] — 2026-07-13

### Fix — Ask the OS input pinned to the bottom
- **The Ask-the-OS message log now fills the drawer and the input box stays at the bottom.** The log inherited a 460px max-height cap, so in the tall assistant drawer the input floated mid-panel and long answers were awkward to read. The log now grows + scrolls, with the input + Send button anchored at the end so the whole conversation is readable.

## [os-ui 0.1.93] — 2026-07-13

### Fix — Simple builder: tools land on the right agent
- **Adding a tool to an agent in the Simple builder now shows on THAT agent**, not on a different (the first) one. Tools are managed per-agent: an agent that had no explicit tool list used to inherit the whole system pool, so a tool added to one agent appeared on every inheriting agent instead of the one you clicked. Add/remove now affect only the target agent (siblings are frozen to their current set), preserving the invariant that an agent's tools are a subset of the system grant pool.

### Fix — Simple builder: any agent is deletable
- **You can now delete any agent card, including the START agent.** Deleting the entrypoint hands START to the next remaining agent automatically (or clears it when the team becomes empty), so you're never stuck with an agent you can't remove.

### Feature — restore an older version of an agent system
- **Agent systems now show Version history with per-version Restore** in the system detail (it was hidden). Every save already commits `system.yaml` + the agent files to a git repo, so the full history was there — restoring re-commits a prior version onto HEAD (auditable).

### Change — navigation
- **Marketplace moved under Plan** (below Big Bets), and **Tutorials + MCP moved up to the top entry area** (under Cockpit), so the sidebar groups read more naturally.

## [os-ui 0.1.92] — 2026-07-13

### Change — multi-agent teams run cheap-first (big token + latency saving)
- **A team run's fast/gatherer nodes now run on the STANDARD model (gpt-oss-20b), not the 235B reasoning model.** The graph's exec ("tools") tier previously followed the reasoning model, so *every* node — even read-only data-gatherers — ran on Qwen3‑235B, the main token/latency sink of a run. Now the Auto per-node router genuinely saves: read-only gatherers → the cheap standard tier, and only write/decide/synthesis nodes escalate to reasoning. gpt-oss-20b's "harmony" tool-call framing is stripped defensively, so it degrades gracefully. Fully reversible: set `LITELLM_TOOLS_MODEL` (or the `tools` model role) back to the reasoning model, or pin any single agent to **Reasoning**. The between-node context budget already sizes to the smaller model window, so this is safe with the 128k standard model.

### Feature — Science tab gains the OS-wide lifecycle
- **A model-as-a-service can now be Archived → Restored / Deleted**, the same consistent lifecycle every other artifact tab has (it was the only tab missing it). The controls sit in the model's tier-ladder detail card; archive is reversible, delete is reachable only once archived and is edit-scoped (owner or domain Admin, agents rejected). Adds a `model` lifecycle kind, an `archived` flag that drops archived models out of the tab list, and the `/api/science/model/[model]` archive/unarchive/delete route.

## [os-ui 0.1.91] — 2026-07-13

### Fix — multi-agent run no longer 400s on ContextWindowExceededError
- **The last agent in a longer team (e.g. the campaign "recommender") could crash** with `LiteLLM 400 ContextWindowExceededError` (~192k input + 8k output = the whole 200k window, zero slack). Two root causes fixed: (1) the input budget was `contextWindow − reservedOutput`, but the request *also* sends `reservedOutput` as `max_tokens` — double-spending the reserve; `inputBudget` now subtracts an additional **safety headroom** (~4% of the window) so `input + max_tokens` stays strictly under the window. (2) the token estimator ignored `tool_calls` argument JSON (a big `query_data` call carries none in `content`) + the message envelope; it now counts both, so the budget reflects the real request. A new invariant test guards `inputBudget + reservedOutput < contextWindow`.

### Fix — PDF run report renders real tables
- **The downloadable run report showed markdown tables as raw `| a | b |` text.** The PDF now parses GFM tables in each agent's output and the final output and renders them as **real tables** (jspdf-autotable), with headings/bullets formatted instead of dumped as markdown source.

### Change — Connections lifecycle is discoverable
- **Archive / Restore / Delete for a connection moved out of the buried "Capabilities" expand** into the card's action row, next to Promote / Unshare — the same clear, consistent lifecycle placement every other artifact tab uses (live → Archive; archived → Restore + Delete, reachable via the "Show archived" toggle).

### Change — system.yaml is a read-only source view (Developer mode)
- **The raw `system.yaml` is now read-only by default with an explicit "✎ Edit YAML" button**, and moved to the **last** Developer tab (the tabs open on Build & run). It stays the single source of truth behind the canvas, grants, and per-agent fields — but raw hand-editing is now a deliberate opt-in rather than the first thing you see.

## [os-ui 0.1.90] — 2026-07-13

### Feature — Simple builder can grant Data & Knowledge
- **The Simple (guided) agent-system builder now has a "What your team can use" section** — plain add/remove chips for **Data** and **Knowledge**, sourced from the same role-scoped `grants/available` catalog the Developer grants table uses and written to the same `grants.data` / `grants.knowledge` (at **Read**). Previously grants lived only in the Developer-only "Grants & routing" tab, so a non-coder building in Simple mode could not attach the dataset or workflow knowledge their team needed. Write access and Metrics/Connections stay in Developer mode to keep Simple uncluttered.

### Change — Simple is the default builder mode for everyone
- **The agent builder now opens in Simple mode for all roles** (admins included), with **Developer** one click away and the choice remembered per user. The raw `system.yaml` editor, canvas, and full grants table remain exactly as they were — in Developer mode — for people who want them. `system.yaml` is still the single source of truth behind every surface; only the default landing changed.

### Change — Knowledge sub-tabs reordered
- **Knowledge opens on Workflows first, then General.** The two sub-tabs were swapped and the tab now lands on Workflows by default (the day-to-day surface), with General (the domain operating manual) second.

## [os-ui 0.1.89] — 2026-07-13

### Feature — revoke sharing (demote down the ladder)
- **You can now pull an artifact back down the sharing ladder.** Previously things only promoted up (Personal → Shared → Certified/Marketplace) with no way back. A governed **demote / "Revoke sharing"** now lowers visibility one rung (Marketplace → Shared, Shared → Personal) for datasets, files, knowledge, agents, apps, connections, and marketplace artifacts — via a central `demoteThroughSeam` mirroring promotion, with the same **role gates** (revoking from Marketplace needs Admin; Shared → Personal needs the owner or an in-domain Builder) and **lineage guards** (blocked if another artifact still depends on it — never orphan a live consumer). Every demote is audited. A "Revoke sharing" control with a confirm sits in each artifact's detail.

### Feature — run diagnostics + downloadable PDF report
- **A simple diagnostics table at the bottom of a completed agent run** — one row per agent (model · tier · governed calls · decision), with tokens / latency / cost columns when the Langfuse trace is reachable (honest "metrics unavailable" note otherwise; the table always renders from the run's own data).
- **A "Download PDF report" button** on a completed run — exports the task, per-agent status + output, the diagnostics table, and the final output as a shareable PDF, so students can send their results to instructors.

### Fix
- **Agent tool-grants show knowledge by NAME, not a raw id.** The grantable-knowledge list only included workflows (`wf_…`) and missed personal knowledge entries (`pk_…`, e.g. "Purchasing Details"), so a granted personal-knowledge item rendered as its machine id. Both are now listed with their titles; a genuinely orphaned grant reads `(removed) …` instead of a bare id.
- **Workflow diagram no longer clips step text, and boxes are clearly editable.** Step boxes are wider with a full-title hover tooltip (no more cut-off), a pointer cursor + hover lift + ✎ badge signal that a box is editable (click → step editor), and the derived Mermaid view is labelled "(read-only)".

## [os-ui 0.1.88] — 2026-07-13

### Feature — Admin → Users & Access is now the one full user-admin console
- **An admin can set (and reset) a user's password in the console.** The live Users & Access surface (`/platform/access`) previously delegated to an identity provider that didn't deliver a credential on this deployment, so invited users couldn't sign in. It now has a **Password** field (Show/Hide, Copy, Generate-strong, live strength meter) validated on client **and** server; the password is hashed (scrypt) and the created user **can log in with it** (proven by test). Existing users get a **Reset password** action. (The earlier 0.1.86 password field had landed on a deprecated component that isn't live — this puts it on the real surface.)
- **Domain picker is a dropdown with checkboxes** (was pill toggles), in both invite and edit.
- **Deactivate asks for confirmation.** **Offboard** now appears only for **deactivated** users (who sort to the bottom), and opens a strong-danger dialog warning the account + its personal "My artifacts" are permanently deleted — with an option to **reassign "My artifacts" to another user** (data · files · knowledge · agents · software; dashboards/bigbets/science reported as deferred) before deletion. Guards: can't deactivate/offboard yourself or the last active admin.

### Fix — Cube RLS no longer 400s on a missing dimension
- **A metric on a domain-scoped cube no longer fails with `'region' not found`.** The per-viewer `securityContext` spread low-cardinality attributes (e.g. `region`) that Cube turned into RLS filters — 400ing on cubes without that dimension. `cubeLoad()` now scrubs the security context against the queried cubes' **actual** dimensions: structural keys (identity/domain/scope) are always kept (RLS stays sound), attributes no queried cube has are dropped. General guard for every cube.

### Cleanup — model settings show only the sovereign set
- The model picker/catalog now presents exactly **`sovereign-default` (gpt-oss-20b) · `sovereign-reasoning` (Qwen3-VL-235B) · `sovereign-embed` (Qwen3-VL-Embedding-8B)** plus **`sovereign-mock`** (offline/testing, the default for every role when no live gateway model is wired). Stale duplicate aliases (`sovereign-vision`/`sovereign-premium`/`sovereign-reasoning-fast`) removed. Still admin/env-configurable.

## [os-ui 0.1.87] — 2026-07-13

### Feature — free-form agent-team scaffolder + `retire_knowledge` MCP
- **"Describe what your team should do" now builds a real multi-agent team from free text.** A plain-language description is turned by the reasoning model into a validated linear team (agents + per-agent instructions + handoff edges), applied through the same `system.yaml` commit path as everything else; the LLM only proposes *structure* — tools are derived deterministically by the suggester within the caller's role floor, models stay Auto. The deterministic structured fast-path (`add a <role> sub-agent…`) still applies; a malformed plan is rejected, never written.
- **`retire_knowledge` MCP tool** — archive (reversible) or delete (physical) a knowledge workflow via MCP, closing the gap where the MCP surface could author/publish/index knowledge but never retire it. Lineage-aware (blocked if any app/agent still consumes it) and role-gated exactly like the UI delete.

## [os-ui 0.1.86] — 2026-07-13

### Fix — an admin can set a user's password in the UI (create + reset)
- **The New-user form now has a Password field**, so an admin can set a user's initial password directly instead of it silently posting an empty one (which produced an un-loginnable account). Includes a **Generate strong password** button, show/hide + copy, and a live strength meter; the password is validated for strength on the client **and** server (empty/weak → 400, no account created). The server always hashes it (`lib/core/password`) — plaintext is never stored or logged.
- **Reset password** for an existing user: a platform-admin action in the user edit panel (same field + generate/strength), gated to admins (domain_admins are denied). A newly created/reset user is asked to change the password at next login.

## [os-ui 0.1.85] — 2026-07-12

### Fix — an app's declared knowledge is now authoritative (stale dependency edges are pruned)
- **Removing a knowledge reference from an app now drops its `consumes`/lineage edge.** Committing an app's `app.yaml` only ever *added* knowledge consumes edges (a union), never removed them — so an undeclared workflow stayed a live dependency and blocked deleting it (delete is lineage-aware). `commitToApp` now **reconciles** the knowledge consumes edges to exactly match `declares.knowledge` (adds new, drops undeclared, keeps labels), on every governed commit including via MCP. Non-knowledge edges (data/connections) are untouched.
- **Also fixed a latent parse bug:** `findFile` matched a suffix before the exact root path, so `app.yaml` could resolve to `manifests/app.yaml` (the k8s Deployment, which has no `declares`) and silently parse empty declares — which would have undermined the reconcile on real templates. It now prefers an exact root match.

## [os-ui 0.1.84] — 2026-07-11

### Feature — a simpler agent-system builder (without taking anything from developers)
- **Simple ⇄ Developer view toggle on the Agents builder.** Simple mode is a guided, plain-fields flow for non-coders; Developer mode is today's full surface (React-Flow graph, Monaco YAML, raw `AGENT.md`/`MEMORY.md`, explicit tool grants) — unchanged. Both edit the **same `system.yaml` / `AGENT.md`** through the same commit path, so a developer sees exactly what Simple mode produced (a test asserts the two produce byte-identical YAML). Default: Simple for builders/creators, Developer for admins; the choice is remembered.
- **The four simplifications in Simple mode:** (1) a prominent **"Describe what your team should do"** box that scaffolds the system; (2) a **guided linear flow** (Describe & name → Your team → Build & run) instead of a canvas; (3) **plain per-agent cards** — Role + an Instructions textarea (losslessly mapped to `AGENT.md`) with the model shown as **Auto** (0.1.82) and its resolved tier; (4) **auto-suggested tools** as accept/remove chips derived from each agent's role, intersected with the caller's role-scoped catalog (never offered a tool above their floor). *(The describe-to-scaffold currently recognizes the structured "add a <role> sub-agent…" class; a richer free-form scaffolder is a follow-up.)*

## [os-ui 0.1.83] — 2026-07-11

### Fix — the general domain-knowledge card is now versioned too
- **Everything in the Knowledge tab now has version history.** Workflows and personal "My knowledge" already snapshotted on every edit with a reversible restore; the general **domain-knowledge card** (the pinned, domain-wide operating manual) was the only knowledge artifact without it. It now uses the identical mechanism — a snapshot on every content change (no churn on no-op saves), a newest-first view-scoped history, and an edit-scoped, itself-reversible restore (the current card is snapshotted before a restore) — surfaced via the same shared **Version history** panel and a new `/api/knowledge/domain/[domain]/versions` route.

## [os-ui 0.1.82] — 2026-07-11

### Feature — Auto model selection per agent (faster multi-agent runs)
- **The OS now picks the right model for each agent automatically.** A node's model defaults to **Auto**, which classifies the agent from its **granted tools** (read-only gatherers — `query_data`, `search_knowledge`, `list_*`… → the **fast** model; agents that write/decide, or have no tools, i.e. pure judgment → the **reasoning** model), with a role/keyword tiebreak. The chosen tier + the reason ("read-only gatherer: …") show in the agent editor and the run drill-down. It's **deterministic** (no LLM call — decided from tools), and an explicit **Reasoning/Standard pin always overrides**. This lets a team put its analysts on the fast model and reserve the big reasoning model for the evaluator/recommender — cutting run time. (An LLM tie-breaker for genuinely ambiguous agents is a defined seam for later.)

### Fix — Software: a visible Promote button
- **Apps can now be promoted from the header, like every other artifact.** The Promote action existed but was tucked inside the collapsed "Manage" panel, so it looked missing. There's now a prominent, role-gated **Promote to Shared / Promote to Marketplace** button next to the app's visibility badge (Personal→Shared for Builder+, Shared→Marketplace for Admin); the full "cascades to the app's data/files/MCP" context still lives in the Manage panel.

## [os-ui 0.1.81] — 2026-07-11

### Feature — live progress: "Running the team…" now shows what's happening *now*
- **A team run streams its progress.** Instead of a static banner, the Run panel now shows the current step live — e.g. `performance_analyst · query_data — running · step 5` — and lights up each agent in the path as it starts (▹) and completes (✓). Implemented over Server-Sent Events (reusing the same streaming grammar as the interactive software-team builder), with the exact same final result on completion and a clean fallback to the non-streaming path if the stream isn't available — never a stuck spinner.

### Security — close two unauthenticated routes (GATE-5 sign-off)
- **`POST /api/classify`** now requires a session. It proxies to the LLM gateway with the server-side master key; leaving it open allowed anonymous, unmetered use of the paid model. Fixed with `requireUser()` (401 for anon).
- **`POST /api/software`** now requires a session. It creates a real Forgejo git repository and writes files as the platform service account; the GET was already gated but the POST was not. Fixed with `requireUser()`.
- (Found by a full cohort security audit; every other area — fail-closed governance, role/DLS isolation, MCP front door, destructive-action gates, secret handling, participant lockdown — passed.)

## [os-ui 0.1.80] — 2026-07-11

### Feature — the Context Librarian (need-aware context curation)
- **A governed, embedding-driven curator that gives each agent the context it actually needs — in full — instead of a naively head-truncated dump.** New `lib/infra/context/librarian.ts` (`curateContext` + `curateThenAssemble`) runs in front of the budget packer: when the candidate pool exceeds the model window it embeds the agent's *need* (role + task) and each competing chunk with the `sovereign-embed` model, keeps pinned + the clearly-relevant material **whole**, compacts the mid-relevance, and drops the low — so a recommender reliably receives its predecessor's **complete scorecard** by relevance rather than the first N rows. It only curates when crowded (no embedding cost in the common case), only ever selects among **already-entitled** items (DLS/OPA preserved — a curator, never a bypass), and **falls back gracefully** to the existing packer if embeddings are unavailable. Wired into the multi-agent handoff and the Talk-to copilots; a Phase-2 LLM-curator escalation seam is in place for later.

### Fix — multi-agent runs are now reliable *and* readable
- **The trailing-semicolon SQL loop is gone.** An agent whose generated SQL ended in `;` hit Trino `SYNTAX_ERROR` and retried dozens of times. The governed `query_data` path (and Talk-to's NL→SQL) now strip a trailing `;` via a shared guard; a genuine multi-statement query gets a clear *"Only one SQL statement is allowed — remove extra semicolons"* instead of a raw stack trace.
- **A node that keeps erroring now stops.** The loop-breaker also trips after several *consecutive tool errors from the same tool* (not only identical calls), so a run can't burn its budget thrashing on slightly-varied bad SQL — it breaks to a graceful final answer and hands off.
- **"DENIED" now means denied.** A bad-SQL/execution failure was mislabeled as a policy denial. Node/step status now distinguishes **`error`** (execution — e.g. a Trino syntax error) from **`denied`** (a real OPA/grant denial), so the run view stops implying a permissions problem when there isn't one.
- **Run asks what you want done.** The Run panel now has a *"What should the team do?"* prompt; an empty box uses a real, purpose-derived task instead of the old literal `"Test invocation"` default that made the recommender no-op.
- **The "team, step by step" is legible.** Consecutive repeated tool rows collapse (34 error rows → one `query_data ×34` line), each agent shows a calm correct status, the **Final Output** is a clearly-separated markdown panel, and a one-line summary up top says whether the run *"Completed through … → END"*, stopped at the step cap, or failed — so you can tell at a glance if it worked.

## [os-ui 0.1.79] — 2026-07-11

### Fix — agent loop-breaker (the platform now stops degenerate re-query loops)
- **An agent that re-fires the identical tool call no longer loops forever.** A node could get stuck ("I have the data, now I'll compute it manually…") re-running the *same* `query_data` every turn, re-appending the full result each time — ballooning context to ~60k tokens and consuming its whole step budget without ever handing off. The ACT loop now **deduplicates identical tool calls**: the first runs normally (OPA-gated as always), and each exact repeat is **not re-executed** — the agent gets a short "you already have this result above; compute and continue" note (progressively firmer), which keeps context bounded. After a small repeated-call budget the node **breaks to a graceful final answer and hands off** instead of thrashing. General harness hardening — it protects every agent a builder creates, not just the seeded example. Also nudges team agents to aggregate in a single SQL query rather than fetch raw rows to "compute manually."

## [os-ui 0.1.78] — 2026-07-11

### Fix — multi-agent handoff carries the full teammate result; more step headroom
- **A teammate's result is no longer truncated in the handoff.** The inter-node handoff compacted a prior node's row-set to its first 5 rows, so a recommender receiving an evaluator's multi-campaign scorecard saw only the head and re-queried the rest — exhausting its step budget. The handoff now keeps up to **60 rows** whole (still bounded by the overall handoff budget), so a downstream node reasons over the complete scorecard instead of re-deriving it. (A proper embedding-driven context curator — the "Context Librarian" — will supersede this heuristic.)
- **More step headroom.** Single-agent runs `assistantMaxSteps` 20 → **30**; team-run per-node `agentTeamNodeMaxSteps` 40 → **60** (both still env-overridable; the runaway cap remains finite).

## [os-ui 0.1.77] — 2026-07-11

### Agents — Build & Run polish (observability + reliability)
- **Per-agent run drill-down.** Each agent node in a run is now expandable — click it to see its **input** (the handoff context / role prompt it received), its **output**, its **status** (ok/failed/denied), and each tool call's **args → result**. The per-node cards now also **persist across a tab-switch** (previously a reseed fell back to a flat call table).
- **Team runs get a higher step cap.** A single analytical node (an evaluator scoring N campaigns, a recommender reasoning over a full scorecard) legitimately needs more than the single-agent one-shot cap of 20. Team runs now use `agentTeamNodeMaxSteps` (env `AGENT_TEAM_NODE_MAX_STEPS`, default **40**). And when a node does hit the cap it now makes one final synthesis pass and returns its **best answer** with a soft cap note, instead of a bare "reached the step limit" stub.
- **Build: Langfuse check is "needs a run first," not a failure.** Before an agent's first run there is no trace to verify, so the observability row used to show ✗. It now shows a neutral **"needs a run first"** state that does not count against the build; it verifies ✓ once a run has produced a trace.

## [os-ui 0.1.76] — 2026-07-11

### Fix — multi-agent "Build & Run" is now observable and correct
- **Inter-node handoff no longer drops structured output (the real bug).** In a team graph (e.g. `performance_analyst → margin_analyst → evaluator → recommender`), each node's handoff was built from its *narration* (`finalText`) only — every node's **tool outputs** (`query_metric`/`query_data` rows, the evaluator's scorecard) were discarded, and the narration could be further truncated by the handoff budget. So the recommender asked the user for a scorecard it should have received. Now each node's handoff carries its narration **plus a compact rendering of its material tool results**, the most-recent node's block is **pinned against truncation** (packed newest→oldest), and a directive tells downstream nodes to **use prior data and never ask the user** for what a prior agent already produced.
- **Per-node observability.** The run response now returns, per node, a `status` (`ok`/`failed`/`denied`), its `finalText`, and each tool call with a one-line result summary — and the Run panel renders a node-by-node card list (status badge · output · tool calls) with a clearly delimited **Final output** section, so you can see what each agent did and what the result is.
- **Visible progress + no silent failure.** Pressing Run now immediately shows an animated "Running the team… `a → b → c → END`" banner. A node that throws is recorded as `failed` with its reason and returns the **partial** results up to that point, instead of aborting the whole run with an opaque 500.

## [os-ui 0.1.75] — 2026-07-11

### Fix — assistant answers now render as formatted markdown
- **Ask the OS and every "Talk to X" copilot rendered the model's markdown as RAW TEXT** (literal `**bold**`, `| tables |`, `### headings`) — there was no markdown renderer in the app at all. Added `react-markdown` + `remark-gfm` and a shared, safe `<Markdown>` component (raw-HTML off, links forced to `target=_blank rel=noopener`, wide tables scroll, house typography) used for assistant/copilot answers (user input stays plain).

### Fix — Talk to Data now returns real rows (and never lies about it)
- **Talk-to-Data answered about columns but never returned actual data.** Root cause: on any NL→SQL failure, the data grounding **silently swallowed the reason** and attached no evidence, so the copilot only saw the schema overview and reported "the context does not include actual data rows" — it couldn't even say a query was attempted. (The marts, the gold FQN `iceberg.<snake_domain>.gold_<slug>`, and the read principal were all verified correct.) Now: a successful query returns the real rows (presented as a compact markdown table); a failed query surfaces its honest `kind: message` so the copilot explains what happened and asks you to clarify — instead of denying the data exists.

## [os-ui 0.1.74] — 2026-07-10

### Feature — "Talk to…" Context Copilots (all 5 Context tabs)
- **A governed, read-only copilot on every Context tab** (Data · Knowledge · Files · Metrics · Connections). Each `Talk to X` panel assembles a DLS-scoped, metadata-driven overview of what *you* can see on that tab, runs the tab's existing governed retrieval **as the caller** (Data → NL→SQL over the lakehouse, Knowledge → knn retrieval, Files → file search; Metrics/Connections grounded on their catalog), packs it within the reasoning model's window via the **Context Assembler** (hard ceiling — no more 200K blow-ups), and answers with the reasoning model. New tab-module `lib/talk/` (contract-compliant) + `POST /api/talk/[tab]` (session-gated). Degrades honestly on retrieval/model failure — never fabricates.
- **Reasoning shown *separately* from the answer.** A dedicated reasoner keeps `reasoning_content` intact; the UI puts it behind a muted, collapsible "Show thinking" panel above the prominent answer, with real citation chips (only entitled ids, real deep links) and a collapsible "what ran" (SQL/retrieval) disclosure below.

### Fix
- **Pillar↔bet link is now two-way.** Linking a Big Bet to a Strategy pillar stamped only one side (`pillar.betIds`) and left `bet.pillarId` unset (and unlink didn't clear it); both directions now stay consistent.

### Infra
- **OpenSearch snapshot register Job is now a proper Helm hook** (`post-install,post-upgrade` + `before-hook-creation`), so it recreates cleanly on every `helm upgrade` instead of failing on the immutable-Job re-apply.
- **OpenSearch snapshot Jobs now actually run.** Both the register Job and the daily CronJob used `curlimages/curl` (named user `curl_user`) under `runAsNonRoot`, which the kubelet can't verify without a numeric uid → `CreateContainerConfigError` (the manual `#112` snapshot test passed, but the *automated* Jobs never started). Pinned `runAsUser/runAsGroup/fsGroup: 100` so the container starts and can write the snapshot-repo PVC.

## [os-ui 0.1.73] — 2026-07-10

### Infra
- **OpenSearch Backup & Restore now works.** The cluster had no snapshot repository (and couldn't register one — no `repository-s3` plugin, no `path.repo`). Added `path.repo` + a dedicated 20Gi snapshot PVC, an idempotent `register-opensearch-snapshot-repo` Job (fs repo `sovereign-fs`), and a daily 03:00 snapshot CronJob (gated on `opensearchSnapshots.enabled`, on for STACKIT). *(Deploying it rolls the OpenSearch StatefulSet once so the snapshot volume + `path.repo` take effect.)*
- **App image pull from the in-cluster Forgejo registry fixed** (node-level): a small additive DaemonSet configures each node's containerd to resolve `forgejo-http` + use plain HTTP for that one registry — so OS-built apps (e.g. the Campaign Manager) actually deploy instead of `ImagePullBackOff`.

### Refactor (Phase 2)
- **Tab-loose files consolidated into their modules** (per `ARCHITECTURE.md`): `apps.ts`→software · `governance.ts`/`approvals.ts`→governance · `platform*.ts`/`users.ts`/`recovery.ts`/`terminal-session.ts`→platform-admin · `gateway-usage.ts`→monitoring · `agent-*.ts`→agents · `data-handoff.ts`→data · `planning.ts`→strategy. 15 history-preserving `git mv`s; behavior identical (1857 tests). The `lib/` root is now essentially free of tab-loose files (only the two client hooks remain for Phase 3).

## [os-ui 0.1.72] — 2026-07-10

### Governance / OPA (the definitive flip-flop fix)
- **Fix (the recurring `query_data`/`retrieve` OPA-deny "flip-flop") — root-caused and made durable.** The chart seeds `data.grants` with **bare** principal keys, but os-ui's policy-compiler publishes at runtime via `PUT /v1/data/grants` with **`domain:`/`user:`-prefixed** keys — and a PUT is a *full-document replace*, so publishing **wiped the chart's bare seed**, after which `authz.rego`'s bare lookup missed → deny (until the next OPA restart re-read the seed → allow: the nondeterministic flip-flop). Now the chart seed lives at a **disjoint `seed_grants` path** (the runtime PUT to `data.grants` can never clobber it) and **`authz.rego` unions both documents**, resolving each principal under bare + `domain:` + `user:` forms. Fail-closed preserved. Verified with the real `opa` CLI (9/9 authz + 29/29 full policy suite). *(Also on the chart: OPA `--watch` + a complete `checksum/policy` annotation so a grant change reloads deterministically.)*

### Refactor (Phase 1b)
- **`lib/core` + `lib/infra` carved out** of the loose `lib/*.ts` files, per `ARCHITECTURE.md`: 48 files moved (history-preserving `git mv`) into `lib/core/` (config · session · auth · scopes · lifecycle · versioning · artifact-model · tabs · …) and `lib/infra/` (governed spine + clients: governed · agent-governed · os-mirror · secrets · k8s · …), 414 importers rewritten. Pure structural change — behavior identical (1857 tests unchanged). Establishes the one-way `tab → infra → core` dependency layering.

## [os-ui 0.1.71] — 2026-07-10

### Agents / context (the 200K fix)
- **Context Assembler** — a first-class, budget-aware context builder (`lib/infra/context/`) with a model-context registry (per-model window + reserved output, admin/env-overridable), tool-result **compaction** (row-sets → header + sample + "…N more", long text → head/tail), and a greedy pinned-first pack that **guarantees the prompt never exceeds the model window**. Wired into the single-agent harness, the multi-node graph handoff (assembled summary, not the full transcript), **and Ask the OS**. Fixes the `ContextWindowExceededError` (200K) agent-run failures. Ships with an embedding-relevance seam for Phase 2.
- **Agent data discovery** — an agent granted `query_data` now auto-gets `list_datasets`/`get_dataset`/`profile_dataset` (and knowledge/files equivalents), plus a "discover-before-you-act, never guess identifiers" directive, so agents resolve real FQNs instead of hallucinating table names.
- **Stale-FQN defense** — the ACT prompt now treats any table name in an agent's stored instructions as possibly stale and re-resolves to the current domain-gold FQN (a promoted dataset lives at `iceberg.<domain>.gold_<slug>`, never the owner's `personal_<uid>` lane).
- **Workspace default routing** now offers only **Standard / Reasoning** (the live admin role models), not the raw LiteLLM catalog.
- **Build/Run persistence** — a persisted activity marker + last-run report, so returning to the Agents tab shows "building/running…" or the last outcome instead of a blank slate.

### Knowledge
- **Tacit knowledge over MCP** — `author_knowledge` now takes per-step **and** workflow-level (`TACIT.md`) `tacit`; the knowledge guide (which described a non-existent `type`/`body`/`actors` API) is rewritten to the real tool.
- **Markdown-only knowledge is retrievable** — the chunker now chunks the workflow's prose body into citable units (previously prose-only workflows indexed 0 units).
- Knowledge tab sub-area **"Knowledge" → "General"** (siblings: General + Workflows).

### Data / Nav
- **Data tab: "Talk to Data"** replaces the raw Query-the-Lakehouse SQL editor (raw SQL lives in the Admin **Query** console); NL question → governed `/api/data/ask` → answer + results + the SQL it ran.
- **Users & Access** now lives only under **Admin** (removed the duplicate from Governance).

### Refactor (Phase 1a)
- **Connections** consolidated into `lib/connections/` as the reference **tab-module** (index/schema/store/README) per the new `ARCHITECTURE.md` contract.

## [os-ui 0.1.70] — 2026-07-09

Agent data-plane hardening — from a live end-to-end test of an agent reading/writing data, files, and knowledge through Trino/dbt/OPA.

### Governance / OPA (the recurring `query_data` deny — root-caused + fixed)
- **OPA no longer serves stale grants.** OPA loaded `/policies/data.json` once at boot with no reload and the Deployment's checksum annotation omitted `requiresApproval` — so a grant change (e.g. the cohort's `query`/`retrieve`) could silently never take effect, denying `query_data`/`search_knowledge` until a manual restart (the "flip-flop"). Now: the checksum annotation covers all policy/data fields **and** OPA runs with `--watch` (hot-reload). *(Live-confirmed: after reload, `query_data` returns rows and the cohort grant is present.)*
- **Fix (knowledge retrieval always denied):** `search_knowledge`/`retrieve` authorized on the **user id** instead of the **domain** (grants are domain-keyed), so it fell to an empty offline mock for everyone. Now gates on the domain principal, exactly like `query_data`.

### Agents
- **Reliable tool-calling on gpt-oss.** The worker model (`gpt-oss-20b`, OpenAI "harmony" format) leaked channel control tokens into tool names (`query_data<|channel|>commentary`) → intermittent tool errors that exhausted the agent's step budget. The tool-call parser now **strips harmony tokens** and **recovers commentary-channel tool calls**, and agent tool-calling routes to a new **admin-configurable `tools` model role** (defaults to the Qwen tier for native tool-calls; `LITELLM_TOOLS_MODEL` / Admin settings override).

### Data / Metrics (Cube)
- **Promotion is fail-closed.** Publishing a dataset to a domain asset now **independently verifies the physical gold materialized in the domain schema** before flipping the tier (502, tier untouched, if absent) — no more "promoted" assets whose gold only exists in the owner's personal lane. Added a governed **re-materialize/repair** path for an already-promoted-but-missing asset.
- **Cube fixes:** defining a metric requires a **promoted (domain-schema) gold** with a clear "promote to Shared first" message (a cube can only read the domain schema its `cube-sales` principal is entitled to); cube dimensions/`drill_members` are **reconciled to real mart columns** (can't reference a missing column like `region`); and the **Metrics tab is fail-soft** — one broken model renders an inline "unavailable" tile instead of 500-ing the whole tab.

### Infra
- **ClickHouse (Langfuse) is PVC-backed** with a `wait-for-clickhouse` init-container gating langfuse-web, so trace-schema migrations always run against a ready CH across redeploys. *(Deployed in 0.1.69; PVC live.)*

## [os-ui 0.1.69] — 2026-07-09

### Navigation / access
- **Menu now hides what a role can't use.** `LLM Gateway`, `Monitoring`, and the `MCP` setup tab are **builder+/admin only** (hidden from creators/students). Creators still connect over MCP — the `/api/mcp` endpoint + their per-user token are unaffected; only the configuration tab is hidden. (Governance was already builder+, and Admin/Components/Terminal/Query/About already admin-only.)
- **New Admin "Query" console** (Admin → Terminal → **Query** → About) — dual-mode **Lakehouse SQL + Cube** console for admins, over the governed read path (admin-scoped, 403 for non-admins).
- **Rename:** the visibility label **"Shared" → "Shared in Domain"** across every tab (scope switcher, badges, tiles) — internal keys/enums unchanged.

### Data (detail rework)
- **Removed the confusing "Advanced Build Rail."** Everything is now inline on one screen with section-level **Edit** (Documentation, Data quality, Metrics, Bring-in-data/Bronze, Configuration/dbt SQL). The three primary actions — **Turn into Silver · Turn into Gold · Archive** — moved to a single **action row at the bottom**.

### Strategy
- **Strategic-pillar headline target.** Each pillar now shows a **big target number** tied to a value-metric type — **EBIT · Revenue · Time Back Hours · # Risks Mitigated · Custom** (user-named, with an optional unit + monetary flag) — and a smaller **"so far: …"** achieved-to-date figure below it, with a subtle on-track/behind cue. Targets carry a **horizon** (year-end · 6 · 12 · 24 · 36-month) that computes a clear **end date** (default: year-end of the current calendar year). Only Builder/Admin set targets; creators view. New MCP tool `set_pillar_target` keeps agents in lockstep.
- **Currency is a tenant Admin setting** (EUR/CHF/USD + other ISO currencies), applied to monetary metrics only (Hours → `h`, Risks → integer count) — the Strategy tab never picks currency locally.

### Governance / Admin
- **Fix (User & Access edit):** the Platform Admin users surface had **no edit form** — only deactivate/reactivate/tenant-admin. Added an edit panel + `edit` op so an admin can change a user's **name/email/role/domains** and have it persist to the `os-users` mirror (admin-gated).

### Versioning
- **Software** version history is now **git-backed** — the app's Forgejo commit log is the version list, and *restore* re-commits a prior commit's files onto HEAD as a new auditable commit (non-destructive, governed). Version panel now shown on Software detail.
- **Data** datasets (no per-dataset repo) get an **append-only snapshot history** — each edit snapshots the prior `dataset.yaml`; restore is reversible. Version panel now shown on Dataset detail.
- **Knowledge:** a creator on a live + Shared **workflow** can now file **Request certification** (Marketplace rung) — admin-gated, no self-publish. (Personal-knowledge promote ladder already existed.)

### LLM Gateway
- **Fix (usage showed 0 requests / 0 tokens):** the usage panel called LiteLLM `/global/activity` **without a date range** (a bare call 400s) and read a `sum_*` shape this LiteLLM version doesn't return. Now passes a rolling 30-day window and sums the `daily_data[]` rollup (keeps `sum_*` back-compat) — real tenant totals show again.
- **Fix (Model Hub blank `[]`):** replaced the iframe to LiteLLM's empty `/public/model_hub` with an **OS-native model list** rendered from `/v1/models` (server-side, key-free) — the brokered models always show.

### Durability (infra)
- **Langfuse ClickHouse hardening.** ClickHouse was `emptyDir` (a pod/node roll wiped all trace tables); it is now **PVC-backed** (10Gi) on STACKIT. Added a `wait-for-clickhouse` **initContainer** on langfuse-web that polls CH `/ping` before the web container starts, so the schema migration always runs against a ready ClickHouse on every redeploy — no manual web-pod bounce. *(Enabling the PVC on an existing cluster needs a one-time `kubectl delete deployment clickhouse`.)*

## [os-ui 0.1.68] — 2026-07-09

### Agents / Governance (durability fix)
- **Fix (agent `query_data` flip-flop):** an agent-run's tool grants (`os-<systemId>` principal) lived only in an **in-memory registry** set at build time, so every os-ui pod restart (any redeploy) wiped them and the agent lost `query_data`/`query` until it was rebuilt — the recurring "works today, denied tomorrow" OPA-deny. The governed-tool endpoint (`/api/agents/tool`) now **lazily rehydrates a principal's grants from the persisted agent record** (the durable `os-agent-systems` mirror) on the first cold-start request, reproducing the exact Build grant vocabulary. **Fail-closed:** a missing/corrupt record grants nothing and falls through to OPA-deny; rehydration never broadens a grant. (App-MCP `app-<slug>` principals already self-healed via `rehydrateConnection`.) *(6 new fail-closed tests.)*

### Connections
- **Consolidated the three Connections sub-tabs into one screen** (matching Data/Metrics): existing connections grouped **All · My · Shared · Marketplace** at the top (with counts + source-domain tags), the **new-connection** flow below, then App-MCP connections, the connector catalog, and outbound access. Tile Open-only lifecycle preserved.

### LLM Gateway (STACKIT)
- **Fix (`sovereign-default` 404):** STACKIT's model id keeps its org prefix (`openai/gpt-oss-20b`); LiteLLM strips the first path segment as the provider, so it was sending bare `gpt-oss-20b` upstream → STACKIT 404 ("no fallback model group"). Model refs now doubled to `openai/openai/gpt-oss-20b`. *(Live-verified: `sovereign-default` + `sovereign-reasoning` return 200 through the gateway.)*

## [os-ui 0.1.67] — 2026-07-09

### Metrics / Cube
- **Fix (Cube 500):** generated Cube **view names contained spaces** (invalid Cube identifier) → the whole schema failed to compile and the Metrics tab 500'd. `cubeViewName` now emits a valid identifier; the gold→Cube scaffold also **skips a dimension whose name collides with a measure** ("defined more than once"). *(Live-verified: cube `/meta` returns 200.)*
- Removed a leftover demo **"Query" panel hardcoded to `daily_revenue`** (the phantom metric users never defined); the governed metric registry is the metric surface. `daily_revenue` stays in Cube (Superset + sales-agent depend on it).

### Nav
- **Marketplace** moved to the top entry row (after Cockpit), out of the Context section.

## [os-ui 0.1.63–0.1.66 · query-tool 0.4.1] — 2026-07-09

### Data
- Radically simplified **Bronze→Silver→Gold** refinement: two guided CTAs ("Turn into clean Silver Dataset" / "Turn into a harmonized Gold dataset"), key **auto-match + adapt** (text-normalize / cast reconcile), a **visual join graph**, and Bronze can no longer be promoted to Shared. Dataset preview auto-loads on detail open. **DuckDB removed** from the stack (Trino-only; docs + PDF updated).
- **Fix (query_data):** the `query_data` handler ran Trino as the caller's *first domain*, so a user was denied on their own `personal_<uid>` schema — now uses the uid for the owner's personal lane (cross-user isolation intact). *(os-ui 0.1.66; live-verified: owner reads own rows, others denied.)*
- **Fix (promotion):** the query-tool write guard compared the underscore schema to the dash domain → 403 on hyphenated-domain mart writes — now `sanitize_ident`s the domain. *(query-tool 0.4.1.)*

### Metrics
- Guided **Cube.js metric editor** (count/count-distinct[-approx]/sum/avg/min/max, ratio/derived, filtered measures, rolling/running windows, format, drill members, time granularity) with **live preview**.

### Nav / UX
- **5-section sidebar** (Plan · Context · Build · Monitor · Admin; Governance→Admin, Admin-first); standalone Settings tab removed. Shared-count badge counts promoted items.
- **Fix:** knowledge workflow detail crashed (`useConfirm` outside `ConfirmProvider`) — `WorkflowView` now self-wraps. *(os-ui 0.1.66.)*

### Admin / platform
- Domains **rename** control; dead **Spark toggle removed** (ML kept). Components status fixes; Sample-RAG entry + Seed-demo-queue button removed.
- Software: app creation now seeds a **real build→push CI workflow** + `REGISTRY_PASS` (fixes the app-image / UI-button pipeline for new apps).
- **Langfuse** ClickHouse schema migrated — traces persist. LiteLLM restored to the STACKIT 3-tier runtime (`sovereign-default` → gpt-oss-20b).

### MCP + Ask-the-OS
- MCP `build_gold_join` key-adapt + `define_metric` rich measures; guides/prompts + Ask-the-OS context brought to UI parity.

## [os-ui 0.1.62] — 2026-07-08

The deployed **os-ui image** carries its own version line (`osUI.image.tag` in
`values.stackit-selfhosted.yaml`). 0.1.62 is the STACKIT three-tier models +
embeddings migration + OS-wide lifecycle UX + Data/Metrics consolidation release,
live on the STACKIT tenant.

### Models & inference

- **STACKIT three-tier model set, admin-configurable.** All in-cluster Mistral
  model workloads (**Ministral** and **Magistral**) and the **model-server**
  component are **deleted** — all inference is STACKIT-managed, so no local model
  weights sit on the node disk.
  - **Standard / worker** — `openai/gpt-oss-20b` (`sovereign-default`)
  - **Reasoning** — `Qwen/Qwen3-VL-235B-A22B-Instruct-FP8` (`sovereign-reasoning`)
  - **Embeddings** — `Qwen/Qwen3-VL-Embedding-8B` (`sovereign-embed`), **4096-dim**
- **Models & Providers admin page** unified to a single live-sourced store. Each
  role (standard / reasoning / embeddings) is independently configurable by an
  Administrator; the catalog is sourced live from the LiteLLM gateway (generic /
  open-source — operators register their own models; the three above are helm
  defaults). Replaces the former split "Models" + "Providers" pages.
- **Agent builder** now offers only **Auto / Standard / Reasoning** — the
  embeddings tier is infrastructure-only, not a user-facing model choice.

### Embeddings migration

- **4096-dim embeddings** replace the prior 384-dim mock. OpenSearch knowledge
  and files indices recreated; `KNOWLEDGE_EMBED_DIM` and `FILES_EMBED_DIM` are
  wired from `retrieval.knnDimension` in the chart.

### OS-wide lifecycle UX

- **Artifact tiles show only "Open".** Archive / Restore and Version history live
  inside the opened detail view. **Delete** is surfaced only on already-archived
  items. Applied consistently across every tab.
- **Show-archived** reveals archived items in each tab's detail lists so Delete
  remains reachable without cluttering the working view.

### Data + Metrics tabs

- **Collapsed to a single screen** — subtabs removed; the query sandbox sits below
  the dataset / metric tiles on one page.
- **Dataset detail** gained a governed **"Preview first 50 rows"** section
  (DLS-filtered; never fabricated).

### Knowledge tab

- Prominent **"New knowledge"** action and My-knowledge focal view.
- **Full Personal → Domain → Marketplace promotion** via the governance ladder.
- **Git-backed versioning** for personal knowledge items.

### Provenance tags

- **Source-domain tags** appear on every artifact shown in Shared or Marketplace
  scope (all tabs), making same-named artifacts from different domains unambiguous.

### Sidebar restructured

- **5 named sections:** Plan / Context / Build / Monitor / Admin (was a flat
  business-tabs list + a Platform group).

### Components tab & Governance

- **Postgres** now detected via StatefulSet fallback (fixes false-negative status).
- **dbt** status shows `"on-demand"` (was incorrectly red).
- **Sample RAG agent** removed from the component registry.
- **"Seed demo queue"** button removed from the Governance page.

### Software delivery pipeline

- **`appImageRef`** now serves the real CI-published image (was the whoami
  placeholder).
- **`ci-runner` pod** gains `fsGroup: 1000` so it can register its runner,
  fixing the `CrashLoopBackOff` that blocked pipeline runs.

### User & Access

- Edit path regression-tested — **6 new route tests** covering the User & Access
  edit flow.

## [os-ui 0.1.32] — 2026-07-05

The deployed **os-ui image** carries its own version line (`osUI.image.tag` in
`values.stackit-selfhosted.yaml`), independent of the chart/app semver. 0.1.32
is the durability + 4-role release, live on the STACKIT tenant.

### Added

- **DURABILITY: one shared OpenSearch mirror behind every user-facing store**
  (`os-ui/lib/os-mirror.ts`). Approvals, audit, artifacts, apps, agent systems
  (incl. `AGENT.md`/`MEMORY.md`), datasets, knowledge, files, dashboards, big
  bets, users, domains, marketplace, pillars, prefs and role-config all
  write-through to OpenSearch and hydrate on boot — **artifacts survive
  redeploys and node-rolls**. Root cause fixed once, centrally: the old
  per-store probe treated a missing index (404 on a fresh cluster) as "mirror
  down forever", so the index was never created and every pod roll wiped state;
  the shared core creates the index on 404, never throws into a request, and
  lazily re-probes/self-heals. Requires the OpenSearch PVC
  (`deploy/opensearch-pvc-migration.sh` migrates a live cluster). See
  `docs/decisions/0003-durability-os-mirror.md`.
- **Data M1 — the Data golden path is physical end to end**: upload → a real
  Bronze Iceberg table in a per-user schema (`iceberg.personal_<uid>`) →
  Explore → Silver → Gold join → **publish-on-approval** (the Builder's
  approval runs the physical publish; the tier flips only on ✓) → Cube →
  **Talk to your data v2** (governed NL→SQL: canView-scoped schema context, one
  validated read-only SELECT, executed through governed Trino under the
  caller's row filters/masks, grounded answers). Live Iceberg writes verified
  on **Polaris 1.1.0-incubating**.
- **MCP Waves A + B**: the physical pipeline tools (`ingest_dataset`,
  `transform_silver`, `build_gold_join`, `profile_dataset`), the sharing-ladder
  split (`request_promotion` owner-filed / `approve_promotion` Builder-applied),
  `query_metric`, `run_agent_system`, Science reads (`list_models`/`get_model`),
  Big Bet updates, Connections tools, and read-back parity (`list_*`/`get_*`
  for every buildable artifact) — ~55 governed tools total. Internal Agent-tab
  systems dispatch through the **same governed toolset** under their owner's
  identity (`lib/agents/build/os-tools.ts`) — front door, no back door
  (`docs/decisions/0005-mcp-front-door-invariant.md`).
- **Backups Tier 0–2** documented and wired: nightly `pg-dump` CronJob, nightly
  Velero off-cluster volume backups, and the standing pre-upgrade backup gate
  (`deploy/pre-upgrade-backup.sh`); honest gap list in `docs/backups.md`,
  drills in `docs/runbooks/restore-drill.md`
  (`docs/decisions/0004-backups-tiers.md`).
- **SECURITY / role model: 4 ranks** — `creator (0) < builder (1) < domain_admin (2) < admin (3)`.
  The new **`domain_admin`** role carries every Builder capability PLUS (a) user
  administration scoped to their OWN domain(s) only — invite, edit, deactivate/
  reactivate, and role assignment **up to builder** (never `domain_admin` or
  `admin`; only the platform Admin appoints domain admins) — and (b) all
  domain-scoped governance approvals (incl. within-domain cost caps). Enforced
  server-side per call in `/api/governance/users` via new pure predicates in
  `lib/governance/roles.ts` (`canAdministerUsers` floor, `userAdminInScope`
  domains-subset rule, `canTouchUser` no-lateral/no-upward), every mutation
  audited with the actor. Builders are approvers, NOT people-admins (user admin
  moved from builder → domain_admin). Tenant powers (strategy pillars,
  cross-domain bets, marketplace certification, the whole Platform group, cost
  caps, role matrix, models, domains) stay platform-admin-only; the Platform
  Users tab keeps its 0.1.31 admin-only gating. Legacy/unknown stored roles
  still normalise to `creator`; nobody is auto-promoted. Builder-floor gates
  across the OS now compare by rank (`roleAtLeast`), so `domain_admin` inherits
  every Builder surface, incl. the 6 builder-floor MCP tools; `whoami`,
  `list_capabilities`, the MCP orientation and prompt role-banners describe all
  4 roles. The `/platform/roles` matrix gains a Domain admin column
  (`manage @ governance` = memberships + domain user-admin); the admin
  never-locked-out invariant is unchanged. See
  `docs/decisions/0001-four-rank-roles.md` and
  `docs/decisions/0002-sharing-ladder.md`.

### Changed

- **Nav consolidation**: Tutorials moved into the main tab group; **Governance**
  tops the Platform group at **builder+** (Domain admins included by rank); the
  remaining Platform entries (Admin, Components, Terminal, About/Licenses) are
  admin-only; the **Workbench tab is retired** from the sidebar (the workload
  stays chart-optional; old routes redirect).
- **Console UX**: the Terminal auto-connects on open and re-attaches to a live
  session across navigation; Dagster's public ingress now requires operator
  basic-auth (`ingress.dagsterBasicAuthSecret`) since Dagster OSS ships no
  login of its own.

### Documentation

- OS guide refreshed to the current architecture (sharing ladder, physical Data
  path, MCP surface, durability, tab map) + regenerated PDF; new ADRs in
  `docs/decisions/`; new runbooks `docs/runbooks/helm-upgrade.md` (pre-upgrade
  backup rule + the ClickHouse SSA `--force-conflicts` recovery) and
  `docs/runbooks/deploy-os-ui.md` (the image-only update path).

## [0.2.0-alpha.11] — 2026-06-30

Headline: **documented STACKIT sizing & capacity recommendations** learned from
the live deploy — the node disk holds container images + local model weights and
is fixed; real data scales independently on object storage / PVCs.

### Changed

- **Node disk default 200 GB.** `node_volume_size_gb` (Terraform) now defaults to
  200 (was 50), with a comment explaining the disk holds container IMAGES + local
  MODEL weights (all Layer 1–4 images ~40–60 GB + the in-box model), NOT user
  data. 80 GB filled during deploy → disk-pressure → node cordoned → pods
  unschedulable; 200 GB is the verified floor. Mirrored in
  `terraform.tfvars.example`.

### Documentation

- **Sizing & capacity guidance.** New "Sizing & capacity" subsection in the OS
  guide (+ regenerated PDF) and a deploy README note: a small RAM / node-disk /
  data-storage table clarifying what each is for and how it scales. Key facts:
  STACKIT `m3i.16` = 16 vCPU / 128 GB RAM (ran ~2–4%); the node disk is FIXED and
  does NOT grow with the dataset; real DATA lives on independently-scalable
  storage (Iceberg lakehouse on object storage — in-cluster MinIO for the demo →
  STACKIT Object Storage / S3 for TB-scale — plus PVCs for OpenSearch, Postgres,
  ClickHouse, MLflow). Don't confuse node RAM (128 GB) with node disk.

## [0.2.0-alpha.10] — 2026-06-30

Headline: **the live platform** — every tab reworked to Apple-grade simplicity,
real Microsoft Graph + SMTP mailer, the full Layer 1–4 stack deployed and
green on STACKIT, a reworked Apple-grade user guide + PDF, and the Northpeak
e-commerce seed running live across all tabs.

### Added

- **Home / Cockpit split.** Home is now a welcoming entry point; Cockpit is the
  at-a-glance operational overview. Navigation restructured to match.
- **Microsoft Graph + SMTP pluggable mailer.** Microsoft Graph is the preferred
  delivery path (OAuth 2.0 client-credentials); SMTP is the automatic fallback.
  Auth onboarding works without email (SMTP optional, verification skipped when
  unconfigured).
- **Full Layer 1–4 self-hosted overlay for STACKIT.** Everything-on deploy
  brings up Trino, Cube, Dagster (dbt-trino adapter), Workbench, Terminal,
  Forgejo, MLflow, KServe, ml-agent, and JupyterHub in one overlay.
  Five re-upgrade issues resolved; Layer 4 gated on `ml.enabled`.
- **Northpeak e-commerce seed (aligned).** Fictional Northpeak case-study seed
  updated to match the reworked Big Bets and Strategy APIs; runs live across
  all 16 tabs for the capstone teaching demo.
- **Reworked Apple-grade user guide + PDF.** Full guide rewritten with Apple
  design philosophy — complexity hidden behind elegant surfaces, every section
  covers a real tab end-to-end.

### Changed

- **Strategy tab → 3 sections.** Pillars as centerpiece; full-screen bet detail
  replaces the old drawer pattern. Big Bets reworked: create / portfolio /
  detail flow.
- **Agents tab → one page.** Collapsed to a single operational view; Mine
  relabelled **Personal**, My Domain relabelled dynamically to the tenant name.
- **Software tab → chat-centric one-pager.** Four-step flow: one page → create
  → build → monitor, with Forgejo and Claude-chat wired in.
- **Platform-section scoping.** Platform internals (governance, infra config,
  admin) moved to the Platform tab; user-facing tabs stay focused on work.
- **Knowledge tab → vertical workflow flow.** Ingest → enrich → retrieve →
  publish flow replaces the flat layout; nav reorder puts Knowledge in context.
- **Data and Personal labels.** "Data" label clarifies data-plane tabs; personal
  workspace relabelled for consistency across the UI.
- **Graceful degradation.** `FORGEJO_PASSWORD` is now optional; os-ui boots
  cleanly when Forgejo is disabled or unconfigured.
- **Sales Assistant removed.** ACME worked-example removed; `listModels()` is
  now RLS-scoped.
- **ml-agent startupProbe + Harbor image fix.** Blocking warmup no longer kills
  liveness; Harbor image reference corrected to a pullable tag.

## [0.2.0-alpha.9] — 2026-06-30

Headline: **the full platform** — every workspace tab is now integrated and real
authentication replaces the mock/fake-user auth. On top of the alpha.8 Agents
tab + governed Trino + live agent-runtime + local reasoning tier, this release
brings up all sixteen tabs as one consolidated, OPA-governed surface, secured by
real scrypt-hashed credentials and a secure first-run bootstrap. **636 tests.**

### Added

- **All 16 tabs integrated.** The OS UI is now the full platform — **Data,
  Files, Knowledge, Connections, Software, Metrics, Dashboards, Science,
  Marketplace, Monitoring, Governance, Strategy, Big Bets, Home, Tutorials,**
  and **Platform Admin** — consolidated onto `main` on top of the alpha.8
  **Agents** tab, governed **Trino** query engine, **live agent-runtime**, and
  **local reasoning** tier. Cross-tab seams are **OPA-governed**: every
  cross-surface read/write is routed through policy, so a capability granted in
  one tab does not silently leak into another.
- **Real authentication.** The mock/fake-user auth is **replaced** with real
  credentials: **scrypt-hashed** passwords, a **secure first-run admin
  bootstrap** (one-time bootstrap token → **forced email + password** on first
  sign-in → the bootstrap credential **auto-deletes**), **master-key recovery**
  for locked-out admins, and an **onboarding wizard** for first-run setup. No
  fake user, no default password.

### Changed

- **Mock auth → real auth across the OS UI.** Sign-in, session, and the
  auth/me/login/logout routes now authenticate against real, hashed credentials
  with the secure bootstrap/recovery flow above, replacing the alpha.1
  teaching-mode mock user.

## [0.2.0-alpha.8] — 2026-06-29

Headline: the **consolidation release** — agents now **execute for real**. This
folds together the central governed query engine, a **live agent-runtime** that
replaces the alpha.6 in-process mocks, a **local reasoning tier**, and a
**two-local-Mistral** model default — all on the alpha.7 governance fixes.

### Added

- **Central governed Trino + a DuckDB personal/sandbox lane.** A central,
  policy-governed **Trino** query engine is the shared analytics plane (every
  query routed through the governed spine), with **DuckDB** providing the
  fast, embedded **personal / sandbox** lane for individual exploration that
  never touches the shared engine.
- **Live agent-runtime + 5 live BuildAdapters.** The Agents tab no longer runs
  against in-process mocks (alpha.6): a **live agent-runtime** with **five live
  BuildAdapters** means agents **execute for real**, fully governed —
  model/connection/tool calls routed **LiteLLM → OPA → Langfuse**, **Cilium
  default-deny egress** on agent workloads, and **CronJob**-backed schedules for
  scheduled systems.
- **Local Magistral 24B reasoning tier.** A self-hosted **Magistral 24B**
  reasoning model served on **llama.cpp** (capped at **6 cores**) adds an in-box
  reasoning tier — no provider key, fully offline.

### Changed

- **Default model routing → two local Mistral models.** The default is now
  **two-local-Mistral**: the **reasoning** tier resolves to the local
  **Magistral 24B** and the **fallback/light** tier to the **in-box Ministral**,
  with **STACKIT off by default**. The stack's default reasoning + chat path is
  now fully self-hosted and permissive out of the box.

### Fixed

- Consolidated the **alpha.7 governance/authorization fixes** (the six Agents-tab
  view-vs-edit / read-only-authorizes-write / disabled-agents-still-run /
  phantom-handoff / Marketplace double-list findings) into this release.

## [0.2.0-alpha.7] — 2026-06-29

### Fixed

- **Agents tab — fixed 6 governance/authorization findings from code review**
  (view-vs-edit auth on Run/Probe, read-only-authorizes-write,
  disabled-agents-still-run, phantom-handoff, Marketplace double-list).

## [0.2.0-alpha.6] — 2026-06-29

Headline: the new **Agents tab** — a three-level agent IDE for building, governing,
and running multi-agent systems entirely inside the OS UI.

### Added

- **Agents tab — three-level agent IDE.** Navigate **Systems → canvas → agent
  editor**: a list of agent systems, a per-system visual canvas (supervisor +
  members with derived routes), and a focused editor for each individual agent.
- **Dual-mode editing, one source of truth.** A drag/connect **SVG canvas**, a
  self-hosted **Monaco** text editor, and an **agent-system helper** (chat) all
  edit the *same* `system.yaml`, which is versioned in Forgejo. Edits made in any
  mode round-trip losslessly through the shared schema/compiler.
- **Build = execute + verify, with the governed-gateway invariant.** "Build" does
  not just generate config — it executes the compiled system and verifies it,
  with **every** model/connection/tool call routed through the governed gateway
  (no agent reaches a capability it was not granted).
- **Per-agent model picker** over the LiteLLM model list (light/reasoning/vision
  tiers), **grants & capability governance** (granted connections work;
  non-granted are blocked; writes are held for approval), **routing** rules,
  **run / schedule / toggle** at the system level, **fork-to-own**, and a
  **validation gate** that must pass before a system can build/run.

> **Note (honest scope):** in this release **Build executes against in-process
> mocks** (five mock Build adapters + a mock Forgejo-backed store). The
> live-service adapter implementations (real Forgejo, real model/connection
> backends) are a deliberate follow-up before real deployment.

## [0.2.0-alpha.5] — 2026-06-29

Headline: the **default light model is now Ministral 3 (3B, Apache-2.0)** — the
**only in-box self-hosted default**. The self-hosted default tier is now
**Apache-clean** and the model server is **right-sized** for the smaller weights.

### Changed

- **Default self-hosted model → Ministral 3 3B (Apache-2.0).** `modelServer.model`
  is now `ministral-3:3b-instruct-2512-q4_K_M` (~2.95 GB, verified against the
  Ollama library), serving the **light tier** (chat, coding, tool-selection).
  LiteLLM `sovereign-default` / `sovereign-mock` routes and
  `values.private.example.yaml` updated to match. Escalation/fallback tiers
  (optional bigger self-host, STACKIT premium/vision) are unchanged.
- **Model server right-sized.** `modelServer.resources` dropped from 5Gi/8Gi back
  to **3Gi req / 4Gi limit** to fit the ~3 GB Ministral 3 3B working set.

### Removed

- **No non-permissive model option ships in-box.** The previous non-permissive
  opt-in default alternative — and its license records — are removed. The
  self-hosted tier is now **Apache-2.0 only** (Ministral 3).

## [0.2.0-alpha.4] — 2026-06-29

Headline: the OS gains an **in-browser code editor** for Layer 3 apps, a
**self-hosted model-serving + routing** stack (self-hosted default + LiteLLM
fallback/cost-caps/rate-limits to STACKIT), and **experimental** in-UI
**terminal** and **domain-builder workbench** tabs (off by default).

### Added

- **In-browser code editor for Layer 3 apps (Monaco).** The Software golden path
  gains a **Code** panel beside the build assistant: a file tree of the app's
  Forgejo repo with a **Monaco** editor; Save commits back to Forgejo on `main`
  (CI → Harbor → Argo CD pick it up). Repo access is **Builder/Admin-gated**
  through a server route — no Forgejo URL/credential reaches the browser.
  - **Sovereignty / air-gap:** Monaco's `vs/` assets are **self-hosted from the
    app** (`public/monaco/vs`, generated at build time from the pinned
    `monaco-editor` dependency by `scripts/copy-monaco.mjs`) and the loader is
    pinned to the **same-origin** path `/monaco/vs`. **No CDN fetch** — the
    editor works fully offline.
- **Self-hosted model serving + routing.** New `model-server` component: a CPU
  OpenAI-compatible LLM runtime (**Ollama**, MIT) serving **Ministral 3 3B
  (`ministral-3:3b-instruct-2512-q4_K_M`, Apache-2.0)** as the **default chat
  backend**, replacing the mock LLM — fully offline, no provider key, **N
  replicas** behind LiteLLM load-balancing (`modelServer.replicas`). The mock
  model is retained for offline embeddings.
  - **License:** Ministral 3 ships under **Apache-2.0** (OSI-permissive). We ship
    only the Ollama engine; the weights are **pulled at runtime, not
    redistributed** (recorded `bundled=no` in `licenses/components.tsv`;
    documented in `NOTICE` + `THIRD-PARTY-LICENSES.md`). The self-hosted default
    is **Apache-clean**.
  - **LiteLLM router:** fallback chain (self-hosted Ministral 3 → optional bigger
    self-host → STACKIT last-resort), with retries, timeouts, circuit-breaking
    (`allowed_fails`/`cooldown_time`), and load-balancing. **STACKIT AI Model
    Serving** (`Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`) is wired as the
    **vision** route + **last-resort** only — never the default; key via
    **External Secrets**, with a dedicated **per-model spend cap** and per-key
    **rate limits** on the agent virtual key.
  - **Config alternatives/toggles:** swap the default model
    (`modelServer.model`); optional GPU **vLLM** bigger model
    (`modelServer.big.enabled`, off by default).
  - **Private overlay:** `values.private.yaml` (gitignored) registers extra
    self-hosted endpoints + extends the fallback chain without touching public
    defaults — see `values.private.example.yaml`.
- **Experimental — in-UI Terminal (off by default).** A sandboxed web terminal
  tab (`terminal.enabled=false`): xterm.js front-end + a token-brokered
  WebSocket to a locked-down `sandbox-shell` pod. **Prototype**, pending the
  design decisions in `docs/terminal-tab-design.md`. Not wired into the default
  deploy.
- **Experimental — domain-builder Workbench (off by default).** A code-server
  workbench tab (`workbench.enabled=false`) for domain builders, brokered through
  a session API to a per-user `code-server-workbench` pod. **Prototype**, pending
  the user's 7 open design decisions in `docs/workbench-tab-design.md §6`. Not
  wired into the default deploy.

### Changed

- **UI labels:** the **Structured Data** tab/page is now **“Data”** and
  **Unstructured Data** is now **“Files”** (display labels only; routes
  `/data` and `/unstructured`, type keys and internal identifiers are unchanged).

### Governance

- **Open-source Git governance.** Added `GOVERNANCE.md` (roles, lazy-consensus
  decision-making, how to become a maintainer, SemVer release process),
  `SECURITY.md` (private vulnerability reporting via GitHub Security Advisories +
  `security@datamasterclass.com`, coordinated disclosure), `.github/CODEOWNERS`
  (the `@Data-Masterclass/maintainers` team owns the tree), a pull-request
  template, and YAML issue forms (`bug_report.yml`, `feature_request.yml`,
  `config.yml` — blank issues disabled, security routed to advisories).
- **CI workflow** (`.github/workflows/ci.yml`) running on pull requests to `main`
  with stable, required-check job names: `build` (os-ui), `helm-lint`, and
  `secret-scan` (gitleaks); actions pinned to commit SHAs.
- **Branch protection** on `main` (public repo): PR required with 1 approval +
  CODEOWNERS review + green CI, **signed commits required**, linear history, and
  admin self-merge bypass for the sole maintainer.

## [0.2.0-alpha.3] — 2026-06-29

Headline: a **clean deploy now brings the agents up green on its own** — the
LiteLLM schema is migrated and the scoped agent key registered without relying
on Helm/Argo hooks — plus the public console links, a stable ingress IP, and a
ClickHouse OOM fix from the live STACKIT shakedown.

### Fixed

- **Agent-Core clean-deploy fix — agents come up green without `--no-hooks`
  gaps.** A fresh install left the agents returning **401s**: the LiteLLM Prisma
  schema was never created and the scoped agent virtual key was never
  registered. Both steps were **hook-gated**, and the deploy is forced to run
  `helm ... --no-hooks` (the argo-cd `argocd-redis-secret-init` pre-upgrade hook
  fails on this cluster), so both were silently skipped.
  - **Schema migration** now runs as a `db-migrate` **initContainer** on the
    LiteLLM proxy pod (`prisma migrate deploy`), part of the Deployment so it
    runs on every pod start regardless of `--no-hooks` / hooks-disabled / ArgoCD
    sync. It gates the proxy (the proxy never serves before the schema exists)
    and is independent of `DISABLE_SCHEMA_UPDATE`. 2Gi limit (1Gi OOMKills on a
    cold DB). The subchart `migrationJob` stays enabled only for the
    `DISABLE_SCHEMA_UPDATE=true` it sets on the proxy.
  - **Agent key** (`litellm-agent-key-init`) is converted from a Helm
    post-install/post-upgrade **hook** to a **normal sync-wave resource** (apps
    tier) so a plain `helm install` (hooks on OR off) and ArgoCD sync always run
    it; an ArgoCD `Replace=true` sync-option lets the immutable Job recreate
    idempotently on later syncs.
  - Validated on local kind: schema migrates from an empty DB (0 → 66 tables);
    a clean apply brings LiteLLM + sample-agent + poet-agent up green with the
    agent key returning 200 (no 401) and no manual steps.
- **OS UI console links use the public ingress URLs when deployed**, not
  `localhost`: the Next.js console route is `force-dynamic` and derives each
  console URL from its `consoleEnv` / matching ingress host at request time.
- **Static reserved ingress public IP.** The ingress-nginx LoadBalancer is
  pinned to a reserved STACKIT public IP via the
  `lb.stackit.cloud/external-address` annotation, with the address tracked in
  Terraform — so the IP (and the DNS records pointing at it) survive LB
  re-creation.
- **ClickHouse memory limit 2Gi → 3Gi** to stop the `OOMKilled` crashloop
  (resident caches + Langfuse schema migrations exceeded 2Gi).

## [0.2.0-alpha.2] — 2026-06-29

Headline: **four golden paths** become demonstrable end-to-end, the in-cluster
database moves to a **plain Postgres** that survives STACKIT's SKE-in-an-SNA
internal-DNS wall, startup is **orchestrated** so the node no longer OOMs, and
the bare zone **apex** now serves the OS UI.

### Added

- **Four golden paths** (agent / science / software / connections).
  - **Agent** — a Sales Assistant vertical slice: `AGENT.md` + `MEMORY.md`
    shipped as a versioned ConfigMap, a supervisor running in the OS UI over the
    governed LiteLLM + OPA + Langfuse spine, with a scoped key and approval-gated
    high-stakes tools (CRM write, knowledge certify).
  - **Science** — churn model as a governed tool (`predict`), a Dagster
    retrain pipeline (off by default), MLflow-tracked re-train → re-certify loop.
  - **Software** — per-app builds in the Software tab (Forgejo Actions → registry
    → Argo CD → subdomain), with an optional Harbor registry (off by default).
  - **Connections** — manually-credentialed API/MCP/Database/SaaS connections
    whose capability profile compiles into per-connection OPA policy data; the
    credential lives only in Secrets Manager (External Secrets, opt-in). Worked
    examples: Notion MCP + Salesforce API, allowlisted on the egress proxy.
- **Apex route.** `ingress.hosts.osUIApex` adds a second os-ui Ingress on the
  bare zone apex (e.g. `agentic.datamasterclass.com`), with its own TLS, so the
  apex serves the OS UI instead of 404ing next to `os.<zone>`. Set in the
  self-hosted overlay.
- **PriorityClasses** (`sovereign-os-infra` / `sovereign-os-app`) protecting the
  data layer under memory pressure; gated so local-kind still admits every pod.

### Changed

- **Plain in-cluster Postgres is now the default** (`postgres.engine: plain`,
  `cnpg` opt-in). A self-contained StatefulSet on the official `postgres` image
  that never talks to the Kubernetes API — fixing the **STACKIT SKE-in-an-SNA
  internal-DNS wall** that hung CloudNativePG's API-dependent bootstrap. It
  reproduces the CNPG path exactly (same `pg-rw`/`pg-ro`/`pg-r` Services, app DB
  + per-`extraDatabases` role/db/grants) so every consumer connects unchanged.
- **Orchestrated startup — no OOM.** Argo CD **sync-waves** (infra 0 / middleware
  1 / apps 2) stage the rollout, **resource requests** add memory backpressure,
  and **PriorityClasses** evict app pods before the DB — replacing the ~30-pods-
  at-once boot that spiked > 32 GB and OOMKilled LiteLLM / errored OpenMetadata.
  Both database engines (plain StatefulSet **and** CNPG cluster) carry the wave-0
  annotation, infra priority, and bumped memory requests/limits.

### Fixed

- **NetworkPolicy DNS egress on `:8053` — the SKE-in-an-SNA root cause.**
  Gardener/SKE runs CoreDNS listening on **8053** (the `kube-dns` Service remaps
  `53 → 8053`), and Calico enforces egress **post-DNAT**, so a policy that only
  allowed port 53 silently dropped every pod's DNS. `allow-dns-egress` now
  permits UDP/TCP **8053** alongside 53, fixing the all-night cluster-internal
  resolution failures (`pg-rw` and internal-API i/o timeouts) on both the
  multi-node and single-node STACKIT SKE deploys. With this fix plus the default
  **plain in-cluster Postgres**, the stack was validated **GREEN on live
  STACKIT** — Postgres up, all 5 governed tools reachable, and the Components
  API healthy.
- **OS UI console links** no longer point at `localhost` when deployed: each
  console URL derives from the matching ingress host (`soa.consoleUrl`); tools
  with no public host hide their "Open" link.

## [0.2.0-alpha.1] — 2026-06-28

Headline: the OS UI becomes a **teaching-ready, multi-tenant workspace**, the
**Admin Console is merged natively into the OS UI** (one app, one image), and a
full **STACKIT (EU) deploy path** lands with both a self-hosted (Mode A) and a
managed-services (Mode B) topology.

### Added

- **Teaching-ready multi-tenant OS UI.**
  - Identity & sessions: sign-in page, cookie session, auth/me/login/logout API
    routes, and route-guarding middleware.
  - Tenancy: per-user **domains** as the tenant scope, plus **user management**
    (users page + users API).
  - **Artifact lifecycle** `Personal → Shared → Certified` with admin-gated
    promotion. Certified artifacts publish cross-domain into a **Marketplace**;
    other users "add" a Certified artifact, which drops a scoped
    `certified-copy` into their own workspace. The server-side scoping rules are
    the security boundary regardless of backing store.
  - **In-app authoring** surfaces for datasets, dbt transformations, Cube
    metrics, dashboards, agents, and knowledge docs — each created and versioned
    as a lifecycle artifact.
- **STACKIT deploy automation** (`deploy/`):
  - Terraform for an SKE cluster + DNS zone, and (Mode B) STACKIT managed
    Postgres Flex, OpenSearch, Object Storage, Secrets Manager, AI Model
    Serving, and Container Registry.
  - Argo CD **app-of-apps** GitOps bootstrap (ingress-nginx, cert-manager,
    external-secrets, CloudNativePG, Velero, KEDA) and the umbrella app.
  - `deploy/Makefile`, `render-values.sh`, `publish-images.sh`,
    `push-secrets.sh`, and example `terraform.tfvars.example` / `.env.stackit.example`
    (placeholders only; real state/creds are git-ignored).
  - A local **`deploy/stackit` control CLI** + launchd scheduler
    (`on`/`off`/`deploy`/`destroy`/`urls`/`open`/`schedule`) to drive cost
    windows from a workstation.
- **Mode A (self-hosted on SKE)** topology: `enable_managed_backends=false` runs
  every backend in-cluster from the self-contained chart and pauses fully with
  the node pool. New `values.stackit-selfhosted.yaml` overlay.
- **Single-node STACKIT install guide** (`docs/stackit-deployment-guide.md`) —
  the **recommended, end-to-end-verified** path: one `g2i.8` node (8 vCPU / 32 GB)
  in a single AZ, node pool pinned `min=1/max=1`, the full self-contained L1–L3
  stack (~14 GB) bundled in-cluster, scaled to 0 off-hours. Captures every issue
  hit on the first real deploy and the validated config that fixes each.
- **Chart Mode-B production templating**: a per-tool **Ingress** template
  (`ingress.yaml`, off unless `ingress.enabled=true`), external-backend wiring,
  `imagePullSecrets`, and an os-ui ServiceAccount/Role.
- **Licensing/governance**: Contributor License Agreement (`CLA.md`) + CLA CI
  workflow, `TRADEMARKS.md`, and brand trademark-lockup assets.

### Changed

- **Admin Console merged into the OS UI.** Its functionality now lives natively
  as the **Platform → Components** surface. The standalone `admin-console` image
  is **deprecated and off by default** (`adminConsole.enabled=false`); the OS UI
  image now builds from the repo root and bakes in the component docs.
- **Entity corrected to Borek Data Ventures UG (haftungsbeschränkt)** across SPDX
  headers, `LICENSE`/`NOTICE`, and scripts (previously "Data Masterclass GmbH").
- OS UI branding/title refresh; docs (the end-user Guide + PDF, getting-started,
  component docs) updated for OS UI v1.0 and the Components surface.
- `values.stackit-managed.yaml` expanded for the Mode-B managed topology.

### Fixed

- Mode A binds bundled stateful components against the **SKE default
  storageClass** (empty class) instead of a hard-coded class.
- Production chart-templating corrections for external backends, image pull
  secrets, and Ingress gating so the local/Mode-A path renders unchanged.
- **STACKIT Terraform hardened from the first real SKE deploy:**
  - Kubernetes default raised to **`1.34`** (the old `1.31` is no longer offered
    by SKE and is rejected at apply).
  - Default machine flavor **`g2i.8`** (8 vCPU / 32 GB; `c1.4` is deprecated).
  - SKE **cluster name truncated to ≤ 11 chars** (`substr(replace(name,"-",""),0,11)`)
    — SKE rejects longer names.
  - New **`network.tf`** creates a routed `/24` so the cluster can attach to the
    project's **STACKIT Network Area (SNA)** (`stackit_ske_cluster.network`).
  - **Kubeconfig `expiration = 2592000`** (30 days) — the ~1 h default expired
    mid-deploy and corrupted installs.
  - **Terraform defaults are now the verified single-node setup** — a plain
    `tofu apply` yields one **`g2i.8`** node in a **single AZ (`eu01-1`)**, node
    pool pinned **`min=1/max=1`**, Kubernetes **`1.34`**. Multi-node and Mode-B
    stay available via explicit tfvars overrides but are now **known-blocked**
    (see Known limitations). (Multi-AZ requires `max ≥ #AZs`.)
- **OS UI console links no longer hard-code `localhost` on a real deploy.** The
  os-ui chart template now **derives every browser-reachable console URL from the
  ingress host** as `https://<tool>.<domain>` (new `soa.consoleUrl` helper) when
  `ingress.enabled` — so Superset/Langfuse/Forgejo/Argo CD/OpenMetadata links in
  the deployed UI point at the public ingress, not `http://localhost:8088` etc.
  Tools with no public ingress host (e.g. Dagster) resolve to an empty URL and the
  UI **hides their "Open" link** instead of linking to an unreachable localhost.
  Local-kind keeps the port-forward defaults.
- **`global.profile: local`** is required for the self-contained overlay so the
  chart generates the bundled credential Secrets (`profile: stackit` skips them,
  causing `CreateContainerConfigError` on ~17 pods). The private-registry pull
  secret is attached to the namespace **ServiceAccounts** (the `global.imagePullSecrets`
  map/string formats clash between bespoke and subchart pods). Bespoke images must
  be built **`linux/amd64`** (ARM images crash on SKE with `exec format error`).

### Known limitations / scaffolded

- The **in-app authoring backends are partly scaffolded.** Authoring produces
  **draft specs/plans stored as lifecycle artifacts** (with full Personal/
  Shared/Certified scoping enforced server-side); **compiling or executing** those
  drafts into the live dbt / Cube / LangGraph (and software scaffold → CI →
  GitOps) runtimes is **draft-for-review**, not yet a one-click live build.
- Artifact/user **persistence** is an authoritative in-process cache with
  **best-effort OpenSearch write-through** — durable when OpenSearch is reachable,
  in-memory otherwise (so the teaching flows work with no live cluster).
- STACKIT Terraform now defaults to the validated single-node values
  (`kubernetes_version_min` `1.34`, `g2i.8`, single-AZ node pool). Still
  **confirm flavor/plan names and sizing in the STACKIT catalog before `apply`**
  — they change per project/region.
- **BLOCKER — cross-node pod networking is broken on SKE-in-an-SNA; single node
  is the only verified path.** On an SKE cluster attached to a STACKIT Network
  Area (SNA), **a pod scheduled on a node *without* a CoreDNS replica cannot reach
  DNS or any pod on another node** — verified: same-node traffic works, cross-node
  is **100% loss** ("no servers could be reached"). This — not the SNA's external
  resolvers — is the real root cause that took down the Postgres-backed components
  on the first multi-node deploy: **CloudNativePG's init pod landed on the bad
  node, could not resolve, and the stateful bootstrap cascaded.** A **single node
  sidesteps it entirely** (no cross-node traffic), which is why single-node is now
  the default and only-verified topology. Multi-node HA and Mode-B managed are
  therefore **known-blocked** until STACKIT confirms cross-node overlay.
  - *Correction to the earlier note:* this was first framed as an **"SNA DNS"**
    problem — the SNA's `8.8.8.8` resolvers "couldn't resolve the internal SKE API
    hostname". That was a **downstream symptom on the multi-node cluster**, not the
    root cause; the defect is the **cross-node overlay dataplane**, and it
    disappears on a single node. Still run `nslookup kubernetes.default` from a
    throwaway pod before deploying (it just works on one node); if it fails there,
    the **SNA itself** is misconfigured — open a STACKIT support ticket.

## [0.1.0-alpha.1]

Initial public pre-release: the umbrella Helm chart (Layers 1–4 + a
secure-by-default baseline), the OS UI front door, the Apache-2.0 licensing
baseline (LICENSE/NOTICE, third-party manifest, SBOM), and the end-user guide.

[0.2.0-alpha.4]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.4
[0.2.0-alpha.3]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.2.0-alpha.1
[0.1.0-alpha.1]: https://github.com/Data-Masterclass/sovereign-agentic-os/releases/tag/v0.1.0-alpha.1
