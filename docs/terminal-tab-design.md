<!-- SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG -->

# In-UI Terminal Tab — Design, Threat Model & kind Prototype (for sign-off)

Status: **PROTOTYPE on local kind — NOT deployed to STACKIT.** Ships **off by
default** (`terminal.enabled=false`). This document is the sign-off package.

A new **Terminal** tab in the OS UI gives an authenticated user an **ephemeral,
sandboxed teaching shell** (python3 + duckdb today; dbt + the governed query CLI
are additive) — for learning, **not** access to the live server/cluster. It is
the highest-risk surface in a 30-student multi-tenant platform, so the security
model is the point of the design.

## 1. Recommended architecture

```
 Browser (xterm.js + fit + web-links)          OS UI (Next.js, server-side)
   │  POST /api/terminal/token  ───────────────▶  requireUser() + role gate
   │  { token, wsUrl }          ◀───────────────  HMAC-signs 60s single-use token
   │
   │  WebSocket  wsUrl?t=<token>
   ▼
 terminal-broker  (the ONLY k8s-credentialed component)
   • verifies token (same HMAC secret), role ∈ allowedRoles, single-use (sid)
   • creates an ephemeral locked-down Pod in the SANDBOX namespace
   • opens a PTY via the k8s exec API and bridges stdin/stdout/resize
   • destroys the Pod on disconnect / idle / max-TTL  (+ janitor reaps orphans)
   ▼
 sandbox Pod  (per session, no rights, no token, non-root, RO-rootfs, deny-egress)
   bash → python3 / duckdb, scoped to the governed data endpoint only
```

### Backend/PTY decision — chosen: **broker + k8s `exec` into an ephemeral pod**

| Option | Verdict | Why |
| --- | --- | --- |
| **node-pty + ws broker, k8s `exec` into ephemeral pod** | **CHOSEN** | The broker holds the only (tightly-scoped) credential; the sandbox holds none. The PTY is a k8s `exec` stream — the broker needs no `node-pty`, no shell on its own host, and never runs student code in-process. Per-session pod = clean blast-radius + trivial teardown. |
| ttyd / gotty / wetty per pod | Rejected | Each ships an HTTP/WS server *inside* the student pod and needs that pod network-reachable from the browser/ingress — more attack surface in the least-trusted place, and auth/lifecycle bolted on per pod. |
| `kubectl exec` shelling out | Rejected | Same model as chosen, but shelling out to a `kubectl` binary is fragile + slower than the API client; the client streams exec natively. |
| node-pty `bash` *in the broker* | Rejected | Runs student processes inside the trusted broker — defeats the isolation. |

Next.js note: `output: 'standalone'` (server.js) does not host a WebSocket
upgrade cleanly, so the broker is a **separate Service**, not a Next API route.
The UI only *mints the token* server-side; the browser dials the broker directly
(ingress `wss://terminal.<domain>` on a deploy; `port-forward` locally).

## 2. Threat model & mitigations

| # | Threat | Mitigation (all implemented in the prototype) |
| --- | --- | --- |
| T1 | **RCE → container escape** | Restricted PSS: `runAsNonRoot`+uid 1000, `readOnlyRootFilesystem`, `allowPrivilegeEscalation:false`, **drop ALL caps**, `seccompProfile: RuntimeDefault`. Namespace labelled `pod-security.kubernetes.io/enforce: restricted`. |
| T2 | **Privilege escalation** | No setuid path (caps dropped, no-new-privs via PSS), non-root user, no sudo/package manager wired for gain. |
| T3 | **Reach k8s API / steal SA token** | `automountServiceAccountToken: false` **and** the pod runs as `sandbox-nobody` which is bound to **no** Role/ClusterRole. `enableServiceLinks:false`. `kubectl` not installed. *Proven: `NO_SA_DIR`, `NO_TOKEN`, `NO_KUBECTL`, API connect timed out.* |
| T4 | **Read Secrets** | Sandbox SA can do nothing (`can-i get secrets` = **no**). Broker SA also **cannot** read secrets in any namespace (verified). |
| T5 | **Lateral movement** | Dedicated sandbox **namespace** + deny-all-ingress + **deny-egress** NetworkPolicy (DNS only, optional single governed `query-tool` egress). On Cilium this enforces; FQDN allowlists add depth. |
| T6 | **Data exfiltration** | No raw internet: egress denied except the governed data endpoint. The existing egress-proxy chokepoint remains the only path off-cluster. |
| T7 | **Resource exhaustion / crypto-mining** | Per-pod `cpu`/`memory`/`ephemeral-storage` **limits** + emptyDir `sizeLimit`; PID pressure bounded by limits; broker-wide `maxConcurrentSessions`. Idle TTL (10m) + max-session TTL (60m) + janitor sweep cap spend. |
| T8 | **Token theft / replay** | Token is HMAC-signed, **60s** lifetime, **single-use** (`sid` de-dup at the broker), role-bound. Secret is server-only; never reaches the browser. |
| T9 | **Cross-tenant access** | Per-session pod; claims carry the user's `domains` so the shell is scoped to that domain's governed data (the single allowed egress). Namespace isolation between sessions. |
| T10 | **Broker compromise** | Broker RBAC is least-privilege: pods + pods/exec **only in the sandbox namespace** — *verified it cannot create pods in the live namespace, read any secret, or list nodes, and has no cluster wildcard*. |

