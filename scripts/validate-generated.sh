#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AREA:       repo tooling — CI rule GLUE-6 (00 §8.3 rule 6)
# FEATURE:    Generated config is validated by the component's OWN tool, in containers pinned to
#             the images production runs: `dbt parse` on every golden generated dbt project,
#             `dagster definitions validate` on the `sovereign` code location loading them,
#             `opa check --strict` + `opa test` on the policies the chart renders, and
#             `helm template | kubeconform` on both chart profiles.
# USER STORY: As the owner I want a generator change that emits something dbt, Dagster, OPA or
#             Kubernetes would refuse to fail CI — decided by dbt, Dagster, OPA and the Kubernetes
#             schemas themselves, never by a hand-written imitation of their rules.
# ARCHITECTURE:
#   - Versions: dbt/Dagster = the chart's `sovereign` user-deployment image (built here from
#     images/extensions/dagster, exactly as build-images.yml builds it); OPA = the chart's
#     opa.image (repository:tag@digest); kubeconform = scripts/glue/validators.json, the one place
#     a validator version lives that the chart does not pin. Nothing is pinned in this file.
#   - dbt parse runs through `os_projects.py --parse`, the production path repo-sync.sh uses (same
#     allowlisted environment), with `--network none`: parse needs no warehouse.
#   - Dagster's loader skips a broken domain and logs it (per-domain gating), so a zero exit from
#     `definitions validate` alone would pass a project Dagster refused. The step therefore also
#     FAILS on any "skipped"/"failed to load" line and asserts every domain produced assets.
#   - `--fixtures <dir>` ADDS inputs to the real ones: `<dir>/dbt/*.json` (golden-shaped project
#     maps), `<dir>/opa/*.rego`, `<dir>/k8s/*.yaml`. This is how the negative twins prove each step
#     really runs (scripts/tests/validate-generated.test.sh).
#   - No silent skip: a missing docker/helm/node FAILS. `GLUE6_ALLOW_SKIP=1` (local only) turns that
#     into a loud SKIP that says nothing was validated.
#   - Ratchet: `knownRefusals.dbt-parse` in scripts/glue/validators.json lists golden fixtures dbt
#     refuses TODAY (each with its reason). They print KNOWN-FAIL and do not fail; one that starts
#     to parse FAILS until it is removed from the list, so the list can only shrink.
#   - dbt compile (C1) runs after every successful parse, in the same image, against the chart's
#     Trino image with an empty in-memory `iceberg` catalog on a private docker network.
#   - `--only <dbt|dagster|opa|kubeconform>` (repeatable) runs a subset; dagster implies dbt.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
LIB="node scripts/glue/validate-generated-lib.mjs"

SKIP_BUILD=0; FIXTURES=""; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --fixtures) FIXTURES="$(cd "$2" && pwd)"; shift ;;
    --only) ONLY="$ONLY $2"; shift ;;
    *) echo "usage: $0 [--skip-build] [--fixtures <dir>] [--only dbt|dagster|opa|kubeconform]…" >&2; exit 2 ;;
  esac
  shift
done
is_known() { [[ " ${KNOWN_DBT_REFUSALS:-} " == *" $1 "* ]]; }
want() { [ -z "$ONLY" ] || [[ " $ONLY " == *" $1 "* ]] || { [ "$1" = dbt ] && [[ " $ONLY " == *" dagster "* ]]; }; }

FAILED=0
ok()   { echo "GLUE-6 $1: ok${2:+ — $2}"; }
fail() { echo "GLUE-6 $1: FAIL $2"; FAILED=1; }
need() {  # need <step> <binary>
  command -v "$2" >/dev/null 2>&1 && return 0
  if [ "${GLUE6_ALLOW_SKIP:-}" = 1 ] && [ -z "${CI:-}" ]; then
    echo "GLUE-6 $1: SKIP — '$2' not installed. NOTHING WAS VALIDATED for this step (GLUE6_ALLOW_SKIP=1)."
  else
    fail "$1" "'$2' is not installed — the validator cannot run (set GLUE6_ALLOW_SKIP=1 locally to skip loudly)"
  fi
  return 1
}

need images node || exit 1
eval "$($LIB images)" || { echo "GLUE-6 images: FAIL could not read pinned images" ; exit 1; }
echo "GLUE-6 images: dagster=$DAGSTER_IMAGE trino=$TRINO_IMAGE opa=$OPA_IMAGE kubeconform=$KUBECONFORM_IMAGE (k8s $KUBERNETES_VERSION)"

