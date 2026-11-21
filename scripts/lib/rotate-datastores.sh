# shellcheck shell=bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotate-datastores.sh — rotation ROUND 2: the datastore credentials and the shared agent key.
# Sourced by scripts/ops/rotate-secrets.sh (its k, say, die, h16, secret_key, port_forward, call,
# check_binding … are used here). Run-book: docs/ops/WP-secret-rotation.md.
# =============================================================================
# What rotates (the ones production still has at the chart default):
#   postgres   every role of the plain engine: the bootstrap owner (postgres.secretName) and each
#              postgres.extraDatabases role — and Dagster's own copy, the dagster-postgresql Secret;
#   clickhouse the Langfuse user (clickhouse-credentials);
#   valkey     the default user (valkey-credentials);
#   minio      the root SECRET key (object-storage-credentials AWS_SECRET_ACCESS_KEY). The access
#              key is an identifier and stays: MinIO service accounts belong to the root user name;
#   litellm-master  the LiteLLM master key (litellm-credentials masterkey, litellmMasterKey) — ONLY
#              while LITELLM_SALT_KEY is set: then stored values are encrypted with the salt key and
#              virtual keys are stored as hashes, so the master key is a credential and nothing else.
#              Without a salt key it IS the encryption key: use round 1's re-key (prepare --path rekey);
#   agent-key  the shared LiteLLM virtual key (agent-litellm-key apiKey).
#
# Each component's own documented mechanism:
#   postgres   ALTER ROLE … PASSWORD '<SCRAM-SHA-256 verifier>' (computed here, so the clear password
#              never reaches the server), as the owner over pg-0's local socket. Postgres has ONE
#              password per role, so the DB change, the Secret and the readers' restart are done
#              back to back. The Postgres pod is not restarted: its POSTGRES_PASSWORD and init
#              script only act on an empty data directory.
#   clickhouse the image entrypoint writes users.d/default-user.xml from CLICKHOUSE_PASSWORD at
#              EVERY start: the Secret, then a restart of ClickHouse, then of its readers.
#   valkey     ACL SETUSER default >new ADDS the new password (both valid), the Secret, the readers
#              restart; `ds-finish` removes the old one (ACL SETUSER default <old). No restart of
#              Valkey, so its queue is kept; at its next start --requirepass reads the new Secret.
#   minio      root credentials come from MINIO_ROOT_PASSWORD at start: the Secret, a restart of
#              MinIO, then of its readers.
#   litellm-master  the Secret, then LiteLLM and its readers restart (os-ui: LITELLM_MASTER_KEY; the
#              worker holds no admin credential, scripts/check-worker-env.mjs). key-init reads it at
#              its next run. Old master → 401, new → 200; an existing virtual key keeps working.
#   agent-key  LiteLLM keeps aliases unique and /key/regenerate is Enterprise-only (1.109.1): the
#              old key's alias is renamed (/key/update, the key keeps working), the deploy's key-init
#              Job creates the new key under the alias, os-ui restarts, `ds-finish` deletes the old
#              key (/key/delete).
# =============================================================================
DS_LIB="python3 $REPO/scripts/lib/rotation-datastores.py"
DS_OLD_ALIAS_SUFFIX="-retired"

ds_values() { # the release's COMPUTED values (chart defaults + release values) → $1 (mode 600)
  helm --kube-context "$CTX" get values "$REL" -n "$NS" --all -o json > "$1"
}
ds_items() { $DS_LIB items "$1"; }   # <values.json> → TSV component secret key path role db
ds_get() { $DS_LIB get "$1" "$2"; }

