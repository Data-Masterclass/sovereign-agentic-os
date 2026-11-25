# Third-party licenses — Sovereign Agentic OS

The Sovereign Agentic OS **aggregates** independent open-source components, each
**under its own license**. We do **not** relicense them; Borek Data Ventures UG's own
code is Apache-2.0 (see `LICENSE` / `NOTICE`).

This file is the **attribution manifest**: every bundled component, its version, its
SPDX license identifier, and a pointer to the **full license text bundled locally**
under `licenses/`. Everything is **offline-complete** — unpacking the single artifact
(chart `.tgz` / air-gap image bundle) reveals every license without network access.

- Full license texts: `licenses/<SPDX-ID>.txt`
- Bundled component NOTICE files: `licenses/notices/`
- Copyleft source records + written offer: `licenses/source-offer.md`
- Machine-readable mirror (drives the CI gate): `licenses/components.tsv`
- SBOM (CycloneDX, syft-generated): `sbom.cdx.json`

## How this was generated / kept in sync

Derived from the umbrella chart (`charts/sovereign-agentic-os/Chart.yaml`) and the
image references in `charts/sovereign-agentic-os/values.yaml`, cross-checked against a
**syft** SBOM:

```bash
# install: brew install syft   (or download the binary from github.com/anchore/syft)
syft scan dir:. -o cyclonedx-json=sbom.cdx.json     # regenerate the SBOM
scripts/license-check.sh --update-sbom              # refresh SBOM + run the licence gate (licenses/policy.json)
```

Regenerate `sbom.cdx.json` and reconcile this manifest **on every release** (see the
Release process section at the bottom).

---

## Licence policy (owner decision, 2026-11-22, refined)

One policy for the **whole repo** — OS code, images, chart components and app templates. It replaces the
earlier "Apache/MIT/BSD/ISC only" rule. The lists live in **one file**, `licenses/policy.json`, which the
gate (`scripts/license-gate.mjs`, run by `scripts/license-check.sh` and CI) reads.

