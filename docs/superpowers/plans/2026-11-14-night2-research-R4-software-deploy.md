> Research report, night run 2, read-only audit at main `31c0fc90`.

# R4 — Deploying vibe-engineered software through the MCP with built-in Git + CI/CD

Research agent R4 · 2026-11-13 · repo `sovereign-os-stack` @ `main` (31c0fc90) · os-ui 0.8.0
READ-ONLY audit. All `path:line` refer to the repo root unless prefixed `os-ui/`.

---

## 0. Executive summary (read this first)

The owner's ask has **four** requirements: (a) deploy from Claude via MCP, (b) versioned,
(c) basic CI/CD built in, (d) apps call agents / agents call apps / apps read+write data
as the OS user. Today the OS delivers **(a) partially and (d) well**, and delivers
**(b) and (c) essentially not at all** — because:

1. **There is no git for software apps.** `os-ui/tabs/software/lib/server.ts:27` states it
   in the code's own words: *"A commit writes the app's source tree to the durable file
   mirror (`snapshot.ts` — the one home of a coded app's files; **there is no git
   backend**)."* App source lives in an OpenSearch doc (`os-app-files`, one doc per app,
   whole-tree replace) plus an in-process `Map`
   (`os-ui/tabs/software/lib/file-mirror.ts:40-60`). The `commit` MCP tool is a file
   overwrite, not a commit. No history, no SHAs, no diffs-from-git, no authorship, no tags.
   Meanwhile `core/infra/git-store.ts` — real isomorphic-git bare repos per domain on the
   `os-repos` PVC, with `OS-Action/OS-Object/OS-Surface/OS-Request-Id` trailers and author =
   the acting user — **exists and is used by the Data and Agents tabs only**
   (`os-ui/tabs/data/lib/dbt/commit.ts`, `os-ui/tabs/agents/lib/git/commit.ts`). Software
   never imports it.
2. **There is no CI and no builder.** The MCP tool description says so explicitly:
   `kind: 'code'` is *"the ADVANCED coded path (raw generated code + image build; **no git
   server, no CI**) — it is DISABLED by default"*
   (`os-ui/tabs/software/lib/platform-mcp.ts:95`). The Kaniko "DIRECT BUILD SERVICE"
   described at `os-ui/core/kernel/config.ts:283-294` and in the lib README has had its
   implementation **deleted**: `lib/software/build-service.ts` and `ci-repair.ts` are
   referenced by `os-ui/tabs/software/lib/README.md` but absent from the tree, and
   `charts/sovereign-agentic-os/values.yaml:1005` leaves the dangling comment
   `# Software DIRECT BUILD SERVICE (deploy redesign Phase B).` with **no keys under it**.
   `config.kanikoImage` / `softwareBuildEnabled` are now dead config with zero call sites.
3. **What does work is good, and it is the declarative path.** `serveMode: 'spec'` is the
   default and golden path: a validated AppSpec rendered same-origin by the trusted OS
   renderer under the viewer's session, with author-time validation that persists nothing
   on a blocking issue, version snapshots, and `os.records` writes through the governed
   gate. The deploy *gate* (`review.ts`) is genuinely enterprise-shaped: four-eyes,
   scan-blocks-approval, envelope subset logic.

**So the gap is not governance — the gap is engineering artefacts.** A medium-enterprise
IT department will not reject the OS's approvals; it will reject the absence of a commit
SHA, a tag, a build log, an SBOM and an immutable artefact digest. That is exactly what
this report specifies.

---

## 1. What "satisfies a medium-enterprise IT department" means

A concrete checklist. Column **B/O/X** = *Built in by the OS* / *Operator-configurable* /
*Out of scope*. Column **Today** = what the OS actually does as of 0.8.0.

### 1.1 Source control & traceability

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 1 | Every change is a commit in a real repo with parent history | SSDF PS.1.1 (protect all forms of code), GitOps P1 "declarative" | **B** | ✗ whole-tree overwrite in OpenSearch (`file-mirror.ts:52`) |
| 2 | Commit carries the **human author** (not a service account), a message, and a provenance trailer | SSDF PS.2.1, ISO 27001 A.8.32 change management | **B** | ✗ for apps; ✓ for Data/Agents via `git-store.ts:260 authorFor()` + trailers (`git-store.ts:218`) |
| 3 | History is **readable and exportable** (log, diff, archive/tar, clone) | 12-factor I "codebase tracked in revision control" | **B** | ✗ for apps; `git-store.ts:531 log()`, `:584 archive()` exist for domain repos |
| 4 | An **off-box mirror** so the repo survives the platform | business continuity; CRA technical documentation | **O** | ✓ `core/infra/git-mirror.ts:130 pushMirrorAfterCommit`, token by SecretRef, never logged — but only for domain repos |
| 5 | Branch protection / no direct push to the release ref | SSDF PS.1.1, SoD | **B** | ✗ `git-store.ts:40` hard-codes `MAIN = refs/heads/main`; there is no branch API at all |

### 1.2 Versioning & releases

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 6 | **SemVer** release identity (`MAJOR.MINOR.PATCH`) | semver.org 2.0.0 | **B** | ✗ version snapshots are opaque, auto-named (`core/kernel/versioning.ts:26 ArtifactVersion`) |
| 7 | A release is an **immutable git tag** pointing at a reviewed commit | SLSA L1 provenance; SSDF PS.3.1 | **B** | ✗ no tag support in `git-store.ts` (no `annotatedTag`, no `tag` export) |
| 8 | A release **manifest** states what is in it (commit, builder, inputs, deps) | SLSA provenance; SSDF PS.3.2 | **B** | ✗ |
| 9 | Deployed artefact is **digest-pinned**, never a mutable tag | SLSA L1/L2; 12-factor V build/release/run separation | **B** | ◐ `runner.ts:43 isDigestRef()` + `:134 pullPolicyFor()` exist and are correct — but nothing produces a digest any more |
| 10 | Build is **reproducible enough** (pinned base image, lockfile committed, no network drift) | SSDF PW.4.4, SLSA L3 hermetic | **B** | ◐ compile gate pins vendored `@sovereign-os/ui`/`app-sdk`; no lockfile discipline enforced |

### 1.3 CI gates

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 11 | **Lint + typecheck** blocks the change | SSDF PW.7.2, PW.8 | **B** | ✓ **strong** — `compileGate` runs *before any write*, and a red gate throws 422 with diagnostics (`os-ui/tabs/software/lib/server.ts:88-92`). This is the single best-engineered gate in the system. |
| 12 | **Automated tests** run and block | SSDF PW.8.2 | **B** | ✗ `verify_software` is an LLM 5-dimension review, not a test run (`platform-mcp.ts:101`) |
| 13 | **SAST** | SSDF PW.8.2; ASVS build chapter | **B** | ◐ `lib/scan.ts` (129 lines) is a deterministic regex scan for secrets/`eval()`/known-bad deps; header says live "swaps in Semgrep/Trivy/gitleaks behind the same shape" — that swap does not exist |
| 14 | **Dependency / vuln audit** (npm audit, Trivy, Grype, osv-scanner) | SSDF PW.4.1/RV.1.1; CRA Art. 13 | **B** | ✗ |
| 15 | **Secret scanning** blocks | SSDF PW.8; ISO A.8.24 | **B** | ✓ a leaked secret blocks approval with **409 even for a Builder** (`review.ts` + README) — real and good |
| 16 | **Licence check** on dependencies | SSDF PW.4.1; repo already ships `THIRD-PARTY-LICENSES.md` | **B** | ✗ for apps (✓ for the platform itself) |
| 17 | **SBOM** emitted per release (CycloneDX or SPDX) and retained | CRA Annex I/II; SSDF PS.3.2; repo already ships `sbom.cdx.json` | **B** | ✗ for apps |
| 18 | Build **provenance** attestation (who/what/where built it) | SLSA L2+ | **O** | ✗ |

