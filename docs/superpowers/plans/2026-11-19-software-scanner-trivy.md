# A real security scanner on the software path, and one audited hatch

**Filed:** 2026-11-19 · **Branch:** `feat/software-scanner-trivy` (from `public/main` `7c45bd95`) ·
**Phases:** PLAN → DESIGN → IMPLEMENT (test-first) → TEST, one commit each.

## 1. The defect, as it stands on this head

`tabs/software/lib/scan.ts` has never had a live engine. Since PR #56 closed the honesty hole
(`docs/superpowers/plans/2026-11-18-offline-mock-production-guard.md` §8, open item 1) the
deterministic baseline no longer issues a verdict on a deployed cluster:

```ts
const resolved: ScanMode = mode ?? (offlineMockAllowed() ? 'offline-mock' : 'unavailable');
…
if (resolved === 'unavailable') return { mode: 'unavailable', passed: false, …, reason };
```

`decideDeploy` approves only on `card.scan.passed`, so on the STACKIT cluster **every software
deploy is blocked**:

> Cannot approve: there is no security verdict to approve. No security scanner engine ran…

`ReviewCard.tsx` renders `security scan NOT RUN` with the reason and disables Approve. That is the
honest state and it is *correct* — a pass from an engine that never ran is the original defect —
but it is a product gap, recorded as such in the #56 plan:

> **No live security scanner is wired.** … That is the honest state … but it is a real product
> gap, not a side effect to be shrugged at.

Two things are therefore missing, and they are different kinds of thing:

