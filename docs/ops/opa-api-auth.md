# OPA API authentication — rollout runbook

OPA's REST API uses OPA's own token authentication and `system.authz`
(`--authentication=token --authorization=basic`, https://www.openpolicyagent.org/docs/security).
The chart's policy is `charts/sovereign-agentic-os/policies/system/authz.rego`; the tokens live in
the Secret `opa-tokens` (or `opa.auth.existingSecret`).

| identity | presented by | allowed |
|---|---|---|
| `writer` | os-ui, os-ui-worker, the principal re-assert hook | every API call (data and policy writes included) |
| `reader` | web-fetch | `POST /v1/data/agentic/authz/*` |
| none | kubelet probes, Trino's OPA plugin (no bearer setting) | `GET /health`, `POST /v1/data/trino/*` |

## Rollout
1. **Release N, `opa.auth.enforce: false` (the default).** The tokens Secret is created and every
   client gets its token. OPA does not require it yet, so pods that roll at different times keep
   working. Check:
   `kubectl -n <ns> get secret opa-tokens` exists;
   `kubectl -n <ns> get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="OPA_TOKEN")].name}'` prints `OPA_TOKEN`.
2. **web-fetch image** that sends its token (`images/base/web-fetch`, `OPA_TOKEN`), pinned by digest
   in the profile. Without it, `web_fetch` decisions are refused once step 3 is live.
3. **Release N+1, `opa.auth.enforce: true`.** OPA restarts with the policy. The OS reconciler
   restores its state with the writer token (`state-reconcile.int.test` runs with enforcement on).
   Check:
   - the OPA args contain `--authorization=basic`;
   - Monitoring shows no "Policy state not restored" alert;
   - a governed query through the query-tool returns filtered rows (Trino → OPA);
   - the re-assert hook logs "re-asserted principal".
4. **Rollback:** `--set opa.auth.enforce=false` (one value; the tokens stay in place).

## Bound
Trino's decision queries under `/v1/data/trino/*` are evaluated without a token. Only the pods that
the platform ingress policy `opa-allow-callers` admits can reach OPA at all. The Trino-pod OPA
sidecar on `127.0.0.1` takes this path off the network (WP-12/WP-14).
