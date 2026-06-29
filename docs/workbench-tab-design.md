<!-- SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG -->

# Domain-Builder Workbench — Design, Domain-Isolation Threat Model & kind Prototype (for sign-off)

Status: **PROTOTYPE on local kind — NOT deployed to STACKIT, NOT published.**
Ships **off by default** (`workbench.enabled=false`). This document is the
sign-off package.

A new **Workbench** tab gives a `builder`-role user a **persistent, domain-scoped
`code-server` (VS Code in the browser)** where they build, edit, and administer
**ALL of their domain's artifacts in one place** — Software (their domain's
Forgejo repos), Agents (agent definitions), Data (the governed data layer via
`dq`/duckdb), and Knowledge. It **extends the terminal sandbox** (`docs/terminal-tab-design.md`,
T1–T10): same broker/least-privilege trust model, but adapted from an *ephemeral
shell with no rights* to a *long-lived editor that holds real, domain-scoped
credentials*. More access ⇒ more to lock down, so this is opt-in and gated.

## 1. Recommended architecture

```
 Browser (iframe → code-server)                OS UI (Next.js, server-side)
   │  POST /api/workbench/session {domain} ─────▶  requireUser() + role gate
   │  { token, brokerUrl }       ◀──────────────  + DOMAIN-MEMBERSHIP gate;
   │                                               HMAC-signs 60s single-use token
   │  POST {brokerUrl}/session?t=<token>  (once)
   │  …then all HTTP/WS to {brokerUrl}/* ─────────▶
   ▼
 workbench-broker  (the ONLY k8s-credentialed component)
   • verifies token (same HMAC secret), role ∈ allowedRoles, domain ∈ domains, single-use (sid)
   • IDEMPOTENTLY reconciles THIS builder's workbench in the WORKBENCH namespace:
       per-builder PVC ── per-builder NetworkPolicy ── per-builder creds Secret
       (copies ONLY this builder's DOMAIN-scoped Forgejo token) ── Deployment+Service
   • scales the Deployment 0→1, waits Ready, then REVERSE-PROXIES HTTP+WS to it
   • idle reaper scales 1→0  (the PVC — the builder's work — PERSISTS)
   ▼
 code-server pod  (per builder; persistent PVC; NO k8s token; non-root; caps dropped;
                   reachable ONLY from the broker; egress only to its domain's
                   Forgejo + the governed query-tool)
   VS Code  +  git (domain-scoped token)  +  python3 / duckdb  +  `dq` governed-data CLI
```

### Backend decision — chosen: **broker reconciles + reverse-proxies a per-builder code-server**

| Option | Verdict | Why |
| --- | --- | --- |
| **Broker reconciles a per-builder code-server (Deployment+PVC) and reverse-proxies HTTP+WS** | **CHOSEN** | One trusted chokepoint holds the only (tightly-scoped) k8s credential — identical trust model to the terminal-broker, so we *extend* it rather than reinvent. The browser never reaches the k8s API or the pod directly; the broker is the single audit + authz point; per-builder Deployment+PVC = clean blast-radius, trivial scale-to-zero, and natural persistence. |
| code-server per builder exposed directly via Ingress (its own `--auth password`) | Rejected | Puts an internet-reachable HTTP server on each builder's pod, with auth/lifecycle/domain-scoping bolted on per pod in the least-trusted place. No central chokepoint for OS authz/audit. |
| Shared multi-tenant code-server | Rejected | One process = one blast radius for ALL domains; a single RCE crosses every tenant. Fails the domain-isolation requirement outright. |
| Ephemeral (terminal-style, no PVC) | Rejected for the workbench | A builder's editor state — unsaved edits, extensions, settings, terminal history, non-repo scratch — MUST survive across sessions (see §2). The terminal is ephemeral *by design*; the workbench is the opposite. |