# psql_as <role> <db> <password> — SQL on stdin, as <role> over TCP to pg-0's POD address: the
# pg_hba line every reader matches (`host all all all scram-sha-256`). NOT 127.0.0.1: the official
# image's initdb trusts loopback, where any password is accepted. The password goes in on stdin.
psql_as() {
  { printf '%s\n' "$3"; cat; } | k exec -i "$PG_POD" -- sh -c \
    'read -r PGPASSWORD; export PGPASSWORD; h=$(hostname -i | cut -d" " -f1); psql -h "$h" -U "$1" -d "$2" -v ON_ERROR_STOP=1 -tA -q 2>&1' _ "$1" "$2"
}
# valkey_cli <password> — commands on stdin, authenticated with <password> (on stdin, REDISCLI_AUTH).
valkey_cli() {
  { printf '%s\n' "$1"; cat; } | k exec -i deploy/valkey -- sh -c \
    'read -r REDISCLI_AUTH; export REDISCLI_AUTH; valkey-cli --no-auth-warning 2>&1'
}
# ch_query <password> <sql> — ClickHouse HTTP (port-forward running) as the Langfuse user; prints
# "<http code> <first line of the body>". The user and password go in on stdin (curl -K -).
ch_query() {
  local user; user=$(k get deploy clickhouse -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLICKHOUSE_USER")].value}')
  printf 'header = "X-ClickHouse-User: %s"\nheader = "X-ClickHouse-Key: %s"\ndata = "%s"\n' "$user" "$1" "$2" \
    | curl -sS -K - -w '\n%{http_code}' --max-time 30 "http://127.0.0.1:$PF_PORT/" 2>/dev/null \
    | { b=$(cat); printf '%s %s\n' "${b##*$'\n'}" "$(head -n1 <<<"${b%$'\n'*}")"; } || true
}
# s3_code <access key> <secret key> <path> — http code of a SigV4-signed GET (port-forward running).
s3_code() {
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:%s:s3"\n' "$1" "$2" "${S3_REGION:-us-east-1}" \
    | curl -sS -K - -o /dev/null -w '%{http_code}' --max-time 30 "http://127.0.0.1:$PF_PORT$3" || true
}
# s3_count <access key> <secret key> <bucket> — objects in the bucket (first 1000; -1 when unreadable).
s3_count() {
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:%s:s3"\n' "$1" "$2" "${S3_REGION:-us-east-1}" \
    | curl -sS -K - --max-time 60 "http://127.0.0.1:$PF_PORT/$3?list-type=2" 2>/dev/null \
    | python3 -c 'import sys,re; b=sys.stdin.read(); m=re.search(r"<KeyCount>(\d+)</KeyCount>", b); print(m.group(1) if m else -1)'
}
# write_secret_key <secret> <key> <value> — ONE key of a Secret, server-side apply (field manager
# rotate-secrets; the next helm upgrade takes the field back with the same value). Value on stdin.
write_secret_key() {
  printf '%s' "$3" | python3 -c '
import json, sys
name, ns, key = sys.argv[1:4]
print(json.dumps({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": ns}, "stringData": {key: sys.stdin.read()}}))' "$1" "$NS" "$2" \
    | k apply --server-side --field-manager=rotate-secrets --force-conflicts -f - >/dev/null
}
# restart_readers <exclude regex> <secret…> — rollout restart of every Deployment/StatefulSet that
# reads one of the Secrets (discovered, never listed), except names matching <exclude>; waits.
restart_readers() {
  local excl=$1; shift
  local rw kind1 d secs names=()
  rw=$(mktemp -d); k get deploy,statefulset,daemonset,cronjob -o json > "$rw/all.json"
  while read -r kind1 d secs; do
    [ -n "$kind1" ] || continue
    case $kind1 in CronJob) echo "   CronJob/$d reads $secs at its next run"; continue ;; esac
    if [[ "$kind1/$d" =~ $excl ]]; then echo "   not restarted: $kind1/$d (see the run-book)"; continue; fi
    names+=("$(printf %s "$kind1" | tr "[:upper:]" "[:lower:]")/$d")
  done < <(python3 "$REPO/scripts/lib/rotation-checks.py" readers "$rw/all.json" "$@")
  rm -rf "$rw"
  [ ${#names[@]} -gt 0 ] || return 0
  k rollout restart "${names[@]}" >/dev/null
  local n; for n in "${names[@]}"; do
    k rollout status "$n" --timeout=15m >/dev/null 2>&1 || die "$n did not become ready after the restart (kubectl -n $NS rollout status $n)"
    wait_old_pods_gone "$n" || die "$n: a pod of the previous revision is still running or terminating after 10 minutes"
    echo "   restarted $n (no pod of the previous revision left)"
  done
}
# wait_old_pods_gone <kind/name> — `rollout status` returns while old pods are still terminating
# (they still hold the old value). Waits until every pod of the workload is of its current
# revision and none is terminating.
wait_old_pods_gone() {
  local _i sel rev
  sel=$(k get "$1" -o json | python3 -c 'import json,sys; print(",".join(f"{k}={v}" for k, v in json.load(sys.stdin)["spec"]["selector"]["matchLabels"].items()))')
  for _i in $(seq 1 120); do
    rev=$(k get "$1" -o jsonpath='{.status.updateRevision}{.metadata.annotations.deployment\.kubernetes\.io/revision}')
    if k get pods -l "$sel" -o json | python3 -c '
import json, sys
kind = sys.argv[1].split("/")[0]; pods = json.load(sys.stdin)["items"]
if kind == "statefulset":
    want = sys.argv[2]; ok = all(p["metadata"].get("labels", {}).get("controller-revision-hash") == want and not p["metadata"].get("deletionTimestamp") for p in pods)
else:
    hashes = {p["metadata"].get("labels", {}).get("pod-template-hash") for p in pods if not p["metadata"].get("deletionTimestamp")}
    ok = len(hashes) <= 1 and not any(p["metadata"].get("deletionTimestamp") for p in pods)
sys.exit(0 if ok else 1)' "$1" "$rev"; then return 0; fi
    sleep 5
  done
  return 1
}

ds_state() { printf '%s' "${OVERLAY%.yaml}.state.json"; }
ds_rollback() { printf '%s' "${OVERLAY%.yaml}.rollback.yaml"; }
ds_comp_items() { # <component> — the TSV items of the overlay's state for that component
  python3 -c 'import json,sys; [print("\t".join(r)) for r in json.load(open(sys.argv[1]))["items"] if r[0]==sys.argv[2]]' "$(ds_state)" "$1"
}
ds_components() { python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["components"]))' "$(ds_state)"; }

# ----------------------------------------------------------------------------------------------
ds_prepare() {
  local comps=${DS_ONLY:-postgres,clickhouse,valkey,minio,litellm-master,agent-key}
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  local stamp; stamp=$(date -u +%Y%m%dT%H%M%SZ)
  OVERLAY=${OVERLAY:-$SECRETS_DIR/datastores-$stamp.yaml}
  [ ! -e "$OVERLAY" ] || die "$OVERLAY exists"
  local w; w=$(mktemp -d); chmod 700 "$w"
  ds_values "$w/values.json" || die "helm get values --all failed"
  say "the live Secrets must equal the release values (nothing hand-edited) — by sha256 prefix"
  local comp sec key path role db live want bad=0
  while IFS=$'\t' read -r comp sec key path role db; do
    [[ ",$comps," == *",$comp,"* ]] || continue
    live=$(secret_key "$sec" "$key"); want=$(ds_get "$w/values.json" "$path")
    if [ -z "$live" ]; then echo "   FAIL $sec/$key is missing"; bad=1
    elif [ "$(h16 "$live")" = "$(h16 "$want")" ]; then echo "   ok   $sec/$key = $path ($(h16 "$live")…)"
    else echo "   FAIL $sec/$key differs from $path: rotated by hand? Reconcile first."; bad=1; fi
  done < <(ds_items "$w/values.json")
  if [[ ",$comps," == *",postgres,"* ]] && k get secret dagster-postgresql >/dev/null 2>&1; then
    want=$(ds_get "$w/values.json" "postgres.extraDatabases[dagster].localPassword")
    [ "$(h16 "$(secret_key dagster-postgresql postgresql-password)")" = "$(h16 "$want")" ] \
      && echo "   ok   dagster-postgresql/postgresql-password = the dagster role's password (outside the chart: written by ds-rekey)" \
      || { echo "   FAIL dagster-postgresql/postgresql-password differs from the dagster role's password"; bad=1; }
  fi
  if [[ ",$comps," == *",litellm-master,"* ]]; then
    if [ -n "$(secret_key litellm-credentials LITELLM_SALT_KEY)" ]; then
      echo "   ok   LITELLM_SALT_KEY is set: the master key encrypts nothing and can rotate alone"
    else echo "   FAIL litellm-credentials has no LITELLM_SALT_KEY: the master key is LiteLLM's encryption key — use round 1's re-key (rotate-secrets.sh prepare), not litellm-master"; bad=1; fi
  fi
  [ "$bad" = 0 ] || { rm -rf "$w"; die "fix the differences above first; nothing was written"; }

  say "read-only checks of each component (the current credentials work)"
  ds_probe current "$w/values.json" "$comps" | tee "$w/probe.txt"
  grep -q '^   FAIL' "$w/probe.txt" && { rm -rf "$w"; die "a current credential does not work; nothing was written"; }

  say "writing the overlay, its rollback and the state (mode 600)"
  $DS_LIB build "$w/values.json" "$OVERLAY" "$comps" | sed 's/^/   new /'
  ds_items "$w/values.json" | python3 -c '
import json, os, sys
rows = [l.rstrip("\n").split("\t") for l in sys.stdin if l.strip()]
comps = sys.argv[2].split(",")
rows = [r for r in rows if r[0] in comps]
counts = {}
for l in open(sys.argv[6]):
    if l.startswith("   count "):
        k, v = l[len("   count "):].rsplit(" ", 1); counts[k] = v.strip()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"path": "datastores", "components": [c for c in comps if any(r[0] == c for r in rows)], "items": rows,
               "cluster": {"uid": sys.argv[3], "namespace": sys.argv[4], "release": sys.argv[5]}, "counts": counts}, f, indent=1)' \
    "$(ds_state)" "$comps" "$(cluster_uid)" "$NS" "$REL" "$w/probe.txt"
  rm -rf "$w"
  echo "   wrote $OVERLAY, ${OVERLAY%.yaml}.rollback.yaml and ${OVERLAY%.yaml}.state.json"
  echo "   next: scripts/ops/rotate-secrets.sh ds-plan --overlay $OVERLAY --context $CTX"
}

# ds_probe <current|new|old> <values.json|overlay> <components> — auth checks and data counts.
# "current": the release values must work (prepare). Prints ok/FAIL lines and `count <what> <n>`.
ds_probe() {
  local src=$2 comps=$3 comp sec key path role db pw out   # $1: current|new (for the reader of the call)
  local vals; vals=$(mktemp); chmod 600 "$vals"; ds_values "$vals"
  while IFS=$'\t' read -r comp sec key path role db; do
    [[ ",$comps," == *",$comp,"* ]] || continue
    pw=$(ds_get "$src" "$path")
    case $comp in
      postgres)
        out=$(printf 'SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ($$pg_catalog$$, $$information_schema$$);\n' | psql_as "$role" "$db" "$pw") \
          && { echo "   ok   postgres role $role logs in to $db"; echo "   count pg:$db:tables $out"; } \
          || echo "   FAIL postgres role $role cannot log in to $db: ${out:0:160}" ;;
      valkey)
        out=$(printf 'PING\nDBSIZE\n' | valkey_cli "$pw")
        case $out in PONG*) echo "   ok   valkey default user authenticates"; echo "   count valkey:keys $(tail -n1 <<<"$out")" ;;
                     *) echo "   FAIL valkey refuses the credential: ${out:0:120}" ;; esac ;;
      clickhouse)
        port_forward clickhouse 8123
        out=$(ch_query "$pw" "SELECT sum(rows) FROM system.parts WHERE active AND database NOT IN ('system')")
        stop_forward
        case $out in "200 "*) echo "   ok   clickhouse user authenticates"; echo "   count clickhouse:rows ${out#200 }" ;;
                     *) echo "   FAIL clickhouse refuses the credential: ${out:0:120}" ;; esac ;;
      minio)
        local ak; ak=$(secret_key "$sec" AWS_ACCESS_KEY_ID)
        port_forward minio 9000
        out=$(s3_code "$ak" "$pw" /)
        if [ "$out" = 200 ]; then
          echo "   ok   minio root credential lists the buckets"
          local b; for b in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["objectStorage"].get("buckets") or []))' "$vals"); do
            echo "   count s3:$b $(s3_count "$ak" "$pw" "$b")"
          done
        else echo "   FAIL minio refuses the credential (http $out)"; fi
        stop_forward ;;
      agent-key)
        port_forward "$LITELLM_SVC" 4000
        out=$(code_of "$(call "$pw" GET /v1/models)")
        stop_forward
        [ "$out" = 200 ] && echo "   ok   the shared agent key → /v1/models 200" || echo "   FAIL the shared agent key → /v1/models $out" ;;
      litellm-master)
        port_forward "$LITELLM_SVC" 4000
        local r1 vk; r1=$(call "$pw" GET "/key/list?page=1&size=1")
        out=$(code_of "$r1")
        if [ "$out" = 200 ]; then
          echo "   ok   the master key → /key/list 200 (admin)"
          echo "   count litellm:keys $(body_of "$r1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total_count", -1))' 2>/dev/null || echo -1)"
        else echo "   FAIL the master key → /key/list $out"; fi
        # An existing virtual key keeps working across a master-key change: the agent key in the cluster.
        vk=$(secret_key agent-litellm-key apiKey)
        if [ -n "$vk" ]; then
          out=$(code_of "$(call "$vk" GET /v1/models)")
          [ "$out" = 200 ] && echo "   ok   an existing virtual key (agent-litellm-key, sha256 $(h16 "$vk")…) → /v1/models 200" || echo "   FAIL the virtual key in agent-litellm-key → /v1/models $out"
        fi
        stop_forward ;;
    esac
  done < <(ds_items "$vals")
  rm -f "$vals"
}

