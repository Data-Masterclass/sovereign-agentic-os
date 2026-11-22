# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""The scheduled Drive sync: a Dagster job and schedule that call os-ui's governed sync path.

FEATURE:    `os_files_drive_sync` (job) and `os_files_drive_sync_schedule` (schedule). The op POSTs to os-ui's
            `/api/runtime/files-sync`, which syncs every connected Google Drive / OneDrive source as ITS owner
            (live owner check + that connection's own token), skips a source that is paused, and records each
            run on the source with trigger `schedule`. Dagster shows the pass: green only when no source failed.
USER STORY: As a drive owner I want my connected drive refreshed on a schedule by the same governed path my
            click uses — and a failed pass to show up as a failed Dagster run, not a green one.
ARCHITECTURE:
  - No sync logic here: files, hashes, indexing and the owner checks stay in os-ui (they are the OS's glue,
    not a Dagster asset). This is only the scheduler and its call.
  - Identity: the run pod's projected ServiceAccount token (`/var/run/secrets/os-ui/token`, audience `os-ui`),
    the same one `os_projects.run_identity_env` uses; os-ui checks it with a TokenReview and an OPA decision
    (`files_sync_run`). No shared bearer. No token ⇒ the schedule is defined STOPPED (a pass would only fail).
  - Fail closed: an unreachable os-ui, a refusal, a malformed answer or a source that failed raises, so the
    Dagster run fails with the reason. A source os-ui skipped because it is paused is not a failure.
  - This module imports no dagster at import time (the pure part is unit-tested without it); `definitions()`
    builds the job and schedule, and `repo.py` adds them to the location.
"""
import json
import os
import re
import urllib.error
import urllib.request
from typing import Dict, List, Mapping, Optional

JOB_NAME = "os_files_drive_sync"
SCHEDULE_NAME = "os_files_drive_sync_schedule"
ROUTE = "/api/runtime/files-sync"
DEFAULT_CRON = "*/15 * * * *"
DEFAULT_OS_UI_URL = "http://os-ui:3000"
RUN_TOKEN_FILE = "/var/run/secrets/os-ui/token"
DEFAULT_TIMEOUT_SECONDS = 900.0
_CRON_RE = re.compile(r"^\s*\S+(\s+\S+){4}\s*$")


class SyncPassFailed(Exception):
    """The pass did not complete cleanly; the message is what the Dagster run shows."""


def _env(env: Optional[Mapping[str, str]]) -> Mapping[str, str]:
    return os.environ if env is None else env


def _token_file(env: Mapping[str, str]) -> str:
    return env.get("OS_RUN_TOKEN_FILE") or RUN_TOKEN_FILE


def cron(env: Optional[Mapping[str, str]] = None) -> str:
    """`OS_FILES_SYNC_CRON` (five fields) or every 15 minutes; a value that is not five fields is ignored."""
    v = _env(env).get("OS_FILES_SYNC_CRON", "")
    return v.strip() if _CRON_RE.match(v) else DEFAULT_CRON


def schedule_default_running(env: Optional[Mapping[str, str]] = None) -> bool:
    """The schedule starts RUNNING only where the run pod can prove its identity to os-ui."""
    return os.path.isfile(_token_file(_env(env)))


def tick(env: Optional[Mapping[str, str]] = None) -> Dict[str, object]:
    """One pass: ask os-ui to sync every unpaused drive as its owner. Raises `SyncPassFailed` unless clean."""
    e = _env(env)
    try:
        with open(_token_file(e), "r", encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        token = ""
    if not token:
        raise SyncPassFailed(f"no run token at {_token_file(e)}: os-ui cannot tell who is calling, so nothing was synced")
    base = (e.get("OS_UI_URL") or DEFAULT_OS_UI_URL).rstrip("/")
    timeout = float(e.get("OS_FILES_SYNC_TIMEOUT_SECONDS") or DEFAULT_TIMEOUT_SECONDS)
    req = urllib.request.Request(
        base + ROUTE,
        data=json.dumps({"trigger": "schedule"}).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json", "authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 — cluster-internal URL from env
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as ex:
        status, raw = ex.code, ex.read()
    except Exception as ex:  # noqa: BLE001 — unreachable, timeout: the pass did not happen
        raise SyncPassFailed(f"os-ui could not be reached at {base}{ROUTE} ({type(ex).__name__}: {ex})") from None
    try:
        body = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        body = {}
    if status != 200:
        raise SyncPassFailed(f"os-ui refused the sync pass: HTTP {status} {body.get('error') or ''} {body.get('reason') or ''}".strip())
    results = body.get("results")
    if not isinstance(results, list) or not isinstance(body.get("failed"), int):
        raise SyncPassFailed("os-ui's answer did not say which sources were synced")
    failed: List[str] = [f"{r.get('sourceId')}: {r.get('reason') or 'failed'}" for r in results if isinstance(r, dict) and r.get("status") == "failed"]
    if failed:
        raise SyncPassFailed(f"{len(failed)} source(s) failed — " + "; ".join(failed))
    return body


def definitions():
    """The job and schedule (imports dagster here, so the module above is testable without it)."""
    from dagster import DefaultScheduleStatus, JsonMetadataValue, Output, ScheduleDefinition, job, op

    tags = {"os/job": "files_drive_sync", "os/trigger": "schedule"}

    @op
    def files_drive_sync_op(context):
        res = tick()
        counts = {k: sum(int(r.get(k) or 0) for r in res["results"]) for k in ("added", "changed", "unchanged")}  # type: ignore[union-attr]
        skipped = sum(1 for r in res["results"] if r.get("status") == "skipped")  # type: ignore[union-attr]
        context.log.info("drive sync pass: %d source(s), %s, %d skipped", len(res["results"]), counts, skipped)  # type: ignore[arg-type]
        yield Output(res, metadata={"os_sync_pass": JsonMetadataValue({**counts, "sources": len(res["results"]), "skipped": skipped})})  # type: ignore[arg-type]

    @job(name=JOB_NAME, tags=tags)
    def files_drive_sync():
        files_drive_sync_op()

    schedule = ScheduleDefinition(
        name=SCHEDULE_NAME,
        job=files_drive_sync,
        cron_schedule=cron(),
        execution_timezone="UTC",
        default_status=DefaultScheduleStatus.RUNNING if schedule_default_running() else DefaultScheduleStatus.STOPPED,
        description="Connected drives (Files): the governed sync as each source's owner, through os-ui. Paused sources are skipped.",
    )
    return files_drive_sync, schedule
