#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# workflow-status.sh — did these GitHub workflows pass on push for this exact commit?
# =============================================================================
#   bash scripts/lib/workflow-status.sh --sha <sha> --branch <branch-or-tag> \
#        --workflows "ci.yml license-gate.yml" [--wait-minutes <n>] [--require-job <job name>]
#
# THE ONE RELEASE-GATE QUERY. `.github/workflows/build-images.yml` asks it before building an
# os-ui image ("did ci.yml and license-gate.yml pass on main for this SHA?"), and
# `scripts/release.sh` asks it twice: the same question before tagging, then "did
# build-images.yml pass for this tag?". One script, so the two gates cannot drift apart.
#
# Only PUSH runs count, and only on <branch>. A PR run proves nothing about main: a rebase
# merge writes new commits, so the merged combination is a different tree. With
# `--branch main` a green answer also proves the commit really was pushed to main.
#
# For each workflow the NEWEST run for the SHA decides (a re-run that went green counts; an
# older green run under a newer red one does not). A workflow with no run yet is PENDING: it may
# not have started.
#
# --require-job <name>: a green RUN is not enough; its job <name> must have concluded `success`
# too. dev.yml uses it: when the dev environment is not enabled every job is skipped, and a run of
# skipped jobs must not count as "green on dev". The job is read from the newest run's job list.
#
# Exit status and the last line printed:
#   0  WORKFLOWS_GREEN                    every workflow's newest run concluded `success`
#   1  WORKFLOWS_RED: <wf>=<conclusion>   one concluded anything else (failure, cancelled, ...)
#   3  WORKFLOWS_PENDING: <wf>=<status>   still running or not started when the wait ran out
#   2  usage error, or the GitHub API could not be read
#
# Needs `gh` with a token that can read Actions (`actions: read` for a workflow's
# GITHUB_TOKEN). Prints no token. A helper run as `bash <path>`, like the rest of scripts/lib.
#
# Environment: WORKFLOW_REPO (default $GITHUB_REPOSITORY, else the public repo),
#              WORKFLOW_POLL_SECONDS (default 30; tests set 0).
set -euo pipefail

REPO=${WORKFLOW_REPO:-${GITHUB_REPOSITORY:-Data-Masterclass/sovereign-agentic-os}}
POLL=${WORKFLOW_POLL_SECONDS:-30}
SHA='' BRANCH='' WORKFLOWS='' WAIT_MINUTES=0 REQUIRE_JOB=

usage() { sed -n '7,8p' "$0" | sed 's/^# //' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --sha)          SHA=${2:-} ; shift ;;
    --branch)       BRANCH=${2:-} ; shift ;;
    --workflows)    WORKFLOWS=${2:-} ; shift ;;
    --wait-minutes) WAIT_MINUTES=${2:-} ; shift ;;
    --require-job)  REQUIRE_JOB=${2:-} ; shift ;;
    *) usage ;;
  esac
  shift
done
[ -n "$SHA" ] && [ -n "$BRANCH" ] && [ -n "$WORKFLOWS" ] || usage
case $WAIT_MINUTES in ''|*[!0-9]*) usage ;; esac

# runs_tsv — one line per run of this SHA on this branch, NEWEST FIRST:
#   <workflow file name> <TAB> <status> <TAB> <conclusion or none> <TAB> <url>
runs_tsv() {
  gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=push&branch=$BRANCH&per_page=100" \
    --jq '.workflow_runs | sort_by(.created_at) | reverse | .[]
          | [(.path | split("/") | last), .status, (.conclusion // "none"), .html_url, (.id | tostring)] | @tsv'
}

# job_conclusion <run id> — the conclusion of job $REQUIRE_JOB in that run ("missing" if absent).
job_conclusion() {
  local c
  c=$(gh api "repos/$REPO/actions/runs/$1/jobs?per_page=100" \
        --jq ".jobs[] | select(.name == \"$REQUIRE_JOB\") | (.conclusion // .status)" | head -1) \
    || { echo "WORKFLOWS_UNKNOWN: the jobs of run $1 could not be read" >&2; exit 2; }
  echo "${c:-missing}"
}

# check_once — print one line per workflow and collect RED and PENDING ("<wf>=<why>" lists).
check_once() {
  local runs wf line status conclusion url run_id job
  runs=$(runs_tsv) || { echo "WORKFLOWS_UNKNOWN: the GitHub API could not be read for $REPO" >&2; exit 2; }
  RED='' PENDING=''
  for wf in $WORKFLOWS; do
    line=$(printf '%s\n' "$runs" | awk -F'\t' -v wf="$wf" '$1 == wf { print; exit }')
    if [ -z "$line" ]; then
      echo "   $wf: no push run on $BRANCH for ${SHA:0:12} yet"
      PENDING="$PENDING $wf=not-started"
      continue
    fi
    IFS=$'\t' read -r _ status conclusion url run_id <<<"$line"
    echo "   $wf: $status/$conclusion  $url"
    if [ "$status" != completed ]; then PENDING="$PENDING $wf=$status"
    elif [ "$conclusion" != success ]; then RED="$RED $wf=$conclusion"
    elif [ -n "$REQUIRE_JOB" ]; then
      [ -n "${run_id:-}" ] || { RED="$RED $wf/$REQUIRE_JOB=unknown-run"; continue; }
      job=$(job_conclusion "$run_id")
      echo "   $wf job $REQUIRE_JOB: $job"
      [ "$job" = success ] || RED="$RED $wf/$REQUIRE_JOB=$job"
    fi
  done
}

deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
while :; do
  echo "checking $WORKFLOWS for ${SHA:0:12} on $BRANCH ($REPO)"
  check_once
  if [ -n "$RED" ];     then echo "WORKFLOWS_RED:$RED"; exit 1; fi
  if [ -z "$PENDING" ]; then echo "WORKFLOWS_GREEN"; exit 0; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "WORKFLOWS_PENDING:$PENDING"; exit 3; fi
  sleep "$POLL"
done