# ----------------------------------------------------------------------------------------------
ds_plan() {
  [ -f "$OVERLAY" ] || die "--overlay <datastores overlay> is required"
  check_binding "$(ds_state)"
  say "rotated per component (from the state)"
  local comp sec key path role db cur new old
  while IFS=$'\t' read -r comp sec key path role db; do
    cur=$(h16 "$(secret_key "$sec" "$key")"); new=$(h16 "$(ds_get "$OVERLAY" "$path")"); old=$(h16 "$(ds_get "$(ds_rollback)" "$path")")
    if [ "$cur" = "$old" ]; then echo "   $comp: $sec/$key  ${old}… → ${new}…  (to do)"
    elif [ "$cur" = "$new" ]; then echo "   $comp: $sec/$key  already ${new}… (done)"
    else echo "   $comp: $sec/$key  is ${cur}…: neither the old nor the new value — STOP, investigate"; fi
  done < <(python3 -c 'import json,sys; [print("\t".join(r)) for r in json.load(open(sys.argv[1]))["items"]]' "$(ds_state)")
  say "readers that restart, per component (discovered from the pod specs)"
  local rw; rw=$(mktemp -d); k get deploy,statefulset,daemonset,cronjob -o json > "$rw/all.json"
  for comp in $(ds_components); do
    local secs; secs=$(ds_comp_items "$comp" | cut -f2 | sort -u | tr '\n' ' ')
    [ "$comp" = postgres ] && k get secret dagster-postgresql >/dev/null 2>&1 && secs="$secs dagster-postgresql"
    echo "   $comp ($secs):"
    # shellcheck disable=SC2086
    python3 "$REPO/scripts/lib/rotation-checks.py" readers "$rw/all.json" $secs | sed 's/^/      /'
  done
  rm -rf "$rw"
  say "the chart render with the overlay (read-only): what the deploy after ds-rekey changes"
  CHART=${CHART:-$REPO/charts/sovereign-agentic-os}
  render_diff "$OVERLAY"
  cat <<EOF
   Order (docs/ops/WP-secret-rotation.md): ds-rekey valkey → postgres → clickhouse → minio → litellm-master → agent-key,
   then deploy.sh with VALUES_OVERLAY=$OVERLAY, then ds-verify, then ds-finish.
EOF
}

