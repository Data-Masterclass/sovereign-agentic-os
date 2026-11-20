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
- Decision logs (`decision_logs.console`, `mask_decision`, `system.log.mask`): https://www.openpolicyagent.org/docs/management-decision-logs
- Configuration (`labels`, `decision_logs`): https://www.openpolicyagent.org/docs/configuration
- REST API (`decision_id` in responses; `GET /v1/config`): https://www.openpolicyagent.org/docs/rest-api
- Rego v1 is the default in OPA 1.x: https://www.openpolicyagent.org/docs/v0-compatibility

## Upgrade notes 1.4.2 → 1.22.4 (from the release notes)
- Rego v1 syntax stays the default; every policy here already uses `import rego.v1`/`if`/`contains`.
- 1.18.0: outbound `User-Agent` changed to RFC 9110 form — affects only OPA-initiated HTTP
  (bundles, decision-log services, `http.send`); none are used yet.
- 1.21.0: YAML is parsed with the 1.2 core schema (`yes`/`no`/`on`/`off` are strings). Our
  config file and data are JSON/YAML without such bare words.
- 1.22.0: stricter bundle signature filenames — relevant once bundles are signed (later step).
- 1.22.0: the `_static` binaries/images are deprecated (the default build is statically linked
  too, https://github.com/open-policy-agent/opa/issues/9431), so the pin uses the default tag
  instead of `-static`.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Eject test
The policies are plain Rego plus JSON data. Without the OS, upstream OPA alone runs them:

    opa test charts/sovereign-agentic-os/policies -v
    opa eval -d charts/sovereign-agentic-os/policies -i input.json 'data.agentic.authz.decision'

CI's `test-opa` job runs exactly this with the pinned OPA binary.