### 1.4 Environments, promotion, approvals

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 19 | Distinct **dev → staging → prod** with promotion of the *same* artefact | 12-factor X dev/prod parity; GitOps | **B** | ◐ the *scope* ladder My→Domain→Company exists and is enforced; it is a **visibility** ladder, not an environment ladder — the same single pod/spec serves all |
| 20 | **Four-eyes** on production go-live; requester ≠ approver | ISO A.8.32; SoD; ITIL change approval | **B** | ✓ **strong** — `decideDeploy` 403s a non-Builder; "an approver of their own filed work is NOT its promotion approver" is an explicit platform rule (`review.ts:484`) |
| 21 | Approval records the **exact commit** being approved | ISO A.8.32 evidence | **B** | ✗ the review card carries scan + envelope + footprint + diff, but no SHA (there is no SHA) |
| 22 | **Rollback** to a previous release in one action | ITIL; SSDF RV.3 | **B** | ◐ spec apps restore a version snapshot; no `rollback_software`, no re-pin of a prior digest |
| 23 | Preview / ephemeral environment per change | Vercel-style DX (not a compliance item) | **B** | ✓ `startPreview` is owner-only, free, no review (`review.ts:264`) |

### 1.5 Runtime, secrets, isolation

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 24 | **Secrets never in git**; injected at runtime from a managed store | 12-factor III; SSDF PW.9; ISO A.8.24 | **B** | ✓ **strong** — grants are id+access metadata, never credentials; an inline secret in `consumeResource` is rejected 400 (`lifecycle.ts`); mirror tokens resolve from SecretRef at call time and are scrubbed from errors (`git-store.ts:621 push`) |
| 25 | Non-root, read-only rootfs, dropped caps, resource limits | ASVS / CIS; PSS `restricted` | **O** | ◐ namespace enforces PSS **`baseline`**, with an in-repo note to move to `restricted` (`charts/.../base/os-ui/apps-runner.yaml:26-31`); limits set in `runner.ts:158 buildDeploymentManifest` |
| 26 | **NetworkPolicy** default-deny both directions | ASVS; zero trust | **B** | ✓ **strong** — `apps-default-deny`, then ingress only from `ingress-nginx`, egress only DNS:53/8053 (`apps-runner.yaml`, policies 1-3) |
| 27 | **Least-privilege RBAC** for the deployer | SSDF PO.5; ISO A.8.2 | **B** | ✓ os-ui SA gets a namespaced Role on deployments/services/ingresses/pods in `agentic-apps` only — no cluster role, no namespace-create (`apps-runner.yaml` Role/RoleBinding) |
| 28 | Per-app TLS + per-app host | baseline hosting | **O** | ✓ cert-manager HTTP-01 on `<slug>.<domain>.<appsDomain>`; needs wildcard DNS (documented in the template header) |

### 1.6 Audit, observability, retention

| # | Requirement | Standard anchor | B/O/X | Today |
|---|---|---|---|---|
| 29 | **Who deployed what, when, from which commit** — queryable | ISO A.8.32/A.8.15; SSDF PO.5.2 | **B** | ◐ every governed call is Langfuse-traced with the caller's identity and decision (`app-tool-call.ts:60,79`); the *commit* dimension is missing |
| 30 | Health checks + readiness driving real status | SRE baseline | **B** | ✓ readiness probe; status read from **actual pod state**, and honest `{live:false}` when the API is unreachable (`runner.ts:402 mapDeploymentStatus`) |
| 31 | Logs/metrics per app; build logs retrievable | 12-factor XI | **B** | ✗ no build logs (no builds) |
| 32 | Retention policy for artefacts/images/SBOMs | ISO A.8.10 | **O** | ✗ (an earlier Forgejo-era prune CronJob existed — see §2.4) |

**Standards to cite in the product doc.** NIST SP 800-218 SSDF v1.1 (`PO`/`PS`/`PW`/`RV`
practice families); SLSA build levels L1-L3; OWASP SAMM v2 (Implementation → Build,
Deploy; Verification) and OWASP ASVS; CycloneDX / SPDX for SBOM; semver.org 2.0.0;
12factor.net (I codebase, III config, V build/release/run, X parity); OpenGitOps 4
principles; ISO/IEC 27001:2022 Annex A 8.24 (crypto/secrets), 8.25 secure development
lifecycle, 8.28 secure coding, 8.29 security testing, 8.31 separation of environments,
8.32 change management; EU Cyber Resilience Act SBOM + vulnerability-handling
obligations (relevant because the product is positioned as sovereign/EU).
*(Exact clause IDs and URLs: see §2.0 — verified by the companion research pass.)*

**The one-sentence test to put in front of an IT department:**
*"Show me the commit, the tag, the build log, the SBOM, the scan result, the approval
with the approver's name, and the digest that is actually running — for the app that is
live right now."* Today the OS can answer "the approval" and "the scan"; it cannot
answer the other five.

---

## 2. Reference designs

### 2.0 Standards references (verified)

| Requirement | Clause to cite | URL |
|---|---|---|
| Code protected from tampering; version control | SSDF **PS.1** / task **PS.1.1** | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf |
| Release integrity / signing | SSDF **PS.2** / **PS.2.1** | ditto |
| Archive each release; **provenance + SBOM** | SSDF **PS.3** / **PS.3.1** (archive), **PS.3.2** ("…share provenance data for all components of each software release (e.g., in an SBOM)") | ditto |
| Third-party components: SBOM/SCA per component | SSDF **PW.4** / **PW.4.1**, **PW.4.4** | ditto |
| Code review / SAST · testing | SSDF **PW.7** · **PW.8** | ditto |
| Toolchain, automation, **evidence artefacts** | SSDF **PO.3** / **PO.3.2**, **PO.3.3** | ditto |
| Secure, segregated dev environments | SSDF **PO.5** | ditto |
| Vulnerability identification → remediation → RCA | SSDF **RV.1** (RV.1.1-1.3) · **RV.2** · **RV.3** | ditto |
| Provenance exists | **SLSA Build L1** — consistent build process; provenance names build platform, process and top-level inputs; distributed to consumers | https://slsa.dev/spec/v1.0/levels |
| Hosted build platform | **SLSA Build L2** — L1 + runs on dedicated infrastructure (not a workstation) + provenance **signed by that infrastructure**; consumer verifies authenticity | ditto |
| Hardened build | **SLSA Build L3** — L2 + runs cannot influence one another, and the **provenance-signing key is unreachable from user build steps** | ditto |
| Build + deploy practices | **OWASP SAMM v2** → Implementation → **Secure Build** (Build Process · Software Dependencies) and **Secure Deployment** (Deployment Process · **Secret Management**); runtime in Operations → Environment Management | https://owaspsamm.org |
| Secrets, config, dependencies | **OWASP ASVS 5.0.0** → **V13 Configuration** incl. **13.3 Secret Management** ("secrets must not be included in application source code or in build artifacts"); **V15 Secure Coding and Architecture** (lockfiles/SBOM, trusted registries, provenance/signing, vuln monitoring, abandoned deps); **V10 OAuth/OIDC** for CI→registry/cluster workload identity | https://github.com/OWASP/ASVS |
| SBOM format | **CycloneDX 1.7** (21 Oct 2025; standardised as **ECMA-424**, 10 Dec 2025) — the recommendation for this product | https://cyclonedx.org/specification/overview/ |
| SBOM format (alt) | **SPDX 3.0** (SPDX 2.2.1 = ISO/IEC 5962:2021) | https://spdx.dev/use/specifications/ |
| Build/release/run separation; immutable releases | **12-factor** I Codebase · III Config · **V Build, release, run** ("every release has a unique id and is immutable; releases can only be appended") · X Dev/prod parity | https://12factor.net |
| GitOps | **OpenGitOps v1.0.0** — (1) Declarative, (2) **Versioned and Immutable** ("…enforces immutability, versioning and retains a complete version history"), (3) Pulled Automatically, (4) Continuously Reconciled | https://opengitops.dev/ |
| EU SBOM obligation | **CRA, Regulation (EU) 2024/2847**, **Annex I Part II(1)**: draw up "a software bill of materials in a commonly used and machine-readable format covering at the very least the top-level dependencies". Goes in technical documentation / to market surveillance on request — **not** required to be public. No format mandated. Reporting duties from **11 Sept 2026**; full application **11 Dec 2027**. | https://eur-lex.europa.eu/eli/reg/2024/2847/oj |

**12-factor V is the formal basis for §4.5's "promotion re-points, never rebuilds"** — quote
it directly at an IT department and the design argues itself.

**Scanner choice (all permissive):**

