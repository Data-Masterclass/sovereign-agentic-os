# Trino T2 cut-over: TLS, password service users, OPA impersonation (WP-14)

Design 06 §5.2 (option B) and §5.4, amended by 10 F4. Chart values `trino.auth.*` and
`trino.opa.sidecar.*`; Rego `charts/sovereign-agentic-os/policies/trino_impersonation.rego`.
Proof: `tests/lakehouse/{auth,impersonation,parity}.int.test.mjs` and
`images/extensions/query-tool/tests/test_trino_tls_int.py` on Trino 476 with the chart's OPA as a
sidecar (CI job `test-lakehouse`).

## What changes for a user

Nothing visible. Every governed query still runs as the same session user under the same OPA row
filters and column masks. What changes is how a client reaches Trino:
- over TLS on 8443;
- as a named service user with a password;
- acting for someone else only when OPA allows it.

When the plain-HTTP port is closed (step 7), a client that has not moved is refused.

## Who may act for whom (OPA `ImpersonateUser`)

| Authenticated service user | May set the session user to | Data |
|---|---|---|
| `svc-os-worker` | the principal of an active, unexpired, unrevoked grant with `kind=run` | `os_grants.run_grants` (WP-11) |
| `svc-dagster-runner` | the principal of a `kind=standing\|dataset` grant whose `active_run_id` is set (between `/start` and `/finish`) | `os_grants.run_grants` (WP-11, WP-15) |
| `svc-os-ui` (interim, removed at T7) | an active OS user (`os_data.users[uid].active`), or a principal declared in `governance.principals` (today's uids, domain principals and chart service principals, until WP-35) | `os_data`, `governance` |
| anyone else (users, `northpeak-marts`, `os-domain-delete`, `dbt-runner`, look-alikes) | nobody | — |

No service user is ever a target. `SET SESSION AUTHORIZATION` inside an impersonated session is
checked by Trino 476 as *session user → new user*, so it is always denied (measured, see
`impersonation.int.test.mjs`).

## Every Trino client, and what it changes

| # | Client | Today | After the cut-over | Changes in | Step |
|---|---|---|---|---|---|
| 1 | **query-tool** (`/query`, `/execute`, MCP). os-ui and os-ui-worker reach Trino only through it | `http://trino:8080`, session user = the principal os-ui chose | `https://trino:8443` as `svc-os-ui` (Basic auth, chart CA), with the session user still that principal. A principal that is a direct service user logs in as itself | image with `trino_login.py` (this PR); values `trino.auth.clients.queryTool` | 3 |
| 2 | **northpeak-marts** seed Job | `http://trino:8080`, user `northpeak-marts` | `https://trino:8443` as the direct user `northpeak-marts` (`NODE_EXTRA_CA_CERTS`) | values `trino.auth.clients.northpeakMarts` | 4 |
| 3 | **delete-domain purge** (PR #197, query-tool `purpose: domain-delete`) | user `os-domain-delete` | the direct user `os-domain-delete`, never impersonated | values: add it to `trino.auth.directUsers` and `trino.auth.queryToolDirectUsers` | 3 |
| 4 | **Dagster run pods**: dbt-trino `profiles.yml`, the dlt `sqlalchemy` Trino destination, and the `repo.py` observation probe | `method: none`, user `dbt-runner` (`os_projects.py`), port 8080 | `method: ldap` as `svc-dagster-runner` with `impersonation_user: OS_PRINCIPAL`, password from a Secret by `secretKeyRef` (never run config), `TRINO_PORT=8443`, the CA through `REQUESTS_CA_BUNDLE`; os-ui `TRINO_AUTH_METHOD=ldap`; `trino.accessControl.serviceUser` and `scripts/check-trino-rules-chart.mjs` follow | WP-15 (needs the run-grant routes and `active_run_id`) | 5 |
| 5 | **Operators' in-pod CLI** (`trino` inside the Trino container) | plain HTTP on localhost | `trino --server https://localhost:8443 --user <svc user> --password` with the chart CA | runbook | 6 |
| 6 | **kind e2e journeys** (`tests/e2e/kind/lib/endpoints.mjs`, `records/trino.mjs`) | plain HTTP | TLS with a test service user | e2e harness | 6 |
| 7 | **Trino's OPA plugin** | `http://opa:8181` | the sidecar on `127.0.0.1:8181` with the `os-data` + `os-grants` bundles | values `trino.opa.sidecar.*` once WP-11 serves bundles | 2b |
| — | **data-runner** | no Trino connection (PyIceberg → Polaris) | unchanged | none | — |
| — | **os-ui / os-ui-worker** | no direct Trino connection (query-tool only) until WP-36 | unchanged. The file-ACL reconciler already passes the three `svc-*` users through to OPA (this PR) | none | — |

## Order (never breaks os-ui, Dagster, the query-tool or the data-runner)

Each step uses a port and credentials that already exist before any client depends on them. Each
step has a one-flag rollback. Only step 2 restarts Trino (strategy `Recreate`, about a minute
without queries). Announce it, and do it in the maintenance window.

| Step | Change | Precondition | Live evidence | Rollback |
|---|---|---|---|---|
| 0 | Merge and deploy with every flag off. OPA loads `trino_impersonation.rego`. The file ACL gains one pass-through entry for the three `svc-*` users | none | OPA decision log: `trino/allow` traffic unchanged; Trino config unchanged | previous chart |
| 1 | Build and pin the query-tool image with `trino_login.py`. With `TRINO_AUTH_USER` unset it connects exactly as today | step 0 | `/health` ok; `query_data` answers unchanged | previous image tag |
| 2 | `trino.auth.enabled=true` (`insecureHttp: true`). Trino serves 8443 with PASSWORD; 8080 keeps serving every client as today | the Secrets render (`helm template` shows `trino-tls`, `trino-service-users`, `trino-internal-communication`); `passwords.existingSecret` once ESO exists (WP-10); `tls.source: certManager` on STACKIT | `curl -sk -o /dev/null -w '%{http_code}' -X POST https://<trino>:8443/v1/statement -d 'SELECT 1'` → `401`; `kubectl --context dmagenticos -n agentic-os get svc trino -o jsonpath='{.spec.ports[*].port}'` → `8080 8443` | `trino.auth.enabled=false` |
| 2b | `trino.opa.sidecar.enabled=true` with `bundles` pointing at os-ui's `os-data` and `os-grants` | WP-11 live; the sidecar's status shows both bundles active | `kubectl … get pod -l app.kubernetes.io/component=trino -o jsonpath='{.items[0].spec.containers[*].name}'` → `trino opa`; sidecar log "Bundle loaded and activated" for both | `trino.opa.sidecar.enabled=false` (Trino back to `opa:8181`) |
| 3 | `trino.auth.clients.queryTool=true`, plus `os-domain-delete` in `directUsers` and `queryToolDirectUsers` once #197 is in | step 2; for the interim `svc-os-ui` rule, `governance.principals` must be in the OPA Trino asks (central OPA today, or the bundle with 2b) | OPA decision log: `ImpersonateUser` `svc-os-ui → <principal>` `true`; no rise in `PERMISSION_DENIED`; `SELECT "user", source, resource_group_id FROM system.runtime.queries` shows the same users and groups as before | `clients.queryTool=false` |
| 4 | `trino.auth.clients.northpeakMarts=true` | step 2 | the seed Job completes; snapshot summary `trino_user` = `northpeak-marts` | flag off |
| 5 | Dagster moves to `svc-dagster-runner` (client 4) | WP-15: `/start` sets `active_run_id`, `/finish` clears it, grants reach the OPA Trino asks within 2 s (WP-11 `grant-propagation`) | a scheduled run's queries show `user = <principal>`; decision log `ImpersonateUser svc-dagster-runner → <principal>` names the grant | WP-15 flag off (run pod back to 8080) |
| 6 | The operator CLI runbook and the kind e2e journeys use TLS | step 2 | — | — |
| 7 | Close plain HTTP: `trino.auth.insecureHttp=false` | steps 3–6 done, and no workload still configured for 8080: `kubectl … get deploy,sts,job,cronjob -o yaml \| grep -nE 'trino:8080\|TRINO_PORT[^0-9]*8080'` is empty | `curl -s -o /dev/null -w '%{http_code}' -X POST http://<trino>:8080/v1/statement -H 'X-Trino-User: x' -d 'SELECT 1'` → `403` | `insecureHttp=true` |
| later | WP-36 disables the HTTP listener (`http-server.http.enabled=false`) and deletes the file ACL and the query-tool. WP-38/T7 adds `JWT` beside `PASSWORD` and removes the `svc-os-ui` rule | — | — | — |

## Operations

- **Passwords.** Generated once into `trino-service-users` (bcrypt cost 10 in `password.db`, one
  key per user) and kept across upgrades. To rotate, write new values (ESO, WP-10). Trino re-reads
  the password file. Restart the client that mounts the key.
- **Certificate.** `helm` mode: CA valid 10 years, server certificate valid 825 days, kept across
  upgrades. `certManager` mode: 90 days, renewed 15 days early. Roll Trino after a renewal; that
  Trino reloads the PEM keystore by itself is not verified.
- **Resource groups (#175).** Unchanged. The selector still reads `X-Trino-Source`, and `${USER}`
  is the session user, so the TLS path lands in the same `global.domains.<d>.<user>` group
  (`parity.int.test.mjs`). Moving the system selector to `authenticatedUser` is a follow-up once
  Dagster runs as `svc-dagster-runner`.
- **Not in this step.** `default allow := false` in `trino.rego` (WP-36), write rules in Rego
  (WP-36), the uid switch (WP-35).