1. **An engine.** Nothing in the repo runs a real scanner over an app's files.
2. **A governed way through, for the case where the engine genuinely cannot run.** #56's review
   round M2 deliberately refused a *per-subsystem offline-mock exemption* ("wire the scanner
   instead"), and that decision stands: `OS_OFFLINE_MOCK` keeps ONE lever and this change does not
   touch it. What M2 did not provide is an *approval-time*, *admin-only*, *audited* override —
   which is a governance control, not a fabrication switch. The difference matters: an exemption
   would make the OS **claim** a clean scan; a hatch makes a named human **take responsibility**
   for approving without one, on the record.

## 2. Required outcome

* A real filesystem scan (dependency vulnerabilities + committed secrets) runs in-cluster per
  deploy request, and `scan.mode === 'live'` **only** when the scanning Job actually completed.
  A failed, timed-out or unreachable Job stays `unavailable` with a reason — never a pass.
* `sast` stays honestly **not run**: Semgrep's engine is LGPL-2.1 and excluded by
  `licenses/allowed-licenses.txt`, and the UI says so rather than implying coverage.
* An `admin` — not `domain_admin`, not `builder` — may approve a deploy whose scan is
  `unavailable` by explicitly acknowledging it with a written reason (≥ 20 characters). The
  approval record, the Governance approval's effect and the audit log all carry
  `approvedWithoutScan: true`, the reason and the acting admin. A scan that **ran and failed** can
  never be acknowledged.
* `OS_OFFLINE_MOCK` is untouched. Nothing in this change lets a deployment fabricate anything.

## 3. The engine choice — Trivy, and why

| Candidate | Licence | Verdict |
|---|---|---|
| **Trivy** (`aquasecurity/trivy`) | **Apache-2.0** | **CHOSEN.** One binary covers dependency vulnerabilities over lockfiles/manifests *and* secret detection; `trivy fs --format json` is a stable, documented contract; it ships as a published image, so it is a **deployed component**, not vendored code. |
| Semgrep OSS | **LGPL-2.1** (engine) | **EXCLUDED** — not on `licenses/allowed-licenses.txt`. This is why `sast` stays "not run": there is no allowlisted SAST engine to wire, and claiming SAST coverage from a vulnerability scanner would be the same dishonesty #56 removed. |
| gitleaks | MIT | Not needed: Trivy's `secret` scanner covers the same ground in the same pass, and one Job is one failure mode. Kept as a future second opinion, not a dependency. |
| Grype / OSV-Scanner | Apache-2.0 / Apache-2.0 | Viable alternates for the `deps` half only. Rejected on "one Job, two categories". |

Trivy enters the bundle as an **image we deploy, not source we ship**, so `CONTRIBUTING.md`'s
bundled-component rule applies (a row in `THIRD-PARTY-LICENSES.md` + `licenses/components.tsv` +
`NOTICE` + `sbom.cdx.json` + `core/kernel/licenses.ts`), and the `os-ui/vendor/` carve-out does
**not** (nothing is compiled into `os-ui`).

## 4. The design

### 4.1 How the scan runs

```
requestDeploy(appId, user)
  └─ appFilesForScan(app)                 (unchanged: the real committed tree)
  └─ resolveScan(files, opts.scanMode)    NEW seam in scan.ts
       ├─ an explicit mode from the caller WINS (tests, and the existing override)
       ├─ scanner disabled            → securityScan(files)   (the #56 decision, unchanged)
       └─ scanner enabled             → runTrivyScan(files)   → ScanResult{mode:'live'}
                                                              │ Job failed/timeout/unreachable
                                                              └→ ScanResult{mode:'unavailable'}
```

`securityScan(files, mode)` keeps its signature, its synchronous body and its #56 semantics
**exactly**: it is the tripwire-pinned decider and the baseline evidence producer. The live path is
a new `async` door beside it, so nothing that imports `securityScan` changes meaning.

### 4.2 The Job

One Kubernetes Job per scan, in the **release namespace**, named
`os-scan-<appSlug>-<short-hash>`, modelled on `tabs/software/lib/runner.ts`: deterministic names,
`GET → PUT/POST` idempotent upsert, an **injectable** k8s client so the whole adapter is
unit-testable without a cluster, and honest degradation (API unreachable ⇒ `unavailable`, never a
verdict).

* **Image:** `aquasec/trivy`, tag pinned in `values.yaml`, optional digest pin.
* **Getting the files in:** the app tree is rendered to a **generated `sh` writer script** —
  `mkdir -p` plus one `printf %s '<base64>' | base64 -d > <path>` per file — base64-encoded into
  ONE container env var, decoded and run by the container's `sh -c` prelude before `trivy fs`.
  * *Why not a ConfigMap:* it would require `configmaps` create/delete RBAC in the platform
    namespace for a transient payload. The brief's RBAC floor is jobs + pods only, and a
    namespace-wide ConfigMap write is exactly the kind of grant that gets reused later.
  * *Cost:* a pod spec has a practical size ceiling. The adapter therefore enforces an explicit
    `maxPayloadBytes` (default 768 KiB of encoded payload) and, above it, returns
    `unavailable` with the real reason ("app tree too large for the inline scan payload") rather
    than scanning a truncated tree and calling it live. Recorded as open item 1.
* **Reading results back:** `trivy fs --quiet --format json` writes pure JSON to **stdout**; the
  adapter polls the Job to completion and reads the pod's `/log` subresource via the existing
  `k8sText` helper. No shared volume, no second service, no results file to clean up.
* **Lifecycle:** `ttlSecondsAfterFinished` so finished Jobs self-delete; `backoffLimit: 0`
  (a retry would double the wall clock for a scan that is going to fail the same way);
  `activeDeadlineSeconds` from the configured timeout.
* **Pod hardening:** `runAsNonRoot`, `readOnlyRootFilesystem` with `emptyDir` scratch for `/work`
  and Trivy's cache, `allowPrivilegeEscalation: false`, dropped capabilities,
  `automountServiceAccountToken: false` (the scanner needs no API access of its own).

### 4.3 The vulnerability database — the documented choice

Trivy needs a vulnerability DB. Two modes, one values key, and the default is the one that works
on a locked-down cluster without a surprise:

| `osUI.software.scanner.dbMode` | What the Job does | Egress needed |
|---|---|---|
| `mirror` (**default**) | `trivy fs` pulls the DB from `dbRepository` (default `ghcr.io/aquasecurity/trivy-db`), cached in the pod's `emptyDir` for the life of the Job | DNS + TCP 443 to the mirror |
| `offline` | `--skip-db-update --skip-java-db-update --offline-scan`; the DB must already be baked into the scanner image the operator pulls | DNS only |

`mirror` is the default because `offline` with no baked DB produces a scan that finds **nothing**
and would report `passed: true` — a clean verdict from an empty database is precisely the failure
mode this whole line of work exists to prevent. An operator running air-gapped sets `offline`
**and** points `image.repository` at their own DB-baked mirror image; the plan's §8 operator steps
say so in those words.

The NetworkPolicy is written to match: a dedicated policy for
`app.kubernetes.io/component: software-scanner` allowing DNS always and 443 only when
`dbMode: mirror`, plus removal of the scanner pods from the namespace's blanket
`allow-intra-namespace-egress` / `allow-apiserver-egress` rules (the same `NotIn` treatment
`agent-schedule` already gets, for the same reason: a pod whose only job is one outbound DB fetch
has no business on the in-namespace plane or the API server).

### 4.4 Mapping Trivy JSON onto `ScanResult`

| Trivy | `ScanFinding` |
|---|---|
| `Results[].Vulnerabilities[]` | `category: 'deps'`, severity lower-cased (`UNKNOWN`→`info`), title `<PkgName>@<InstalledVersion>: <VulnerabilityID>`, detail = title/description + fixed version, `path` = `Target` |
| `Results[].Secrets[]` | `category: 'secrets'`, severity **always `critical`** (the existing rule: a leaked secret always blocks), title from `RuleID`/`Title`, `path` = `Target` + line |
| `Results[].Misconfigurations[]` | **deliberately not mapped** — `ScanCategory` is `sast \| deps \| secrets` and there is no honest slot; folding misconfig into `sast` would claim SAST coverage. Open item 2. |
| no `Results` / unparseable | **not** a clean scan: `unavailable` with the parse error |

`passed` is computed by the SAME rule as the baseline (no secret, no high/critical), so the gate
`decideDeploy` enforces does not change shape. `ScanResult` gains two additive optional fields:
`engine?: string` (`'trivy 0.x'`) and `notRun?: ScanCategory[]` (`['sast']`), so the card can say
which categories were actually covered instead of letting a zero count imply "clean".

### 4.5 The approval hatch

```
decideDeploy(cardId, user, 'approve', note, { acknowledgeNoScan: true, reason: '…' })
POST /api/software/reviews/<cardId>/decide-equivalent  (the existing POST on the card route)
  body { decision:'approve', acknowledgeNoScan:true, reason:'…' }
MCP decide_deploy { cardId, decision:'approve', acknowledgeNoScan:true, reason:'…' }
```

Refusal matrix, all typed and all tested:

| scan state | role | `acknowledgeNoScan` | reason | outcome |
|---|---|---|---|---|
| `unavailable` | `admin` | true | ≥ 20 chars | **approved**, `approvedWithoutScan: true` |
| `unavailable` | `admin` | true | missing / < 20 | **400** — the reason is the record |
| `unavailable` | `domain_admin` / `builder` | true | any | **403** — naming the role required |
| `unavailable` | any | absent | any | **409** — the existing "no verdict to approve" |
| ran and **FAILED** | `admin` | true | any | **409** — a real failure still blocks; the hatch names itself as inapplicable |
| passed | any builder+ | n/a | n/a | approved as today |

What the acknowledgement writes:

* `ReviewCard.approvedWithoutScan: true`, `.noScanReason`, `.decidedBy` (additive optional fields).
* The Governance approval's `effect.approvedWithoutScan = { reason, by, scanMode }` via the
  existing `recordEffect` seam — this is the `core/policy` bit, and it is why the card in the
  Governance inbox can show it without the Software tab re-telling the story.
* One `core/policy/audit.ts` entry: `action: 'deploy'`, `actor` = the admin, `subject` = the app,
  `reason` = the typed reason, `detail.approvedWithoutScan = true` + `cardId` + `scanMode` +
  `scanReason`. Hash-chained like every other audit row, so the acknowledgement cannot be removed
  without breaking `verifyChain()`.
* The existing `trace()` call gains the same two fields, so the agent-visible run trace shows it.

The UI (`tabs/governance/ui/ReviewCard.tsx`, scan block only): when `scan.unavailable` **and** the
new optional `canAcknowledgeNoScan` prop is true, Approve is no longer unconditionally disabled —
a checkbox ("Approve without a security verdict") plus a required reason field appear, Approve
enables only when both are satisfied, and a decided card renders
**"approved without a security verdict"** with the reason and the admin. Non-admins see exactly
today's disabled button and reason. The prop is optional and defaults to `false`, so the other
call sites (including `SoftwareBuilder.tsx`, owned by another agent this session) compile and
behave unchanged.

## 5. Scope — the files

### Mine (owned outright by this brief)

| File | Change |
|---|---|
| `os-ui/tabs/software/lib/scan-trivy.ts` | **new** — the adapter: Job manifest builder, payload writer, poll + log read, Trivy-JSON mapper, injectable k8s |
| `os-ui/tabs/software/lib/scan.ts` | **additive** — `resolveScan` / `securityScanLive`; `securityScan` itself untouched |
| `os-ui/tabs/software/lib/review.ts` | scan call becomes `await resolveScan(...)`; `decideDeploy` gains the hatch + the audit write |
| `os-ui/tabs/governance/ui/ReviewCard.tsx` | the scan block + the acknowledgement controls |
| `charts/.../templates/base/os-ui/software-scanner.yaml` | **new** — Role + RoleBinding (jobs, pods, pods/log) + the scanner NetworkPolicies. IMPLEMENT change from the plan: the `batch/jobs` grant became its OWN flag-gated Role here rather than a rule inside the shared `os-ui.yaml` Role, so that file was never touched and the grant disappears entirely when the scanner is off |
| `docs/superpowers/plans/2026-11-19-software-scanner-trivy.md` | this plan |

### Shared files, edited additively (declared in the report)

| File | Additive change |
|---|---|
| `os-ui/tabs/software/lib/model.ts` | `ScanResult.engine` / `.notRun`; `ReviewCard.approvedWithoutScan` / `.noScanReason` — all optional |
| `os-ui/core/policy/approvals.ts` | `ApprovalEffect.approvedWithoutScan?` — optional |
| `os-ui/core/kernel/config.ts` | five `softwareScanner*` keys |
| `charts/.../values.yaml` | `osUI.software.scanner.*` |
| `charts/.../templates/base/os-ui/_os-ui-env.tpl` | the scanner env block (RUN path, so the worker matches) |
| `charts/.../templates/base/network/egress-policies.yaml` | `software-scanner` added to two `NotIn` lists |
| `os-ui/app/api/software/reviews/[cardId]/route.ts` | reads the two new body fields |
| `os-ui/app/(experimental)/software/reviews/page.tsx` | passes `canAcknowledgeNoScan` |
| `os-ui/tabs/software/lib/platform-mcp.ts` + `core/mcp/experimental/platform-tools.ts` | the two new `decide_deploy` arguments |
| `NOTICE`, `THIRD-PARTY-LICENSES.md`, `licenses/components.tsv`, `sbom.cdx.json`, `os-ui/core/kernel/licenses.ts` | the Trivy row |

**Not touched**, because another agent owns the build/deploy path this session:
`tabs/software/lib/builder/**`, `tabs/software/lib/app-records.ts`,
`tabs/software/ui/SoftwareBuilder.tsx`, `runner.ts`, `preview-runtime.ts`.

## 6. The tests, test-first and in this order

1. **`tabs/software/lib/scan-trivy.test.ts`** — the mapper against four pinned Trivy JSON
   fixtures: **clean** (`Results: []` ⇒ `passed: true`, zero findings, `notRun: ['sast']`),
   **vulnerable** (a HIGH npm CVE ⇒ one `deps` finding, `passed: false`), **secret found**
   (`Secrets[]` ⇒ one `critical` `secrets` finding, `passed: false`), **malformed** (not JSON /
   no `Results` ⇒ `unavailable` + reason, **never** `passed: true`). Plus: the Job manifest's
   image/flags/hardening/TTL, the writer payload round-trip, `dbMode: offline` adds
   `--skip-db-update`, and the payload cap refuses instead of truncating.
2. **`tabs/software/lib/scan-live.test.ts`** — the seam: Job succeeds ⇒ `mode: 'live'`; Job
   `failed` ⇒ `unavailable`; Job never completes within the deadline ⇒ `unavailable`; the k8s API
   unreachable (`status: 0`) ⇒ `unavailable`; scanner flag off ⇒ the #56 behaviour verbatim.
   Includes the **tripwire that `securityScan` has no mock default**, kept from #56: with
   `NODE_ENV=production` and `OS_OFFLINE_MOCK` unset, no path returns `passed: true` without an
   engine.
3. **`tabs/software/lib/review-no-scan-hatch.test.ts`** — the `decideDeploy` matrix of §4.5 row by
   row, the audit row's content (`action`, `actor`, `detail.approvedWithoutScan`, the reason text,
   chain intact), and that a **failed live scan cannot be acknowledged**.