Next.js `output: 'standalone'` does not host a WS upgrade cleanly (same finding as
the terminal), so the broker is a **separate Service**. The OS UI only *mints the
token + gates on role/domain* server-side; the browser then talks to the broker
(Ingress `https://workbench.<domain>` on a deploy; `port-forward` locally).

## 2. Persistence decision — **per-builder RWO PVC, Forgejo as canonical VCS** (justified)

A builder's work must survive across sessions. The options:

| Model | Verdict |
| --- | --- |
| **Per-builder RWO PVC for `$HOME` (editor workspace) + Forgejo as the canonical store for repos** | **CHOSEN** |
| Forgejo-backed only (ephemeral pod, clone on start / push on save) | Rejected as the *sole* store |
| Per-builder PVC only (no remote) | Rejected |

**Why the hybrid.** Forgejo is the durable source of truth for the *software*
artifacts (the builder `git push`es there with their domain-scoped token). But
Forgejo **cannot** hold uncommitted edits, code-server *settings/extensions*,
terminal history, or *non-repo* scratch (draft agent defs, notes). So the PVC is
the **live working copy** (fast, holds everything), and Forgejo is the **canonical
VCS** for anything that graduates to a repo. The PVC is named deterministically
per builder (`wb-<id>-home`), is **ReadWriteOnce**, and is mounted **only** into
that builder's pod — so it is both the persistence boundary *and* an isolation
boundary. Scale-to-zero on idle keeps the PVC (cheap) while releasing the pod
(the expensive ~1–2 GB).

## 3. Domain-isolation + persistence threat model

Extends the terminal model (T1–T10 carry over unchanged: restricted PSS, no SA
token, non-root, RO-rootfs, drop-ALL-caps, seccomp, deny-egress baseline, HMAC
single-use token, least-privilege broker RBAC). The **new** surface — persistence,
real domain credentials, a listening editor, and a reverse proxy — adds T11–T16.

| # | New threat (persistent + artifact-access surface) | Mitigation (in the prototype) |
| --- | --- | --- |
| **T11** | **Cross-builder PVC / data remanence** — builder B mounts builder A's persisted work | PVC is per-builder (`wb-<id>-home`), **RWO**, named from the authenticated `sub`; the broker only ever mounts the *requesting* builder's PVC; pod `fsGroup` 1000. *Proven on kind: work persists across scale 0→1 for the same builder; names are per-builder.* |
| **T12** | **Cross-domain credential access** — builder in domain A obtains domain B's Forgejo token / pushes to B's repos | Credentials are **domain-scoped, never global**. The chart seeds one `workbench-domain-creds-<domain>` Secret per domain; the broker copies **only the requesting builder's domain creds** into their per-builder Secret (`wb-<id>-creds`), so another domain's token is *never assembled into the pod*. Egress NetworkPolicy further restricts the token's blast radius to that domain's Forgejo. *Proven on kind: bea(sales) sees ONLY the sales token, kenji(finance) ONLY finance; bea cannot see the finance token nor read the finance Secret via the API.* |
| **T13** | **code-server HTTP listener exposure** — the pod now runs a listening server (the sandbox had none) | code-server runs `--auth none` but is **reachable ONLY from the broker** (per-builder NetworkPolicy `ingress: from broker pod` on the code-server port). It is never Ingress-exposed; auth is enforced *upstream* by the OS token + the broker's signed proxy cookie. |
| **T14** | **Proxy target confusion / SSRF via the broker** — browser steers the proxy to another pod/host | The proxy target is derived **server-side from the signed cookie's `{sub,domain}`** (HMAC, HttpOnly), never from a browser-supplied path/host. The broker only ever proxies to `wb-<id>.<workbench-ns>.svc`. Token is single-use (sid) + 60s; the cookie binds the session. |
| **T15** | **Long-lived resource creep / idle cost** (persistent ≠ ephemeral) | Idle reaper **scales the Deployment to 0** after `idleTimeoutSeconds` (PVC persists); `maxActiveWorkbenches` caps *concurrently running* editors; per-pod cpu/mem/ephemeral **limits** + emptyDir `sizeLimit`. Only *active* builders consume RAM. |
| **T16** | **Supply chain** (code-server + the VS Code extension marketplace, git, pip) | Image pinned (code-server tag now; **digest-pin + Trivy scan** before any deploy); no kubectl/helm/cloud CLIs in the image (no pivot tooling); egress restricted so a malicious extension/dependency cannot phone home or reach another domain. Marketplace policy is a sign-off decision (§6). |
| **T9′** | **Cross-tenant access** (restated for persistence) | Per-builder pod + per-builder PVC + per-builder NetworkPolicy + per-domain creds. A builder cannot even *mint* a token for a domain they are not a member of (the OS UI gates `domain ∈ user.domains`; the broker re-checks). |