# ----------------------------------------------------------------------------------------------
ds_rekey() {
  local comp=${DS_COMPONENT:-}
  [ -f "$OVERLAY" ] || die "--overlay <datastores overlay> is required"
  [ -n "$comp" ] || die "name the component: ds-rekey <postgres|clickhouse|valkey|minio|litellm-master|agent-key>"
  check_binding "$(ds_state)"
  local src=$OVERLAY; [ -z "$ROLLBACK" ] || src=$(ds_rollback)
  local from; from=$(ds_rollback); [ -z "$ROLLBACK" ] || from=$OVERLAY
  local rows; rows=$(ds_comp_items "$comp"); [ -n "$rows" ] || die "$comp is not in this overlay"
  local secs; secs=$(cut -f2 <<<"$rows" | sort -u | tr '\n' ' ')
  if [ -z "$APPLY" ]; then
    echo "   DRY RUN ($comp${ROLLBACK:+, ROLLBACK}). With --apply (the owner's approval), in order:"
    case $comp in
      postgres) echo "     1. ALTER ROLE <role> PASSWORD '<SCRAM verifier>' for: $(cut -f5 <<<"$rows" | tr '\n' ' ')(kubectl exec $PG_POD psql, local socket)"
                echo "     2. the Secrets: ${secs}$(k get secret dagster-postgresql >/dev/null 2>&1 && echo '+ dagster-postgresql') (server-side apply, one key each)"
                echo "     3. rollout restart of every reader except StatefulSet/$PG_POD%-0 (init-only), each waited for" ;;
      clickhouse) echo "     1. the Secret $secs; 2. rollout restart deploy/clickhouse (users.d is written at start); 3. its readers" ;;
      valkey) echo "     1. ACL SETUSER default >new (old AND new valid); 2. the Secret $secs; 3. the readers (not Valkey)."
              echo "     ds-finish later removes the old password." ;;
      minio) echo "     1. the Secret $secs (secret key only); 2. rollout restart deploy/minio; 3. its readers" ;;
      litellm-master) echo "     1. the Secret $secs (masterkey; LITELLM_SALT_KEY must be set); 2. rollout restart of LiteLLM and every reader (os-ui)" ;;
      agent-key) echo "     1. /key/update: the current key's alias gets the suffix $DS_OLD_ALIAS_SUFFIX (it keeps working until ds-finish);"
                 echo "     2. the Secret $secs; 3. the chart's key-init Job re-run (it creates the new key under the alias);"
                 echo "     4. the new key must be served (/v1/models 200); 5. rollout restart of its readers (os-ui, os-ui-worker)."
                 echo "     ds-finish later deletes the old key (/key/delete)." ;;
    esac
    return 0
  fi
  local sec key path role db pw
  case $comp in
    postgres)
      say "postgres: ALTER ROLE (SCRAM verifiers), then the Secrets, then the readers"
      while IFS=$'\t' read -r _ sec key path role db; do
        pw=$(ds_get "$src" "$path"); [ -n "$pw" ] || die "no value for $path"
        case $role in *[!a-z0-9_]*) die "unexpected role name '$role'" ;; esac
        local v; v=$(printf '%s' "$pw" | $DS_LIB scram)
        local r; r=$( { printf "\\\\set v '%s'\n" "$v"; printf 'ALTER ROLE "%s" PASSWORD :'"'"'v'"'"';\n' "$role"; } \
          | k exec -i "$PG_POD" -- sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tA 2>&1')
        [ "$r" = "ALTER ROLE" ] || die "ALTER ROLE $role answered: ${r:0:200}"
        echo "   role $role: password set ($(h16 "$pw")…)"
      done <<<"$rows"
      while IFS=$'\t' read -r _ sec key path _ _; do
        write_secret_key "$sec" "$key" "$(ds_get "$src" "$path")"; echo "   Secret $sec/$key written"
      done <<<"$rows"
      if k get secret dagster-postgresql >/dev/null 2>&1; then
        write_secret_key dagster-postgresql postgresql-password "$(ds_get "$src" "postgres.extraDatabases[dagster].localPassword")"
        echo "   Secret dagster-postgresql/postgresql-password written"; secs="$secs dagster-postgresql"
      fi
      # shellcheck disable=SC2086
      restart_readers "^StatefulSet/${PG_POD%-0}\$" $secs ;;
    clickhouse)
      say "clickhouse: the Secret, ClickHouse, its readers"
      while IFS=$'\t' read -r _ sec key path _ _; do write_secret_key "$sec" "$key" "$(ds_get "$src" "$path")"; echo "   Secret $sec/$key written"; done <<<"$rows"
      k rollout restart deploy/clickhouse >/dev/null && k rollout status deploy/clickhouse --timeout=15m >/dev/null && wait_old_pods_gone deploy/clickhouse || die "clickhouse did not come back"
      echo "   restarted deployment/clickhouse"
      # shellcheck disable=SC2086
      restart_readers '^Deployment/clickhouse$' $secs ;;
    valkey)
      say "valkey: add the new password (both valid), the Secret, the readers"
      while IFS=$'\t' read -r _ sec key path _ _; do
        local cur; cur=$(ds_get "$from" "$path"); pw=$(ds_get "$src" "$path")
        local r; r=$(printf 'ACL SETUSER default >%s\n' "$pw" | valkey_cli "$cur")
        [ "$r" = OK ] || die "ACL SETUSER answered: ${r:0:120}"
        echo "   valkey default user: new password added ($(h16 "$pw")…); the old one stays valid until ds-finish"
        write_secret_key "$sec" "$key" "$pw"; echo "   Secret $sec/$key written"
      done <<<"$rows"
      # shellcheck disable=SC2086
      restart_readers '^Deployment/valkey$' $secs ;;
    minio)
      say "minio: the Secret, MinIO, its readers"
      while IFS=$'\t' read -r _ sec key path _ _; do write_secret_key "$sec" "$key" "$(ds_get "$src" "$path")"; echo "   Secret $sec/$key written"; done <<<"$rows"
      k rollout restart deploy/minio >/dev/null && k rollout status deploy/minio --timeout=15m >/dev/null && wait_old_pods_gone deploy/minio || die "minio did not come back"
      echo "   restarted deployment/minio"
      # shellcheck disable=SC2086
      restart_readers '^Deployment/minio$' $secs ;;
    litellm-master)
      [ -n "$(secret_key litellm-credentials LITELLM_SALT_KEY)" ] || die "no LITELLM_SALT_KEY in litellm-credentials: the master key is the encryption key — use round 1's re-key"
      say "litellm-master: the Secret, then LiteLLM and its readers"
      while IFS=$'\t' read -r _ sec key path _ _; do write_secret_key "$sec" "$key" "$(ds_get "$src" "$path")"; echo "   Secret $sec/$key written ($(h16 "$(ds_get "$src" "$path")")…)"; done <<<"$rows"
      # shellcheck disable=SC2086
      restart_readers '^$' $secs ;;
    agent-key)
      # The chart's key-init Job creates the key: it is re-run HERE, after the Secret holds the new
      # value. Left to the deploy, the Job pod can start before Helm has updated the Secret, read
      # the OLD key and reconcile that one (seen in the rehearsal) — the new key is then never made.
      local mk keep give alias body c rv suf=$DS_OLD_ALIAS_SUFFIX
      [ -z "$ROLLBACK" ] || suf=-rolledback
      mk=$(secret_key litellm-credentials masterkey)
      keep=$(ds_get "$src" litellmAgentKey.local.value); give=$(ds_get "$from" litellmAgentKey.local.value)
      alias=$(helm --kube-context "$CTX" get values "$REL" -n "$NS" --all -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["litellmAgentKey"]["alias"])')
      say "agent-key${ROLLBACK:+ (ROLLBACK)}: the key going out gives up the alias (it keeps working until ds-finish)"
      port_forward "$LITELLM_SVC" 4000
      body=$(pairs key "$give" key_alias "$alias$suf" | pairs_json)
      c=$(code_of "$(call "$mk" POST /key/update "$body")")
      [ "$c" = 200 ] || { stop_forward; die "/key/update (alias) of the key going out → $c"; }
      if [ -n "$ROLLBACK" ]; then   # the previous key exists still (before ds-finish): it takes the alias back
        body=$(pairs key "$keep" key_alias "$alias" | pairs_json)
        c=$(code_of "$(call "$mk" POST /key/update "$body")"); [ "$c" = 200 ] || { stop_forward; die "/key/update (alias back) → $c (deleted by ds-finish already?)"; }
      fi
      stop_forward
      echo "   the key going out is now '$alias$suf'"
      while IFS=$'\t' read -r _ sec key path _ _; do write_secret_key "$sec" "$key" "$keep"; echo "   Secret $sec/$key written ($(h16 "$keep")…)"; done <<<"$rows"
      if [ -z "$ROLLBACK" ]; then
        say "agent-key: the chart's key-init Job, re-run from the release manifest"
        local jf; jf=$(mktemp)
        helm --kube-context "$CTX" get manifest "$REL" -n "$NS" | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if isinstance(d, dict) and d.get("kind") == "Job" and d["metadata"]["name"] == "litellm-agent-key-init":
        print(yaml.safe_dump(d)); break