4. **`tabs/software/lib/scanner-chart.test.ts`** — the chart text: the Job RBAC rule exists with
   exactly `create/get/list/watch` on `jobs` + `pods` (+ `pods/log` read), the values flag defaults
   to `true`, the image is pinned, the NetworkPolicy is present and `OS_OFFLINE_MOCK` is not
   weakened anywhere in the diff. Reads the repo files directly (the `vendor-licence.test.ts`
   precedent) so it needs no `helm` binary; `helm lint` covers rendering in the gates.

Every new file carries the SPDX header **and** `FEATURE:` / `USER STORY:` / `ARCHITECTURE:`, so
`FILE-HEADER` must not move. No new file names the offline-mock marker strings, so the
`core/kernel/offline-mock-tripwire.test.ts` partition needs no new entry.

## 7. Gates

`os-ui/node_modules/.bin/tsc --noEmit -p os-ui` · the targeted tests · ONE full
`npm --prefix os-ui test --test-concurrency=2` · `bash os-ui/scripts/gate.sh` ·
`node scripts/check-structure.mjs` (ceilings `TAB-ISOLATION 419` / `LEGACY-IMPORT 1` /
`CORE-INDEPENDENCE 200` / `FILE-HEADER` at or below its committed baseline) ·
`bash scripts/license-check.sh` · `helm lint charts/sovereign-agentic-os -f values.local.yaml`.

