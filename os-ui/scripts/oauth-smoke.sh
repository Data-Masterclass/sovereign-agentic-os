#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschraenkt)
#
# End-to-end smoke test for the MCP managed-authorization (OAuth 2.1) flow.
# Walks the exact chain Claude Desktop drives: unauthenticated 401 discovery
# pointer -> protected-resource metadata -> AS metadata -> DCR register ->
# authorize (cookie login + consent) -> token (PKCE) -> call /api/mcp.
#
# Usage:
#   BASE=https://os.agentic.datamasterclass.com \
#   OS_USER=you@company.com OS_PASS='secret' \
#   scripts/oauth-smoke.sh
#
# Requires: bash, curl, jq, openssl. Re-run after every deploy.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
OS_USER="${OS_USER:-admin}"
OS_PASS="${OS_PASS:-admin}"
REDIRECT="${REDIRECT:-https://claude.ai/api/mcp/auth_callback}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mok\033[0m %s\n' "$*"; }
die() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

say "1. Unauthenticated /api/mcp -> 401 with resource_metadata pointer"
HDRS="$(curl -sD- -o /dev/null -X POST "$BASE/api/mcp" -H 'content-type: application/json' -d '{}')"
echo "$HDRS" | grep -i '^www-authenticate:' | grep -q 'resource_metadata=' \
  || die "401 WWW-Authenticate is missing resource_metadata (managed auth cannot discover)"
ok "WWW-Authenticate advertises resource_metadata"

say "2. Protected Resource Metadata (RFC 9728)"
PRM="$(curl -s "$BASE/.well-known/oauth-protected-resource/api/mcp")"
echo "$PRM" | jq -e '.resource and (.authorization_servers|length>0)' >/dev/null \
  || die "protected-resource metadata malformed: $PRM"
ok "resource=$(echo "$PRM" | jq -r .resource)"

say "3. Authorization Server Metadata (RFC 8414)"
ASM="$(curl -s "$BASE/.well-known/oauth-authorization-server")"
echo "$ASM" | jq -e '(.code_challenge_methods_supported|index("S256")) and (.token_endpoint_auth_methods_supported|index("none")) and .authorization_endpoint and .token_endpoint' >/dev/null \
  || die "AS metadata missing S256 / none / endpoints: $ASM"
ok "S256 + none + endpoints present; CIMD=$(echo "$ASM" | jq -r .client_id_metadata_document_supported)"

say "4. Dynamic Client Registration (RFC 7591)"
CID="$(curl -s -XPOST "$BASE/oauth/register" -H 'content-type: application/json' \
  -d "{\"client_name\":\"oauth-smoke\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\"}" \
  | jq -r .client_id)"
[ -n "$CID" ] && [ "$CID" != "null" ] || die "register returned no client_id"
ok "client_id=$CID"

say "5. Cookie login (reuse OS session for the authorize step)"
curl -s -c "$JAR" -XPOST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$OS_USER\",\"password\":\"$OS_PASS\"}" | jq -e '.user.id' >/dev/null \
  || die "login failed for $OS_USER (set OS_USER / OS_PASS)"
ok "signed in as $OS_USER"

say "6. Authorize -> consent approve -> capture the PKCE-bound code"
VERIFIER="$(openssl rand -base64 60 | tr -d '=+/\n' | cut -c1-64)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
AUTHZ="response_type=code&client_id=$CID&redirect_uri=$(printf %s "$REDIRECT" | jq -sRr @uri)&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=$(printf %s "$BASE/api/mcp" | jq -sRr @uri)&scope=mcp:tools&state=xyz"
# POST the consent decision (the browser would submit this form); do not follow
# the 302 so we can read the code from the Location header.
LOC="$(curl -s -b "$JAR" -o /dev/null -D- -XPOST "$BASE/oauth/authorize" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data "$AUTHZ&decision=approve" | grep -i '^location:' | tr -d '\r' | sed 's/^[Ll]ocation: //')"
CODE="$(printf '%s' "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
[ -n "$CODE" ] || die "no authorization code in redirect Location: $LOC"
ok "code=${CODE:0:12}..."

say "7. Token exchange (authorization_code + PKCE verify)"
TOK="$(curl -s -XPOST "$BASE/oauth/token" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "client_id=$CID" \
  --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "resource=$BASE/api/mcp")"
ACCESS="$(echo "$TOK" | jq -r .access_token)"
REFRESH="$(echo "$TOK" | jq -r .refresh_token)"
[ -n "$ACCESS" ] && [ "$ACCESS" != "null" ] || die "token exchange failed: $TOK"
ok "access_token + refresh_token issued (expires_in=$(echo "$TOK" | jq -r .expires_in))"

say "8. Call /api/mcp with the access token -> tools/list"
LIST="$(curl -s -XPOST "$BASE/api/mcp" -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
N="$(echo "$LIST" | jq '.result.tools|length')"
[ "$N" -gt 0 ] 2>/dev/null || die "tools/list returned no tools: $LIST"
ok "$N role-scoped tools returned"

say "9. Refresh token exchange (rotation)"
RT="$(curl -s -XPOST "$BASE/oauth/token" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$REFRESH" \
  --data-urlencode "client_id=$CID")"
echo "$RT" | jq -e '.access_token and .refresh_token' >/dev/null || die "refresh failed: $RT"
ok "refresh rotated a new access + refresh token"

printf '\n\033[32mALL GREEN\033[0m — managed-authorization handshake works end-to-end.\n'
