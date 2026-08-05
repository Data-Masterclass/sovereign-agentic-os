# Operational System Connections — approved design (2026-08-05)

API connections to operational systems (Salesforce, SAP, Workday, …) — "a different
beast to data lakehouse connections." Companion to
[lakehouse-import-exposure.md](lakehouse-import-exposure.md) and
[lakehouse-expose-experience.md](lakehouse-expose-experience.md); reuses their
Connect → Snapshot → Organize → Expose → Adopt spine with a second, new dimension:
operational systems are BOTH a data source (entity extraction → synced datasets)
AND an action surface (live governed tools for agents/apps, incl. gated write-back).

## Approved decisions

1. **Identity v1: service integration account, labeled.** One vaulted credential per
   connection (Salesforce Connected App client-credentials / SAP communication user /
   Workday ISU). Every tool result and synced dataset carries the honest label
   "as the service account — records it cannot see are absent." Per-user delegation
   (Salesforce sharing rules, Workday constrained groups) = v2 template variant on the
   existing per-user OAuth machinery (`lib/oauth/connection-token.ts`).
2. **Write-action approvals: two layers.** (a) Enable-time: adding create/update to an
   exposure's actions enqueues `ApprovalKind: 'exposure_action_enable'` (approver
   `admin`, unified queue); write scopes stay compiled-out until approved. Read/search
   activate immediately. (b) Runtime: every write call is held-with-preview at
   `Write-approval` in `callConnectionTool` (`connection_write`, standing
   approve-&-remember policies apply). Deletes stay `Blocked`.
3. **SAP v1: generic OData core** (`lib/connections/odata/` — EDMX $metadata parser,
   V2/V4 dialects, page puller streaming to /ingest-rows) branded `sap-odata`,
   cloud-reachable services only; on-prem behind SAP Cloud Connector explicitly out of
   v1 (honest install-guide caveat). Same core yields generic `odata-v4`
   (Dynamics 365 / Business Central) for free.
4. **Workday v1: RaaS-only, full-refresh-only.** Configured custom reports ARE the
   entities (no cheap global describe); fields inferred from a sampled first page,
   labeled as such; incremental only when a report exposes a date prompt (detected,
   never assumed). SOAP WWS (true incremental) = v2, stated plainly.

**Ship order: Salesforce end-to-end first** — transport already shipped
(`lib/connections/salesforce.ts`: OAuth CC, describe discovery, api-batch sync with
SystemModstamp cursor + /ingest-rows landing), sanest API (uniform describe/cursor/
pagination, real /limits endpoint), and the only system proving both dimensions
without new auth infrastructure. Then SAP (OData core), then Workday.

## Audited substrate (facts of record)

- **~40% exists.** Salesforce + Kajabi connectors are real; `kajabi-resources.ts` is
  the cursor-honesty-map precedent (updated_at true-incremental vs created_at
  append-only vs full-refresh, per entity, "nothing here is guessed").
- Sync engine has two strategies (`federated-sql` | `api-batch`); the api-batch
  dispatch is a hardcoded `'salesforce'|'kajabi'` switch (`liveApiPlatform`,
  `sync-run-server.ts`) — THE seam to registry-ize. The 15s governed ceiling does not
  bind API pulls (lease TTL + CronJob deadline bound them); landing goes through the
  data-runner `POST /ingest-rows` (bounded memory). `syncTargetFor` already lands
  connected-sync at `iceberg.<domainSchema>.<tier>_<slug>` as the domain principal.
- Expose/adopt spine shipped; lakehouse-specific filters to widen:
  `exposed-tables.ts` (`template !== 'warehouse'`), `buildCatalogSnapshot`
  (warehouse-only discovery), snapshot/describe/classification routes.
- Action governance machinery exists end-to-end (`CapabilityMode` Off/Read/
  Write-approval/Write-bounded/Blocked, `callConnectionTool` upstream gate, unified
  approvals `connection_write`, `grantToAgent` restrict-only, app `connection_<id>`
  tools) — but `salesforce-api`/`kajabi-api` have NO entry in `CONNECTION_EXECUTORS`:
  their tools fall to `executeMock`. Real executors are the gap.
