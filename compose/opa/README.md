# compose/opa — file provenance

## Copied verbatim (edit these directly, then diff against source to confirm you didn't drift)

- `authz.rego` — from `charts/sovereign-agentic-os/templates/opa/opa.yaml:35-108`, de-indented. No Helm `{{ }}` expressions in that block, so it's a straight copy.
- `trino.rego`, `marketplace.rego` — from `charts/sovereign-agentic-os/policies/`, byte-identical (`cp` + `diff`).

## Generated (do NOT hand-edit — regenerate instead)

- `data.json` — rendered content of the `data.json` ConfigMap key, `templates/opa/opa.yaml:115-116` (`{{ dict "seed_grants" $opa.grants "requires_approval" ... | toJson }}`).
- `governance.json` — rendered content of the `governance.json` ConfigMap key, `templates/opa/opa.yaml:124-125` (`{{ dict "governance" $gov | toJson }}`).

### Regenerate

```
helm dependency build charts/sovereign-agentic-os
helm template agentic-os charts/sovereign-agentic-os -f values.selfcontained.yaml --show-only templates/opa/opa.yaml
```

Then copy the `data.json: |` / `governance.json: |` block's content (de-indented) verbatim into the matching file here — **nothing else**, see below.

`helm` is deliberately **not** part of the Compose runtime path. `data.json`/`governance.json` are committed snapshots so a clean checkout needs only Docker to bring the stack up — no Helm, no chart dependencies fetched.

## Do not add top-level keys to these JSON files

`data.json` and `governance.json` must contain **only** their rendered content, nothing added. OPA merges every JSON file in its file list into the root of `data`, so two files sharing a top-level key collide and OPA refuses to start with `load error: merge error`. Provenance belongs in this README, not in the data files.

Any JSON file you add to OPA's file list (`compose.yaml`'s `opa` service `command:`) must not share a top-level key with a file that's already loaded.

## Fail-closed, and what that means for debugging

`authz.rego` sets `default allow := false`. If a policy file fails to load (bad JSON, a merge collision, a Rego syntax error), OPA does not fall back to "allow everything" — it fails to come up serving the policy, and every downstream authorization call gets an honest deny. That's the intended fail-closed behavior, but it also means a broken policy change is **silent** from the caller's side (just a deny, indistinguishable from a legitimate deny) — after any change to a file in this directory, check:

```
docker compose logs opa
```
