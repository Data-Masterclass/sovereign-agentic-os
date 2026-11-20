# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The chart's ONE shell client for OpenSearch (WP-21). Every maintenance Job sources this file
# instead of building its own curl line, so the security switch (WP-22) adds credentials and the
# CA in exactly one place, as `core/adapters/opensearch/client.ts` does for os-ui.
#
#   OPENSEARCH_URL         base URL (rendered by the chart helper `soa.opensearchUrl`)
#   OPENSEARCH_USERNAME    optional basic-auth user  (unset while the security plugin is off)
#   OPENSEARCH_PASSWORD    optional basic-auth password
#   OPENSEARCH_CA_FILE     optional CA bundle for a private CA
#
# os_curl METHOD PATH [JSON_BODY]  prints the response body; the HTTP status goes to
# $OS_STATUS_FILE. A transport failure exits non-zero. Credentials are never echoed.

: "${OPENSEARCH_URL:?OPENSEARCH_URL is not set}"
OS_STATUS_FILE=${OS_STATUS_FILE:-/tmp/os-curl.status}

os_curl() {
  _m=$1; _p=$2; _b=${3-}
  set -- -sS -o /tmp/os-curl.body -w '%{http_code}' -X "$_m" -H 'Content-Type: application/json' --max-time 120
  if [ -n "${OPENSEARCH_USERNAME:-}" ]; then set -- "$@" -u "$OPENSEARCH_USERNAME:${OPENSEARCH_PASSWORD:-}"; fi
  if [ -n "${OPENSEARCH_CA_FILE:-}" ]; then set -- "$@" --cacert "$OPENSEARCH_CA_FILE"; fi
  if [ -n "$_b" ]; then set -- "$@" --data-binary "$_b"; fi
  curl "$@" "${OPENSEARCH_URL%/}$_p" > "$OS_STATUS_FILE" || return 1
  cat /tmp/os-curl.body
}

os_status() { cat "$OS_STATUS_FILE"; }

# Wait for the cluster (yellow or better). A 401/403 is said in plain words, not looped on.
os_wait_ready() {
  _tries=${1:-60}
  _i=0
  while [ "$_i" -lt "$_tries" ]; do
    if os_curl GET '/_cluster/health?wait_for_status=yellow&timeout=5s' >/dev/null 2>&1; then
      case $(os_status) in
        200) echo "OpenSearch ready."; return 0 ;;
        401|403) echo "$(os_status) from OpenSearch: credentials missing or wrong (OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD)" ;;
        *) echo "OpenSearch not ready: HTTP $(os_status)" ;;
      esac
    else
      echo "OpenSearch unreachable at ${OPENSEARCH_URL}"
    fi
    _i=$((_i + 1))
    sleep 5
  done
  echo "FATAL: OpenSearch not ready after $_tries attempts"
  return 1
}
