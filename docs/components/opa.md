# OPA — policy at the tool boundary

**What it is:** Open Policy Agent (Apache 2.0) makes **default-deny** authorization decisions
for tool use: a principal (a LiteLLM key / agent identity) may invoke a tool only if it's
granted. Internet tools (`web_fetch`) are intentionally not granted by default — the
"deny internet tools unless granted" baseline (security.md).

## Access (decision API)
```bash
kubectl -n agentic-os port-forward svc/opa 8181:8181
curl http://localhost:8181/v1/data/agentic/authz/allow \
  -d '{"input":{"principal":"sovereign-agents","tool":"web_fetch"}}'   # -> {"result":false}
curl http://localhost:8181/v1/data/agentic/authz/allow \
  -d '{"input":{"principal":"sovereign-agents","tool":"query"}}'       # -> {"result":true}
```

## How to use it
- **Grants** live in `opa.grants` (values): principal → allowed tools. e.g. `sovereign-agents`
  → `rag_search, llm_generate, query`; `sovereign-agents-web` adds `web_fetch`.
- The **governed web_fetch tool** consults OPA before every fetch.

## FAQ
**Q: How do I grant a tool?** Add it under the principal in `opa.grants`, then `helm upgrade`.
**Q: Does OPA gate models too?** Tool access here; model/key caps are enforced in LiteLLM. In
production OPA also covers row/column data policies.
**Q: Why default-deny?** Least privilege — unknown principals/tools are denied unless explicitly allowed.

## Runbook: a refused policy-data update (os-data bundle guards)

With `opa.dataBundle.enabled`, os-ui compiles the `os-data` bundle (grants, governance principals and
tables, users) that OPA downloads. Before a new compile replaces what OPA has active, the guards in
`os-ui/core/policy/bundle-guards.ts` refuse it when it has:

- fewer governance tables than the active bundle, or an internal (`iceberg.*`) table missing;
- a relative drop above `opa.dataBundle.maxDropPercent` (default 10 %) in grant principals,
  governance principals or tables.

A refused compile changes nothing in OPA: it keeps the last good revision, so **no access change made
after the refusal (grant, revoke, new user, new table) reaches OPA** until the refusal is resolved.
The os-ui log says `os-data bundle: NOT recompiled … refused (needs an admin acknowledgement of <hash>)`.

**Where you see it**

- **Platform → Policy data** (admin only): current revision and last update, "In sync" or
  "Refused since <time>", the reasons and the threshold, and the exact lists of removed and added grant
  principals, governance principals and tables (first 200 of each, with the totals). Every removed
  `user:<id>` is annotated from the user directory: *deactivated on Access*, *disabled*, *no longer in a
  domain*, *unknown to the directory*, or *still active — check why it is removed* (the case to worry
  about). Annotations are read-only; when the directory is not loaded none are shown.
- **Monitoring** (alert "Policy data update refused") and **every admin's notification bell**, once a
  refusal has lasted longer than `opa.dataBundle.refusalAlertMinutes` (default 15). The alert disappears
  and the bell notification is marked read as soon as a compile passes.
- **History** on the same card, from the OS audit store (`opa-bundle.*` actions, also in Governance →
  Audit; ids, hashes and counts only): one `refused` row when a refusal starts; while it lasts, newer
  refused content at most once every 10 min (`refusal-changed`, with how many were skipped); each
  acknowledgement as `ack-requested` then `acknowledged` or `ack-failed`; and `recovered` when a
  compile passes.

**What to do**

1. Read the removed lists. A removal you expect (users offboarded, a domain deleted, tables dropped on
   purpose) shows its users as deactivated / disabled / no domain.
2. If anything is *still active* or *unknown*, or the tables were not dropped on purpose, **do not
   acknowledge**. Find the cause (a store that loaded only partly, a broken source; see the os-ui log
   lines `os-data bundle:`), fix it, and the next compile (within 60 s) passes on its own.
3. If the removal is intended: type a reason (at least 10 characters, e.g. the ticket), press
   **Acknowledge <hash>…**, read the confirmation that names everything removed, and confirm.

**Guarantees**

- `GET` and `POST /api/platform-admin/opa-bundle` need the admin role **and** an OPA `admin`
  decision; anyone else gets 403 (an OPA deny is audited as `opa-bundle.denied`). The same-origin check
  of `middleware.ts` applies as to every mutating route.
- An acknowledgement accepts exactly the content hash you were shown, once. If the refused content
  changed since you loaded the card, the API answers **409** and the card asks you to review again.
- Every acknowledgement REQUEST is written to the audit store and confirmed **before** it takes
  effect (who, when, hash, reason, counts, removed totals), then its outcome. If the refused content
  changes while that row is written (a resync), the acknowledgement fails with 409 and the trail says
  `ack-failed`, never `acknowledged`.
- An acknowledgement covers exactly the content you reviewed, now: if a different content is compiled
  first, or the refusal ends on its own, the acknowledgement is dropped, and that content coming back
  later is refused and reviewed again.

**Limits you should know**

- **Audit store down → no acknowledgement (503).** When OpenSearch (the audit store) does not confirm
  the request row, nothing is acknowledged. OPA keeps the last good revision meanwhile, so nobody loses
  access they had. A refusal caused by a store that loaded only partly heals by itself once the store
  is complete (the next compile, within 60 s, passes); an intentional large removal waits until the
  audit store is back.
- **The OPA admin decision uses what OPA has ACTIVE.** `authorize('user:<id>', 'admin')` reads
  `data.grants` from the active (last good) os-data bundle plus the chart's `seed_grants`. An admin whose
  admin grant exists only in the refused content (for example one created after the refusal started)
  gets 403 on this card and the API; another admin, already granted in the active bundle, must review
  and acknowledge.
- **One os-ui replica, in-process memory.** The refusal's `since`, the bell's per-incident memory and the
  history's "one row per incident" are held in the os-ui process. After an os-ui restart during a
  refusal, the incident starts again from the first refusal after boot: "Refused since" shows the new
  time, a new `refused` row is written, and admins are notified again after the threshold.

**Emergency escape (what turning bundles off actually does).** Setting `opa.dataBundle.enabled: false`
and redeploying is the documented rollback to the interim REST-push mode, not a way to accept one
refusal: OPA gets no bundle configuration, and os-ui's reconciler pushes every policy-state source to
OPA directly (`core/policy/opa-reconcile.ts`, every five minutes and after an OPA restart). **The bundle
guards do not run on that path**, so whatever the stores hold — including a partial load — reaches OPA
unchecked. The chart refuses to render it while a feature that needs bundles is on
(`opa.guardrailsData.enabled`, `dagsterRunIdentity.enabled`), and Trino's OPA sidecar only receives
bundles while it is on. Prefer fixing the cause or acknowledging; use this only with the owner's go.

**Settings** (chart values, `opa.dataBundle`): `maxDropPercent` (10), `refusalAlertMinutes` (15).
API without the UI: `GET /api/platform-admin/opa-bundle`; `POST {"hash": "<hash>", "reason": "<why>"}`.