> Like the terminal: **kindnet does NOT enforce NetworkPolicy** — locally the
> guarantees rest on **no-token + non-root + RO-rootfs + drop-ALL-caps +
> domain-scoped-creds + no-pivot-tooling + the broker chokepoint**. On STACKIT
> (Cilium) the per-builder NetworkPolicies enforce ingress/egress as designed.

## 4. kind prototype — evidence

`scripts/workbench-kind-proto.sh` builds an **isolated** stand-in of both trust
tiers in throwaway namespaces (`wb-proto`, `wb-proto-wb`) — the **live `agentic-os`
namespace is untouched** — and asserts the security model that matters for
sign-off. The code-server *runtime* is stood in by a minimal image because every
property under test lives in the **Pod spec + RBAC + Secret scoping + PVC**, not in
the editor binary (exactly as the terminal proto proved sandbox properties, not
xterm). The `workbench-broker` image builds and `node --check`s clean. Transcript:

```
A. Workspace lockdown      non-root uid 1000 · NO_SA_DIR · NO_TOKEN · NO_KUBECTL ·
                           ROOTFS_READONLY · HOME(PVC) writable
B. Domain-scoped creds     bea sees ONLY sales token · kenji ONLY finance token ·
                           bea CANNOT see finance token · bea CANNOT read the finance
                           Secret via the k8s API (no token)
C. Persistence (PVC)       wrote notes.txt → scale 0 → scale 1 → work PERSISTED on the
                           new pod
D. Broker RBAC boundary    CAN reconcile deployments/PVCs in the workbench ns ·
                           CANNOT create workloads in the release ns · CANNOT read
                           secrets in the release ns or kube-system · NO cluster scope
RESULT: 17 passed, 0 failed
```

That is the literal mapping of the requirement: a builder scoped to **domain A**
gets domain-A credentials + a persistent workspace and **cannot** reach **domain
B**'s artifacts, secrets, or the k8s API. The *functional* artifact flows (git
push to the domain repo, `dq` query) are wired (domain-token git credential helper
in `workbench-entrypoint.sh`; `dq` → the already-GREEN governed query-tool) and
reuse the stack's proven governed paths; exercising them end-to-end is a
full-deploy step (§6).

Gates: `npm --prefix os-ui run build` ✅ (`/workbench` + `/api/workbench/session`
compiled) · `helm lint` default + `workbench.enabled=true` ✅.

## 5. Sizing math

`code-server` ≈ **1–2 GB RAM** per *active* builder (`memLimit: 2Gi`, request
`512Mi`). Because idle workbenches **scale to zero** (PVC stays), the live cost is
`concurrent_active_builders × ~2 GB`, not `total_builders × 2 GB`:

| Concurrent active builders | Editor RAM (≈) |
| --- | --- |
| 1 | ~2 GB |
| 4 | ~8 GB |
| 8 (`maxActiveWorkbenches` default 12) | ~16 GB |

Plus the broker (~96–256 Mi) + the existing OS stack. A **class of builders** all
editing at once therefore reinforces the **`g2i.16` (16 GB)** node sizing already
chosen for the cohort — and `maxActiveWorkbenches` is the hard ceiling that
protects it. Storage: `pvcSize` default **2 Gi** per builder (durable, cheap).

