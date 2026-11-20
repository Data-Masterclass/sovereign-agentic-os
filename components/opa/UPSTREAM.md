# Open Policy Agent

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/open-policy-agent/opa
- **Pinned as:** Image `openpolicyagent/opa:1.22.4@sha256:ff50f50332ff9e722ffafe2658c195ced1f9b6d4f3064000c2ecfa8cdf7acccf`
  (release https://github.com/open-policy-agent/opa/releases/tag/v1.22.4). The same version is
  pinned for the CI `opa` binary (`test-opa` job) and the integration-test container.
- **Linter:** Regal v0.43.0 (Apache-2.0, https://github.com/open-policy-agent/regal), CI only.

**Why the OS ships it:** Authorization decisions, fail-closed. Policies live in the chart
(`charts/sovereign-agentic-os/policies/`, plain Rego with their `*_test.rego` beside them),
not here.

## Upstream docs this pin relies on
- Policy testing, coverage, `opa check --strict`, `opa fmt`: https://www.openpolicyagent.org/docs/policy-testing
- Decision logs (`decision_logs.console`, `drop_decision`/`mask_decision`, `system.log`): https://www.openpolicyagent.org/docs/management-decision-logs
- Configuration (`labels`, `decision_logs`): https://www.openpolicyagent.org/docs/configuration
- REST API (`decision_id` in responses; `GET /v1/config`): https://www.openpolicyagent.org/docs/rest-api
- Rego v1 is the default in OPA 1.x: https://www.openpolicyagent.org/docs/v0-compatibility
- Bundles (WP-11): service + `bundles.<name>.resource`, `.manifest` `revision` and `roots`, a
  path under a root is owned by that bundle (a `PUT /v1/data` there is refused), ETag /
  If-None-Match → 304, `persist: true` + `persistence_directory`, HTTP long polling
  (`polling.long_polling_timeout_seconds`, `Prefer: wait=<s>`, response
  `Content-Type: application/vnd.openpolicyagent.bundles`):
  https://www.openpolicyagent.org/docs/management-bundles
- Bearer credentials for a service (`credentials.bearer.token_path`): https://www.openpolicyagent.org/docs/configuration
- Status API (`status.service`, `bundles[<name>].active_revision`, POST `<service>/status`):
  https://www.openpolicyagent.org/docs/management-status
- Health API (`GET /health?bundles`: 200 only once every bundle is activated):
  https://www.openpolicyagent.org/docs/rest-api#health-api
- Guardrails eject (WP-30): `opa eval --data <dotted.path>:<file>` loads a JSON file under a
  prefix of the data document (`-d 'os_data.guardrails.<id>:guardrails.json'`), so a committed
  data file decides with the platform policy and no OS: https://www.openpolicyagent.org/docs/cli#eval
  (behaviour checked on 1.22.4 by `tabs/knowledge/lib/guardrails.eject.test.ts`).

## Upgrade notes 1.4.2 → 1.22.4 (from the release notes)
- Rego v1 syntax stays the default; every policy here already uses `import rego.v1`/`if`/`contains`.
- 1.18.0: outbound `User-Agent` changed to RFC 9110 form — affects only OPA-initiated HTTP
  (bundles, decision-log services, `http.send`); none are used yet.
- 1.21.0: YAML is parsed with the 1.2 core schema (`yes`/`no`/`on`/`off` are strings). Our
  config file and data are JSON/YAML without such bare words.
- 1.22.0: stricter bundle signature filenames — relevant once bundles are signed (later step).
- 1.22.0: the `_static` release **binaries** are deprecated
  (https://github.com/open-policy-agent/opa/pull/9441). For the `-static` **images** a deprecation
  was only discussed (https://github.com/open-policy-agent/opa/issues/9431), which also shows the
  default build is statically linked too. The pin uses the default image tag.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## API protection (token authentication + `system.authz`)
- Docs: https://www.openpolicyagent.org/docs/security ("Authentication and Authorization"),
  same pinned version (1.22.4, Apache-2.0). Flags `--authentication=token --authorization=basic`;
  OPA evaluates `data.system.authz.allow` with `input.identity` = the bearer token.
- Built-in `opa.runtime()` (https://www.openpolicyagent.org/docs/policy-reference/builtins/opa)
  exposes the process environment; `policies/system/authz.rego` reads the two tokens from there,
  so no token is stored as OPA data.
- Trino's OPA access control (https://trino.io/docs/current/security/opa-access-control.html)
  has no bearer-token property; its decision paths are therefore admitted without a token
  (POST under `/v1/data/trino/`), network-restricted to the callers in `opa-allow-callers`.

## Eject test
The policies are plain Rego plus JSON data. Without the OS, upstream OPA alone runs them:

    opa test charts/sovereign-agentic-os/policies -v
    opa eval -d charts/sovereign-agentic-os/policies -i input.json 'data.agentic.authz.decision'

CI's `test-opa` job runs exactly this with the pinned OPA binary.

## Delete domain (2026-11-20)

Data API `GET`/`PUT`/`DELETE /v1/data/governance/{tables,principals}/<key>`
(https://www.openpolicyagent.org/docs/rest-api#data-api); run against the chart's OPA in
`tests/domain-delete`.