- **Permissive only for our own code and everything linked into it.** Allowed: Apache-2.0, MIT, MIT-0, BSD-2-Clause,
  BSD-3-Clause (the plain "BSD License" classifier resolves to this), ISC, 0BSD, Zlib, Unlicense, BlueOak-1.0.0,
  PostgreSQL, PSF-2.0 / Python-2.0, and — for data and docs — CC-BY-4.0 and CC0-1.0. Added with owner approval
  2026-11-24 (found in components compiled into Python wheels and in `regex`): Unicode-3.0, Unicode-DFS-2016,
  BSL-1.0 (the **Boost** Software License — not the Business Source License, which stays forbidden),
  CDLA-Permissive-2.0 and CNRI-Python. Added with owner approval 2026-11-25 ("WTFPL version 2 seems to work for
  us."), found as the licence of `prexit` in the `langfuse-oss` web image: WTFPL (version 2). Every allowed id has its full text in `licenses/<id>.txt` and a row in
  "Licence obligations by type" below (both checked by `scripts/tests/license-gate.test.mjs`).
- **Only through a reviewed exception:** unmodified weak-copyleft libraries (MPL, LGPL, EPL, CDDL) and unmodified
  separate GPL programs (for example `git` in the git-http, git-daemon and backup-tools images). Each entry in
  `licenses/exceptions.json` needs a reason, a reviewer, and the condition `unmodified-not-linked` (a library used
  unmodified, not linked into our code) or `separate-program` (its own process; the only condition a GPL accepts).
  The gate checks the condition.
- **Never allowed, never excepted:** AGPL, strong copyleft linked into our code (EUPL, and GPL anywhere but as a
  separate program), and source-available licences (BUSL/BSL, SSPL, Elastic-2.0, Commons Clause, CC-BY-NC-*, CC-BY-SA-*).
- **Unknown or unlicensed:** fails, unless an entry in `licenses/exceptions.json` carries a reviewed reason.
- **Dual-licensed** (`A OR B`): passes if any option is allowed; the gate prints which option it chose.
  It takes an option made only of a standard permissive licence (`preferOnOr` in `licenses/policy.json`: MIT,
  Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD) when there is one, so `(WTFPL OR MIT)` is used as MIT;
  otherwise the first allowed option. (`A AND B` needs both allowed.)
- **Attribution:** every dependency whose chosen licence is not Apache-2.0 or MIT — excepted ones included — needs an
  entry in this file or in `licenses/ATTRIBUTIONS.md` (generated: `node scripts/license-gate.mjs --python-resolve
  --write-attributions`). The gate fails when one is missing.
- **Known violations:** `licenses/known-violations.json` lists the findings that existed on main when the
  policy began. It is a ratchet, not a waiver: each run prints them, `--strict` fails on them, a new finding
  fails, and an entry whose package is fixed is reported STALE and fails — so the list only shrinks.

## Licence obligations by type

What each licence we accept requires when we **redistribute** a component, and how we meet it. Covered:
every id on `licenses/policy.json` `allow`, the scoped exceptions (LGPL-3.0-only and MPL-2.0 in the
`litellm-oss` image), and the GPL-2.0-only `git` exception. Each row was read from the licence text in
`licenses/<id>.txt`, which is the SPDX License List canonical text (https://spdx.org/licenses/<id>.html).
"OSI" marks an OSI-approved licence (https://opensource.org/licenses). Checked 2026-11-24 (WTFPL 2026-11-25): none of the
`allow` ids has a copyleft clause, and none restricts field of use or commercial use.

> **Not legal advice.** This is a working summary for engineers. The licence text in `licenses/` is
> authoritative.

**How the general obligations are met.** These are referred to below as (N), (T), (A) and (I).
- **(N) The package's own notice files ship with it.**
  - Python packages keep `*.dist-info/licenses/` (LICENSE and NOTICE) in every image; pip installs them.
  - Container images and charts we redistribute unmodified carry the upstream's own files.
  - Apache NOTICE files of bundled Apache projects are reproduced in `licenses/notices/*NOTICE.txt`.
- **(T) Full licence texts** are in `licenses/<id>.txt`, which the air-gap bundle ships, and in the
  `litellm-oss` image under `/usr/share/licenses/litellm-oss/texts/`.
- **(A) Attribution index**: `licenses/ATTRIBUTIONS.md` (generated),
  `licenses/notices/litellm-oss-image.md` and `licenses/notices/langfuse-oss-{web,worker}-image.md` name
  every non-MIT/Apache dependency and its licence. The gate fails when one is missing.
- **(I) Component tables**: the tables below.

| Licence | Notice / attribution | Modified copies | Source offer | Patent | Trademark | Specific | How we meet it | Source |
|---|---|---|---|---|---|---|---|---|
| `Apache-2.0` (OSI) | Give recipients a copy of the licence; keep copyright, patent, trademark and attribution notices; pass on the NOTICE file's attributions (§4 a, c, d) | Modified files must carry prominent notices stating that you changed them (§4 b) | none | Express grant from each contributor; it ends for anyone who sues claiming the work infringes (§3) | No trademark rights (§6) | Our own code is Apache-2.0 (`LICENSE`, `NOTICE`) | (N), (T), `licenses/notices/*NOTICE.txt`; we modify no Apache-2.0 dependency | https://spdx.org/licenses/Apache-2.0.html, licence §3, §4, §6 |
| `MIT` (OSI) | Keep the copyright notice and the permission notice in all copies or substantial portions | none beyond the notice | none | none express | none | LiteLLM is MIT; our patch 0001 to it is documented in the image's `LICENSE-NOTICE.md` (not required by MIT). Langfuse is MIT: the `langfuse-oss` images ship its `LICENSE` (with its EE statement) at `/usr/share/licenses/langfuse-oss/LANGFUSE-LICENSE` and list our changes (stubs, removed EE directories) in `LICENSE-NOTICE.md` next to it | (N), (T); per-package copies for the os-ui agent engine in `licenses/notices/os-ui-*-NOTICE.txt` | https://spdx.org/licenses/MIT.html |
| `MIT-0` (OSI) | none | none | none | none | none | Attribution not required | (A) for traceability | https://spdx.org/licenses/MIT-0.html |
| `BSD-2-Clause` (OSI) | Source: keep the notice, conditions and disclaimer. Binary: reproduce them in the documentation or other materials | none | none | none express | none | — | (N), (T), (A) | https://spdx.org/licenses/BSD-2-Clause.html, clauses 1–2 |
| `BSD-3-Clause` (OSI) | As BSD-2-Clause | none | none | none express | Contributors' names may not be used to endorse or promote (clause 3) | The plain "BSD License" classifier resolves here | (N), (T), (A); we never use contributor names to promote | https://spdx.org/licenses/BSD-3-Clause.html |
| `ISC` (OSI) | Keep the copyright notice and the permission notice in all copies | none | none | none | none | — | (N), (T), (A) | https://spdx.org/licenses/ISC.html |
| `0BSD` (OSI) | none | none | none | none | none | Public-domain-equivalent | (A) | https://spdx.org/licenses/0BSD.html |
| `Zlib` (OSI) | The notice may not be removed or altered from any **source** distribution. Acknowledgement in product documentation is appreciated but not required | Altered source versions must be plainly marked as such | none | none | Do not misrepresent the origin | — | (N), (T), (A); unmodified | https://spdx.org/licenses/Zlib.html, clauses 1–3 |
| `Unlicense` (OSI) | none | none | none | none | none | Public-domain dedication | (A) | https://spdx.org/licenses/Unlicense.html |
| `BlueOak-1.0.0` (OSI) | Everyone who gets a copy must also get the licence text or a link to it ("Notices") | none | none | Express patent licence; ends for a party that makes a patent claim against it ("Patent", "Excuse") | none | — | (N), (T) | https://spdx.org/licenses/BlueOak-1.0.0.html |
| `PSF-2.0` | Retain the PSF licence agreement and its copyright notice in the software and in derivative works (clause 2) | A derivative work made available must include a brief summary of the changes (clause 3) | none | none | No use of PSF trademarks or trade name (clause 7) | — | (N), (T), (A); no PSF-licensed file is modified | https://spdx.org/licenses/PSF-2.0.html |
| `Python-2.0` (OSI) | As PSF-2.0, plus the BeOpen and CNRI notices it contains | Brief summary of changes in derivative works | none | none | No use of PSF, BeOpen or CNRI marks | Stack of the PSF, BeOpen, CNRI and CWI licences | (N), (T), (A) | https://spdx.org/licenses/Python-2.0.html |
| `CNRI-Python` (OSI) | Retain CNRI's licence agreement, or the substitute handle notice (clause 2) | Derivative works made public must indicate the nature of the modifications (clause 3) | none | none | No CNRI trademarks (clause 7) | Virginia law. Used by `regex` (Apache-2.0 AND CNRI-Python) | (N): `regex`'s licence ships in its dist-info; (T); unmodified | https://spdx.org/licenses/CNRI-Python.html |
| `PostgreSQL` (OSI) | Keep the copyright notice and the two following paragraphs in all copies | none | none | none | none | — | (N), (T); libpq5 in the `litellm-oss` image carries Debian's `/usr/share/doc/libpq5/copyright` | https://spdx.org/licenses/PostgreSQL.html |
| `CC-BY-4.0` | Credit the creator, keep the copyright, licence and disclaimer notices, link the licence (§3(a)(1)) | Indicate if you modified the material and keep any indication of earlier changes (§3(a)(1)(B)) | none | **Not** licensed (§2(b)(2)) | **Not** licensed (§2(b)(2)) | No additional restrictions or DRM that block the licensed rights (§2(a)(5)(B)) | (N), (A); unmodified | https://spdx.org/licenses/CC-BY-4.0.html, §2–3 |
| `CC0-1.0` | none (waiver) | none | none | **Not** licensed (§4(a)) | **Not** licensed (§4(a)) | — | (A) | https://spdx.org/licenses/CC0-1.0.html |
| `BSL-1.0` (OSI) — Boost | Copyright notices and the licence text in all copies and derivative works **except** machine-executable object code | none beyond the notice | none | none | none | Not the Business Source License (`BUSL-1.1`, forbidden) | Object code (crates compiled into wheels) is exempt; (T) and (A) are still shipped | https://spdx.org/licenses/BSL-1.0.html |
| `Unicode-3.0` (OSI) | The copyright and permission notice must appear with all copies **or** in associated documentation | none | none | none | Copyright holders' names may not be used to promote | Covers data files and software | (T) in the image (`texts/Unicode-3.0.txt`, which is the notice) and `licenses/` (documentation option (b)); (A) | https://spdx.org/licenses/Unicode-3.0.html |
| `Unicode-DFS-2016` (OSI) | As Unicode-3.0 | none | none | none | As Unicode-3.0 | Older wording of the same terms | As Unicode-3.0 | https://spdx.org/licenses/Unicode-DFS-2016.html |
| `CDLA-Permissive-2.0` | Sharing the Data requires making the **text of the agreement** available with it (§2.1) | none (modification allowed, §1.1) | none | none | none | A **data** licence. No restriction or obligation on **Results**, i.e. outputs of computational analysis (§3.1). Here: the webpki root-certificate data compiled into `litellm` | (T): `texts/CDLA-Permissive-2.0.txt` in the image next to the data; (A) | https://spdx.org/licenses/CDLA-Permissive-2.0.html (Linux Foundation; not OSI, as it is a data licence) |
| `WTFPL` (version 2; not OSI) | none required | none | none | none | none | Grants every right with no condition ("You just DO WHAT THE F\*CK YOU WANT TO", clause 0). Added 2026-11-25 (owner: "WTFPL version 2 seems to work for us."). Used by `prexit` 2.2.0 in the `langfuse-oss` web image | Nothing required. As a courtesy: (N) its notice ships with the package, (T), (A) in `licenses/notices/langfuse-oss-web-image.md` and `licenses/ATTRIBUTIONS.md` | https://spdx.org/licenses/WTFPL.html |
| `LGPL-3.0-only` (OSI) — scoped exception: `psycopg` in `litellm-oss` only | Give prominent notice that the Library is used and is under the LGPL, and ship the GPL-3.0 and LGPL-3.0 texts (§4 a, b) | We do not modify it. If we did, the modified library would have to stay under the LGPL (§2) | Corresponding source of the Library (via GPL-3.0 §6). The user must be able to replace it (§4 d) | Express grant (GPL-3.0 §11) | May be declined (GPL-3.0 §7 e) | Python import = dynamic use; replaceable in the venv | Image `THIRD_PARTY_NOTICES.md` (notice, exact PyPI sdist and sha256, how to replace); `texts/LGPL-3.0.txt` + `texts/GPL-3.0.txt`; `licenses/source-offer.md`; `licenses/exceptions.images.json` | https://spdx.org/licenses/LGPL-3.0-only.html, §4; GPL-3.0 §6, §11 |
| `MPL-2.0` (OSI) — scoped exception: `certifi`, `orjson`, `tqdm` in `litellm-oss` only | Keep all notices in the covered files (§3.4) | Modified covered files stay MPL-2.0 (file-level). We modify none | When distributing in Executable form, make the covered files' **Source Code Form** available and tell recipients how (§3.2 a) | Express grant (§2.1). Ends on patent litigation (§5.2) | No trademark rights (§2.3) | Larger Work may be under other terms (§3.3) | Unmodified files; image `THIRD_PARTY_NOTICES.md` names each exact PyPI sdist (orjson is the compiled one); `texts/MPL-2.0.txt`; `licenses/source-offer.md` | https://spdx.org/licenses/MPL-2.0.html, §2–3, §5 |
| `GPL-2.0-only` (OSI) — exception: `git` as a separate program | Licence text and notices with every copy (§1) | Modified copies need prominent change notices (§2 a). We modify none | Corresponding source, or a written offer valid for three years (§3) | none express | none | Separate program (mere aggregation) | `licenses/GPL-2.0.txt`; `licenses/source-offer.md` (exact upstream tarball + written offer) | https://spdx.org/licenses/GPL-2.0-only.html, §1–3 |

**Obligations we do not fully meet today.** These are found gaps, not waivers:
1. **Notices of components compiled into binaries.**
   - The Rust crates inside the `litellm`, `orjson`, `pydantic-core`, `cryptography`, `tokenizers`,
     `granian`, `jiter` and `rpds-py` wheels (the ones with an embedded SBOM in the `litellm-oss` image)
     ship no notice files of their own; only the wheels' SBOMs list them.
   - We ship the full licence **texts** and a per-component attribution list. We do not ship each
     crate's **copyright line**, which MIT, BSD-2/3-Clause and ISC require "in all copies" (for BSD
     binaries: "in the documentation"), nor the NOTICE file of an Apache-2.0 crate.
   - BSL-1.0 exempts object code, and the Unicode notice is the licence text itself.
   - Upstream wheels have the same gap. To close it: generate a notices file from each crate's own LICENSE
     at image build time.
2. **npm packages in the os-ui image.**
   - Next's standalone output traces only the files it needs, so a package's LICENSE file is not
     guaranteed to be in the image.
   - The agent-engine libraries have verbatim per-package notices (`licenses/notices/os-ui-*-NOTICE.txt`);
     the rest are covered by (T) and (A) only.
   - To close it: generate the os-ui `THIRD_PARTY_NOTICES` from `node_modules/*/LICENSE` at build time.
3. **MPL-2.0 packages in other images.** These are on the repo-wide ratchet (`licenses/known-violations.json`):
   certifi, tqdm, orjson and pathspec in other images. They ship unmodified with their own licence files,
   but `licenses/source-offer.md` names exact sources for the `litellm-oss` copies only. The ratchet entries
   still await an owner decision.


Licenses in use and their bundled full text:

| SPDX id | Full text |
|---|---|
| Apache-2.0 | `licenses/Apache-2.0.txt` |
| MIT | `licenses/MIT.txt` |
| BSD-2-Clause | `licenses/BSD-2-Clause.txt` |
| BSD-3-Clause | `licenses/BSD-3-Clause.txt` |
| ISC | `licenses/ISC.txt` |
| 0BSD | `licenses/0BSD.txt` |
| PostgreSQL | `licenses/PostgreSQL.txt` |
| MPL-2.0 | `licenses/MPL-2.0.txt` |
| GPL-3.0-or-later | `licenses/GPL-3.0.txt` |
| AGPL-3.0 (dev-only, not bundled) | `licenses/AGPL-3.0.txt` |

### Agent core & gateway

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| LangGraph (library) | 0.3.34 | MIT | `licenses/MIT.txt` | MIT **library** only — the Elastic-licensed LangGraph Platform/API server is **not** bundled |
| LiteLLM | 1.109.1 (chart 1.109.1, image `litellm-oss`) | MIT | `licenses/MIT.txt` | Model / MCP gateway. Our image, built from the MIT wheel **without** the proprietary `litellm-enterprise` (`docs/components/litellm-oss.md`); its packages: `licenses/notices/litellm-oss-image.md` |
| Langfuse (core) | chart 1.5.36 / app 3.194.1 (images `langfuse-oss-web`, `langfuse-oss-worker`) | MIT | `licenses/MIT.txt` | Observability core. Our images, built from Langfuse's MIT source **without** the directories under the Langfuse Enterprise License (`ee/`, `web/src/ee/`, `worker/src/ee/`), with original stubs where MIT code imported them (`docs/components/langfuse-oss.md`); their packages: `licenses/notices/langfuse-oss-web-image.md`, `licenses/notices/langfuse-oss-worker-image.md`. Rollback overlay to the upstream images (which contain EE code; worker EE queues off): `deploy/overlays/langfuse-upstream-image.yaml` |

#### os-ui agent engine — npm libraries (engine rebuild, Phase A0)

Node.js dependencies of our own `os-ui` code (`os-ui/package.json`, exact-pinned), traced into
the os-ui image. Per-package copyright notices: `licenses/notices/os-ui-agent-engine-npm-NOTICE.txt`.

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| @langchain/langgraph (JS) | 1.7.4 | MIT | `licenses/MIT.txt` | The in-process graph engine for agent systems (MIT **library**; the Elastic-licensed LangGraph Platform is **not** bundled) |
| @langchain/langgraph-checkpoint-postgres | 1.1.3 | MIT | `licenses/MIT.txt` | Run checkpoints in the existing CNPG Postgres (`agent_runs` database) |
| @langchain/core (JS) | 1.4.0 | MIT | `licenses/MIT.txt` | Peer dependency of the two above, pinned explicitly |
| pg (node-postgres) | 8.23.1 | MIT | `licenses/MIT.txt` | Postgres driver used by the checkpointer |
| pg-boss | 12.38.2 | MIT | `licenses/MIT.txt` | The one job queue (reconcilers, outbox, schedules), installed in its own Postgres schema `pgboss` |
| node-pg-migrate | 9.0.0 | MIT | `licenses/MIT.txt` | Applies the plain-SQL migrations of the Postgres `os_governance` schema |
| langfuse (JS SDK v3) | 3.39.2 | MIT | `licenses/MIT.txt` | One Langfuse trace per run (trace id = run id). The npm tarball ships no LICENSE file; `package.json` declares MIT and the upstream text is reproduced in the NOTICE file |

#### os-ui git store — npm library (engine rebuild, Phase B1)

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| isomorphic-git | 1.44.13 | MIT | `licenses/MIT.txt` | In-process git for the per-domain data-product repositories (bare repos on the `os-repos` PVC; commit/log/read/archive/push). Notice: `licenses/notices/os-ui-git-store-npm-NOTICE.txt`. The `git` binary (GPL-2.0) is NOT bundled by os-ui; the chart runs it as a separate process from the stock `alpine/git` image (git daemon) and the Dagster image's distro package (repo-sync) |
| Apache ECharts (JS, os-ui npm) | 5.6.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | The OS UI chart renderer (dashboard panels, query results, app charts). ONE registration surface at `os-ui/core/ui/charts`; the line/area/bar transformers are the vendored Apache Superset slice below |
| js-yaml (JS, os-ui npm) | 4.1.0 | MIT | `licenses/MIT.txt` | YAML reader for dashboard-as-code (`dashboards/<slug>/dashboard.yaml`) and agent `system.yaml` |
| smol-toml (JS, os-ui npm) | 1.9.1 | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | TOML reader for an app's `bunfig.toml` in the Software tab's dependency scan (`tabs/software/lib/scope-pin.ts`) |

Deliberately **not** added: `langfuse-langchain@3` — its peer range is the legacy `langchain <0.4`
(`@langchain/core` 0.x), incompatible with `@langchain/core@1` that LangGraph 1.x requires; its
successor `@langfuse/langchain@6` (OTel-based) is the alternative if a LangChain callback
handler is ever needed. Model calls go through LiteLLM via our own `LlmCall`, not LangChain chat
models, so run tracing is done explicitly with the `langfuse` SDK.

### Retrieval, data & catalog

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| OpenSearch | chart 3.7.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/OpenSearch-NOTICE.txt` |
| OpenSearch Dashboards | chart 3.7.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | |
| ClickHouse | 24.8 | Apache-2.0 | `licenses/Apache-2.0.txt` | Langfuse analytics backend |
| Valkey | 8.1 | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | Cache/queue (**not** Redis/SSPL) |
| PostgreSQL | 17.5 | PostgreSQL | `licenses/PostgreSQL.txt` | CloudNativePG-managed image |
| CloudNativePG (operator) | chart 0.28.3 / op 1.29.1 | Apache-2.0 | `licenses/Apache-2.0.txt` | Bootstrap prerequisite |
| dbt Core | 0.1.0 image | Apache-2.0 | `licenses/Apache-2.0.txt` | Transformations |
| Haystack | in retriever image | Apache-2.0 | `licenses/Apache-2.0.txt` | RAG pipeline |
| Cube | digest-pinned | Apache-2.0 | `licenses/Apache-2.0.txt` | Semantic/metrics layer |
| OpenMetadata | chart 1.13.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | Catalog/lineage |
| Docling | digest-pinned | MIT | `licenses/MIT.txt` | Document parsing |
| OPA (Open Policy Agent) | 1.4.2 | Apache-2.0 | `licenses/Apache-2.0.txt` | Policy-as-code |
| Dagster | chart 1.13.11 | Apache-2.0 | `licenses/Apache-2.0.txt` | Orchestrator |
| DuckDB | in sandbox-duckdb image | MIT | `licenses/MIT.txt` | Personal/sandbox lane engine (behind Trino) |
| Apache Polaris | 1.0.1-incubating | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Polaris-NOTICE.txt` |
| Superset | chart 0.17.2 / app 6.1.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | NOTICE: `licenses/notices/Apache-Superset-NOTICE.txt` |
| Apache Superset (vendored source) | `c83fb2bb1dcfac41ac51bcebd82471f4a7180d18` | Apache-2.0 | `licenses/Apache-2.0.txt` | Pure chart transformers vendored into `os-ui/vendor/superset/`, pinned to a commit sha; NOTICE: `licenses/notices/Apache-Superset-NOTICE.txt` |
| Trino | 476 | Apache-2.0 | `licenses/Apache-2.0.txt` | Central governed query engine (all shared marts) |
| Apache Spark | optional (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Optional; NOTICE: `licenses/notices/Apache-Spark-NOTICE.txt` |
| SeaweedFS | 3.97 | Apache-2.0 | `licenses/Apache-2.0.txt` | Air-gap object storage |
| Supabase | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | |

### Software delivery & platform

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| Conftest | 0.56.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | CI-only binary. Pre-merge OPA/Rego policy gate for the `analytics` monorepo (#146). Pinned in the seeded `.forgejo/workflows/ci.yml`; **not** bundled in a runtime image (downloaded by the CI job). |
| Argo CD | chart 10.0.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | GitOps deploy |
| Harbor | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Production registry |
| Velero | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Backup/restore |
| git (backup-tools, git-daemon and git-http images) | 2.47.3 | GPL-2.0-only | `licenses/GPL-2.0.txt` | Unmodified Alpine package, a separate tool binary run as its own process (`git bundle`/`fsck` for WP-56 backups, `git daemon`, `git-http-backend`); never linked into OS code — mere aggregation |
| cert-manager | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | TLS certificate management |
| External Secrets Operator | chart 2.15.0 | Apache-2.0 | `licenses/Apache-2.0.txt` | Secrets from STACKIT Secrets Manager (WP-10). Its own release (`deploy/external-secrets/`); the optional `bitwarden-sdk-server` subchart stays disabled. |
| Cilium | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | CNI / NetworkPolicy enforcement |
| Ory | platform | Apache-2.0 | `licenses/Apache-2.0.txt` | Identity / auth federation |

### Layer 4 — Science / ML (optional, `ml.enabled=false`)

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| JupyterHub | Layer 4 (off) | BSD-3-Clause | `licenses/BSD-3-Clause.txt` | Notebooks |
| MLflow | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Experiment tracking / model registry |
| KServe | Layer 4 (off) | Apache-2.0 | `licenses/Apache-2.0.txt` | Model serving / inference |

### Helper / demo images

| Component | Version | License (SPDX) | Full text | Notes |
|---|---|---|---|---|
| amazon/aws-cli | 2.31.13 | Apache-2.0 | `licenses/Apache-2.0.txt` | Bucket-init helper |
| traefik/whoami | 1.10.3 | MIT | `licenses/MIT.txt` | Software-delivery demo app |
| **Trivy** | **0.58.2** (`aquasec/trivy`) | **Apache-2.0** | `licenses/Apache-2.0.txt` | **Software deploy security scanner.** os-ui launches ONE Job per deploy request (`os-ui/tabs/software/lib/scan-trivy.ts`) and maps its JSON onto the Builder review card: dependency vulnerabilities from the app's manifests/lockfiles + committed secrets. **Deployed image only** — no Trivy source is vendored into `os-ui` and nothing links against it; it is a separate short-lived process (mere aggregation). `sast` stays *not run*: Semgrep's engine is LGPL-2.1 and is **not** on `licenses/allowed-licenses.txt`. |
| Docker-in-Docker (dind) | 27 | Apache-2.0 | `licenses/Apache-2.0.txt` | CI build sidecar (Moby/Docker) |

### Model serving

> Inference runs entirely on **STACKIT AI Model Serving** (a managed, EU-sovereign
> API — three-tier set: reasoning `Qwen/Qwen3-VL-235B-A22B-Instruct-FP8`,
> standard/worker `openai/gpt-oss-20b`, embeddings `Qwen/Qwen3-VL-Embedding-8B`).
> No model engines or model weights are bundled or redistributed by this project;
> LiteLLM calls the managed API. On kind/local the bundled `mock-model` (our own
> Apache-2.0 image) serves deterministic offline embeddings only.

### Referenced but NOT bundled

| Component | Version | License (SPDX) | Notes |
|---|---|---|---|
| MinIO | digest-pinned | AGPL-3.0 | **Local dev-only S3 stand-in.** AGPL — **never bundled/redistributed** in the product. SeaweedFS (Apache-2.0) is the bundled/air-gap object store. Full text kept for transparency at `licenses/AGPL-3.0.txt`. |

> Our own images (`sovereign-os/*`: mock-model, sample-agent, poet-agent,
> haystack-retriever, query-tool, dbt, dagster, superset, egress-proxy, web-fetch,
> os-ui, ci-builder) are **Borek Data Ventures UG** code under
> **Apache-2.0** (`LICENSE`) and carry SPDX headers.

---

## Copyleft source availability

- **git (GPL-2.0-only)** — the unmodified Alpine package in the git-http, git-daemon and backup-tools images, run as a
  separate program (reviewed exception in `licenses/exceptions.json`). Upstream source and the written offer for the
  air-gap bundle are recorded in `licenses/source-offer.md`.
- **psycopg 3.3.6 (LGPL-3.0-only), certifi 2026.10.19, orjson 3.13.0, tqdm 4.67.3 (MPL-2.0)** — in the
  LiteLLM gateway image `litellm-oss` **only**.
  - **Exception:** reviewed and written, owner sign-off 2026-11-24 (`licenses/exceptions.images.json`,
    condition `unmodified-not-linked`, re-review on any version change and by 2027-05-24).
  - **How they are shipped:** unmodified PyPI wheels, dynamically imported, replaceable.
  - **Why each is needed, and the exit plan:** `docs/components/litellm-oss.md`, "Reviewed exceptions
    (copyleft packages)".
  - **Licence texts:** in the image, `/usr/share/licenses/litellm-oss/`.
  - **Exact sources and how to replace psycopg:** `licenses/source-offer.md` and the image's
    `THIRD_PARTY_NOTICES.md`.
  - **Gate:** any other non-permissive package in that image fails `scripts/license-gate-image.mjs`.

The air-gap bundle (per `stackit/packaging.md`) ships `sbom.cdx.json`, this manifest,
and the whole `licenses/` directory alongside the mirrored images.

## Release process

On every release:

1. `scripts/license-check.sh --update-sbom` — regenerate `sbom.cdx.json` (syft) and run
   the licence gate (`licenses/policy.json`; see "Licence policy" above).
2. Reconcile this manifest + `licenses/components.tsv` with any added/updated/removed
   components and pinned versions in `Chart.yaml` / `values.yaml`.
3. Add the full license text for any **new** license under `licenses/`, and the
   component's NOTICE (if it ships one) under `licenses/notices/`.
4. Update `licenses/source-offer.md` if a copyleft component's pinned version changed.

The CI gate (`.github/workflows/license-gate.yml`) fails the build if a component's
license is never allowed by `licenses/policy.json` (AGPL, source-available), is copyleft without a reviewed
exception, is unknown without a reviewed exception, or lacks an attribution entry.
