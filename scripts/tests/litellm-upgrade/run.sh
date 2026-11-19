#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# LiteLLM gateway upgrade test — run it BEFORE changing the gateway version in the chart.
#
#   scripts/tests/litellm-upgrade/run.sh
#   OLD_IMAGE=… NEW_IMAGE=… EXTRA_VALUES="-f some-overlay.yaml" scripts/tests/litellm-upgrade/run.sh
#
# What it does, with real containers (Docker or Colima; ~5 minutes once the images are pulled):
#   1. renders THIS chart for the STACKIT profile and takes the gateway's ConfigMap text and the
#      key-init Job's script from the rendered manifests — the test runs what the cluster runs;
#      only the upstream endpoint is pointed at a local stub (stub.mjs: an OpenAI-compatible
#      upstream that also records what a Langfuse server would receive);
#   2. EMPTY database: the chart's migration command with NEW_IMAGE, the proxy, the key Job, and
#      the behaviour battery (exercise.sh: probes, /key/generate|info|update with the bodies the
#      OS sends, a tool call through a scoped key, the tpm 429 the OS parses, a spent budget,
#      the response cache, every admin read of core/infra/litellm-admin.ts, the console login,
#      the MCP server, what reaches the upstream);
#   3. UPGRADE: a database initialised and used by OLD_IMAGE (shared key, a system key, a team,
#      a model stored in the database, spend), dumped; then
#        a. the NEW proxy on the still-OLD schema (the rollout race — expected to break; this is
#           why docs/ops/litellm-upgrade.md migrates FIRST);
#        b. the migration with NEW_IMAGE; the OLD proxy on the NEW schema (backward
#           compatibility = the pre-migration window and the image-only rollback);
#        c. the NEW proxy: state preserved?, the key Job against the existing key, the battery;
#        d. Langfuse unreachable: calls still answer, the proxy stays healthy;
#        e. which kinds of call put prompt content into the gateway's Langfuse record (leak.sh);
#   4. ROLLBACK: the dump restored, OLD_IMAGE started on it.
# Logs land in $LITELLM_TEST_WORKDIR (default ~/.cache/litellm-upgrade-test; it must be a path
# the Docker VM shares, which $TMPDIR is not under Colima). Exit code 0 only
# when every asserted check passed. No secret is involved: every credential is a test literal.
#
# Requirements: docker, helm (with `helm dependency build charts/sovereign-agentic-os` done),
# node, and os-ui/node_modules (for js-yaml).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
source "$HERE/lib.sh"
OLD=${OLD_IMAGE:-ghcr.io/berriai/litellm-database:v1.90.0}
NEW=${NEW_IMAGE:-ghcr.io/berriai/litellm-database:v1.108.12}
YAML_DIR=${JS_YAML_DIR:-$REPO/os-ui/node_modules/js-yaml}
# The committed STACKIT overlay names the standard model `openai/gpt-oss-20b`; production routes
# `openai/openai/gpt-oss-20b` (STACKIT's id carries the `openai/` itself). Test what runs.
ROUTING=${ROUTING_SUBSTITUTION-'model: openai/gpt-oss-20b=>model: openai/openai/gpt-oss-20b'}
failures=0
step() { printf '\n==================== %s\n' "$*"; }
must() { "$@" || { echo "  FAILED: $*"; failures=$((failures+1)); }; }
# A gateway that does not come up makes every later line meaningless: stop there.
up() { gw_up "$@" || { echo "ABORT — the gateway did not start ($1). Nothing after this point was tested."; infra_down; exit 1; }; }

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is not running (colima start?)"; exit 2; }
step "render the chart (STACKIT profile ${EXTRA_VALUES:-}) and derive the gateway config + key Job"
# shellcheck disable=SC2086
helm template agentic-os "$REPO/charts/sovereign-agentic-os" -n agentic-os -f "$REPO/values.stackit-managed.yaml" ${EXTRA_VALUES:-} > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; exit 2; }
node "$HERE/mkconfig.mjs" "$W/rendered.yaml" "$W/config.yaml" "$YAML_DIR" ${ROUTING:+"$ROUTING"} || exit 2
node "$HERE/mkjob.mjs" "$W/rendered.yaml" "$W/key-job.sh" "$YAML_DIR" || exit 2
grep -n 'image:.*litellm' "$W/rendered.yaml" | sort -u -k2 | sed 's/^/  chart renders /'

step "infrastructure: Postgres, Valkey, stub upstream + Langfuse sink"
infra_up

step "1/4 EMPTY database → migration with $NEW → proxy → key Job → battery"
reset_db; docker exec gwvalkey valkey-cli -a test --no-auth-warning flushall >/dev/null
migrate "$NEW" 3 | tee "$W/migrate-empty.log"; must grep -q 'migration exit: 0' "$W/migrate-empty.log"
up "$NEW" "$W/config.yaml"
keyjob "$W/key-job.sh" | tail -2
bash "$HERE/exercise.sh" "$NEW — EMPTY database" > "$W/exercise-new-empty.log" 2>&1 || failures=$((failures+1))
grep -E 'CHECK FAIL|SKIPPED|passed,' "$W/exercise-new-empty.log"