else: sys.exit("the release has no Job litellm-agent-key-init")' > "$jf" || die "no key-init Job in the release manifest"
        k delete job litellm-agent-key-init --ignore-not-found --wait=true >/dev/null
        k apply --server-side --field-manager=rotate-secrets --force-conflicts -f "$jf" >/dev/null; rm -f "$jf"
        k wait --for=condition=complete job/litellm-agent-key-init --timeout=10m >/dev/null || die "key-init did not complete (kubectl -n $NS logs job/litellm-agent-key-init)"
        rv=$(k logs job/litellm-agent-key-init 2>/dev/null | grep -E '^virtual key (created|reconciled)$' | tail -n1)
        [ -n "$rv" ] || die "key-init completed without creating the key (its log has no 'virtual key created')"
        echo "   key-init: $rv"
      fi
      port_forward "$LITELLM_SVC" 4000
      c=$(code_of "$(call "$keep" GET /v1/models)"); stop_forward
      [ "$c" = 200 ] || die "the key now in the Secret → /v1/models $c"
      echo "   the key in the Secret is served (/v1/models 200)"
      # shellcheck disable=SC2086
      restart_readers '^$' $secs ;;
    *) die "unknown component $comp" ;;
  esac
  echo "   next: the next component, or deploy.sh with VALUES_OVERLAY=$OVERLAY once all are done"
}