| Tool | Licence | Covers | Use here |
|---|---|---|---|
| **Trivy** (Aqua) | Apache-2.0 | images, filesystems, git repos, IaC/K8s misconfig, secrets, **licences**, SBOM in/out | **broadest — the default pick**; one tool covers S9/S10/S11/S12 |
| **Grype** (Anchore) | Apache-2.0 | package vulns in images/dirs/**SBOMs** | pairs with Syft for an SBOM-driven gate |
| **Syft** (Anchore) | Apache-2.0 | SBOM **generation** (CycloneDX + SPDX) — not a scanner | S12 if not using kpack |
| **osv-scanner** (Google) | Apache-2.0 | OSV.dev across ecosystems; lockfile/SBOM/container input; low false positives | precise S10 gate on the committed lockfile |
| **npm audit** | Artistic-2.0 | JS deps from the npm advisory DB; noisy on transitive dev deps | necessary but **not sufficient** — don't ship it as "the" dependency gate |

### 2.0b What medium-enterprise IT departments actually demand (nameable controls)

These gate procurement, not features:

- **ISO/IEC 27001:2022 Annex A** — **8.25** secure development lifecycle · **8.26**
  application security requirements · **8.27** secure architecture/engineering principles ·
  **8.28** secure coding · **8.29** security testing in development and acceptance ·
  **8.30** outsourced development · **8.31** **separation of development, test and
  production environments** · **8.32** **change management**; plus **8.4** access to source
  code, **8.9** configuration management, **8.19** installation of software on operational
  systems, and **5.3** **segregation of duties**.
  → **A.8.31 is the control that fails "one namespace for everything"** (§7 risk 3).
  → **A.8.32 is the control that requires an approval record per production change** — the
  OS already has the approval; §S6 adds the commit it approves.
  → **A.5.3 is four-eyes** — already enforced (`review.ts:484`).
- **ITIL 4 Change Enablement** — every prod deploy must be classifiable as *standard* /
  *normal* / *emergency*, with a pre-authorised **change model** for standard changes.
  → This is the clause that lets the OS keep "routine in-envelope updates auto-deploy"
  (`scopeBroadened`) **without** breaking change management: an in-envelope redeploy is a
  *standard change* under a pre-authorised model, and a scope-broadening one is a *normal
  change* needing authority. The OS's existing predicate already implements the
  distinction — it just needs to be named in these words in the product documentation.
- **Audit evidence per release** — who committed, who approved, what **digest** shipped,
  what scan results and SBOM accompanied it, who promoted and when, and the rollback path.
  = SSDF **PO.3.3** + **PS.3.2** + SLSA L2 provenance. This is the single highest-value
  thing to build *into* the product rather than bolt on, and it is exactly §S5/S6/S7/S12.
- **EU mid-market non-negotiables**: **no outbound build service**; pinned/mirrored base
  images from an internal registry; SSO/OIDC with group-mapped RBAC on the deploy surface;
  secrets never in git.

### 2.1 The UX reference: Vercel / Netlify

What to copy is the *shape*, not the stack:

- **One action, three artefacts**: a push produces a build, an immutable deployment, and
  a URL. The deployment is immutable forever; the *alias* moves.
- **Preview per change**, prod behind an explicit promotion. Promotion does **not
  rebuild** — it re-points the alias at an already-built deployment. This is the single
  most important idea to steal: *promotion must not be a rebuild*, or staging and prod
  are not the same artefact and §1.4/19 fails.
- **Rollback = re-point the alias** at a prior deployment. Instant, no build.
- **Build logs are a first-class, linkable object.**

Map onto the OS: `deployment` = (app, release tag, artefact digest *or* frozen AppSpec
version); `alias` = the per-app host / the `/apps/<slug>` route; `promote` = move the
alias; `rollback` = move it back.

### 2.2 In-cluster candidates — verified licences and feasibility

| Tool | Licence (verified) | What it would give the OS | Cost in our SKE cluster | Verdict |
|---|---|---|---|---|
| **Coolify** | **Apache-2.0** | Full self-hosted PaaS UX: git push → build → deploy, PR previews, domains, TLS | Docker/Compose-centric, **not K8s-native**; wants a Docker socket on hosts | ❌ wrong substrate — mine the UX |
| **Dokku** | **MIT** | Herokuish/buildpack + Dockerfile builds, `git push dokku main` | Single-host, Docker-socket-on-host; K8s support peripheral | ❌ single-node PaaS |
| **Kamal** (37signals) | **MIT** | Zero-downtime container deploys, kamal-proxy, very simple model | **No Kubernetes concept at all** — SSH + Docker | ❌ architecturally out of scope (good prose on deploy locking/rollback) |
| **CapRover** | **Apache-2.0** | One-click PaaS, nginx + Let's Encrypt, web UI | Requires Docker **Swarm** | ❌ not K8s |
| **Argo CD** / **Workflows** / **Rollouts** | **Apache-2.0** (all three, CNCF) | CD: git = desired state, drift detection, sync waves, **rollback to any prior revision**, SSO/RBAC, audit trail. Workflows = build DAG. Rollouts = canary/blue-green | CRDs (`Application`/`ApplicationSet`; Workflow CRDs + an artifact repo e.g. MinIO; Rollouts CRD replaces Deployment). All **unprivileged**. Argo CD controller wants cluster-wide or namespaced RBAC | ⚠️ **Not now.** The OS already owns a least-privilege apply path (`apps-runner.yaml`) with honest pod-state reporting. But **fix the false claim first**: `tabs/admin/ui/OverviewHealth.tsx:257` tells users "Argo CD reverts drift automatically" over pure mock data (`tabs/admin/lib/components-extra.ts:41-49`) |
| **Tekton Pipelines** (+ **Chains**) | **Apache-2.0** | K8s-native build primitives; **Tekton Chains gives in-toto/SLSA provenance + signing for free** → the cheapest route to SLSA L2/L3 | Heaviest CRD surface; `PipelineRun` workspaces need PVCs; logs/results need an external store; **still must choose an image builder** | ⚠️ the right answer *if* SLSA L3 is ever contractually required; against v2-lean otherwise |
| **Dagger** | **Apache-2.0** (engine + Go/TS SDKs) | **Pipelines-as-TypeScript** — identical code locally and in-cluster; content-addressed caching. Genuinely attractive for a TS/Next.js host product | **The Dagger Engine *is* BuildKit**, so it inherits the privilege problem: the standard K8s deployment is a **privileged StatefulSet**; rootless is non-default and documented as degraded | ⚠️ best DX, privilege-hostile default |
| **Gitea Actions** | Gitea **MIT**; `act_runner` MIT | GitHub-Actions-compatible workflows on a self-hosted forge | **Runner labels decide privilege**: a `docker`-flavoured label needs a Docker daemon (DinD sidecar ≈ privileged, or a mounted socket); a `host`-flavoured label runs steps directly with **no isolation**. Needs a registry | ⚠️ familiar syntax, DinD is the default path |
| **Forgejo Actions** | Forgejo **GPL-3.0-or-later since v9.0 (Aug 2024)** — the key delta vs Gitea's MIT; Forgejo Runner MIT (act_runner fork) — **re-verify the runner's LICENSE before shipping** | Same, in an EU-governed, copyleft, non-open-core forge → a strong *sovereign* story | Same runner privilege question. **Licence note:** running Forgejo *unmodified* alongside the product does **not** affect the OS's own Apache-2.0 TS code; shipping a *modified* Forgejo would require releasing that source | ❌ **for us** — `d9064980` removed Forgejo as part of v2-lean; re-adding a forge reverses that decision. Keep as the option of record if a customer demands a forge |
| **Woodpecker CI** | **Apache-2.0** | Lightweight server+agent CI, container-native, Forgejo/Gitea forge support, simple YAML | Agents normally need the **Docker socket**; the `kubernetes` backend (creates pods) is less mature. Needs registry + secrets | ⚠️ small and pleasant; socket privilege is the catch |
| **kpack + CNB / Paketo** | kpack **Apache-2.0** (buildpacks-community); CNB lifecycle + Paketo buildpacks **Apache-2.0** | **No Dockerfile at all.** An `Image` CRD watches a git ref and auto-rebuilds on commit, **base-image CVE patch**, or buildpack update; emits OCI **plus an SBOM** and a bill-of-materials label. Node.js/Next.js is a first-class Paketo buildpack | CRDs (`Image`, `Builder`, `ClusterStore`, `ClusterStack`) + a **registry** with push creds. Builds run as **non-root pods — no privileged container, no DinD** (the lifecycle writes layers directly) | ✅✅ **strongest Tier-3 fit for SKE** — removes both the Dockerfile *and* the privileged-build problem, and hands us S12 (SBOM) for free. Costs: buildpack opinionation, larger images, 4 more CRDs |
| **Knative Serving** | **Apache-2.0** | Request-driven autoscaling incl. **scale-to-zero**; a **`Revision` is an immutable snapshot**; `traffic:` splitting on a Service = *exactly* the Vercel preview-URL/promote/instant-rollback semantics, natively; per-revision tag URLs | CRDs + a networking layer (Kourier/Istio/Contour) + webhooks + wildcard DNS/TLS. Unprivileged. Real operational weight | ⚠️ would solve §7 risk 4 (idle pod cost) and §4.5 (promote = re-point) as *data* rather than bespoke code. Revisit only if Tier-3 volume justifies it; plain Deployment + alias Ingress is enough at current scale |

### 2.2b Image builders without privileged containers — the crux

| Builder | Licence | Status / what it actually needs |
|---|---|---|
| **kaniko** | Apache-2.0 | **Archived by Google ≈3 June 2025, repo read-only, no upstream CVE fixes** (issue #3348). A **Chainguard fork** is maintained. Never needed `privileged`, but did need root-ish unpacking into the container filesystem. → **`config.ts:294` pins `gcr.io/kaniko-project/executor:v1.23.2` — an unmaintained image. Do not revive this path.** |
| **BuildKit rootless** | Apache-2.0 | Awkward on managed K8s. Upstream states **"Kubernetes lacks the equivalent of `systempaths=unconfined`"**; `securityContext.procMount: Unmasked` is close but depends on `hostUsers: false` (user namespaces, K8s 1.30+ beta). The shipped rootless examples therefore pass **`--oci-worker-no-process-sandbox`**, which upstream explicitly discourages, plus `seccomp: Unconfined` + AppArmor `unconfined` and an `emptyDir` for `/home/user/.local/share/buildkit`. Needs **fuse-overlayfs (`/dev/fuse`)** unless the kernel allows native overlayfs in a userns (≥5.11/5.13). |
| **Buildah rootless** | Apache-2.0 | Runs `runAsUser: 1000` with `BUILDAH_ISOLATION=chroot`. Storage driver is the decision: **fuse-overlayfs needs `/dev/fuse`** → usually `privileged: true` or a device plugin; **`STORAGE_DRIVER=vfs` needs no device and no privilege**, at a real disk/speed cost. Needs `seccomp: Unconfined` in practice for `newuidmap`/`setgroups`. |
| **Depot** | Service **proprietary SaaS** (CLI permissive); BYO-cloud self-hosted is a paid tier | Fastest builds, zero in-cluster privilege — but it is an **external build service**. **Fatal for a sovereign/EU positioning** unless EU-region + DPA is contractually nailed down. |

**Direct answer to "what can build OCI images on SKE without privileged pods":** only two
options are genuinely clean — **(a) kpack/CNB** (no Dockerfile, non-root pods, SBOM
included) and **(b) Buildah rootless with `STORAGE_DRIVER=vfs`** (Dockerfile support,
slow). BuildKit rootless and Dagger are *possible* but need `seccomp`/AppArmor
`unconfined` plus `--oci-worker-no-process-sandbox` or user namespaces — i.e. **you trade
"not privileged" for "unconfined", which an auditor treats as equivalent.** That is the
sentence to put in front of the owner, and it is why §4.3 recommends keeping OCI building
out of the critical path.

**This changes one recommendation in §4.3:** when Tier 3 is eventually built, prefer
**kpack/CNB** over BuildKit rootless. It is non-root by construction, it auto-rebuilds on
base-image CVE patches (which is an SSDF **RV.1** control the OS would otherwise have to
implement itself), and it emits the SBOM that S12 needs. The cost is 4 CRDs and a
registry — pay it only when a customer needs Tier 3.

### 2.2c The reference shape, if the OS ever goes full pipeline

For the record, the maximal standards-complete shape is:
forge → webhook → **Tekton** → **kpack/CNB** build (unprivileged, SBOM out) → internal
registry (digest-pinned) → **Trivy + Grype** gate → **cosign** sign + **Tekton Chains**
provenance (SLSA L2/L3) → commit the digest to git → **Argo CD** reconcile → **Knative
Revision** with per-revision preview URL, traffic-split promote and instant rollback.
Everything Apache-2.0/MIT except a forge, nothing privileged, and every SSDF/SLSA/Annex-A
control has a concrete artefact attached.

**This is not the recommendation.** It is six new components against a v2-lean direction
that just removed one of them. It is recorded so the owner can see what the OS is
*choosing not to build*, and so the Tier-3 decision in §4.3 is made with the full price
visible. The recommendation stays: **Tiers 1-2 to full standard with in-process gates and
real git — which needs no component from this diagram.**

- **Verdicts on the PaaS family unchanged:** Coolify / Dokku / CapRover / Kamal all assume
  they *own* the host or orchestrator. The OS already owns it. **Mine for UX, adopt none.**

### 2.3 Forgejo remnants (asked explicitly)

`git log --oneline -S forgejo | head` — removal landed in **`d9064980` "v2 lean: 13 tabs,
core/ + tabs/ layout, local-first deploy (#24)"**. Earlier Forgejo-era commits:
`89d5bec4` (Forgejo registry self-manages — CI prune step keep-2 + `cleanup_packages`
cron + disk alert), `a8318c6c` ("+ forgejo cron overlay"), `e3122508`, `b5087801`,
`daa194c1`, `91890a23` (Kaniko digest build path).

Remnants **still in the tree today** (all inert, all misleading):
- `values.stackit-managed.yaml:194` `forgejoConsoleUrl: "https://forgejo.REPLACE-DNS-NAME"`
  and `:366` `forgejo: "forgejo.REPLACE-DNS-NAME"` — a console link to a component that
  no longer exists.
- `os-ui/core/kernel/config.ts:258` comment block `// Forgejo (Software / Delivery): GET
  {FORGEJO_URL}/api/v1/...` and `:260-262` "locally CI uses Forgejo's built-in OCI
  registry, so HARBOR_REGISTRY defaults to it" — describing a path with no code.
- `os-ui/tabs/software/lib/scaffolds/vite-os.ts:443,644,690` — every scaffolded app's
  README/Dockerfile comments tell the user *"built by Sovereign Agentic OS CI → Harbor →
  Argo CD"* and *"Argo CD syncs it to https://<slug>.<domain>"*. **This is shipped
  documentation that is false.** A medium-enterprise reviewer reading a generated app's
  README will find a described pipeline that does not exist — this is the most damaging
  single artefact in the audit.
- `os-ui/tabs/software/lib/README.md` — the whole document describes Forgejo/Harbor/Argo
  CD, `forgejoReachable`, `build-service.ts`, `ci-repair.ts`, `live | offline-mock` duals.
  None of it is true; `build-service.ts` and `ci-repair.ts` do not exist.
- `os-ui/tabs/admin/mcp/discovery-waveb-tools.ts` still mentions forgejo (and is where
  `read_app_files:189` / `get_software_status:231` actually live, **not** in the software
  tab's own MCP module — `tabs/software/mcp/software-write-tools.ts` contains exactly one
  tool, `set_app_design`).

**`cron-deploy-pipelines`**: there is **no template for it anywhere in the repo** —
`grep -rl "cron-deploy-pipelines\|deploy-pipelines"` returns nothing, and the chart's only
CronJobs are `connections/catalog-refresh-cronjob.yaml`,
`metrics/metrics-alert-cronjob.yaml`, `backup/pg-dump-cronjob.yaml`,
`backup/opensearch-snapshot.yaml`, `agent-runtime/schedule-cronjobs.yaml`. Conclusion:
the CronJob observed in the live cluster is an **orphaned Forgejo-era object** — almost
certainly the descendant of the `a8318c6c` "forgejo cron overlay" / `89d5bec4`
`cleanup_packages` + registry-prune work, left behind because it was applied by an
overlay rather than the chart (so `helm upgrade` never pruned it). **It is drift: it is
not in git, nothing manages it, and nobody knows what it runs.** Action: `kubectl -n
agentic-os get cronjob cron-deploy-pipelines -o yaml` to capture it, then delete it
— an unmanaged CronJob in a cluster is precisely the finding an IT audit writes up.

---

## 3. Audit of the OS today (file:line)

### 3.1 The app model — three serve modes, one home of record

`os-ui/tabs/software/lib/apps.ts` (2202 lines) is the home of record.
`ServeMode = 'image' | 'runtime' | 'spec'` (`apps.ts:147`), coerced by the single
`normalizeServeMode` (`:155`, legacy/nil → `'image'`), read via `serveModeOf` (`:159`).

| Mode | How served | Needs a build? | State today |
|---|---|---|---|
| **`spec`** | Declarative AppSpec rendered **same-origin by the trusted OS renderer** under the viewer's session, at `/apps/<slug>`. No source tree, no registry, no pod (`platform-mcp.ts:95`). | No | **The golden path and the default** (`apps.ts:1609` `serveMode: specKind ? 'spec' : 'image'`) |
| **`runtime`** | The committed Vite tree is bundled by the OS and mounted in a **sandboxed same-origin iframe** (`app-runtime.ts:14-33`), Vite-shaped SPAs only, compile-gate-green only | No (bundles in-process) | Works, flagged beta |
| **`image`** | Per-app Deployment+Service+Ingress in `agentic-apps` on `<slug>.<domain>.<appsDomain>` (`runner.ts`, `apps.ts:1527`) | **Yes — and nothing builds it** | **Broken by design today**: `runner.ts:111 appImageRef` falls back to `config.softwareRunnerImage`, chart default `traefik/whoami:latest` (`values.yaml:999`, comment: *"Teaching default served when a built app has no image of its own"*). The *default for every legacy record* is `'image'`. |

`resolveServeTarget` (`served-app.ts:26`) routes `/apps/<slug>`: `'spec'` → render,
`'image-elsewhere'` → honest "open it at its URL", `'none'` → honest "nothing to render
yet". The honesty discipline throughout this module is genuinely high quality.

Coded apps are **disabled by default** behind a platform-admin flag
(`codedAppsEnabled`, imported at `apps.ts:51`; `createApp` fails closed 403).

### 3.2 The MCP surface

`PLATFORM_MCP_TOOLS` (`os-ui/tabs/software/lib/platform-mcp.ts:93-164`), staged:

| Stage | Tools |
|---|---|
| 1 Define | `create_software` (`:95`) |
| 2 Design (+3 Choose Context) | `design_software` (`:97`) — grants are the context-binding surface |
| 4 Build | `build_software` (`:99`) — **read-only**; returns a *directive* + frozen granted-context schema + committed files + honest built-vs-pending; the agent then authors code and calls `commit` |
| 5 Test & Publish | `verify_software` (`:101`, read-only, 5-dimension LLM review → refinements), `request_deploy` (`:102`), `decide_deploy` (`:103`), `promote` (`:104`) |
| AppSpec authoring | `set_app_spec` (`:107`, **author = publish**, validates then persists + snapshots a version, returns `{ok:true, servedUrl:'/apps/<slug>', version, warnings}`), `generate_app_spec` (`:113`, model-composed spec, not persisted), `get_app_spec` (`:119`) |
| Grants / lifecycle | `use_connection`, `use_data`, `use_knowledge`, `use_as_data`, `archive`, `delete`, `start_preview` (`:126`, owner-only) |
| Escape hatch | **`commit`** (`:163`) — *"DEVELOPER MODE — writes files DIRECTLY to the app folders, BYPASSING the staged Design→Build→Test governance… Role-gated to builder/admin"* |

`read_app_files` and `get_software_status` are defined in
`os-ui/tabs/admin/mcp/discovery-waveb-tools.ts:189,231`, **not** in the software tab.

**The governance invariant is real and worth keeping:** every Platform-MCP tool delegates
to the exact governed library function the UI route calls, passing the caller's
`CurrentUser`, never a service identity — so a Creator calling `promote` gets the same
403 as in the UI, and `request_deploy` cannot self-approve. `platformMcpToolNames` exists
so a test can diff the MCP surface against the UI and assert no hidden escalation tool.

### 3.3 Versioning today

- **For code apps: nothing.** `commitToApp` (`server.ts:66-160`) merges a changeset over
  the prior tree (`mergeTree`, `:50`), runs the compile gate, parses metadata, recompiles
  the auto-MCP, then `snapshotFiles(app.id, tree)` — a **whole-tree replace** of one
  OpenSearch doc. The prior tree is simply gone.
- **For spec apps:** `set_app_spec` snapshots an `ArtifactVersion`
  (`core/kernel/versioning.ts:26`, `versionLog(kind)` at `:70`), auto-named and
  restorable. Opaque, no SemVer, not a tag, not tied to a commit.
- **`git-store.ts` has no tagging and no branching.** Exports are `commitTree`,
  `commitSubtree`, `log`, `readBlob`, `listTree`, `archive`, `push`, plus naming and
  trailer helpers. `MAIN` is a module constant (`:40`). Adding releases means **adding a
  tag API** — it is not a config change.
- Nice existing properties to build on: content-addressed, **commits only when the root
  tree hash changed** (idempotent regeneration), per-repo in-process mutex,
  `reserveSubtree` so one subtree owner cannot be clobbered by a whole-tree writer, and a
  `DestructiveReconcileError` guard refusing a `boot-reconcile` commit that would delete
  >50% of its tracked scope (`git-store.ts:379-391`).

### 3.4 Identity: how an app calls the OS, and with whose rights

This is the part that is **already right**, and it is the owner's requirement (d).

- **Spec apps and `runtime` apps are same-origin.** `app-runtime.ts:16-22` states the
  auth bridge explicitly: the iframe is same-origin, so the app's `createOsClient()`
  calls hit the OS API with `credentials:'include'` — *"the exact ambient `soa_session`
  mechanism the Instant Preview already relies on. **No token, no postMessage RPC, no new
  auth path.**"* The app therefore acts **as the signed-in user**, and RLS/OPA apply
  unchanged. This is the cheapest correct answer to "with the user access rights of the OS
  users being considered" and it should be defended, not replaced with token exchange.
- **CSP is tight and layered**: outer doc `default-src 'none'` + nonce'd script +
  `frame-ancestors 'self'` (`app-runtime.ts:57-69`); inner iframe meta-CSP with no
  `frame-src`/`base-uri` so the app cannot re-frame or rebase (`:78-90`); sandbox is
  `allow-scripts allow-same-origin` only — `allow-top-navigation` and `allow-popups`
  deliberately omitted (`:122-137`).
- **Custom AppSpec blocks run in a null-origin iframe that "can never act as the user"**
  (`platform-mcp.ts:107`) — the correct split: patterns write through the governed
  `os.records` door with role gates; arbitrary HTML/JS gets no identity.
- **The app principal is `app-<slug>`** (`apps.ts:1572`), registered as a connection in
  the app registry (`core/infra/app-registry.ts`) with a compiled capability profile.
- **Agent → app** goes through `callAppTool` (`app-tool-call.ts:29-86`): authorize via
  the compiled profile (`authorizeConnectionCall`), falling back to `authorizeAppTool`
  (`core/infra/agent-governed.ts:169`) → **writes held for human approval and queued in
  the Governance inbox (202)**, deny → 403, allow → execute → Langfuse trace. The
  **reads-on / writes-off preset** means a write tool is *never* auto-enabled
  (`applyReadsOnWritesOff`).
- **`os.records` is "one store, two doors"** (`app-records.ts:20-37`): the app's own
  frontend via the by-slug routes + SDK, and an agent via the app's MCP tools — both
  funnel through `executeAppTool` (`:193`) and the shared envelope-write gate. Records are
  **scoped to the caller** via `recordActor` (`:57`), whose `domain` is the user's
  *effective* operating domain — the same accessor `/api/auth/me` uses, so the record
  store's Domain scope tracks the OS domain switcher. Writes (`add_record`,
  `export_records`) are governed by the **approved deploy envelope**; reads are always-on.
- **Non-record tools** proxy to the live app Service when its runner pod is Running
  (`source:'live-app'`), else return honestly-labelled `demo-seed` — see §7 risk 7.
- **`adopt_entity_actions` / `list_adoptable_actions` are NOT the app path.** They live in
  `core/mcp/experimental/exposure-write-tools.ts:343,372` and govern *Connection*
  exposures, with a four-layer fail-closed intersection *capability ∩ exposure ∩
  ADOPTION ∩ grant* and `domain_admin` consent. **This is the best governance primitive in
  the codebase and app actions should be made to reuse it** (see §4.6).

### 3.5 The deploy gate (`review.ts`, 687 lines)

`requestedEnvelope` (`:151`) → `scopeBroadened` (`:169`) → `startPreview` (`:264`,
owner-only, free, no review) → `requestDeploy` (`:315`) → `decideDeploy` (`:484`) →
`reconcileDeployApproval` (`:582`) / `reconcileDeployStatus` (`:632`) →
`getReviewCard`/`listReviewCards` (`:676`,`:681`).

Correct, enterprise-shaped behaviours already implemented: four-eyes; routine
in-envelope updates auto-deploy when the requested envelope is a subset *and* the
footprint did not rise; any added write tool / connection / data / knowledge grant or
raised footprint re-opens a card; a failing scan forces a card; **approval requires
`scan.passed` and a leaked secret blocks even a Builder with 409**. Honest preview notes
exist for pending states (`PREVIEW_PENDING_NOTE:212`, `IMAGE_BUILDING_NOTE:223`,
`previewNoteForRunner:239`).

**What the card lacks:** a commit SHA, a release tag, a test result, an SBOM, a vuln
report, an artefact digest. Six fields.

### 3.6 Serving infrastructure

`charts/sovereign-agentic-os/templates/base/os-ui/apps-runner.yaml` — the only
app-hosting template. Declares the `agentic-apps` Namespace with
`pod-security.kubernetes.io/enforce: baseline` (default, with an in-file note to move to
`restricted`), a **namespaced** Role (deployments+scale, services, ingresses, pods-read)
bound to the os-ui SA in the release namespace, and four NetworkPolicies (default-deny
both ways; ingress only from `ingress-nginx`; egress only DNS 53/8053 — with the
Gardener/SKE CoreDNS:8053 note; plus ingress locks on `query-tool` and `data-runner` so
only os-ui pods reach them). Gated `softwareRunner.enabled` (false in base, on for
STACKIT). Operator note in the header: per-app URLs need wildcard DNS
`*.<appsDomain>` → the ingress-nginx LB.

`charts/.../base/os-ui/os-repos.yaml` — the `os-repos` RWO PVC (`2Gi` default) plus a
**read-only `git daemon` sidecar on the os-ui pod** (`os-ui.yaml:212-220`:
`git daemon --export-all --base-path=/repos --port=9418`) and a NetworkPolicy admitting
**only the Dagster user-code pod** to 9418. *This is the single most important existing
asset for §4:* an in-cluster, already-governed, already-network-policied way for a build
pod to clone a pinned commit. Opening it to one more labelled pod is a small, reviewable
change — not new infrastructure.

---

## 4. Architecture options + recommendation

### 4.1 Where app source lives — **one repo per domain, apps under `apps/<slug>/`**

Reuse `git-store.ts` exactly as Data and Agents do, via `commitSubtree('apps/<slug>')`
plus `reserveSubtree('apps/')` so a whole-tree writer can never clobber app code.

Why not a repo per app: the PVC is RWO and os-ui is single-replica with a per-repo mutex
— one repo per domain keeps that invariant, keeps the existing push-mirror config
(`git-mirror.ts`, one `{url, tokenSecretRef}` per domain) working unchanged, keeps
`git daemon --base-path=/repos` and its NetworkPolicy unchanged, and gives a domain
admin **one** repo to point their IT department at. Per-app repos would multiply mirrors,
secrets and daemon exposure for no governance gain. (If a Tier-3 customer later demands
per-app repos, `repoPath` already validates a single safe path segment — the change is
local.)

The OpenSearch mirror **stays** as the fast read path (`getSnapshot` is synchronous and
many call sites depend on it) — it becomes a *cache of the committed tree*, not the home
of record. `hydrateSnapshot` already handles the cold-process miss.

Commit message + trailers follow `commitMessage`/`appendTrailers`
(`git-store.ts:204,218`) and the existing `OS-Actor/OS-Reason/OS-Surface/OS-Run-Id`
convention; author = the acting user via `authorFor` (`:260`).

### 4.2 Branch / tag / release model — **keep it boring**

- `main` is the only long-lived ref per domain repo (matches `MAIN` today).
- A change is a commit on `main` under `apps/<slug>/`. No feature branches in v1 —
  the OS is the only writer and the compile gate is pre-write, so a branch buys nothing
  and costs a merge story.
- **A release is an annotated tag `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>`** pointing at the
  reviewed commit, carrying a release manifest blob at
  `apps/<slug>/.app/release.json`: `{ version, commit, appSpecHash | artefactDigest,
  builtAt, builtBy, inputs: {sdkVersion, nodeVersion, baseImage}, sbom: 'sbom.cdx.json',
  gates: {compile, tests, sast, deps, licence, secrets}, approval: {cardId, approver, at} }`.
- Tag namespacing by slug is what makes one-repo-per-domain work: `git tag --list
  'app/invoices/v*'` is an app's release history.
- **Requires new code in `git-store.ts`**: `annotatedTag(domain, tag, sha, tagger,
  message)`, `listTags(domain, prefix)`, `resolveTag`, and `log(domain, {path})` so
  `apps/<slug>/` history is readable independently. ~150 lines, fully testable with the
  existing temp-dir test pattern.

### 4.3 The pipeline — **three tiers, and only Tier 3 needs an image builder**

| Tier | What it is | Artefact | Builder needed | Serve |
|---|---|---|---|---|
| **1 — Declarative (`spec`)** | AppSpec patterns over granted data | **frozen AppSpec + its hash** | **none** | OS renderer, same-origin, `/apps/<slug>` |
| **2 — SPA (`runtime`)** | Vite SPA + vendored `@sovereign-os/ui`/`app-sdk` | **content-addressed static bundle** (JS+CSS), hash-pinned | **none** — the OS already bundles in-process (`preview-runtime.getCachedAppBundle`) | sandboxed same-origin iframe |
| **3 — Container** | Node/Next server app or arbitrary OCI image | **OCI image digest** | **yes** | per-app Deployment, digest-pinned |

**Recommendation: ship Tiers 1 and 2 to full enterprise standard now, and gate Tier 3
behind an operator flag.** The reasoning:

1. Tiers 1 and 2 cover "vibe engineered business apps over governed data" — which is what
   the owner's examples actually are.
2. Tiers 1-2 need **no image registry, no privileged build pod, no per-app Deployment, no
   wildcard DNS, no per-app TLS cert, no idle pod cost** — and they already have the
   strongest identity story (same-origin session = the user's own rights, RLS intact).
3. **Every §1 checklist item except #9 (digest-pinned image) and #18 (provenance) is
   achievable on Tiers 1-2.** A content-addressed bundle hash *is* an immutable artefact;
   "re-pin the digest" becomes "re-pin the bundle hash". An IT department asking "what
   exactly is running" gets a hash that resolves to a tag that resolves to a commit.
4. Tier 3 is where the hard SKE questions live (§7) and where the deleted Kaniko path
   died once already. Do not re-enter it to satisfy a checklist that Tiers 1-2 satisfy.

**When Tier 3 is built: BuildKit rootless (or Buildah rootless), as a `batch/v1` Job in
`agentic-apps`, cloning from the existing in-cluster `git://os-repos/<domain>.git` at the
pinned tag.** Not kaniko (deprecated — the exact reason the old path should not be
revived as-is). The clone path is the key insight: the git daemon + its NetworkPolicy
already exist; the build Job needs one label and one policy peer, and it never touches a
credential because the repo holds no secrets (`profiles.yml` uses `env_var()` only — the
same argument `os-repos.yaml:7` already makes). Verify the chosen builder's
securityContext against `agentic-apps` PSS **before** promising it, and keep the honest
`{live:false}` degradation discipline `runner.ts` already models.

### 4.4 Where the pipeline runs — **the OS's own job runner, not Dagster, not Tekton**

The OS already submits and reads `batch/v1` Jobs with a least-privilege namespaced Role
and reports status from real cluster state (`runner.ts`). Reuse that pattern:

- **Tiers 1-2 gates run in-process in os-ui** — they already do. `compileGate` is the
  model: synchronous, pre-write, typed diagnostics, 422. Add tests (`node --test` in the
  committed tree), `npm audit`/osv-scan against the committed lockfile, a licence check
  over the dependency set, `syft`-style SBOM generation from the lockfile, and the
  existing `securityScan`. Emit all six results as a **`PipelineRun` record** with a log
  readable over MCP.
- **Tier 3 build runs as a Job**, submitted the way `deployApp` applies manifests, with
  the digest surfaced via the pod termination message (this was the previous design's one
  genuinely good idea — see `config.ts:286-290`).
- **Not Dagster**: Dagster's `sovereign` code location is the data-product orchestrator;
  coupling app CI to it couples app deploys to dbt parse cycles and to a pod the data team
  owns.
- **Not Tekton/Argo Workflows**: new CRDs and a controller, against the v2-lean direction.

Gates enforced, in order, all blocking unless noted: **compile/typecheck** (exists) →
**tests** → **secret scan** (exists, blocking even for Builder) → **SAST** (exists,
needs a real engine) → **dependency vuln** (fail on high/critical, warn below) →
**licence policy** (fail on denylist) → **SBOM emitted** (non-blocking, but *absence*
blocks the release tag) → **release manifest written** → tag.

### 4.5 Environments & promotion — **map onto the scope ladder, don't invent a second one**

| Env | OS scope | Gate | Serves |
|---|---|---|---|
| **dev / preview** | My | none (`startPreview`, owner-only, free) | owner only |
| **staging** | Domain | `request_deploy` → Builder review card (four-eyes) | the domain |
| **prod** | Company | `promote` → Admin certification | the tenant |

**The critical rule: promotion must re-point, never rebuild.** A release tag is built and
gated **once**, at the My→Domain transition. Domain→Company moves the pointer to the
same release. This makes dev/prod parity (§1.4/19, 12-factor X) true by construction and
makes rollback trivial. It also means `scopeBroadened` keeps doing exactly what it does
today — it is already the right predicate for "does this need a fresh card".

The one change needed: the review card must name the **release tag and commit** being
approved, and `decideDeploy` must record them on the approval (§1.4/21).

### 4.6 Identity — **keep same-origin; reuse the four-layer adoption gate for app actions**

- **App → OS as the user: do nothing.** The same-origin `soa_session` bridge
  (`app-runtime.ts:16-22`) is already correct, already RLS-intact, and introduces no new
  credential. **Do not build token exchange for Tiers 1-2.** Token exchange would be a new
  secret, a new rotation story, a new confused-deputy surface, and an auditor's favourite
  question — in exchange for nothing the ambient session doesn't give.
  *Tier 3 is the only case that needs it* (a server-side app pod has no browser session):
  there, mint a short-lived, audience-restricted, per-request OS token derived from the
  caller's session, never a long-lived app credential, and never a token the app can use
  when no user is present.
- **Agent → app**: app actions are already registered as tools under principal
  `app-<slug>` with a reads-on/writes-off compiled profile, held for approval on write
  (§3.4). **Add the adoption layer**: make a domain_admin *adopt* an app's actions before
  the domain's agents can be granted them, reusing `adoptActions` from
  `core/mcp/experimental/exposure-write-tools.ts` — giving app actions the same
  *capability ∩ exposure ∩ adoption ∩ grant* fail-closed intersection Connections have.
  Execute as the **calling run's principal**, not the app's.
- **App → agent**: an app calling `run_agent_system` goes through the same governed MCP
  door under the viewer's session; the agent's own grants then apply. No new path.

### 4.7 Rollback

`rollback_software(appId, toVersion)`: resolve the tag → read `release.json` → re-pin
(AppSpec hash | bundle hash | image digest) → write the pointer → audit with the actor,
the from/to tags and the reason. **No rebuild, no re-review** (the target release was
already approved — re-reviewing a rollback is the anti-pattern that makes teams avoid
rolling back). Guard: refuse to roll back to a release whose scan has since failed a
newly-added rule, and say so honestly.

---

## 5. User stories + requirements (numbered, testable)

**US-1 — Push from Claude Code and get a preview URL.**
*As a developer in Claude Code I push app files via MCP and get a preview URL.*
R1.1 `push_app_files(appId, files[], message)` writes to `apps/<slug>/` via
`commitSubtree` and returns `{commit, changed, gate}`. R1.2 The compile gate runs
**before** the write; red → 422 with diagnostics, **nothing committed** (preserve today's
behaviour). R1.3 The commit's author is the calling user, committer `Sovereign OS`, with
`OS-Actor/OS-Reason/OS-Surface/OS-Run-Id` trailers. R1.4 A no-change push returns
`changed: false` and creates no commit. R1.5 Response includes a preview URL.
*Test:* push twice identically → one commit; `git log` shows the user as author.

**US-2 — Open a release.**
R2.1 `release_software(appId, bump: 'major'|'minor'|'patch' | version)` runs the full gate
set, writes `apps/<slug>/.app/release.json`, and creates annotated tag
`app/<slug>/v<x.y.z>`. R2.2 A failing blocking gate creates **no tag** and returns which
gate failed. R2.3 A tag is immutable: re-releasing the same version → 409. R2.4
`list_releases(appId)` returns tags newest-first with commit, gate results and approval
state.
*Test:* force a high-severity dependency finding → no tag, named gate.

**US-3 — Staging → approval → prod, same artefact.**
R3.1 `request_deploy` names the **release tag and commit** on the review card. R3.2
`decide_deploy` records approver id, decision, timestamp, tag and commit. R3.3 Requester
≠ approver, enforced (exists). R3.4 `promote` to Company **re-points** to the already-built
release — it must not rebuild, and a test must assert the artefact hash is byte-identical
before and after. R3.5 A scan failure or a secret blocks approval 409 (exists).
*Test:* assert prod and staging resolve to the same artefact hash.

**US-4 — See pipeline status and logs via MCP.**
R4.1 `get_pipeline_status(appId, releaseOrCommit)` returns per-gate
`{gate, status, startedAt, durationMs, summary}`. R4.2 `get_pipeline_log(runId, gate)`
returns the log tail, bounded. R4.3 An unreachable backend returns an honest degraded
status, never a fabricated pass (the `{live:false}` discipline).

**US-5 — Rollback.**
R5.1 `rollback_software(appId, toVersion)` re-pins without rebuilding. R5.2 Audited with
actor, from→to, reason. R5.3 Rolling back to a never-approved release → 403. R5.4 The
app's served pointer changes within one request.

**US-6 — The app reads and writes OS data as the end user.**
R6.1 An app's data read returns **only** rows the viewing user may see — two users, same
app, different row sets. R6.2 `os.records` writes are scoped by `recordActor`
(`app-records.ts:57`) and governed by the approved envelope. R6.3 A dataset not in
`app.grants.data` is refused; the reference is flagged on commit
(`ungrantedDatasetWarningForApp`) **and** on the review card. R6.4 A custom AppSpec block
runs null-origin and **cannot** act as the user.
*Test:* two sessions, same app, assert row-level divergence.

**US-7 — An agent calls an app action.**
R7.1 App actions are tools under `app-<slug>` with reads-on/writes-off. R7.2 A write is
held 202 and queued in the Governance inbox (exists, `app-tool-call.ts:50-66`). R7.3
Execution uses the **calling run's** principal. R7.4 A domain_admin must adopt the app's
actions before a domain agent can be granted them (§4.6).

**US-8 — An app calls an agent.**
R8.1 An app invokes `run_agent_system` through the governed MCP door as the viewing user.
R8.2 The agent's own grants apply; the app cannot widen them. R8.3 Traced with both the
app principal and the user.

**US-9 — Audit of every deploy.**
R9.1 One query returns, for any live app: commit, tag, artefact hash/digest, gate results,
requester, approver, timestamps, and current pointer. R9.2 The record is immutable and
retained per the retention policy. R9.3 Exportable as evidence (CSV/JSON).

**US-10 — SBOM + vuln gate.**
R10.1 A CycloneDX SBOM is produced per release and attached to `release.json`. R10.2 High
or critical dependency findings block the release; lower severities warn. R10.3 The SBOM is
retrievable over MCP for any release, including superseded ones.

**US-11 — Secrets.**
R11.1 No secret is ever committed; the secret scan blocks (exists). R11.2 An app receives
only `{id, access}` grant references; an inline credential is rejected 400 (exists,
`lifecycle.ts`). R11.3 Tier-3 runtime secrets are k8s Secret refs injected by the runner,
never in git, never in the image.

**US-12 — Quotas and limits.**
R12.1 Every Tier-3 pod has requests+limits (exists, `runner.ts:158`). R12.2 Per-domain caps
on live apps and total CPU/memory, enforced at `decide_deploy`. R12.3 Tier-1/2 apps carry
a bundle-size cap and a records-count cap.

**US-13 — Deletion.**
R13.1 Delete is lineage-aware and blocked at 409 when a dependent exists (exists,
`lifecycle.ts dependentsOf`). R13.2 Delete removes the Deployment/Service/Ingress,
revokes the MCP grant and OPA profile, and **retains git history and the audit trail**.
R13.3 Archive disables without data loss and is reversible (exists).

---

## 6. Checklist (S1…S20)

Ordered by dependency; **S1-S6 are the enterprise-credibility minimum.**

| # | Item | Where |
|---|---|---|
| **S1** | **Delete the false documentation.** Fix `scaffolds/vite-os.ts:443,644,690` ("CI → Harbor → Argo CD", "Argo CD syncs it to…"), rewrite `tabs/software/lib/README.md` (it describes Forgejo/Harbor/Argo + two deleted modules), drop the Forgejo/Harbor comment blocks at `config.ts:258-262`, remove dead `kanikoImage` (it pins `gcr.io/kaniko-project/executor:v1.23.2` — **a project Google archived ≈3 June 2025, no upstream CVE fixes**) / `softwareBuildEnabled` / `softwareBuildNamespace`, remove `forgejoConsoleUrl` from `values.stackit-managed.yaml:194,366`, remove the dangling `values.yaml:1005` comment. Make the Admin "Argo CD reverts drift" claim honest (`OverviewHealth.tsx:257` over mock `components-extra.ts:41-49`). **Cheapest, highest-value item in this report.** |
| **S2** | Capture and delete the orphan `cron-deploy-pipelines` CronJob; add a drift check that fails if an unmanaged object exists in the namespace. |
| **S3** | Software commits go through `git-store.ts` `commitSubtree('apps/<slug>')` + `reserveSubtree('apps/')`; OpenSearch mirror demoted to a cache. |
| **S4** | Add tag support to `git-store.ts`: `annotatedTag`, `listTags(prefix)`, `resolveTag`, path-scoped `log`. |
| **S5** | `release_software` → SemVer annotated tag + `release.json` manifest. |
| **S6** | Review card and approval record the **tag + commit**; `decide_deploy` persists approver+timestamp against them. |
| **S7** | `PipelineRun` model + `get_pipeline_status` / `get_pipeline_log` MCP tools. |
| **S8** | Real tests gate: run the committed tree's tests, block on failure. |
| **S9** | Replace the regex `scan.ts` SAST with a real engine behind the same shape (the header already promises this). |
| **S10** | Dependency vuln gate from the committed lockfile; block high/critical. |
| **S11** | Licence policy gate with a denylist. |
| **S12** | CycloneDX SBOM per release, attached and retrievable. |
| **S13** | `rollback_software` — re-pin, no rebuild, no re-review, audited. |
| **S14** | Content-addressed Tier-2 bundle artefact: hash it, store it, pin it, and serve the pinned hash (not a re-bundle on each request). |
| **S15** | Promotion re-points rather than rebuilds; test asserts identical artefact hash across environments. |
| **S16** | `push_app_files` MCP tool (US-1), so "code in Claude → deploy" is one documented verb rather than the `commit` escape hatch. |
| **S17** | Adoption gate for app actions, reusing `adoptActions` (§4.6). |
| **S18** | Per-domain quotas enforced at `decide_deploy` (US-12). |
| **S19** | Move `agentic-apps` PSS from `baseline` to `restricted` (the in-repo note already asks for it) and verify the runner's pod spec still admits. |
| **S20** | Tier 3 behind an operator flag: BuildKit-rootless Job cloning `git://os-repos/<domain>.git` at the tag, digest via termination message, runner already handles digest pinning. Only when a customer needs it. |

---

## 7. Risks

1. **In-cluster builds on SKE.** Managed/Gardener node images, PSS `baseline` (moving to
   `restricted`), no privileged pods assumed. Rootless BuildKit/Buildah need specific
   securityContext, seccomp and userns support that must be **verified on the actual node
   image before anything is promised**. Mitigation: §4.3 — Tiers 1-2 need no builder at
   all, so this risk is deferrable rather than blocking. The precedent is bad: the Kaniko
   path was designed, configured, documented, and then deleted.
2. **Registry access from pods.** Tier 3 needs a registry the build pod can push to and
   the runner pod can pull from. Harbor is default-off and heavy; Forgejo's registry is
   gone. The `agentic-apps` egress policy currently allows **DNS only** — a build pod
   pushing to any registry requires a deliberate egress exception, which is exactly the
   hole the policy was written to close. Mitigation: keep the build Job in its own
   namespace with its own narrow policy, never widen the app namespace.
3. **Multi-tenancy of app pods.** Apps are explicitly "untrusted code"
   (`apps-runner.yaml` header). PSS `baseline` permits more than it should for untrusted
   workloads; all apps share one namespace, so NetworkPolicy is the only tenant boundary
   and a namespace-wide policy change affects every tenant at once. Mitigation: S19
   (`restricted`), per-app labels and per-app policies, and keep Tier 1/2 — which run no
   tenant pod at all — as the default.
4. **Cost of per-app Deployments.** One Deployment + Service + Ingress + TLS cert per app,
   each with requests reserved and no scale-to-zero. 50 apps is 50 idle pods, 50 certs and
   50 LB rules. Mitigation: Tiers 1-2 cost **zero** marginal pods — this is the strongest
   commercial argument for the recommended tiering; add quotas (S18) and consider
   scale-to-zero only if Tier 3 volume ever justifies it.
5. **Token exchange security (Tier 3 only).** A server-side app pod cannot use the
   same-origin session, so it needs a delegated token — the classic confused-deputy and
   token-replay surface, and the one place the OS would hold a credential that acts as a
   user. Mitigation: do not build it for Tiers 1-2 (§4.6); when Tier 3 lands, short-lived,
   audience-restricted, per-request, never usable without a live user context.
6. **The `'image'` default is a live trap.** `normalizeServeMode` maps every legacy/nil
   record to `'image'` (`apps.ts:155`), and an image app with no image of its own is served
   by `traefik/whoami:latest` (`values.yaml:999`). Any legacy app that flips live today
   serves a **stranger's placeholder container on the customer's domain**. Mitigation:
   make the default `'spec'`, or make a missing image fail closed and loudly.
7. **The demo-seed paths.** `executeAppTool` returns `source:'demo-seed'` when the runner
   pod isn't Running (`app-records.ts:30-37`), `seedToolResult` in `tool-exec.ts`, and
   `appspec/seed-demo.ts` exist. They are *honestly labelled*, which is the right design —
   but the label lives in a response field a UI or an agent can drop. An approval card or a
   verification "PASS" grounded in seeded data is a governance failure wearing a green tick.
   Mitigation: make `demo-seed` structurally unusable in any gate, review card or
   `verify_software` result, and assert that in a test.
8. **Stale documentation as an audit finding in itself.** An IT reviewer who reads
   `tabs/software/lib/README.md` or a generated app's README and then greps for
   `build-service.ts`, Harbor or Argo CD will conclude the documentation is unreliable —
   and will then distrust the parts that *are* true and good (the deploy gate, the
   identity model, the NetworkPolicies). This is a credibility risk disproportionate to
   the effort of fixing it. See S1.
