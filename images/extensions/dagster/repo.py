# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Dagster definitions — the `sovereign` code location (engine rebuild B2).

FEATURE:    One code location for every domain's data product: `dbt_assets` per validated commit
            under `/repos-checkout/<domain>/current/`, schedules from the repo's `os/schedules.yml`,
            a failure sensor that pauses a schedule after repeated failures (replaces the OS's
            `isQuarantined`), a sensor that pauses schedules whose principal the OS reports
            inactive, and a weekly Iceberg maintenance job per schema. `hello_sovereign` stays as
            the smoke asset.
USER STORY: As a data engineer I want the OS's datasets to be real Dagster assets scheduled from a
            git commit I can read, with run history, asset checks (dbt tests) and the next tick
            visible in Dagster — and the OS reading those instead of keeping its own ledger.
ARCHITECTURE:
  - Thin: discovery, YAML, tags and pause decisions live in `os_projects.py` (pure, unit-tested).
    This file only wires Dagster objects. A domain that fails to load is logged and skipped —
    one broken repo never takes the location down (per-domain parse gating, concept §2.3).
  - K8s run pods re-import this file with an EMPTY `/repos-checkout` emptyDir: `OS_PINNED_COMMITS`
    (baked into every job's `dagster-k8s/config` env, and set by the OS on launch) tells
    `os_projects.ensure_checkout` which commit to clone from the read-only git daemon and parse.
    The user-code pod never clones — its sidecar maintains `current`.
  - `OS_PRINCIPAL` (the Trino user dbt-trino impersonates) is injected per run through the
    `dagster-k8s/config` tag — the schedule's principal, the maintenance schema's owner, or what the
    OS passed for an explicit launch. Nothing here runs as a shared service identity.
  - Asset keys are `[<domain>, <dbt node name>]` (translator prefix); group = the domain.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Dict, List

from dagster import (
    AssetSelection,
    DefaultScheduleStatus,
    DefaultSensorStatus,
    Definitions,
    RunFailureSensorContext,
    RunsFilter,
    ScheduleDefinition,
    SensorEvaluationContext,
    SkipReason,
    asset,
    define_asset_job,
    job,
    op,
    run_failure_sensor,
    sensor,
)
from dagster_dbt import DagsterDbtTranslator, DbtCliResource, build_dbt_asset_selection, dbt_assets

import os_projects as osp

log = logging.getLogger("sovereign")

CHECKOUT = os.environ.get("REPO_SYNC_CHECKOUT", osp.DEFAULT_CHECKOUT)
GIT_BASE = os.environ.get("REPO_SYNC_GIT_BASE", osp.DEFAULT_GIT_BASE)
OS_INDEX_URL = os.environ.get("OS_INDEX_URL", "")
OS_TOKEN = os.environ.get("AGENT_RUNTIME_TOKEN", "")
QUARANTINE_THRESHOLD = int(os.environ.get("OS_QUARANTINE_THRESHOLD", str(osp.QUARANTINE_THRESHOLD)))

DEMO_DBT_DIR = Path("/opt/dbt/project")
DEMO_MANIFEST = DEMO_DBT_DIR / "target" / "manifest.json"


@asset(group_name="sovereign_os", description="Proof-of-life asset for the orchestrator.")
def hello_sovereign() -> str:
    return "hello from the Sovereign Agentic OS orchestrator"


class PrefixedTranslator(DagsterDbtTranslator):
    """Asset keys `[<domain>, <node>]`, grouped per domain."""

    def __init__(self, domain: str):
        super().__init__()
        self._domain = domain
        self._group = osp.sanitize(domain)

    def get_asset_key(self, dbt_resource_props):  # type: ignore[override]
        return super().get_asset_key(dbt_resource_props).with_prefix(self._domain)

    def get_group_name(self, dbt_resource_props):  # type: ignore[override]
        return self._group


def _pause_schedule(instance, schedule_name: str, logger) -> bool:
    """Stop a schedule by name through the instance's stored instigator state (pause, never delete)."""
    from dagster._core.scheduler.instigation import InstigatorStatus, InstigatorType

    for state in instance.all_instigator_state(instigator_type=InstigatorType.SCHEDULE):
        if state.instigator_name != schedule_name:
            continue
        if state.status == InstigatorStatus.STOPPED:
            return False
        instance.stop_schedule(state.instigator_origin_id, state.selector_id, None)
        logger.warning("paused schedule %s", schedule_name)
        return True
    logger.warning("schedule %s has no stored state yet — cannot pause it (it has never ticked)", schedule_name)
    return False


def build_definitions() -> Definitions:
    pinned = osp.parse_pinned(os.environ.get("OS_PINNED_COMMITS"))
    projects, skipped = osp.discover(CHECKOUT, pinned, GIT_BASE)
    for s in skipped:
        log.warning("sovereign: domain %s skipped — %s", s.domain, s.reason)
    pinned_env = osp.pinned_env(projects)

    assets = [hello_sovereign]
    jobs = []
    schedules: List[ScheduleDefinition] = []
    resources: Dict[str, object] = {}
    schedule_principals: Dict[str, str] = {}

    if DEMO_MANIFEST.is_file():
        @dbt_assets(manifest=DEMO_MANIFEST, name="sovereign_demo_dbt")
        def sovereign_dbt(context, dbt: DbtCliResource):
            yield from dbt.cli(["build"], context=context).stream()

        assets.append(sovereign_dbt)
        resources["dbt"] = DbtCliResource(project_dir=str(DEMO_DBT_DIR), profiles_dir=str(DEMO_DBT_DIR))

    for p in projects:
        try:
            _wire_project(p, pinned_env, assets, jobs, schedules, resources, schedule_principals)
        except Exception as e:  # noqa: BLE001 — per-domain gating
            log.error("sovereign: domain %s failed to load (%s: %s) — skipped", p.domain, type(e).__name__, e)

    @run_failure_sensor(name="os_quarantine", default_status=DefaultSensorStatus.RUNNING)
    def os_quarantine(context: RunFailureSensorContext):
        """Pause a schedule after QUARANTINE_THRESHOLD consecutive failures (the OS's old `isQuarantined`)."""
        run = context.dagster_run
        schedule = run.tags.get("os/schedule")
        if not schedule:
            return
        recent = context.instance.get_runs(filters=RunsFilter(job_name=run.job_name), limit=QUARANTINE_THRESHOLD)
        statuses = [r.status.value for r in recent]
        if osp.should_pause(statuses, QUARANTINE_THRESHOLD):
            context.log.warning("%s failed %d× in a row — quarantining", run.job_name, QUARANTINE_THRESHOLD)
            _pause_schedule(context.instance, schedule, context.log)

    @sensor(name="os_principals", minimum_interval_seconds=300, default_status=DefaultSensorStatus.RUNNING)
    def os_principals(context: SensorEvaluationContext):
        """Pause schedules whose principal the OS reports inactive (deactivated owner — concept §6)."""
        if not OS_INDEX_URL:
            return SkipReason("OS_INDEX_URL unset — principal activity is not checked")
        index = osp.fetch_index(OS_INDEX_URL, OS_TOKEN)
        if index is None:
            return SkipReason("OS index unreachable")
        to_pause = osp.schedules_to_pause(schedule_principals, osp.inactive_principals(index))
        paused = [n for n in to_pause if _pause_schedule(context.instance, n, context.log)]
        return SkipReason(f"paused {len(paused)} schedule(s) for inactive principals" if paused else "all principals active")

    return Definitions(
        assets=assets,
        jobs=jobs,
        schedules=schedules,
        sensors=[os_quarantine, os_principals],
        resources=resources,
    )


def _wire_project(p: osp.Project, pinned_env: str, assets, jobs, schedules, resources, schedule_principals) -> None:
    dom = osp.sanitize(p.domain)
    resource_key = f"dbt_{dom}"
    resources[resource_key] = DbtCliResource(project_dir=p.path, profiles_dir=p.path)

    @dbt_assets(
        manifest=Path(p.manifest),
        name=f"{dom}_dbt",
        dagster_dbt_translator=PrefixedTranslator(p.domain),
        required_resource_keys={resource_key},
    )
    def domain_assets(context):
        dbt = getattr(context.resources, resource_key)
        tags = context.run.tags
        args = ["build"]
        dbt_vars = {}
        # A retry that passes the SAME os_batch_id re-covers the same slice (delete+insert on
        # _batch_id); a plain re-run defaults to invocation_id and DUPLICATES the lookback rows.
        if tags.get("os/batch_id"):
            dbt_vars["os_batch_id"] = tags["os/batch_id"]
        if dbt_vars:
            args += ["--vars", json.dumps(dbt_vars)]
        if tags.get("os/full_refresh") == "true":
            args.append("--full-refresh")
        yield from dbt.cli(args, context=context).stream()

    assets.append(domain_assets)

    # The job the OS launches with an explicit asset subset (Build, transform, gold join, sync now).
    jobs.append(
        define_asset_job(
            name=osp.all_job_name(p.domain),
            selection=AssetSelection.assets(domain_assets),
            tags=osp.all_job_tags(p.domain, p.sha, pinned_env),
            description=f"All dbt assets of domain {p.domain} at commit {p.sha[:7]} (OS launches a subset).",
        )
    )

    # os/schedules.yml → one schedule per sync landing (`<model>+`), UTC, Dagster does not fire missed ticks.
    for s in p.schedules:
        name = osp.schedule_name(p.domain, s.dataset)
        selection = build_dbt_asset_selection([domain_assets], dbt_select=s.select)
        sync_job = define_asset_job(name=name, selection=selection, tags=osp.schedule_tags(p.domain, s, p.sha, pinned_env))
        jobs.append(sync_job)
        schedules.append(
            ScheduleDefinition(
                name=name,
                job=sync_job,
                cron_schedule=s.cron,
                execution_timezone="UTC",
                default_status=DefaultScheduleStatus.RUNNING if s.enabled else DefaultScheduleStatus.STOPPED,
                description=f"OS dataset {s.dataset} sync — dbt select '{s.select}' as {s.principal} (from os/schedules.yml).",
            )
        )
        schedule_principals[name] = s.principal

    # Weekly Iceberg maintenance per schema, as the schema's owner (the dbt macro the generator ships).
    for schema, principal in p.schemas.items():
        jobs.append(_maintenance_job(p, schema, principal, resource_key, pinned_env))
        schedules.append(
            ScheduleDefinition(
                name=f"{osp.maintenance_job_name(p.domain, schema)}_weekly",
                job=jobs[-1],
                cron_schedule=osp.MAINTENANCE_CRON,
                execution_timezone="UTC",
                default_status=DefaultScheduleStatus.RUNNING,
                description=f"Iceberg optimize + expire_snapshots for {schema} as {principal}.",
            )
        )


def _maintenance_job(p: osp.Project, schema: str, principal: str, resource_key: str, pinned_env: str):
    name = osp.maintenance_job_name(p.domain, schema)

    @op(name=f"{name}_op", required_resource_keys={resource_key})
    def maintenance_op(context):
        dbt = getattr(context.resources, resource_key)
        # `os_maintenance` (macros/os_maintenance.sql, generated) runs `ALTER TABLE … EXECUTE optimize`
        # and `expire_snapshots(retention_threshold => '7d')` for every table model in `schema`.
        context.log.info("os_maintenance for schema %s as %s", schema, principal)
        dbt.cli(["run-operation", "os_maintenance", "--args", json.dumps({"schema": schema})]).wait()

    @job(name=name, tags=osp.maintenance_tags(p.domain, schema, principal, p.sha, pinned_env))
    def maintenance_job():
        maintenance_op()

    return maintenance_job


defs = build_definitions()
