#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# assert.sh — the four assertion helpers the shell tests share. Source it; do not run it.
#   ok <name> | bad <name> [detail] | check <name> <expected substring> <actual>
#   absent <name> <forbidden substring> <actual> | rc_is <name> <expected $rc>
#   holds <name> <command...>   (ok when the command succeeds) | finish <test name> (the tally)
pass=0; fail=0; rc=0; out=""   # rc and out are set by each test's runner function
ok()     { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()    { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }
check()  { case $3 in *"$2"*) ok "$1" ;; *) bad "$1" "expected to contain: $2 | got: ${3:0:400}" ;; esac; }
absent() { case $3 in *"$2"*) bad "$1" "must not contain: $2" ;; *) ok "$1" ;; esac; }
rc_is()  { if [ "$rc" -eq "$2" ]; then ok "$1"; else bad "$1" "exit $rc, wanted $2: ${out:0:400}"; fi; }
holds()  { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
finish() { echo; echo "$1: $pass passed, $fail failed"; [ "$fail" -eq 0 ]; }