No deploy, no merge, no live-cluster call.

## 8. What an operator does to turn it on

The chart turns it on by DEFAULT (`osUI.software.scanner.enabled: true`), so a normal
`helm upgrade` is enough — but two things must be true on the cluster first, and both are
operator work, not chart work:

**1. The image must be pullable.** There is no OS image builder and nothing pulls it on your
behalf at install time; the first scan pulls it:

```
aquasec/trivy:0.58.2
```

Air-gapped or registry-mirrored installs re-tag it into their own registry and point the chart
at that:

```
--set osUI.software.scanner.image.repository=harbor.internal/mirror/aquasec/trivy \
--set osUI.software.scanner.image.tag=0.58.2 \
--set osUI.software.scanner.image.digest=sha256:<digest>      # optional, recommended
```

**2. The vulnerability database must be reachable — or baked in.** Pick one, deliberately:

```
# (a) DEFAULT — the Job fetches the DB per scan. Needs DNS + TCP 443 egress, which the
#     chart's software-scanner-egress NetworkPolicy grants and nothing else.
--set osUI.software.scanner.dbMode=mirror \
--set osUI.software.scanner.dbRepository=ghcr.io/aquasecurity/trivy-db

# (b) AIR-GAPPED — no registry is contacted at all (--skip-db-update --offline-scan), so the
#     image you pull MUST already contain the DB. An image without one finds nothing and the
#     scan would PASS, so only use this with a DB-baked mirror image.
--set osUI.software.scanner.dbMode=offline \
--set osUI.software.scanner.image.repository=harbor.internal/mirror/trivy-with-db
```