step "2/4 a database initialised and used by $OLD"
docker rm -f gw >/dev/null 2>&1; reset_db; docker exec gwvalkey valkey-cli -a test --no-auth-warning flushall >/dev/null
migrate "$OLD" 1; up "$OLD" "$W/config.yaml"
keyjob "$W/key-job.sh" | tail -1
adm -o /dev/null -X POST $B/key/generate -d '{"key":"sk-os-upg1","key_alias":"os-upg1","models":["sovereign-default","sovereign-reasoning"],"max_budget":5,"budget_duration":"7d","rpm_limit":300,"tpm_limit":1000000,"metadata":{"allowed_tools":["list_files"],"model_max_budget":{}}}'
adm -o /dev/null -X POST $B/team/new -d '{"team_alias":"domain-sales","team_id":"team-sales","max_budget":50,"budget_duration":"30d"}'
dbmodel_new; python3 -c "import time; time.sleep(3)"
for i in 1 2 3; do chat sk-os-upg1 sovereign-default "before upgrade $i" >/dev/null; done; python3 -c "import time; time.sleep(12)"
bash "$HERE/exercise.sh" "$OLD — baseline" > "$W/exercise-old.log" 2>&1; grep -E 'CHECK FAIL|SKIPPED|passed,' "$W/exercise-old.log"
bash "$HERE/state.sh" | tee "$W/state-old.log"
docker rm -f gw >/dev/null; docker exec gwpg pg_dump -U litellm -Fc litellm > "$W/pre-upgrade.dump"; echo "  pg_dump: $(wc -c < "$W/pre-upgrade.dump") bytes"

step "3a RACE — the NEW proxy on the OLD schema (not yet migrated). Expected: ready but refusing."
up "$NEW" "$W/config.yaml"; printf '  shared key chat: HTTP '; chat $AGENT_KEY sovereign-default hello; echo "  $(head -c 160 "$W/data/last.body")"
docker rm -f gw >/dev/null

step "3b migration of the OLD database with $NEW, then the OLD proxy on the NEW schema"
SECONDS=0; migrate "$NEW" 3 | tee "$W/migrate-upgrade.log"; echo "  took ${SECONDS}s"; must grep -q 'migration exit: 0' "$W/migrate-upgrade.log"
up "$OLD" "$W/config.yaml"; bash "$HERE/state.sh" | tee "$W/state-old-on-new-schema.log"
printf '  OLD proxy, NEW schema — shared key chat: HTTP '; C=$(chat $AGENT_KEY sovereign-default hello); echo "$C"; must [ "$C" = 200 ]
echo "  schema errors in the OLD proxy's log: $(docker logs gw 2>&1 | grep -c -i -E 'does not exist|prisma.errors')"

step "3c the NEW proxy on the upgraded database"
: > "$W/data/langfuse.jsonl"; up "$NEW" "$W/config.yaml"
keyjob "$W/key-job.sh" | tail -4
bash "$HERE/state.sh" | tee "$W/state-new.log"
for what in 'key os-upg1' "stored in DB: \['db-added-model'\]" 'db-added-model call -> HTTP 200' 'shared key chat: HTTP 200' 'system key chat: HTTP 200' "domain-sales"; do must grep -q "$what" "$W/state-new.log"; done
bash "$HERE/exercise.sh" "$NEW — UPGRADED database" > "$W/exercise-new-upgraded.log" 2>&1 || failures=$((failures+1))
grep -E 'CHECK FAIL|SKIPPED|passed,' "$W/exercise-new-upgraded.log"

step "3e prompt content in the gateway's Langfuse record (report)"
bash "$HERE/leak.sh" "$NEW" | tee "$W/leak-new.log"

step "3d Langfuse unreachable"
LANGFUSE_HOST_OVERRIDE=http://langfuse-is-down.invalid:3000 gw_up "$NEW" "$W/config.yaml" >/dev/null
for i in 1 2 3; do C=$(chat $AGENT_KEY sovereign-default hello); printf '  chat: HTTP %s\n' "$C"; must [ "$C" = 200 ]; done
python3 -c "import time; time.sleep(10)"
must [ "$(curl -s -o /dev/null -w '%{http_code}' $B/health/readiness)" = 200 ]
docker inspect -f '  container running={{.State.Running}} restarts={{.RestartCount}}' gw

step "4/4 ROLLBACK — restore the pre-upgrade dump, start $OLD"
docker rm -f gw >/dev/null; reset_db; docker exec -i gwpg pg_restore -U litellm -d litellm --no-owner < "$W/pre-upgrade.dump"
up "$OLD" "$W/config.yaml"; bash "$HERE/state.sh" | tee "$W/state-rollback.log"
must grep -q 'shared key chat: HTTP 200' "$W/state-rollback.log"; must grep -q 'db-added-model call -> HTTP 200' "$W/state-rollback.log"

step "clean up"
infra_down
echo
echo "logs: $W"
if [ "$failures" = 0 ]; then echo "LITELLM_UPGRADE_TEST_OK ($OLD -> $NEW)"; else echo "LITELLM_UPGRADE_TEST_FAILED — $failures failed step(s); read the logs above"; exit 1; fi