## 3. kind prototype — evidence

Built `sovereign-os/terminal-broker:0.1.0` + `sovereign-os/sandbox-shell:0.1.0`,
deployed into an isolated `term-proto` / `term-proto-sandbox` (live `agentic-os`
untouched), and drove the **real browser path** (WebSocket → broker → spawned
pod PTY). Captured transcript:

```
uid=1000(sandbox) gid=1000(sandbox) groups=1000(sandbox)   # non-root
NO_SA_DIR            # /var/run/secrets/kubernetes.io absent
NO_TOKEN             # no service-account token
NO_KUBECTL           # kubectl not installed
API_BLOCKED_OR_NO_ROUTE   # connect to 10.96.0.1:443 timed out
ROOTFS_READONLY      # touch / -> read-only file system
CapEff: 0000000000000000   # all capabilities dropped
duckdb 1.1.3 ; select 6*7 -> (42,)   # teaching toolset works
```
Plus: broker SA `can-i create pods -n agentic-os` = **no**, `get secrets` (any ns)
= **no**, `list nodes` = **no**, `* * --all-namespaces` = **no**; sandbox SA = no
rights at all; and the pod was **destroyed on disconnect** (namespace empty).
`npm --prefix os-ui run build` ✅ · `helm lint` (default + `terminal.enabled=true`) ✅.

> kind's kindnet CNI does **not** enforce NetworkPolicy — locally the egress
> guarantee rests on **no-token + no-tooling + non-root + RO-rootfs**. On STACKIT
> (Cilium) the NetworkPolicies enforce egress as designed.

## 4. Chart additions (`terminal.enabled`, default off)

`templates/terminal/terminal.yaml`: sandbox **Namespace** (PSS=restricted),
`sandbox-nobody` SA (no bindings, no automount), **broker** Deployment+Service+SA,
least-privilege **Role/RoleBinding** (pods+exec in sandbox ns only, cross-ns
subject), shared-secret **Secret**, and sandbox **NetworkPolicies** (deny-egress,
allow-DNS, optional allow-governed-query-tool). OS UI deployment gains the
`TERMINAL_*` env (gated). `values.yaml` `terminal:` block carries roles, TTLs,
limits, images.

## 5. Decisions for sign-off

1. **Which roles get it?** Prototype default = `builder`, `admin` (participants
   excluded). Decision: do students (participants) get a terminal, or only
   builders/instructors? (`terminal.allowedRoles`.)
2. **Toolset.** Prototype = python3 + duckdb. Add `dbt-core`/`dbt-duckdb` + the
   governed query CLI to `images/sandbox-shell`? Anything else (pandas, polars)?
3. **Session/resource limits.** Idle 10m / max 60m / 30 concurrent; pod
   0.5 vCPU / 512Mi / 512Mi ephemeral. OK for a 30-student cohort, or tune?
4. **Isolation model.** Prototype = **one shared sandbox namespace** + per-pod
   isolation + NetworkPolicy. Upgrade to **namespace-per-user** for hard
   multi-tenant isolation (more objects/quotas to manage)?
5. **Secret management.** Replace the placeholder `terminal.brokerSecret` with a
   generated/External Secret before any deploy.
6. **Exposure.** Add `ingress.hosts.terminal` (`wss://terminal.<domain>`, TLS) so
   the browser can reach the broker on a real deploy.

## 6. Build plan to production-ready (est.)

- Harden image: add dbt + query CLI, pin digests, scan (Trivy), distroless-ish. ~1d
- Secret via ExternalSecret + per-env `brokerSecret`; ingress + TLS for the WS. ~0.5d
- Namespace-per-user option + ResourceQuota/LimitRange per cohort. ~1d
- Broker: structured audit logging (who/when/pod), Langfuse/metrics, graceful
  drain, session cap per-user (not just global). ~1d
- E2E + load test (30 concurrent), Cilium NetworkPolicy enforcement test on
  STACKIT, security review sign-off. ~1–2d