Verified renders on this branch:

| Command | Result |
|---|---|
| default | Role + RoleBinding + `software-scanner-egress` (DNS + 443) + `software-scanner-no-ingress`; `SOFTWARE_SCANNER_*` on **both** the `os-ui` and `os-ui-worker` pods |
| `--set osUI.software.scanner.enabled=false` | the whole template renders **nothing**; `SOFTWARE_SCANNER_ENABLED=false` is still set, so the UI says the scanner is off instead of "nothing is wired" |
| `--set osUI.software.scanner.dbMode=offline` | **zero** `port: 443` rules — DNS only |

Optional, if a first scan is slow because of the DB fetch:
`--set osUI.software.scanner.timeoutSeconds=300`.

**What NOT to do.** Do not set `osUI.offlineMock=allow` to unblock a deploy. That re-enables
fabricated metrics, ingests and connector syncs tenant-wide and still does not scan anything —
and it is the exact trade #56's review M2 refused. If the scanner cannot run and a deploy must
ship, use the admin acknowledgement: it ships the same deploy and leaves a record of who decided
and why.

**Verifying it on the cluster** (read-only, nothing in this branch was deployed):

```
kubectl -n agentic-os get role os-ui-software-scanner
kubectl -n agentic-os get netpol software-scanner-egress software-scanner-no-ingress
kubectl -n agentic-os get jobs -l app.kubernetes.io/component=software-scanner
```

A scan Job self-deletes 600 s after it finishes (`ttlSecondsAfterFinished`), so an empty list
between deploys is the expected state.

---

## 9. Outcome (TEST phase, 2026-11-19)

### Gates, measured on `feat/software-scanner-trivy`

| Check | Result |
|---|---|
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| full unit suite (`--test-concurrency=2`) | **exit 0** — 6601 tests, 6597 pass, **0 fail**, 4 todo (the pinned regression markers) |
| `bash os-ui/scripts/gate.sh` | **exit 0** — 436 tests, 432 pass, 0 fail, 4 todo; all four chart/allowlist checks pass, including `OS_OFFLINE_MOCK` still explicit on both pods and defaulting to `refuse` |
| `node scripts/check-structure.mjs` | **exit 0** — "ok (no new violations)" |
| ratchet | `TAB-ISOLATION 419` · `LEGACY-IMPORT 1` · `CORE-INDEPENDENCE 200` — at baseline; `FILE-HEADER 1230` against a committed baseline of 1235, i.e. **5 under**. Not re-baselined: the baseline file is shared with another agent's branch this session, and tightening it is not this change's business. |
| `bash scripts/license-check.sh` (with syft) | **exit 0** — "LICENSE GATE: PASS", 48 bundled components checked, `Trivy (aquasec/trivy) -> Apache-2.0` among them. The five syft warnings are pre-existing transitive app-dependency licences, unchanged by this branch. |
| `helm lint charts/sovereign-agentic-os -f values.local.yaml` | **exit 0** — 1 linted, 0 failed |

### New tests — 40, in four files

