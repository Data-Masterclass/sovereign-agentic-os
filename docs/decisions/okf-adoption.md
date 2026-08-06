# OKF Adoption — approved design (2026-08-05)

Adopt the **Open Knowledge Format (OKF)** as the interchange format for the Knowledge
tab + Marketplace. Spec: `github.com/GoogleCloudPlatform/knowledge-catalog` → `okf/`
— **Apache-2.0 (SPDX-verified)**, spec version **v0.2** (pinned; the version is
stamped into every exported bundle). Repo vitality checked 2026-08-05: created
2026-05, actively pushed, 8.3k stars — young, fast traction.

## Why adopt (the honest calculus)

- **The downside case still pays.** OKF is markdown + YAML frontmatter — nearly
  isomorphic to our Knowledge artifacts. Even if OKF dies, we keep a clean,
  human-readable, self-describing knowledge export/import: pure sovereignty value.
- **Narrative fit**: a Sovereign OS that locks knowledge in is a contradiction.
- **Risk neutralized by scope**: boundary interchange ONLY. Internal storage and the
  OpenSearch hybrid retrieval engine are untouched — spec churn is an adapter update,
  never a migration.
- **Carve-out**: the spec's "attested computation" concept type is NOT adopted in v1
  (experimental end of the spec). Concept-document core only.

## Corrected spec facts (build to these, not to summaries)

- It is **v0.2**. `type` is the ONLY required frontmatter field and it is a
  **free-form string** — the spec does NOT enumerate types. Our five
  (`workflow`, `decision-rule`, `tacit-knowledge`, `term`, `overview`) are OUR
  vocabulary carried in OKF's open type field.
- Recommended: `title`, `description`, `resource` (URI uniquely identifying the
  asset), `tags`. Optional families: `generated {by, at}`, `verified` (list of
  verification events), `sources`; lifecycle `status: draft|stable|deprecated`
  (default stable) and `stale_after: YYYY-MM-DD`.
- **Consumers MUST NOT reject documents with unrecognized fields** and must
  gracefully handle unknown types, broken links, and absent index files. Rejection
  is legal ONLY for true conformance failures: unparseable YAML frontmatter,
  missing/empty `type`, malformed reserved files.
- Reserved filenames: `index.md` (directory listing), `log.md` (update history).
  All other `.md` files are concept documents. Links: bundle-absolute (leading `/`)
  or standard relative markdown links.

## Field mapping (export ⇄ import)

| Ours | OKF |
|---|---|
| kind (workflow/rule/tacit/term/general) | `type` (our five strings) |
| name / summary | `title` / `description` |
| stable artifact identity | `resource: sovereign-os://knowledge/<id>` (the round-trip + idempotency key) |
| tags/folders | `tags` |
| author + createdAt | `generated: {by, at}` |
| certification events (who/when) | `verified` events |
| tier | `status`: Personal → `draft`, Shared/Certified → `stable`; full tier + `owner`, `domain`, workflow metadata under a namespaced extension block `sovereign_os:` (extensions explicitly allowed) |
| workflow structure (steps/actors/rules/per-step tacit) | body markdown with defined headings; anything the body cannot carry losslessly goes into `sovereign_os:` — the round-trip rule is absolute for our own artifacts |

Export generates a spec-correct `index.md` per directory. Import treats
`index.md`/`log.md` as reserved (never imported as concepts).

## Locked decisions

1. **Boundary only** — no storage migration, retrieval engine untouched (machinery
   unchanged; a no-import control query returns identical results).
2. **Export**: any Knowledge artifact / domain operating manual / certified
   knowledge product → OKF bundle (directory of .md + frontmatter, internal links
   rewritten to relative links, zipped). Surfaces: "Export as OKF" in Knowledge;
   certified Marketplace knowledge products carry their bundle **generated and
   frozen at certify time**; MCP twin `export_okf_bundle` in the same PR — the tool
   writes the bundle as a Files-tab artifact and returns its id/link (MCP cannot
   return a zip).
3. **Import**: upload bundle → conformance validation (narrowed rejection rules
   above) → governed Knowledge artifacts at **Personal tier, importer as owner**,
   through the normal author→index→publish→certify ladder — never a governance
   bypass. Foreign frontmatter preserved verbatim; unknown `type` strings import
   with their original type kept (shown honestly), mapped internally to the general
   kind. MCP twin `import_okf_bundle`.
4. **Idempotency**: import matches on `resource` URI — match → a new VERSION of the
   existing artifact (normal versioning); no match → new artifact. No silent
   duplicates.
5. **Security (hard requirements)**: zip extraction sanitizes paths (reject `../`
   and absolute escapes — zip-slip), enforces caps (≤ 50 MB unpacked, ≤ 2,000
   files), bounded memory; violations rejected with the honest reason.
6. **Link navigation**: markdown links between Knowledge artifacts resolve to
   first-class references — rendered in the UI, and `get_knowledge` returns
   linked-artifact refs so an agent can deterministically walk a certified bundle
   (workflow → rule → term) as the governed alternative to probabilistic retrieval.
   Unresolvable links preserved as plain links and flagged, never dropped.
7. **Validation**: an OKF conformance check (the three spec rules + graceful-
   degradation behaviors) runs on every export AND import.

## Validation gate (definition of done)

Export a domain's operating manual → bundle validates (type present, frontmatter
parseable, relative links, index.md correct) and renders readably on GitHub →
re-import → lossless round-trip (extensions incl. tier/owner preserved, version
created not duplicate) → import one of Google's sample bundles → artifacts appear
as Personal-tier governed items that pass index→publish normally → agent follows a
link chain deterministically via `get_knowledge` → certified Marketplace product
carries its frozen bundle → an unparseable-frontmatter bundle is rejected with a
clear error while an unknown-fields bundle is ACCEPTED (spec rule) → zip-slip
attempt rejected → retrieval control query unchanged → both MCP twins run as the
signed-in user, OPA-gated. Full suite green; `npm run build` passes; MCP
tool-count/prompt-count test invariants updated deliberately.