## 6. Decisions for sign-off

1. **Persistence model.** Confirm **per-builder RWO PVC + Forgejo-canonical**
   (this design), vs Forgejo-only (lighter, loses non-repo state) — and the PVC
   size (default 2 Gi) and storage class (kind default / STACKIT managed).
2. **Which artifact types in v1?** Wired: **Software** (Forgejo repos, domain
   token) + **Data** (`dq`/duckdb, governed). **Agents** + **Knowledge** are
   edited as files in the domain repo today — promote them to first-class panels
   (validation, schema) in v1, or keep file-based for the prototype?
3. **Per-builder vs shared infra.** Prototype = **per-builder pod + PVC** in **one
   shared `<ns>-workbench` namespace** + per-builder NetworkPolicy + per-domain
   creds. Upgrade to **namespace-per-domain** for harder isolation (more
   quotas/objects to manage)?
4. **Resource limits / lifecycle.** Per pod 1 vCPU / 2 Gi / 1 Gi ephemeral; idle
   scale-to-zero 30 m; `maxActiveWorkbenches` 12. OK for a cohort, or tune?
5. **Domain-scoped credentials.** Replace the placeholder per-domain Secrets with
   **real domain-scoped Forgejo tokens via ExternalSecret** (org/repo-scoped, NOT
   the global admin) before any deploy. Decide token scope (push to own org only).
6. **Extension marketplace policy.** Allow the public VS Code/OpenVSX marketplace,
   a curated internal registry, or none (T16)?
7. **Exposure.** Add `ingress.hosts.workbench` (`https://workbench.<domain>`, TLS)
   so the browser can reach the broker on a real deploy. **Coupled broker-hardening
   follow-ups (from the v0.2.0-alpha.4 code review — do BEFORE any deploy):**
   (a) set the `soa_wb_proxy` proxy-session cookie `Secure` once served over TLS
   (deferred here because the kind proto is plain-http; gate on a deploy-mode env);
   (b) make the broker's `MAX_SESSIONS` admission **atomic** — it is currently
   checked in the sync upgrade handler but the session is added later in the async
   `handleSession`, so a burst of concurrent upgrades can overshoot the cap (use a
   reservation counter). NOTE: single-use-`sid` enforcement and mandatory
   `domains` membership were **already hardened** in alpha.4 (the broker now
   rejects tokens lacking `sid` or `domains`).
8. **Monaco integration (note, not a dependency).** A concurrent agent is adding a
   Monaco editor to `os-ui/app/software/` (Layer 3). Conceptually, Monaco is the
   *lightweight inline* edit (quick changes to one repo file in the OS UI) and the
   Workbench is the *full IDE* (multi-file, terminal, git, extensions). v1 wiring:
   a "Open in Workbench" affordance from the Software panel. The two are
   complementary; this prototype stands alone and edits **no** Monaco files.

## 7. Build plan to production-ready (est.)

- Build + digest-pin + Trivy-scan the `code-server-workbench` image (git + duckdb +
  `dq` + entrypoint already authored); add dbt/query-CLI parity with the sandbox. ~1d
- Real domain-scoped Forgejo tokens via ExternalSecret; ingress + TLS for the
  broker; per-domain creds rotation. ~1d
- Broker hardening: structured audit log (who/when/domain/pod), Langfuse/metrics,
  graceful drain, per-user (not just global) active cap, PVC GC policy. ~1–2d
- Namespace-per-domain option + ResourceQuota/LimitRange per domain. ~1d
- E2E (git push to domain repo + `dq` query + cross-domain DENY) on Cilium with
  NetworkPolicy enforcement; load test (N concurrent builders); security review. ~2d
- Promote Agents/Knowledge to first-class panels; "Open in Workbench" from Software. ~1–2d