| File | Tests | What they pin |
|---|---|---|
| `tabs/software/lib/scan-trivy.test.ts` | 17 | the four Trivy JSON fixtures (clean / vulnerable / secret / malformed, the last across six malformed inputs), the Job manifest's hardening + label + TTL + `backoffLimit: 0`, the base64 writer's quoting safety, unsafe paths and the payload cap failing closed, `dbMode` arguments, and every Job failure mode (failed, timeout, unreachable, unreadable log) |
| `tabs/software/lib/scan-live.test.ts` | 10 | the seam: a completed Job is the only route to `live`; failed / timed-out / unreachable / disabled all land on `unavailable` with the real cause; the laptop flow is unchanged; the baseline evidence survives a refused verdict; and the #56 tripwire — under `NODE_ENV=production` no path returns `passed: true` without an engine |
| `tabs/software/lib/review-no-scan-hatch.test.ts` | 8 | the §4.5 matrix row by row, including domain_admin **and** builder refused with their rank named, six bad reasons refused, a **failed** scan refused, and the happy path's three writes (card, approval effect, hash-chained audit row with `verifyChain() === null`) |
| `tabs/software/lib/scanner-chart.test.ts` | 5 | the Role's exact resources and verbs (and that it grants no Secrets, no ConfigMaps, no `pods/exec`, and is not a ClusterRole), the flag's default, the pinned image, the NetworkPolicies, the scanner's exclusion from the two blanket egress allows, the env on the RUN path, and that nothing here sets `OS_OFFLINE_MOCK` |

The ten most-related pre-existing files (`scan`, `review`, `review-security`, `approval-sync`,
`offline-mock-production`, `reconcile-deploy`, `platform-mcp`, the kernel offline-mock tripwire,
`approvals-route`, `audit`) pass unchanged — 63 tests. That is the property that made this safe:
the laptop flow still answers `offline-mock` because `resolveScan` delegates the
no-verdict decision to `securityScan`, which already keys on `OS_OFFLINE_MOCK`.

### Decisions a later reader will want

* **`sast` is `notRun`, not `0`.** There is no allowlisted SAST engine — Semgrep's is LGPL-2.1
  and absent from `licenses/allowed-licenses.txt` — so the card says "sast not run" with the
  reason. A zero would have been the same shape of lie #56 removed.
* **Misconfiguration scanning is not requested.** `--scanners vuln,secret` only. `ScanCategory`
  is `sast | deps | secrets` and folding misconfig into `sast` would claim SAST coverage. Open
  item 2.
* **The scanner Job runs in the RELEASE namespace, not `softwareRunner.namespace`.** It holds the
  app's SOURCE; the apps namespace is where untrusted student code runs.
* **The files travel inline, not via a ConfigMap.** A ConfigMap would need namespace-wide
  `configmaps` create/delete in the os-ui Role for a transient payload, and that grant would be
  reused. The cost is the payload ceiling — open item 1.
* **The hatch is `admin`-only, not `domain_admin`.** `domain_admin` approves artefact promotions
  in its own domain; a security waiver is a different kind of authority and must not be inherited.
* **The hatch writes an audit row only for the waiver.** An audit log carrying every ordinary
  approval is one nobody reads; the Governance item and the run trace already record those.

### Open items

1. **The payload ceiling (768 KiB encoded) is a real limit.** A larger tree is REFUSED, honestly,
   with the size in the reason — not truncated. The follow-up is an initContainer that clones
   from the OS git store instead, which needs a credential decision; filed rather than guessed.
2. **No misconfiguration findings**, per the decision above. Adding them means adding a fourth
   `ScanCategory`, which touches the serialised card shape and the Builder UI — a separate change.
3. **No SAST at all.** Not fixable without an allowlisted engine. If one is wanted, the licence
   question comes first, not the wiring.
4. **The DB mirror's 443 rule is destination-wide.** Kubernetes NetworkPolicy cannot express a
   hostname; on Cilium (STACKIT) narrow it with an FQDN policy, or run `dbMode: offline`. Recorded
   in the template's own comment so the next reader meets it there.
5. **Not verified against a live cluster.** Every Job branch is unit-tested against an injected
   API client; nothing in this branch was deployed, per the brief. The first real scan will
   exercise the image pull and the DB fetch for the first time.
6. **Not deployed, not merged** — per the brief. The branch is pushed and one PR is open.

---

## 10. Review round (PR #63, 2026-11-19) — H1–H3 blocked merge

An independent review found three blockers, and it was right about all three: each one is a way
the *first* implementation could have shipped a verdict weaker than the baseline it replaced, or
no verdict at all. Per finding.

