#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Register the off-cluster S3 snapshot repository, prove it works, and apply the Snapshot
# Management policy (WP-21, design 02 step 3). Run by the `register-opensearch-s3-repo` Job on
# every install/upgrade, and by `tests/opensearch` against the real image. Idempotent.
#
#   1. PUT  _snapshot/$OS_S3_REPO          body: $OS_S3_REPO_BODY_FILE  (type s3, bucket, base_path)
#   2. POST _snapshot/$OS_S3_REPO/_verify  — every node writes and reads a test blob through the
#                                            s3 client (endpoint and egress proxy from opensearch.yml,
#                                            keys from the keystore). Failure = Job failure.
#   3. SM policy $OS_SM_POLICY_NAME        body: $OS_SM_POLICY_FILE — created, or updated in place
#                                            with if_seq_no/if_primary_term when it already exists.
#
# Upstream: snapshot-restore and sm-api pages of https://docs.opensearch.org/3.7/
set -eu
. "${OS_LIB:-/opt/soa/lib/os-curl.sh}"
: "${OS_S3_REPO:?}" "${OS_S3_REPO_BODY_FILE:?}" "${OS_SM_POLICY_NAME:?}" "${OS_SM_POLICY_FILE:?}"

os_wait_ready "${OS_WAIT_TRIES:-60}"

echo "Registering snapshot repository '$OS_S3_REPO' (type s3) ..."
out=$(os_curl PUT "/_snapshot/$OS_S3_REPO" "@$OS_S3_REPO_BODY_FILE")
[ "$(os_status)" = 200 ] || { echo "FATAL: repository registration refused (HTTP $(os_status)): $out"; exit 1; }

echo "Verifying '$OS_S3_REPO' (POST _verify) ..."
out=$(os_curl POST "/_snapshot/$OS_S3_REPO/_verify")
if [ "$(os_status)" != 200 ]; then
  echo "FATAL: repository '$OS_S3_REPO' failed _verify (HTTP $(os_status)): $out"
  echo "Check: the bucket exists, the keystore secret holds s3.client.default.access_key/secret_key,"
  echo "and the object-storage host is on egressProxy.allowlist (OpenSearch reaches it only via the proxy)."
  exit 1
fi
echo "Verified: $out"

echo "Applying Snapshot Management policy '$OS_SM_POLICY_NAME' ..."
cur=$(os_curl GET "/_plugins/_sm/policies/$OS_SM_POLICY_NAME")
if [ "$(os_status)" = 200 ]; then
  seq=$(printf '%s' "$cur" | sed -n 's/.*"_seq_no":\([0-9][0-9]*\).*/\1/p')
  term=$(printf '%s' "$cur" | sed -n 's/.*"_primary_term":\([0-9][0-9]*\).*/\1/p')
  [ -n "$seq" ] && [ -n "$term" ] || { echo "FATAL: cannot read _seq_no/_primary_term of policy: $cur"; exit 1; }
  out=$(os_curl PUT "/_plugins/_sm/policies/$OS_SM_POLICY_NAME?if_seq_no=$seq&if_primary_term=$term" "@$OS_SM_POLICY_FILE")
else
  out=$(os_curl POST "/_plugins/_sm/policies/$OS_SM_POLICY_NAME" "@$OS_SM_POLICY_FILE")
fi
case $(os_status) in
  200|201) echo "SM policy '$OS_SM_POLICY_NAME' applied." ;;
  *) echo "FATAL: SM policy refused (HTTP $(os_status)): $out"; exit 1 ;;
esac