# ----------------------------------------------------------------------------------------------
ds_verify() {
  [ -f "$OVERLAY" ] || die "--overlay <datastores overlay> is required"
  check_binding "$(ds_state)"
  local n_fail=0 comps; comps=$(ds_components | tr ' ' ',')
  [ -z "${DS_COMPONENT:-}" ] || comps=$DS_COMPONENT
  pass() { echo "   ok   $*"; }; fail() { echo "   FAIL $*"; n_fail=$((n_fail+1)); }
  say "the Secrets hold the new values (sha256 prefixes)"
  local comp sec key path role db pw
  while IFS=$'\t' read -r comp sec key path role db; do
    [[ ",$comps," == *",$comp,"* ]] || continue
    [ "$(h16 "$(secret_key "$sec" "$key")")" = "$(h16 "$(ds_get "$OVERLAY" "$path")")" ] && pass "$sec/$key = new" || fail "$sec/$key is not the new value"
  done < <(python3 -c 'import json,sys; [print("\t".join(r)) for r in json.load(open(sys.argv[1]))["items"]]' "$(ds_state)")
  say "new credentials accepted, data still there"
  local out pf; pf=$(mktemp); ds_probe new "$OVERLAY" "$comps" > "$pf"; out=$(cat "$pf"); grep -v '^   count' "$pf"
  grep -q '^   FAIL' <<<"$out" && n_fail=$((n_fail+1))
  python3 - "$(ds_state)" "$pf" <<'PY' || n_fail=$((n_fail+1))
import json, sys
before = json.load(open(sys.argv[1])).get("counts", {})
bad = 0
for l in open(sys.argv[2]):
    if not l.startswith("   count "): continue
    k, v = l[len("   count "):].rsplit(" ", 1); v = v.strip()
    b = before.get(k)
    if b is None: print(f"   note {k}: {v} (no count before)"); continue
    if k == "valkey:keys":   # a cache and a queue: it changes on its own
        print(f"   ok   {k}: {b} before, {v} now (a live cache: compared loosely)"); continue
    if int(v) >= int(b): print(f"   ok   {k}: {b} before, {v} now")
    else: print(f"   FAIL {k}: {b} before, {v} now"); bad = 1
sys.exit(bad)
PY
  rm -f "$pf"
  if [[ ",$comps," == *",litellm-master,"* ]] && k get deploy os-ui >/dev/null 2>&1; then
    say "os-ui's own master key (exec: the admin reads it makes, with the key it holds) — and the worker holds none"
    out=$(k exec deploy/os-ui -c os-ui -- node -e '
const u = process.env.LITELLM_URL, h = { Authorization: "Bearer " + process.env.LITELLM_MASTER_KEY };
Promise.all(["/v1/models", "/key/list?page=1&size=1"].map(p => fetch(u + p, { headers: h }).then(r => p + "=" + r.status, e => p + "=ERR")))
  .then(x => console.log(x.join(" ")));' 2>&1 || true)
    case $out in *"/key/list?page=1&size=1=200"*) pass "os-ui → LiteLLM admin with its LITELLM_MASTER_KEY: $out" ;; *) fail "os-ui → LiteLLM admin: ${out:0:200}" ;; esac
    if k get deploy os-ui-worker >/dev/null 2>&1; then
      if k get deploy os-ui-worker -o json | python3 -c 'import json,sys; t=json.dumps(json.load(sys.stdin)["spec"]["template"]); sys.exit(0 if ("LITELLM_MASTER_KEY" in t or "litellm-credentials" in t) else 1)'
      then fail "os-ui-worker reads the master key (it must hold no admin credential)"
      else pass "os-ui-worker holds no master key (no LITELLM_MASTER_KEY, no litellm-credentials): nothing to restart for it"; fi
    fi
  fi
  say "old credentials refused"
  local old
  while IFS=$'\t' read -r comp sec key path role db; do
    [[ ",$comps," == *",$comp,"* ]] || continue
    old=$(ds_get "$(ds_rollback)" "$path")
    case $comp in
      postgres) printf 'SELECT 1;\n' | psql_as "$role" "$db" "$old" >/dev/null 2>&1 && fail "postgres role $role still accepts the old password" || pass "postgres role $role refuses the old password" ;;
      clickhouse) port_forward clickhouse 8123; out=$(ch_query "$old" "SELECT 1"); stop_forward
                  case $out in "200 "*) fail "clickhouse still accepts the old password" ;; *) pass "clickhouse refuses the old password (${out%% *})" ;; esac ;;
      valkey) out=$(printf 'PING\n' | valkey_cli "$old")
              case $out in PONG*) if [ -n "${DS_FINISHED:-}" ]; then fail "valkey still accepts the old password"; else echo "   note valkey still accepts the old password (expected until ds-finish)"; fi ;;
                           *) pass "valkey refuses the old password" ;; esac ;;
      minio) port_forward minio 9000; out=$(s3_code "$(secret_key "$sec" AWS_ACCESS_KEY_ID)" "$old" /); stop_forward
             [ "$out" = 403 ] && pass "minio refuses the old secret key (403)" || fail "minio with the old secret key → $out (want 403)" ;;
      litellm-master) port_forward "$LITELLM_SVC" 4000; out=$(code_of "$(call "$old" GET "/key/list?page=1&size=1")"); stop_forward
                 [ "$out" = 401 ] && pass "the old master key is refused (401)" || fail "the old master key → $out (want 401)" ;;
      agent-key) port_forward "$LITELLM_SVC" 4000; out=$(code_of "$(call "$old" GET /v1/models)"); stop_forward
                 case $out in 401|400|403) pass "the old agent key is refused ($out)" ;;
                   200) if [ -n "${DS_FINISHED:-}" ]; then fail "the old agent key still works"; else echo "   note the old agent key still works (expected until ds-finish)"; fi ;;
                   *) fail "the old agent key → $out" ;; esac ;;
    esac
  done < <(python3 -c 'import json,sys; [print("\t".join(r)) for r in json.load(open(sys.argv[1]))["items"]]' "$(ds_state)")
  say "every reader serves from pods started after its Secrets changed"
  local secs="" c; for c in ${comps//,/ }; do secs="$secs $(ds_comp_items "$c" | cut -f2 | sort -u | tr '\n' ' ')"; done
  [[ ",$comps," == *",postgres,"* ]] && k get secret dagster-postgresql >/dev/null 2>&1 && secs="$secs dagster-postgresql"
  local rw kind1 d rsecs since sel line rc found=0
  rw=$(mktemp -d); k get deploy,statefulset,daemonset,cronjob -o json > "$rw/all.json"
  while read -r kind1 d rsecs; do
    [ -n "$kind1" ] || continue; found=$((found+1))
    case "$kind1/$d" in
      CronJob/*) pass "CronJob/$d reads $rsecs at each run"; continue ;;
      "StatefulSet/${PG_POD%-0}") pass "StatefulSet/$d: POSTGRES_PASSWORD and the init script act only on an empty data directory (not restarted by design)"; continue ;;
      Deployment/valkey) pass "Deployment/valkey: the password was changed live (ACL); at its next start it reads the new Secret"; continue ;;
    esac
    python3 "$REPO/scripts/lib/rotation-checks.py" item "$rw/all.json" "$kind1" "$d" > "$rw/dep.json"
    local sf=() s1; for s1 in ${rsecs//,/ }; do k get secret "$s1" -o json > "$rw/sec-$s1.json" 2>/dev/null || : > "$rw/sec-$s1.json"; sf+=("$rw/sec-$s1.json"); done
    since=$(python3 "$REPO/scripts/lib/rotation-checks.py" changed-at "${sf[@]}") || { fail "$kind1/$d: a Secret it reads is missing ($rsecs)"; continue; }
    sel=$(python3 -c 'import json,sys; print(",".join(f"{k}={v}" for k, v in json.load(open(sys.argv[1]))["spec"]["selector"]["matchLabels"].items()))' "$rw/dep.json")
    : > "$rw/rs.json"; [ "$kind1" = Deployment ] && k get rs -l "$sel" -o json > "$rw/rs.json"
    k get pods -l "$sel" -o json > "$rw/pods.json"
    rc=0; line=$(python3 "$REPO/scripts/lib/readers-restarted.py" "$rw/dep.json" "$rw/rs.json" "$rw/pods.json" "$since") || rc=$?
    case $rc in 0) pass "$line (reads: $rsecs)" ;; 2) echo "   skip $line" ;; *) fail "$kind1/$d: $line" ;; esac
  done < <(python3 "$REPO/scripts/lib/rotation-checks.py" readers "$rw/all.json" $secs)
  [ "$found" -gt 0 ] || fail "no workload reads a rotated Secret: the discovery found nothing"
  k get pods,jobs -A -o json > "$rw/pj.json" 2>/dev/null || k get pods,jobs -o json > "$rw/pj.json"
  local un st l
  # shellcheck disable=SC2086
  un=$(python3 "$REPO/scripts/lib/rotation-checks.py" unowned "$rw/pj.json" "$NS" $secs)
  while read -r st l; do [ -n "$st" ] || continue
    [ "$st" = live ] && fail "$l reads a rotated Secret and is still running" || echo "   note finished unowned $l"
  done <<<"$un"
  rm -rf "$rw"
  if [ "$n_fail" -gt 0 ]; then echo "DS_VERIFY_FAILED — $n_fail check(s) failed"; return 1; fi
  echo "DS_VERIFY_OK"
}

# ----------------------------------------------------------------------------------------------
ds_finish() {
  [ -f "$OVERLAY" ] || die "--overlay <datastores overlay> is required"
  check_binding "$(ds_state)"
  local comps; comps=",$(ds_components | tr ' ' ','),"
  if [ -z "$APPLY" ]; then
    echo "   DRY RUN. With --apply: valkey — ACL SETUSER default <old (the old password goes);"
    echo "   agent-key — /key/delete of the old key (only after the new one is served: ds-verify first)."
    return 0
  fi
  if [[ "$comps" == *",valkey,"* ]]; then
    local path new old r; path=valkey.local.password; new=$(ds_get "$OVERLAY" "$path"); old=$(ds_get "$(ds_rollback)" "$path")
    r=$(printf 'ACL SETUSER default <%s\n' "$old" | valkey_cli "$new"); [ "$r" = OK ] || die "ACL SETUSER (remove the old password) answered: ${r:0:120}"
    echo "   valkey: the old password is removed"
  fi
  if [[ "$comps" == *",agent-key,"* ]]; then
    local mk new old c body
    mk=$(secret_key litellm-credentials masterkey); new=$(ds_get "$OVERLAY" litellmAgentKey.local.value); old=$(ds_get "$(ds_rollback)" litellmAgentKey.local.value)
    port_forward "$LITELLM_SVC" 4000
    c=$(code_of "$(call "$new" GET /v1/models)"); [ "$c" = 200 ] || { stop_forward; die "the NEW agent key is not served yet (/v1/models → $c): deploy the overlay and run ds-verify first"; }
    body=$(printf '%s' "$old" | python3 -c 'import json,sys; print(json.dumps({"keys": [sys.stdin.read().strip()]}))')
    c=$(code_of "$(call "$mk" POST /key/delete "$body")")
    stop_forward
    [ "$c" = 200 ] || die "/key/delete of the old key → $c"
    echo "   agent-key: the old key is deleted"
  fi
  echo "   next: DS_FINISHED=1 scripts/ops/rotate-secrets.sh ds-verify --overlay $OVERLAY (old credentials must now ALL be refused)"
}
