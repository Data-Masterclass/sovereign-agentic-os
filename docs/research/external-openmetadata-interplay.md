<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# #163 — Interplay with a customer's EXISTING external OpenMetadata

**Design/research deliverable — no code changes.** Read + write against an OM
instance the customer owns and operates, without ever corrupting their catalog.
Grounded in the shipped code (`os-ui/lib/connections/openmetadata*.ts`,
`lib/data/openmetadata.ts`) and mirroring the #156 external-warehouse pattern
(`docs/external-warehouse-connectors.md`, `lib/connections/warehouse/*`).

---

## 0. What already exists (and what is genuinely new)

A lot of #163 is already built — the OM connector was designed for a *customer's*
OM from day one. Honest inventory:

| Capability | Status | Where |
|---|---|---|
| `om-catalog` connection template (base URL + vaulted bot JWT, read-only tools, gated by `OPENMETADATA_CONNECT_ENABLED`) | **shipped** | `schema.ts` (~line 456), `store.ts` |
| Phase-1 reads: domains / data products / tables / search / lineage / version detect | **shipped** | `openmetadata.ts` (bridge), `lib/data/openmetadata.ts` (pure client) |
| Catalog-tab discovery fold, DLS-clamped to the caller's own Iceberg FQNs | **shipped** | `omConnectionSource()` in `openmetadata.ts` |
| 7-guard additive write-back engine (plan → preview → apply) | **shipped** | `openmetadata-sync.ts` |
| DQ write-back (TestSuite/TestCase + result append) | **shipped** | `openmetadata-dq.ts` |
| Ingestion orchestrator folding both engines over every governed mart | **shipped (#147)** | `openmetadata-ingest.ts` |
| Version fail-closed (`omVersionWritable`, tested range 1.3.0–1.9.99) | **shipped** | `lib/data/openmetadata.ts` |

**What #163 genuinely adds** (the gaps this design closes):

1. **`om.version` is never stamped.** `detectOmVersion()` exists but no
   production path writes it to the connection record (`store.ts` only stamps
   `om.service` at create; `CONNECTION_HEALTH` has no `om-catalog` entry — an
   om-catalog test falls through to the generic HEAD probe). Consequence today:
   `omVersionWritable(undefined)` fails closed, so **every real write against a
   live external OM currently refuses**. Safe, but hollow. Fix is Phase 0.
2. **Read interplay is clamped, not federated.** `omConnectionSource()` only
   surfaces *their* OM entries whose FQN maps to a table the caller already sees
   in *our* lakehouse. Discovering **their** tables/glossary/owners — the actual
   "read their catalog" ask — is new.
3. **Foreign provisioning.** Guard 7 (least-priv writer bot Role/Policy) is
   provisioned "by the chart Job" — which only exists in *our* Helm deploy. In a
   customer's OM **we have no chart Job and no admin creds, ever**. The
   customer's admin must provision the bot; we must ship them an exact,
   paste-able bundle (the #156 `warehouseRegistration()` pattern).
4. **Foreign-instance collision/skew handling** — `sovereign_os` may already
   exist in their OM; their custom properties may clash; their RBAC may deny us;
   they may upgrade past our tested range. Enumerated in §4.
5. **Multi-OM.** `firstOmCatalogFor()` picks the *first* visible om-catalog
   connection; the ingest orchestrator inherits that. One-external-OM-per-tenant
   is an implicit assumption that becomes explicit (or is lifted) here.

---

## 1. The scenario

The customer already runs OpenMetadata (OSS 1.x or Collate) as **their**
company catalog — their services, their glossary, their owners, their lineage.
It is authoritative for them; we are a guest. The OS must:

- **READ**: let OS users discover the customer's catalog — tables, lineage,
  glossary terms, ownership — inside the Data/Catalog tab, as *federated
  reference* (a pointer, not a copy), so an OS analyst can find "the customer's
  `orders` table, owned by Jane, tagged PII" before deciding to federate or
  import the data itself (#156 path).
- **WRITE (optional)**: publish OUR governed artifacts — gold marts, data
  products, DQ suites/results, lineage among OS entities — into THEIR OM so
  their analysts see our governed outputs in the catalog they already live in.
- **Never corrupt**: their entities are theirs. We never delete, never
  overwrite a human field, never write outside our namespace, never require
  admin rights, and when in doubt we skip and say so.

Trust model: their OM's availability, RBAC, version cadence and data are
outside our control. Every interaction must degrade honestly (skip + surface a
reason), exactly like the read client's never-throw discipline today.

## 2. Connection model

Reuse the existing `om-catalog` template — one connection per external OM. The
additions are all on the non-secret `om` config block and the vault:

```ts
// schema.ts — Connection.om (extended)
om?: {
  service?: string;              // existing: default OM Trino service name
  version?: string;              // existing field — NOW actually stamped (Phase 0)
  mode?: 'read' | 'read-write';  // NEW — default 'read'; 'read-write' unlocks the writer leg
  scope?: { services?: string[]; domains?: string[] }; // NEW — admin-curated read scope (§3)
  namespaceSuffix?: string;      // NEW — optional collision-avoidance suffix (§4.3)
};
```

- **Registration (admin/builder)**: base URL (egress request→approve if the
  host is not allowlisted — `egress-requests.ts` flow, default-deny), plus the
  **read bot JWT** under the existing `om-bot-jwt` vault key. Secrets remain
  write-only: the record stores only `secretRef` + fingerprint, never a value,
  exactly as today.
- **Read-write upgrade**: a *second*, distinct credential — the writer bot JWT
  under `om-writer-jwt` (the key `openmetadata.ts` already reads). The UI needs
  a write-only field for this second key; today there is no way to set it.
  Setting `mode: 'read-write'` without a writer secret is refused at save time.
- **Test-connection (Phase 0, the biggest single fix)**: add a
  `CONNECTION_HEALTH['om-catalog']` probe that (a) calls `detectOmVersion()`,
  (b) **stamps `c.om.version`** on the record, (c) does one cheap authenticated
  read (`listOmDomains`) to verify the token, and (d) reports honestly:
  `live · OM 1.5.3 (inside tested write range 1.3.0–1.9.99)` or
  `live · OM 2.1.0 — reads OK, writes will refuse (outside tested range)`.
  Without this, the entire write path stays permanently fail-closed.
- **Versions supported**: reads are shape-tolerant across 1.x; writes obey
  `TESTED_OM_MIN/MAX` (1.3.0–1.9.99). The range is widened only after re-testing
  against a newer OM — never at a customer's request without a test pass.

## 3. READ interplay — federated reference, not a copy

Mirror #156's Layer-4 shape: a foreign OM entity becomes a **read-only
reference record**, discriminated so it can never be mistaken for a governed OS
dataset.

```ts
// NEW: lib/connections/openmetadata-federated.ts (pure transform + fold)
export type OmFederatedAsset = {
  kind: 'om-federated';                  // peer of FederatedDataset's 'federated'
  id: `om:${string}:${string}`;          // om:<connectionId>:<fqn> — stable, per-connection
  connectionId: string;
  fqn: string;                           // THEIR FQN, verbatim — we never rewrite it
  entityType: 'table' | 'glossaryTerm' | 'domain' | 'dataProduct';
  displayName: string;
  description?: string;                  // theirs, read-only
  owners: { name: string; matchedOsUser?: string }[];  // §3 identity mapping
  tags: string[];
  sourceUrl: string;                     // deep link back into THEIR OM UI
};
```

**Coexistence with `sovereign_os`**: when the OS also *writes* to this OM, its
own echo lives under the `sovereign_os` service / `Sovereign OS Products`
domain. The read fold **excludes the OS namespace** (`fqn.startsWith(OS_SERVICE)`
/ OS domain) so we never re-import our own write-back as "their" catalog — no
hall-of-mirrors.

**Authorization (the genuinely hard part)**: the read bot token sees whatever
the customer granted it; their per-user RBAC cannot be mirrored into ours.
Today's clamp (only FQNs the caller already sees) is safe but defeats
discovery. Design: **admin-curated scope** — `om.scope` lists the OM services/
domains the connection may surface; within that scope, foreign assets are
visible to the connection's OS visibility audience (Personal → owner; Domain →
domain members), same as every other shared artifact. The existing FQN clamp
stays for the *un-scoped* default so behaviour is unchanged until an admin
opts in. We must say honestly in the UI: *"visibility of external entries is
governed by the scope your admin chose + what the customer granted the bot —
not by the customer's own per-user permissions."*

**Identity/owner mapping**: best-effort, display-only. Match their owner
`email`/`name` to OS users by email; matched → render the OS user chip;
unmatched → render the foreign name with an "external" badge. We never create
OS users from their catalog and never write our owners onto their entities.

**Catalog tab**: a new source group "External catalog — <connection name>"
alongside the existing sources, rendered by the same assembler
`omConnectionSource()` feeds today (extend, don't fork). Rows are reference
rows: no Ingest/Refine actions; the actions are *View in their OM* (deep link),
*Federate the data* (hand off to the #156 warehouse path when the physical
table is reachable via a mounted Trino catalog), and *Request import*.
Freshness: fetch-on-view with a short server-side TTL cache (their OM is the
store of record; we cache to be polite, not to own).

## 4. WRITE interplay — the 7 guards on a foreign instance

The engines (`openmetadata-sync.ts`, `openmetadata-dq.ts`,
`openmetadata-ingest.ts`) are reused **verbatim** — they were already written
against "a customer's existing OM". What changes is the *operational frame*
around them. Guard by guard:

| Guard | On our bundled OM | Generalized to THEIR OM |
|---|---|---|
| 1 Namespace isolation | `sovereign_os` service / `Sovereign OS Products` domain, hard-asserted per PUT | Same, plus **collision handling** (§4.3) and an optional `namespaceSuffix` |
| 2 Additive JSON-Patch only | `buildAdditivePatch` — no `remove`, structurally | Unchanged; plus the `test`-on-absent-path caveat (§4.6) |
| 3 `managedBy=SovereignOS` | stamped on every OS entity | Same, plus **adopt-only-if-marked**: we act on an entity only when its extension carries our marker (already enforced in archive/restore; extend to provisioning) |
| 4 Idempotent | PUT create-or-update, deterministic FQNs | Unchanged — re-running heals partial writes (§4.4) |
| 5 Optimistic concurrency | `updatedBy` yield + JSON-Patch `test` → 412 | Unchanged — *their* edits always win; we record a conflict and skip |
| 6 Dry-run first | preview → governance approval → apply | Unchanged; the preview additionally shows *which OM instance* it will write to |
| 7 Least-priv writer bot | chart Job provisions Role/Policy | **Cannot run there.** Replaced by a paste-able provisioning bundle for THEIR admin (§4.1) — we never hold or request their admin creds |
| + Version fail-closed | `omVersionWritable` per verb | Unchanged — but only meaningful once `om.version` is stamped (Phase 0) |

### 4.1 Foreign provisioning — the `omRegistration()` bundle

Mirror `warehouseRegistration()` (store.ts ~line 955): a function that returns
**what the customer's OM admin must apply**, never mutating their instance:

- the bot user + JWT creation steps (their UI or API),
- the exact OM Role/Policy JSON scoping that bot to: create/edit within the
  `sovereign_os` Database Service + `Sovereign OS Products` Domain + the
  `SovereignOS` classification + DQ entities bound to OS tables — and nothing
  else,
- the read bot's viewer policy (scoped to the services in `om.scope`),
- what we explicitly do **not** need: no admin role, no delete rights, no
  glossary write, no policy on any of their services.

`provisionOmNamespace()` (entity shells: service/domain/classification/custom
properties) still runs through the writer bot on first apply — those PUTs are
inside our namespace and within the bot's granted policy. If their RBAC denies
even that, the apply refuses wholesale with the 403 surfaced (§4.5).

New module: `lib/connections/openmetadata-register.ts` (pure; returns the
bundle + human steps), surfaced in the connection detail UI and as an MCP read
tool, exactly like the warehouse GitOps snippet.

### 4.2 Failure modes — enumerated, each handled honestly

| # | Failure | Detection | Handling (never fake, never block the OS) |
|---|---|---|---|
| 1 | **Version skew** — they run OM outside 1.3.0–1.9.99, or upgrade mid-flight | `om.version` stamped at test/health; every write verb re-checks | Refuse wholesale (`refused: …outside tested write range`); reads continue; health banner says writes are off and why. Never "try anyway". |
| 2 | **Schema drift** — our custom-property names (`managedBy`, `osDatasetId`, …) already exist on their `table` type with a different type/meaning | provisioning PUT fails or returns a conflicting definition | Refuse the provisioning step, surface the exact clash; offer the `namespaceSuffix`'d property names as the remedy. Never overwrite their property definition. |
| 3 | **Name collision** — a `sovereign_os` service / OS domain / `SovereignOS` classification already exists (another tenant, an old install, coincidence) | on first provisioning, GET the entity and check `extension.managedBy` / our description marker | **Adopt-only-if-marked**: marked → it's ours, idempotent re-use. Unmarked → refuse wholesale, tell the admin, offer `namespaceSuffix` (`sovereign_os_<tenant>`), which threads through every FQN helper. Never squat on an unmarked namespace. |
| 4 | **Partial writes** — some PUTs land, then network/RBAC fails | per-entity fold already records per-op errors (`OmSyncResult.errors`) | Leave what landed (all writes are additive + idempotent); re-running the same apply heals the gap (Guard 4). No rollback in their instance — rollback would itself be a write we may not own. Result honestly lists applied vs failed per entity. |
| 5 | **Their RBAC denies us** — 401 (bad/expired JWT) vs 403 (policy narrowed) | HTTP status per verb | 401 → connection `health: needs-reconnect`, writes refuse. 403 → record per-op error with the OM message, keep going on remaining ops (they may have narrowed one entity type only), summarize "N ops denied by the customer's OM policy — re-check the granted Role". Never retry-loop against a 403. |
| 6 | **Human edited our annotation target** | `updatedBy` changed since last sync, or JSON-Patch `test` → 412 | Yield: recorded as a conflict, skipped, surfaced in the result. Their edit is permanent — we never re-assert over a human. (Shipped behaviour, Guard 5.) |
| 7 | **They deleted our entities** in their OM (soft- or hard-delete) | next apply: GET-by-FQN shows `deleted:true` or 404 | **Do not silently resurrect.** Surface as a conflict ("the customer removed `<fqn>` from their catalog") and require an explicit re-publish approval to re-create. A customer deleting our echo is a signal, not an error. *(Change from today's blind idempotent re-PUT — see Open decision D6.)* |
| 8 | **Unreachable / flaky** | network error / timeout | Shipped: never-throw, per-dataset skip with reason; scheduled refresh retries next cycle. DQ result-append stays fire-and-forget and never blocks the OS-side DQ run. |
| 9 | **Search-index lag** — their Elasticsearch trails the API | writes land but search doesn't show them | Preview/apply report API truth, not search truth; the UI copy says the entity may take time to appear in their search. Nothing to handle — just don't "verify" via search. |

### 4.3 What we write, and only ever write

Unchanged from the shipped engines: OS gold marts as tables under
`sovereign_os.<domain>.gold_<slug>`; product-tier datasets as Data Products
under the OS domain; lineage edges **only between OS-authored endpoints**;
DQ TestSuites/TestCases bound to OS-namespace tables + appended results; the
one optional additive annotation on the customer's own copy of a mart
(`humanServiceFqn`, tag + provenance props behind `test` preconditions).
We never write: their glossary, their owners, their descriptions, their tags
outside our classification, cross-namespace lineage onto their entities
(their crawler owns that), and never any delete but our own soft-delete of
our own marked entities.

### 4.4 The `test`-on-absent-path caveat (needs live verification)

RFC 6902 says a `test` op against a *non-existent* path **fails**. The shipped
annotation patch guards `/extension/managedBy` with
`{ op: 'test', path: '/extension/managedBy', value: undefined }` — on a fresh
human table with **no extension object at all**, a strict patch engine fails
the test → 412 → the whole annotation is refused. That is fail-**closed**
(safe: we never overwrite), but it may mean the human-table annotation *never
succeeds* on a pristine table. OM's Java patch implementation must be verified
live (§7 test matrix); the likely fix is a read-then-branch: GET the entity,
build the patch against the observed extension shape (add the object when
absent, `test` its value when present). This cannot be resolved without a real
OM — flagged honestly.

## 5. Federate vs replicate (the #156 dichotomy, applied to metadata)

| | **Federate (reference-only)** — recommended default | **Replicate (materialized copy)** |
|---|---|---|
| What it is | `OmFederatedAsset` pointers, fetched on view (short TTL), deep-linking into their OM | Periodic import of scoped entities into OS-side records (searchable offline, joinable to OS knowledge) |
| Freshness | Always current (their OM is truth) | Stale between syncs; needs drift reconciliation + tombstoning when they delete/rename |
| Sovereignty | Their data stays theirs; nothing persisted beyond cache | We now *hold a copy* of their metadata — retention, deletion-on-disconnect, and "right to be forgotten" obligations appear |
| Availability | Their OM down → the source degrades to "reconnecting…" (shipped pattern) | Survives their outage |
| Search | Live pass-through per query (latency, their rate limits) | Fast local search; index maintenance cost |
| Complexity | Low — one pure transform + a fold | High — a sync store, conflict rules, lifecycle |

Recommendation: **federate first, replicate never by default.** The only
replication worth considering later is a *search-index-only* mirror (ids +
names, no descriptions/owners) to make Catalog search snappy — and even that
only if live search proves too slow. This mirrors #156 exactly: federation is
the on-ramp; materialization is a deliberate, governed act (and for *data*,
that act is the warehouse import path, not an OM copy).

## 6. Security & sovereignty

- **Egress**: their OM host goes through the default-deny allowlist +
  Builder-request → Admin-approve flow (`egress-requests.ts`); every outbound
  call is logged. Live deploys enforce via the egress proxy + Cilium FQDN
  policy; the base URL is pinned at approval (no redirects off-host).
- **Secrets**: two JWTs, two vault keys (`om-bot-jwt` read, `om-writer-jwt`
  write), write-only from the UI, dereferenced server-side only
  (`getSecretServerSide`), never logged/echoed; fingerprint-only display.
  Recommend the customer issue **expiring** bot JWTs; expiry shows up as 401 →
  `needs-reconnect`, rotation is paste-a-new-token.
- **Least privilege — what we ask of the customer**: read bot = viewer on the
  services in scope; writer bot = create/edit inside our namespace + our
  classification only. **What we must never require**: admin role, delete
  rights, glossary/policy/user administration, or a token minted for a human.
- **Audit**: every preview and apply is already an OS-side governed action
  (approval-gated, traced); add the target instance + per-entity outcome to
  the trace so "what did we ever write into the customer's OM" is answerable
  from our audit log alone. Their side sees the bot as `updatedBy` on every
  entity we touched — by design (Guard 3 makes us identifiable, never
  impersonating a human).
- **Tenant separation**: one connection = one external OM = one bot pair.
  Nothing cross-tenant is shared; `namespaceSuffix` prevents two OS tenants
  writing into one shared customer OM from colliding.

## 7. Phased implementation plan

**Phase 0 — make the shipped write path real (small, high value)**
- `store.ts`: add `CONNECTION_HEALTH['om-catalog']` — authenticated read probe +
  `detectOmVersion()` → **stamp `c.om.version`** (+ re-stamp on every test).
- `schema.ts`: extend `Connection.om` with `mode` / `scope` / `namespaceSuffix`;
  refuse `read-write` without a writer secret; UI write-only field for
  `om-writer-jwt`.
- Tests: extend `store.test.ts` + a new health-probe test against the fake OM.
- Verifiable without a live external OM (fake fetch), except the real version
  string shape.

**Phase 1 — READ federation**
- NEW `lib/connections/openmetadata-federated.ts` — pure transforms
  (`toOmFederatedAsset`, OS-namespace exclusion, owner matching) mirroring
  `warehouse/federated-dataset.ts`; scope filtering from `om.scope`.
- Extend `omConnectionSource()` (or add a sibling fold) to emit the scoped
  foreign assets alongside the existing clamped signal; Catalog tab source
  group + reference-row actions (deep link / federate data / request import).
- MCP: extend the existing read tools with scope-aware
  `list_glossary` and `get_entity` reads (read-only, auto-allow).
- Tests: pure-transform units + fold tests against the fake OM.

**Phase 2 — foreign WRITE enablement**
- NEW `lib/connections/openmetadata-register.ts` — the `omRegistration()`
  bundle (bot + Role/Policy JSON + steps), mirroring `warehouseRegistration()`.
- `openmetadata-sync.ts`: adopt-only-if-marked provisioning (GET before first
  PUT of service/domain/classification; refuse unmarked collisions), thread
  `namespaceSuffix` through `OS_SERVICE`/`OS_DOMAIN` FQN helpers, deleted-entity
  conflict (failure mode 7) per decision D6.
- Fix the `test`-on-absent-path patch shape per live findings (§4.4).
- Gate: writes additionally require `om.mode === 'read-write'` (today the flag
  + approval + version guard; mode makes read-only a hard property of the
  connection, not just an unset secret).
- Tests: fake-OM units for collision/adopt/suffix/403-fold; the 412 semantics
  and RBAC denial *shapes* need the live matrix below.

**Phase 3 — orchestration parity + operations**
- `openmetadata-ingest.ts`: fold per *connection* (lift `firstOmCatalogFor`)
  if D5 says multi-OM; scheduled refresh CronJob reusing the shipped
  orchestrator; per-connection result history on the connection detail page.

**Test matrix**

| Layer | Harness | Covers |
|---|---|---|
| Pure engines (existing + new) | vitest, fake OM client | plans, guards 1–6, collisions, suffix, folds, owner matching |
| Version guard | unit | 1.2.x refuse / 1.3.0–1.9.99 allow / 2.x refuse / unparseable refuse |
| Live OM, in CI | docker `openmetadata/server` at 1.3, mid (1.5/1.6), 1.9 | provisioning PUTs, JSON-Patch `test`+412 semantics (§4.4), custom-property creation, soft-delete/restore, search lag |
| **Customer-shaped OM (cannot be simulated)** | a real external instance | their RBAC policy shapes + 403 bodies, SSO-minted bot JWTs, Collate-vs-OSS drift, proxy/TLS quirks, real glossary/owner data for the mapping, scale of `listOmTables` on a 10k-table catalog (pagination limits) |

Honest boundary: everything up to the docker row is verifiable in-repo. The
last row is the operator's step with a real customer — the same stance #156
takes ("needs a live customer source to validate").

## 8. Open decisions (for you)

- **D1 — Default mode**: ship external OM as **read-only first** with
  read-write as an explicit admin upgrade (recommended), or allow read-write at
  registration? Recommended: read-only default; `mode` is a deliberate second
  step after the customer's admin applies the bot bundle.
- **D2 — Read scope**: adopt the admin-curated `om.scope`
  (services/domains allowlist) as the visibility boundary for foreign entries
  (recommended), or keep today's hard clamp to already-visible FQNs (safe but
  no real discovery), or full-bot-view for domain_admin+?
- **D3 — Conflict ownership on the annotated human table**: their
  glossary/owners/descriptions always win (recommended — we only ever add our
  tag + provenance props); any appetite for writing OS descriptions onto their
  entities means abandoning "additive-only" and is not recommended.
- **D4 — Marketplace exposure**: do foreign catalog entries appear only in the
  Catalog tab (recommended), or also as Company-tier Marketplace listings?
  Marketplace implies certification semantics we cannot honestly grant for
  entities we don't govern.
- **D5 — Multi-OM**: keep one-external-OM-per-tenant (simple, matches
  `firstOmCatalogFor`) or lift to per-connection folds in Phase 3? Recommended:
  keep single until a customer actually has two.
- **D6 — Resurrection policy**: when the customer deletes our entities in
  their OM, re-create silently on next refresh (today's idempotent behaviour)
  or surface-and-require-re-approval (recommended — their delete is a signal)?
- **D7 — Search mirror**: if live pass-through search against their OM proves
  slow on big catalogs, approve a names-only local search index (a narrow,
  deliberate exception to "federate, never replicate")?

---

*Prior art: #156 `docs/external-warehouse-connectors.md` (federate vs import,
registration-as-operator-step, honest "needs a live source" boundary), #147
`openmetadata-ingest.ts`. Date: 2026-07-20.*