# Under $HOME, not $TMPDIR: a VM-backed docker (colima, Docker Desktop) shares the home directory
# with the VM but not macOS's /var/folders temp dir, and a bind mount of an unshared path is
# silently EMPTY. On a Linux CI runner both work.
mkdir -p "${GLUE6_TMP:-$HOME/.cache/glue6}"
WORK="$(mktemp -d "${GLUE6_TMP:-$HOME/.cache/glue6}/run.XXXXXX")"
NET="glue6-$$"; TRINO_CTR="glue6-trino-$$"
trap 'docker rm -f "$TRINO_CTR" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
# A container writing target/ into a bind mount runs as the image user; keep the tree writable.
chmod 0777 "$WORK"

# ---------------------------------------------------------------- 1. dbt parse ----------------
CHECKOUT="$WORK/repos-checkout"
if want dbt && need dbt-parse docker; then
  if [ "$SKIP_BUILD" = 1 ]; then
    docker image inspect "$DAGSTER_IMAGE" >/dev/null 2>&1 \
      || fail dbt-parse "--skip-build given but $DAGSTER_IMAGE is not present locally"
  else
    # Same Dockerfile + context as .github/workflows/build-images.yml (`dagster` image).
    docker build -q -f images/extensions/dagster/Dockerfile -t "$DAGSTER_IMAGE" images/extensions >/dev/null \
      || fail dbt-parse "docker build of $DAGSTER_IMAGE failed"
  fi
  fixtures=(os-ui/tabs/data/lib/dbt/fixtures/*.golden.json)
  [ -n "$FIXTURES" ] && [ -d "$FIXTURES/dbt" ] && fixtures+=("$FIXTURES"/dbt/*.json)
  if docker image inspect "$DAGSTER_IMAGE" >/dev/null 2>&1; then
    mkdir -p "$CHECKOUT" && chmod 0777 "$CHECKOUT"
    $LIB materialise "$CHECKOUT" "${fixtures[@]}" > "$WORK/domains.txt" || fail dbt-parse "could not write the fixtures out"
    chmod -R a+rwX "$CHECKOUT"
    # `dbt compile` (C1) needs a warehouse for what dbt asks at compile time (is_incremental()
    # looks the relation up). It gets the chart's OWN Trino image with an empty in-memory catalog
    # named like the profile's (`iceberg`), on a private network: never a mock, never the cluster.
    trino_ready=0
    printf 'connector.name=memory\n' > "$WORK/iceberg.properties"; chmod a+r "$WORK/iceberg.properties"
    if docker network create "$NET" >/dev/null 2>&1 && docker run -d --name "$TRINO_CTR" --network "$NET" --network-alias trino \
         -v "$WORK/iceberg.properties:/etc/trino/catalog/iceberg.properties:ro" "$TRINO_IMAGE" >/dev/null 2>&1; then
      for _ in $(seq 1 90); do
        docker exec "$TRINO_CTR" trino --execute 'SELECT 1' >/dev/null 2>&1 && { trino_ready=1; break; }
        sleep 2
      done
    fi
    [ $trino_ready = 1 ] || fail dbt-compile "the chart's Trino image ($TRINO_IMAGE) did not start for dbt compile"
    while read -r domain sha; do
      out="$(docker run --rm --network none -v "$CHECKOUT:/repos-checkout" -w /opt/dagster/app "$DAGSTER_IMAGE" \
        python os_projects.py --parse "/repos-checkout/$domain/$sha" 2>&1)"
      rc=$?   # captured IMMEDIATELY: dbt's own exit code decides, together with the manifest it writes
      parsed=0; { [ $rc -eq 0 ] && [ -f "$CHECKOUT/$domain/$sha/target/manifest.json" ]; } && parsed=1
      if is_known "$domain"; then
        match="$($LIB known-match "$domain")" || { fail dbt-parse "$domain: knownRefusals entry has no match text"; continue; }
        if [ $parsed = 1 ]; then
          fail dbt-parse "$domain now parses — remove it from knownRefusals.dbt-parse in scripts/glue/validators.json (ratchet)"
        elif ! grep -qF -- "$match" <<<"$out"; then
          fail dbt-parse "$domain is refused for a DIFFERENT reason than the recorded one ($match):"
          printf '%s\n' "$out" | grep -v 'keyring module not found' | tail -10 | sed 's/^/    /'
        else
          echo "GLUE-6 dbt-parse: KNOWN-FAIL $domain (baselined in scripts/glue/validators.json knownRefusals; still refused with: $match)"
        fi
      elif [ $parsed = 1 ]; then
        ok dbt-parse "$domain"
        # C1: `dbt compile` renders every model's SQL, in the same image, with the project's own
        # profiles.yml pointed at the throwaway Trino above.
        if [ $trino_ready = 1 ]; then
          cout="$(docker run --rm --network "$NET" -v "$CHECKOUT:/repos-checkout" -e HOME=/tmp -e OS_PRINCIPAL=glue6-ci \
            -e TRINO_HOST=trino -w "/repos-checkout/$domain/$sha" "$DAGSTER_IMAGE" dbt compile --profiles-dir . 2>&1)"
          crc=$?
        else cout="Trino not available"; crc=99; fi
        if [ $crc -eq 0 ] && [ -d "$CHECKOUT/$domain/$sha/target/compiled" ]; then
          ok dbt-compile "$domain ($(find "$CHECKOUT/$domain/$sha/target/compiled" -name '*.sql' | wc -l | tr -d ' ') compiled files)"
        else
          fail dbt-compile "$domain: dbt compile exited $crc"
          printf '%s\n' "$cout" | grep -v 'keyring module not found' | tail -12 | sed 's/^/    /'
        fi
      else
        summary="$(printf '%s' "$out" | docker run --rm -i --network none -w /opt/dagster/app "$DAGSTER_IMAGE" python os_projects.py --error-summary 2>/dev/null)"
        fail dbt-parse "$domain: ${summary:-dbt parse exited non-zero}"
        printf '%s\n' "$out" | grep -v 'keyring module not found' | tail -15 | sed 's/^/    /'
      fi
    done < "$WORK/domains.txt"
  fi
fi

# ------------------------------------------------------ 2. dagster definitions validate -------
if want dagster && [ -s "$WORK/domains.txt" ] && docker image inspect "$DAGSTER_IMAGE" >/dev/null 2>&1; then
  # Every domain is loaded, including one whose parse failed above: Dagster must refuse it too.
  out="$(docker run --rm --network none -v "$CHECKOUT:/repos-checkout:ro" -w /opt/dagster/app \
    -e REPO_SYNC_CHECKOUT=/repos-checkout "$DAGSTER_IMAGE" \
    dagster definitions validate -f /opt/dagster/app/repo.py 2>&1)"
  code=$?
  # Assets per domain, read from the SAME Definitions object (asset keys are [<domain>, <node>]).
  assets="$(docker run --rm --network none -v "$CHECKOUT:/repos-checkout:ro" -w /opt/dagster/app \
    -e REPO_SYNC_CHECKOUT=/repos-checkout "$DAGSTER_IMAGE" python -c '
import collections, logging, repo
logging.disable(logging.CRITICAL)
c = collections.Counter(k.path[0] for k in repo.defs.resolve_all_asset_keys() if len(k.path) > 1)
print("\n".join(f"{d} {n}" for d, n in sorted(c.items())))' 2>"$WORK/assets.err")"
  refused="$(printf '%s\n' "$out" | grep -E 'skipped —|failed to load' || true)"
  # A baselined dbt refusal is necessarily skipped by Dagster too; every OTHER refusal fails.
  for k in $KNOWN_DBT_REFUSALS; do refused="$(printf '%s\n' "$refused" | grep -v "domain $k skipped" || true)"; done
  refused="$(printf '%s\n' "$refused" | sed '/^$/d')"
  if [ $code -ne 0 ]; then
    fail dagster-definitions-validate "exit $code"; printf '%s\n' "$out" | tail -15 | sed 's/^/    /'
  elif [ -n "$refused" ]; then
    fail dagster-definitions-validate "the code location loaded but refused a domain:"; printf '%s\n' "$refused" | sed 's/^/    /'
  else
    missing=""
    while read -r domain _; do is_known "$domain" || grep -q "^$domain [1-9]" <<<"$assets" || missing="$missing $domain"; done < "$WORK/domains.txt"
    if [ -n "$missing" ]; then
      fail dagster-definitions-validate "no assets loaded for:$missing"; { printf '%s\n' "$assets"; tail -10 "$WORK/assets.err"; } | sed 's/^/    /'
    else
      ok dagster-definitions-validate "assets per domain: $(tr '\n' ',' <<<"$assets" | sed 's/,$//; s/,/, /g')"
    fi
  fi
fi

# ---------------------------------------------------------------- 3. OPA -----------------------
if want opa && need opa-check helm && need opa-check docker; then
  POL="$WORK/opa"; mkdir -p "$POL/rendered" "$POL/extra"
  if helm template sov charts/sovereign-agentic-os 2>"$WORK/helm-opa.err" | $LIB opa-extract "$POL/rendered" >/dev/null; then
    # Every chart policy and its tests, EXCEPT a file the chart also renders into the ConfigMap:
    # the rendered copy is what OPA runs, so it wins over the source (no duplicate package).
    cp -R charts/sovereign-agentic-os/policies/. "$POL/extra/"
    for r in "$POL"/rendered/*; do find "$POL/extra" -name "$(basename "$r")" -delete; done
    [ -d tests/policies ] && cp tests/policies/*.rego "$POL/extra/" 2>/dev/null
    [ -n "$FIXTURES" ] && [ -d "$FIXTURES/opa" ] && cp "$FIXTURES"/opa/*.rego "$POL/extra/" 2>/dev/null
    files=(); while IFS= read -r f; do files+=("/p/${f#"$POL"/}"); done < <(find "$POL/rendered" "$POL/extra" -type f \( -name '*.rego' -o -name '*.json' \) | sort)
    out="$(docker run --rm --network none -v "$POL:/p:ro" "$OPA_IMAGE" check --strict "${files[@]}" 2>&1)" \
      && ok opa-check "${#files[@]} files (rendered ConfigMap opa-policy + charts/sovereign-agentic-os/policies)" \
      || { fail opa-check "opa check --strict refused the policies:"; printf '%s\n' "$out" | head -20 | sed 's/^/    /'; }
    out="$(docker run --rm --network none -v "$POL:/p:ro" "$OPA_IMAGE" test "${files[@]}" 2>&1)" \
      && ok opa-test "$(printf '%s\n' "$out" | grep -E '^PASS' | tail -1)" \
      || { fail opa-test "opa test failed:"; printf '%s\n' "$out" | grep -vE '^(PASS|-+$)' | head -20 | sed 's/^/    /'; }
  else
    fail opa-check "helm template could not render the chart: $(tail -3 "$WORK/helm-opa.err")"
  fi
fi

# ---------------------------------------------------------------- 4. kubeconform ---------------
if want kubeconform && need kubeconform helm && need kubeconform docker; then
  for profile in default stackit; do
    args=(template sov charts/sovereign-agentic-os)
    [ "$profile" = stackit ] && args+=(-f values.stackit-managed.yaml)
    if ! helm "${args[@]}" > "$WORK/render-$profile.yaml" 2>"$WORK/helm-$profile.err"; then
      fail "kubeconform[$profile]" "helm template failed: $(tail -3 "$WORK/helm-$profile.err")"; continue
    fi
    if [ -n "$FIXTURES" ] && [ -d "$FIXTURES/k8s" ]; then
      for m in "$FIXTURES"/k8s/*.yaml; do printf '\n---\n' >> "$WORK/render-$profile.yaml"; cat "$m" >> "$WORK/render-$profile.yaml"; done
    fi
    # -ignore-missing-schemas: CRD-backed kinds (e.g. a CNPG Cluster, ServiceMonitor) have no schema
    # in the Kubernetes set and would otherwise fail as "could not find schema". Every built-in kind
    # (Deployment, Service, NetworkPolicy, …) is still validated strictly. The summary line names
    # how many were skipped.
    out="$(docker run --rm -i "$KUBECONFORM_IMAGE" -strict -summary -output text \
      -kubernetes-version "$KUBERNETES_VERSION" -ignore-missing-schemas - < "$WORK/render-$profile.yaml" 2>&1)"
    if [ $? -eq 0 ]; then
      ok "kubeconform[$profile]" "$(printf '%s\n' "$out" | tail -1)"
    else
      fail "kubeconform[$profile]" "kubeconform refused the rendered manifests:"
      printf '%s\n' "$out" | grep -v ' is valid' | head -20 | sed 's/^/    /'
    fi
  done
fi

if [ $FAILED -ne 0 ]; then echo "GLUE-6: FAIL — a component's own validator refused generated config"; exit 1; fi
echo "GLUE-6: ok — every generated artefact passed its component's own validator"
