#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# conn-key-secrets-manager.test.sh — scripts/ops/conn-key-secrets-manager.py against a fake Secrets
# Manager (curl stub: a KV v2 store in files, cas enforced) and a fake kubectl. No network, no cluster.
#   * no key value ever reaches the output, a command line, or a call log — fingerprints only;
#   * create: writes a new key with cas=0; refuses when the remote key exists;
#   * migrate: copies the live key (absent → written + read back; same → nothing written;
#     ANOTHER key remotely → refused); --dry-run writes nothing;
#   * verify: SAME / DIFFERS by fingerprint; rotate: previous := current, current := new (cas);
#   * a group/world-readable SM_HEADER is refused.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/sm"
LIVE_KEY="LIVEKEYMARKER$(printf 'x%.0s' {1..40})"
cat >"$T/bin/kubectl" <<SH
#!/usr/bin/env bash
echo "\$*" >>"$T/calls"
case "\$*" in
  *"get secret os-secrets-encryption-key -o json"*)
    printf '{"metadata":{"labels":{"app.kubernetes.io/managed-by":"Helm"}},"data":{"OS_SECRETS_ENCRYPTION_KEY":"%s"}}' "\$(printf '%s' "$LIVE_KEY" | base64)" ;;
  *) echo "Error from server (NotFound)" >&2; exit 1 ;;
esac
SH
# Fake KV v2: GET → {data:{data,metadata:{version}}} or 404; POST {options:{cas},data} with cas checked.
cat >"$T/bin/curl" <<'SH'
#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
log = open(os.environ["FAKE_DIR"] + "/curl-calls", "a"); log.write(" ".join(a) + "\n"); log.close()
out = a[a.index("-o") + 1]; url = a[-1]; path = url.split("/data/", 1)[1].replace("/", "__")
f = os.path.join(os.environ["FAKE_DIR"], "sm", path)
def answer(code, body=None):
    if body is not None: open(out, "w").write(json.dumps(body))
    sys.stdout.write(str(code)); sys.exit(0)
if "-X" in a:
    body = json.loads(sys.stdin.read())
    cur = json.load(open(f)) if os.path.exists(f) else None
    ver = cur["v"] if cur else 0
    if body["options"]["cas"] != ver: answer(400, {"errors": ["check-and-set mismatch"]})
    json.dump({"v": ver + 1, "data": body["data"]}, open(f, "w")); answer(200, {})
if not os.path.exists(f): answer(404, {"errors": []})
cur = json.load(open(f)); answer(200, {"data": {"data": cur["data"], "metadata": {"version": cur["v"]}}})
SH
chmod +x "$T/bin/"*
printf 'X-Vault-Token: TOKENMARKER\n' >"$T/hdr"; chmod 600 "$T/hdr"
export FAKE_DIR=$T
run() { : >"$T/calls"; out=$(PATH="$T/bin:$PATH" SM_HEADER="$T/hdr" SM_URL=https://sm.example.test python3 scripts/ops/conn-key-secrets-manager.py "$@" 2>&1); rc=$?; }
remote() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"].get(sys.argv[2],""))' "$T/sm/$1" "$2" 2>/dev/null; }
noleak() {
  absent "$1: no live key in the output" "LIVEKEYMARKER" "$out"
  absent "$1: no token in the output" "TOKENMARKER" "$out"
  if grep -q "LIVEKEYMARKER" "$T/curl-calls" "$T/calls" 2>/dev/null; then bad "$1: no key on any command line"; else ok "$1: no key on any command line"; fi
}

echo "== migrate (the live chart-generated key → Secrets Manager)"
run migrate --instance-id inst --dry-run
rc_is "dry run → exit 0" 0
check "dry run says it would write" "would write os-secrets-encryption-key" "$out"
[ ! -e "$T/sm/agentic-os__os-secrets-encryption-key" ] && ok "dry run wrote nothing" || bad "dry run wrote nothing"
run migrate --instance-id inst
rc_is "migrate → exit 0" 0
check "fingerprints match after read-back" "read back sha256:" "$out"
check "names the live key as chart-generated" "Helm (chart-generated)" "$out"
[ "$(remote agentic-os__os-secrets-encryption-key OS_SECRETS_ENCRYPTION_KEY)" = "$LIVE_KEY" ] && ok "the vault holds the live key" || bad "the vault holds the live key"
noleak migrate
run migrate --instance-id inst
rc_is "migrate again → exit 0" 0
check "same fingerprint → nothing written" "nothing to write" "$out"
run verify --instance-id inst
rc_is "verify → exit 0" 0; check "verify says SAME" "SAME" "$out"
noleak verify
python3 -c 'import json,sys; json.dump({"v":5,"data":{"OS_SECRETS_ENCRYPTION_KEY":"another-key-"+"y"*40}}, open(sys.argv[1],"w"))' "$T/sm/agentic-os__os-secrets-encryption-key"
run migrate --instance-id inst
rc_is "another key in the vault → refused (exit 1)" 1
check "the refusal explains" "already holds ANOTHER key" "$out"
run verify --instance-id inst
rc_is "verify with another key → exit 1" 1; check "verify says DIFFERS" "DIFFERS" "$out"

echo "== create (a fresh install)"
run create --instance-id inst --prefix fresh
rc_is "create → exit 0" 0
check "prints a fingerprint" "sha256:" "$out"
k=$(remote fresh__os-secrets-encryption-key OS_SECRETS_ENCRYPTION_KEY)
[ "${#k}" = 64 ] && ok "a 64-character key was written" || bad "a 64-character key was written" "len ${#k}"
absent "the new key is not printed" "$k" "$out"
if grep -q "$k" "$T/curl-calls"; then bad "the new key is on no command line"; else ok "the new key is on no command line"; fi
run create --instance-id inst --prefix fresh
rc_is "create when it exists → refused (exit 1)" 1
check "never overwrites" "create never overwrites" "$out"

echo "== rotate"
run rotate --instance-id inst --prefix fresh
rc_is "rotate → exit 0" 0
[ "$(remote fresh__os-secrets-encryption-key-previous OS_SECRETS_ENCRYPTION_KEY_PREVIOUS)" = "$k" ] && ok "the old key became previous" || bad "the old key became previous"
k2=$(remote fresh__os-secrets-encryption-key OS_SECRETS_ENCRYPTION_KEY)
[ -n "$k2" ] && [ "$k2" != "$k" ] && ok "a new current key" || bad "a new current key"
absent "rotate prints no key" "$k2" "$out"

echo "== refusals"
chmod 644 "$T/hdr"; run verify --instance-id inst
rc_is "a readable SM_HEADER → exit 1" 1; check "says chmod 600" "chmod 600" "$out"
chmod 600 "$T/hdr"
run verify; rc_is "no --instance-id → usage (exit 2)" 2
run push --instance-id inst; rc_is "unknown command → usage (exit 2)" 2

finish conn-key-secrets-manager
