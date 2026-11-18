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
| `charts/.../templates/base/os-ui/software-scanner.yaml` | **new** — Role + RoleBinding (jobs, pods, pods/log) + the scanner NetworkPolicy |
| `docs/superpowers/plans/2026-11-19-software-scanner-trivy.md` | this plan |

### Shared files, edited additively (declared in the report)

| File | Additive change |
|---|---|
| `os-ui/tabs/software/lib/model.ts` | `ScanResult.engine` / `.notRun`; `ReviewCard.approvedWithoutScan` / `.noScanReason` — all optional |
| `os-ui/core/policy/approvals.ts` | `ApprovalEffect.approvedWithoutScan?` — optional |
| `os-ui/core/kernel/config.ts` | five `softwareScanner*` keys |
| `charts/.../values.yaml` | `osUI.software.scanner.*` |
| `charts/.../templates/base/os-ui/_os-ui-env.tpl` | the scanner env block (RUN path, so the worker matches) |
| `charts/.../templates/base/os-ui/os-ui.yaml` | the `batch/jobs` rule, gated on the scanner flag |
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

Filled in with measured values in §9 after the TEST phase.

## 9. Outcome

Filled in by the TEST phase.