- Rate limiting: `lib/connections/retry.ts` (`retryWithBackoff`, honors Retry-After).

## The design

- **Sync-only data mode is structural** (no Trino catalog exists for api-batch), and
  the UI says it; operational exposures force `mode:'sync'`.
- **Entity catalog rides the existing stores**: `buildCatalogSnapshot` gains a
  per-template discovery registry (warehouse | salesforce-api | kajabi-api | later
  sap-odata | workday-raas); describe route dispatches likewise. Entity rows show
  business label, API name, cursor-honesty chip, record count ONLY where cheaply real
  (SF COUNT()/limits on expand; SAP $count; Workday omitted), fields on lazy expand.
  Classification/taxonomy/CatalogBrowser unchanged (smart seed default flips to
  Starter when the source has ≤1 schema).
- **ExposureSet extends additively**: `kind?: 'warehouse'|'operational'`, and
  `actions?: { [entityKey]: { read?, search?, create?, update? } }` (absent =
  data-only, the safe default). Assign stage gains a collapsed "Agent actions
  (optional)" section, defaults off.
- **Action compilation = intersection**, no new policy engine: (capability profile) ∩
  (exposure actions) ∩ (domain adoption) ∩ (agent/app grant), evaluated per call in
  `callConnectionTool`; no exposure ⇒ no tool for anyone, fail closed.
- **Entity-generic Salesforce tools** replace the hardcoded preset: `sf_get_record`,
  `sf_search` (bounded, truncated-flag), `sf_create_record`/`sf_update_record`
  (Write-approval; bounded variant via argConstraints), `sf_delete_record` (Blocked);
  real executor in `CONNECTION_EXECUTORS['salesforce-api']`
  (`lib/connections/salesforce-tools.ts`), never-throw `{ok:false,reason}`.
- **Action adoption**: domain-scoped acceptance record (`os-action-adoptions` mirror:
  `{exposureId, domain, entities, adoptedBy, at, revoked?}`) — the consent step so an
  exposure never silently arms another domain's agents; then normal agent/app grants.
- **Extracted data** lands as normal Domain-tier iceberg datasets — existing OPA floor
  + dataset grants apply unchanged. Profile/DQ run on the synced copy (full honesty
  for free; no live sampling problem).
- **Rate limits**: page-by-page with retryWithBackoff; 429 mid-slice fails the run
  honestly (cursor not advanced); pre-flight /limits near-quota → skip reason
  "throttled — resuming next window" with real numbers in Developer view.
- **Revocation**: data = freeze-not-delete (existing); action tools die immediately on
  exposure revoke / domain adoption revoke / connection archive (intersection
  recomputes per call).

## Phases

- **0** Registry-ize the two hardcoded seams (`liveApiPlatform` switch +
  `buildCatalogSnapshot` discovery) — no behavior change, byte-identical outcomes.
- **1** Salesforce entity catalog (snapshot/describe/classify serve `salesforce-api`;
  labels, cursor chips, lazy fields, real counts on demand).
- **2** Data expose + adopt for operational connections (widen exposed-tables,
  `catalog:null` branch, mode forced sync, deferredReason wired, adopt-dialog cursor
  honesty via the registry).
- **3** Action surface (entity-generic SF tools + real executor; `ExposureSet.actions`
  + `exposure_action_enable` approval; adoption record + grant intersection; service-
  account labels). Flag `OPERATIONAL_ACTIONS_ENABLED`, nil-safe, default off.
- **4** SAP OData (generic core + sap-odata template + install guide with the
  Cloud-Connector caveat; pure $metadata parser tests; public-sandbox verification).
- **5** Workday RaaS (report-as-entity catalog, full-refresh honesty, ISU auth,
  SOAP-punt caveat).
- **6** MCP/assistant parity (`adopt_entity_actions`, `list_adoptable_actions`,
  exposure CRUD gains `actions`, ExposeChat action starters) + /limits quota
  surfacing.

## Governance mapping (summary)

Platform admin exposes (data + read/search actions); Admin approves write-action
enablement; domain admin adopts data and actions; Builder+ grants tools to
agents/apps; every write call held-with-preview at runtime. Audit: exposure traces,
`entity_actions_adopted`, `dataset_adopted`, full call traces without secrets.