### H1 (block) — `Results: []` was read as a clean dependency verdict. **Fixed.**
Trivy's language analysers resolve dependencies from **lockfiles**. Our own scaffolds emit
`package.json` with **no** lockfile (`scaffolds/vite-os.ts`'s Dockerfile even says "if no
lockfile is committed yet"), so `trivy fs` returns `Results: []` and the first mapper read that as
`deps 0, passed: true, mode: 'live'` — a green dependency verdict over dependencies **never
resolved**, and therefore *weaker* than the two-entry baseline it replaced, which would still have
flagged `lodash@4.17.20` straight from the manifest.

*How:* coverage is now **derived from evidence**. `mapTrivyReport(text, files)` takes the scanned
tree; if it holds a dependency manifest (`package.json`, `requirements*.txt`, `pyproject.toml`,
`Pipfile`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle`, `composer.json`) and **no**
result carries `Class: 'lang-pkgs'`, then `'deps'` joins `notRun`, `passed` is **false**, and the
`reason` names the cause — distinguishing "there is no lockfile" (names the manifests it saw, and
what to commit) from "a lockfile is present but the ecosystem is unsupported". The card renders
that reason for a *live* scan too, not only for `unavailable`.

*And the baseline is layered on top, not replaced.* `resolveScan` runs `securityScan` alongside
every live scan and merges its `deps` and `secrets` findings into the result (deduped; `sast`
excluded, because `notRun` says sast was not covered and adding heuristics would contradict the
label). The strictest answer wins: `passed` requires both. So the real scaffold case —
`lodash@4.17.20`, no lockfile — comes back `mode: 'live'`, `passed: false`, with the actionable
finding present, `notRun: ['sast','deps']` and the lockfile named.

*On emitting a lockfile from the scaffold:* **deliberately not done, and this is the honest
answer.** A lockfile we synthesise would carry no integrity hashes and no resolved transitive
tree; Trivy would then resolve a *fiction* and report a verdict over it — the same class of defect
as #56, dressed as a fix. Running `npm install --package-lock-only` inside the Job was considered
and rejected: it needs `npm` in the scanner image (it is not there) and **registry egress from the
scan pod**, which is exactly the reach H2 is about narrowing. The honest states are the two we
now produce: a tree *with* a lockfile gets a dependency verdict; a tree without one is told, in
the reason, that it will not get one until a lockfile is committed. Open item 7 carries the
follow-up.

### H2 (block) — the DB-mirror rule granted 443 to *any* destination. **Fixed.**
`software-scanner-egress` carried a `ports:`-only rule with no `to:`. A NetworkPolicy rule without
`to:` matches **every** destination, so the "narrow" scanner policy was *wider* than the
egress-proxy chokepoint — and re-granted the API server the `NotIn` exclusion had just taken away.

*How:* the rule now mirrors policy 5 of `egress-policies.yaml` exactly: `ipBlock 0.0.0.0/0` with
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` in `except`. Public address space only, so it can
reach an OCI registry and nothing in the cluster. NetworkPolicy still cannot name a hostname —
that limit is now recorded in the template itself, with the two real answers (a Cilium FQDN policy,
or `dbMode: offline`). `scanner-chart.test.ts` asserts the `to:` block and all three `except`
entries.

### H3 (block) — a 768 KiB env var cannot start a container. **Fixed.**
The writer script travelled in one container env var capped at **768 KiB**. Linux
`MAX_ARG_STRLEN` caps a single argument/environment string at **128 KiB**, so for any real app the
container would have failed to start with `E2BIG`, every scan would have come back `unavailable`,
and **the admin hatch would have become the routine path** — the worst possible outcome for a
change whose point is that the hatch is exceptional.

*How:* the tree now travels in a **Secret**, mounted read-only at `/scan`:
* The Job is created **first**, so the Secret can carry `ownerReferences` to the Job's UID **at
  creation** and Kubernetes garbage-collects it. The kubelet retries a missing secret mount, so
  the ordering costs nothing — and it means the Role needs no `patch` on secrets.
* The Role gets `secrets: ["create", "delete"]` and **deliberately no `get` and no `list`**: the
  ServiceAccount must not be able to *read* any secret in the namespace, and it never needs to.
* The adapter deletes the Secret the moment the result is read (and on every abandon path), so the
  app's source lives for one scan.
* The cap is now 900 KiB of encoded payload — below a Secret's ~1 MiB etcd ceiling — and
  `scan-trivy.test.ts` pins the **shipped default** by not injecting it: a 300 KiB file must scan,
  a 2 MiB one must be refused with the Secret ceiling named.

This also closes **M4**: the app's source is no longer part of the Job spec that every
`kubectl get job -o yaml` prints, and a Secret is redacted in API audit logs and can be encrypted
at rest.

### M1 — the result was read from the merged pod log. **Fixed.**
One byte of stderr in front of the JSON — a DB-download notice, a warning — voided the scan.
*How:* `trivy --output /tmp/os-scan-report.json`; the prelude then echoes `<<<OS-SCAN-VERSION>>>`,
the version blob, `<<<OS-SCAN-REPORT>>>`, and `cat`s the report. `parseScanLog` reads after the
**last** delimiter and discards everything before it; a log with no report delimiter is a typed
failure, never an empty clean scan. Fixture: a log whose noise is itself JSON still scans.

### M2 — pod selection could read a previous generation's output. **Fixed.**
`labelSelector=job-name=<name>` + `items[0]` can return a pod from a prior Job of the same name
while a Background delete finishes — i.e. a *stale verdict for this deploy*.
*How:* the Job's **UID** is now the identity everything hangs off. The pod query selects on
`controller-uid=<uid>` **and** every candidate's `ownerReferences` must contain that UID; a pod
that merely shares the name is refused with that reason. A Job the API returns without a UID is
refused rather than guessed at.

### M3 — namespace-wide `pods/log`. **Accepted, narrowable, and written down.**
`pods` / `pods/log` cannot be narrowed by name, so in the default layout this is read access to
every pod log in the platform namespace. The os-ui Role already held namespace-wide `pods`
get/list, so this adds the log *subresource* rather than a new reach — but it is broader than the
feature needs, and that is now stated **at the grant**, not only in a doc.
*And it is narrowable today:* `osUI.software.scanner.namespace` (default `""` = release namespace)
moves the whole grant set — jobs, pods/log, secrets — into a dedicated namespace this chart
creates with Pod Security `restricted` **and its own default-deny NetworkPolicy** (a fresh
namespace inherits none, so without that it would start wide open). Making it the default is
open item 8, after it has been run on a real cluster.

### M5 — the engine string hid which database answered. **Fixed.**
A fresh mirror fetch and a baked DB from last year are not the same scan. The prelude now runs
`trivy version --format json` into the framed version section, and the engine reads
`trivy (aquasec/trivy:0.58.2; db: mirror ghcr.io/aquasecurity/trivy-db, vuln DB updated
2026-11-18T12:00:00Z)` — or, for a baked DB with no readable date, `db: offline/baked, vuln DB age
UNKNOWN`, which is the honest label for exactly the case an approver must not read as fresh.

### M6 — a failed scan could still fall back to a green `offline-mock`. **Fixed.**
With `OS_OFFLINE_MOCK=allow` (a teaching install, or a laptop pointed at a cluster) a *wired and
broken* scanner degraded to the baseline — laundering a real scan failure into a pass.
*How:* the adapter's failure is typed. `kind: 'no-cluster'` (there is no Kubernetes API at all —
a laptop) is the **only** kind allowed to fall back, and even then the scanner's reason is attached
to the card. Every other failure — refused create, failed Job, deadline, unreadable log,
unparseable report, oversized tree, unsafe path — is `kind: 'scan-failed'` and forces
`mode: 'unavailable'` with the cause, whatever the lever says.

### Lows — all fixed
* `AUDITED_OVERRIDE_REASON_MIN` now lives in `@core/policy/approvals`; `review.ts` takes the number
  from there. `ReviewCard.tsx` cannot import a `server-only` module, so its copy stays — and
  `scanner-chart.test.ts` pins the two equal, plus that the tab does not restate the number.
* The pod-log GET carries `limitBytes`; findings on a card are capped at 200 with a line saying the
  verdict still covers them all (the `summary` counts every one).
* `seccompProfile: RuntimeDefault` on both the pod and the container.
* The writer dedupes repeated paths (last write wins), so the payload's size is not a function of a
  caller's bug.
* The Job test asserts the configured `resources` actually reach the container.

### Gates after the review round

| Check | Result |
|---|---|
| `os-ui/node_modules/.bin/tsc --noEmit -p os-ui` | **exit 0**, no output |
| scan + software + governance + policy tests | **exit 0** — see §9's table, re-measured |
| `node scripts/check-structure.mjs` | **exit 0** — no new violations |
| `bash scripts/license-check.sh` | **exit 0** — PASS |
| `helm lint charts/sovereign-agentic-os -f values.local.yaml` | **exit 0** |
| three chart renders | default · `scanner.enabled=false` (nothing) · `scanner.namespace=software-scans` (dedicated ns + default-deny) |

### Open items added by this round

7. **A scaffolded app gets no dependency verdict until it commits a lockfile.** The scan says so,
   in those words, and the baseline's known-bad list is layered on so the common case still
   blocks. The real fix is a resolve step the OS can run honestly — a lockfile produced by a real
   `npm install` in the build path, not in the scan path. That belongs to the build/deploy stream,
   not here.
8. **The dedicated scan namespace is not yet the default.** The value exists and renders; making
   it the default needs one run on a real cluster, because a cross-namespace Job launch is the
   kind of thing that works in a render and 403s in a cluster.
