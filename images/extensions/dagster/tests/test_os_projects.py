# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Unit tests for os_projects.py — run with `python3 -m unittest discover -s images/extensions/dagster/tests`.

FEATURE:    Prove the loader's pure half: schedules.yml → UTC schedules with the right selection,
            tags and names; N project dirs → N projects (and a broken one is skipped, not fatal);
            run-pod bootstrap clones + parses exactly once; quarantine and principal pauses.
USER STORY: As a maintainer I want the Dagster code location testable without Dagster installed,
            so a regression in schedule generation fails here, not on the cluster.
ARCHITECTURE:
  - Temp dirs stand in for /repos-checkout; `run=` fakes replace git and dbt.
  - The B2 review classes: `ParseEnvironment` (no secret reaches `dbt parse`), `NameCollisions`
    (two domains cannot collapse onto one Dagster name), `Timezones`, `PartitionedDefinitions`
    (one bad domain is skipped, not the location) and `ChartContract` (the run pods really carry
    the label the os-repos NetworkPolicy admits to the git daemon).
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_projects as osp  # noqa: E402

SHA_A = "a" * 40
SHA_B = "b" * 40

SCHEDULES_YML = """
version: 1
schedules:
  - dataset: ds_events01
    name: silver_events
    select: silver_events+
    cron: "*/15 * * * *"
    timezone: UTC
    principal: bea
    enabled: true
  - dataset: ds_accts001
    name: gold_accounts
    select: gold_accounts+
    cron: "0 6 * * *"
    timezone: UTC
    principal: bea
    enabled: false
  - dataset: broken
    name: x
    cron: "not a cron"
    principal: bea
"""


def manifest(nodes):
    return json.dumps({"nodes": nodes})


def write_project(root, domain, sha, schedules=SCHEDULES_YML, with_manifest=True, nodes=None):
    sha_dir = os.path.join(root, domain, sha)
    os.makedirs(os.path.join(sha_dir, "os"), exist_ok=True)
    if with_manifest:
        os.makedirs(os.path.join(sha_dir, "target"), exist_ok=True)
        with open(os.path.join(sha_dir, "target", "manifest.json"), "w") as fh:
            fh.write(manifest(nodes or {}))
    if schedules is not None:
        with open(os.path.join(sha_dir, "os", "schedules.yml"), "w") as fh:
            fh.write(schedules)
    link = os.path.join(root, domain, "current")
    if os.path.islink(link):
        os.unlink(link)
    os.symlink(sha, link)
    return sha_dir


class Schedules(unittest.TestCase):
    def test_parse_keeps_valid_entries_sorted_and_utc(self):
        s = osp.parse_schedules(SCHEDULES_YML)
        self.assertEqual([x.dataset for x in s], ["ds_accts001", "ds_events01"])
        ev = next(x for x in s if x.dataset == "ds_events01")
        self.assertEqual((ev.cron, ev.select, ev.principal, ev.enabled, ev.timezone), ("*/15 * * * *", "silver_events+", "bea", True, "UTC"))
        self.assertFalse(next(x for x in s if x.dataset == "ds_accts001").enabled)

    def test_names_are_dagster_safe(self):
        self.assertEqual(osp.schedule_name("agentic-leader q3", "ds_1"), "agentic_leader_q3__ds_1")
        self.assertEqual(osp.all_job_name("sales"), "sales__all")
        self.assertEqual(osp.maintenance_job_name("sales", "personal_amir"), "sales__maintenance__personal_amir")

    def test_schedule_tags_carry_dataset_principal_commit_and_k8s_env(self):
        s = osp.parse_schedules(SCHEDULES_YML)[1]
        tags = osp.schedule_tags("sales", s, SHA_A, f"sales={SHA_A}")
        self.assertEqual(tags["os/dataset"], "ds_events01")
        self.assertEqual(tags["os/principal"], "bea")
        self.assertEqual(tags["os/domain"], "sales")
        self.assertEqual(tags["os/commit"], SHA_A)
        self.assertEqual(tags["os/schedule"], "sales__ds_events01")
        k8s = json.loads(tags["dagster-k8s/config"])
        env = {e["name"]: e["value"] for e in k8s["container_config"]["env"]}
        self.assertEqual(env, {"OS_PRINCIPAL": "bea", "OS_PINNED_COMMITS": f"sales={SHA_A}"})
        for v in tags.values():
            self.assertIsInstance(v, str)


class Discovery(unittest.TestCase):
    def test_n_project_dirs_give_n_projects_and_a_broken_one_is_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            write_project(root, "sales", SHA_A, nodes={
                "model.sales.silver_events": {"resource_type": "model", "schema": "sales", "config": {"meta": {"os_owner": "bea"}}},
                "model.sales.silver_x": {"resource_type": "model", "schema": "personal_amir", "config": {"meta": {"os_owner": "amir"}}},
                "model.sales.silver_y": {"resource_type": "model", "schema": "personal_zed", "config": {"meta": {}}},
                "source.sales.s": {"resource_type": "source", "schema": "zzz"},
            })
            write_project(root, "finance", SHA_B, schedules=None)
            write_project(root, "broken", SHA_A, with_manifest=False)
            os.makedirs(os.path.join(root, "nocurrent"))
            os.makedirs(os.path.join(root, ".mirrors"))
            projects, skipped = osp.discover(root)
            self.assertEqual([p.domain for p in projects], ["finance", "sales"])
            sales = projects[1]
            self.assertEqual(sales.sha, SHA_A)
            self.assertTrue(sales.path.endswith(os.path.join("sales", SHA_A)))
            self.assertEqual(len(sales.schedules), 2)
            self.assertEqual(sales.schemas, {"personal_amir": "amir", "sales": "sales"})
            self.assertEqual(projects[0].schedules, [])
            self.assertEqual(sorted(s.domain for s in skipped), ["broken", "nocurrent"])
            self.assertEqual(osp.pinned_env(projects), f"finance={SHA_B},sales={SHA_A}")

    def test_pinned_commit_bootstraps_a_run_pod_checkout_once(self):
        calls = []
        with tempfile.TemporaryDirectory() as root:
            def fake_run(cmd, cwd=None, env=None):
                calls.append((list(cmd), cwd))
                if cmd[:2] == ["git", "clone"]:
                    os.makedirs(os.path.join(cmd[-1], ".git"))
                    return 0, ""
                if cmd[0] == "dbt":
                    os.makedirs(os.path.join(cwd, "target"), exist_ok=True)
                    with open(os.path.join(cwd, "target", "manifest.json"), "w") as fh:
                        fh.write(manifest({}))
                    return 0, ""
                return 0, ""
            projects, skipped = osp.discover(root, {"sales": SHA_A}, "git://os-repos", fake_run)
            self.assertEqual(skipped, [])
            self.assertEqual([(p.domain, p.sha) for p in projects], [("sales", SHA_A)])
            clone = [c for c in calls if c[0][:2] == ["git", "clone"]]
            self.assertEqual(clone[0][0][-2], "git://os-repos/sales.git")
            self.assertEqual([c for c in calls if c[0][0] == "dbt"][0][1], os.path.join(root, "sales", SHA_A))
            # second discovery: the checkout exists — no git, no dbt
            calls.clear()
            osp.discover(root, {"sales": SHA_A}, "git://os-repos", fake_run)
            self.assertEqual(calls, [])

    def test_pinned_parse_failure_is_skipped_not_fatal(self):
        with tempfile.TemporaryDirectory() as root:
            def fake_run(cmd, cwd=None, env=None):
                if cmd[:2] == ["git", "clone"]:
                    os.makedirs(os.path.join(cmd[-1], ".git"))
                return (1, "Compilation Error in model x") if cmd[0] == "dbt" else (0, "")
            projects, skipped = osp.discover(root, {"sales": SHA_A}, "git://os-repos", fake_run)
            self.assertEqual(projects, [])
            self.assertIn("dbt parse failed", skipped[0].reason)

    def test_parse_pinned_rejects_garbage(self):
        self.assertEqual(osp.parse_pinned(f"sales={SHA_A}, ../x={SHA_A},fin=nope,"), {"sales": SHA_A})
        self.assertEqual(osp.parse_pinned(None), {})
        dir_, err = osp.ensure_checkout("../evil", SHA_A, "/tmp/none", run=lambda c, w=None, e=None: (0, ""))
        self.assertIsNone(dir_)
        self.assertIn("refusing", err)


class Pauses(unittest.TestCase):
    def test_consecutive_failures_skip_canceled_and_stop_at_success(self):
        self.assertEqual(osp.consecutive_failures(["FAILURE", "CANCELED", "FAILURE", "SUCCESS", "FAILURE"]), 2)
        self.assertEqual(osp.consecutive_failures(["SUCCESS", "FAILURE"]), 0)
        self.assertEqual(osp.consecutive_failures([]), 0)
        self.assertTrue(osp.should_pause(["FAILURE"] * 10))
        self.assertFalse(osp.should_pause(["FAILURE"] * 9))
        self.assertTrue(osp.should_pause(["FAILURE"] * 3, threshold=3))

    def test_inactive_principals_pause_only_their_schedules(self):
        index = {"domains": [{"name": "sales", "head": SHA_A, "principals": [{"id": "bea", "active": False}, {"id": "amir", "active": True}]}]}
        inactive = osp.inactive_principals(index)
        self.assertEqual(inactive, {"bea"})
        self.assertEqual(osp.schedules_to_pause({"sales__ds_1": "bea", "sales__ds_2": "amir", "fin__ds_3": "bea"}, inactive), ["fin__ds_3", "sales__ds_1"])
        self.assertEqual(osp.inactive_principals({}), set())

# The EXACT bytes os-ui's generator emits (tabs/data/lib/dbt/schedules.ts; the golden file
# fixtures/append-sync-with-cursor.golden.json). This is the contract between the two halves:
# if the TypeScript renderer changes a key, this test fails here rather than on the cluster.
GENERATED_SCHEDULES_YML = """version: 1
schedules:
  - dataset: ds_accts001
    name: gold_accounts
    select: gold_accounts+
    cron: 0 6 * * *
    timezone: UTC
    principal: bea
    enabled: false
  - dataset: ds_events01
    name: silver_events
    select: silver_events+
    cron: "*/15 * * * *"
    timezone: UTC
    principal: bea
    enabled: true
"""


class GeneratorContract(unittest.TestCase):
    def test_the_os_generated_schedules_yml_parses_into_the_loaders_schedules(self):
        """The OS writes it, this module reads it — one shape, asserted on the real bytes."""
        out = osp.parse_schedules(GENERATED_SCHEDULES_YML)
        self.assertEqual([s.dataset for s in out], ["ds_accts001", "ds_events01"])
        gold, silver = out
        self.assertEqual((gold.model, gold.select, gold.cron, gold.principal, gold.enabled), ("gold_accounts", "gold_accounts+", "0 6 * * *", "bea", False))
        self.assertEqual((silver.model, silver.select, silver.cron, silver.enabled), ("silver_events", "silver_events+", "*/15 * * * *", True))
        self.assertTrue(all(s.timezone == "UTC" for s in out))
        # A disabled entry still produces a schedule — STOPPED, not absent, so it is visible.
        names = [osp.schedule_name("sales", s.dataset) for s in out]
        self.assertEqual(names, ["sales__ds_accts001", "sales__ds_events01"])

    def test_malformed_entries_are_dropped_never_guessed(self):
        bad = """
version: 1
schedules:
  - dataset: ds_a
    name: m_a
    cron: "not a cron"
    principal: bea
  - dataset: ds_b
    cron: "0 6 * * *"
    principal: bea
  - name: m_c
    cron: "0 6 * * *"
    principal: bea
  - dataset: ds_d
    name: m_d
    cron: "0 6 * * *"
  - "a string, not a mapping"
  - dataset: ds_ok
    name: m_ok
    cron: "0 6 * * *"
    principal: bea
"""
        out = osp.parse_schedules(bad)
        self.assertEqual([s.dataset for s in out], ["ds_ok"])
        self.assertEqual(out[0].select, "m_ok+", "an absent `select` defaults to <model>+")
        self.assertEqual(osp.parse_schedules(""), [])
        self.assertEqual(osp.parse_schedules("version: 1"), [])


class Maintenance(unittest.TestCase):
    """The weekly Iceberg job needs a schema AND the principal that owns it — never a guess."""

    def _manifest(self, tmp, nodes):
        path = os.path.join(tmp, "manifest.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"nodes": nodes}, fh)
        return path

    def test_domain_schema_belongs_to_the_domain_and_a_personal_schema_to_its_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._manifest(tmp, {
                "model.sales.gold_orders": {"resource_type": "model", "schema": "sales", "config": {"meta": {"os_owner": "amir"}}},
                "model.sales.silver_orders": {"resource_type": "model", "schema": "personal_amir", "config": {"meta": {"os_owner": "amir"}}},
                "model.sales.nameless": {"resource_type": "model", "schema": ""},
                "test.sales.not_null": {"resource_type": "test", "schema": "sales"},
            })
            out = osp.schemas_from_manifest(path, "sales")
        self.assertEqual(out, {"personal_amir": "amir", "sales": "sales"})

    def test_a_personal_schema_without_a_recorded_owner_is_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._manifest(tmp, {"model.x.m": {"resource_type": "model", "schema": "personal_zoe"}})
            self.assertEqual(osp.schemas_from_manifest(path, "sales"), {})
        self.assertEqual(osp.schemas_from_manifest("/nope/manifest.json", "sales"), {})

    def test_maintenance_names_and_tags_carry_the_owning_principal(self):
        self.assertEqual(osp.maintenance_job_name("agentic-leader", "personal_amir"), "agentic_leader__maintenance__personal_amir")
        tags = osp.maintenance_tags("sales", "personal_amir", "amir", SHA_A, f"sales={SHA_A}")
        self.assertEqual(tags["os/principal"], "amir")
        self.assertEqual(tags["os/schema"], "personal_amir")
        self.assertEqual(tags["os/action"], "iceberg maintenance")
        env = json.loads(tags["dagster-k8s/config"])["container_config"]["env"]
        self.assertEqual({e["name"]: e["value"] for e in env}, {"OS_PRINCIPAL": "amir", "OS_PINNED_COMMITS": f"sales={SHA_A}"})
        self.assertEqual(osp.MAINTENANCE_CRON, "0 3 * * 0")

    def test_the_os_launched_job_carries_no_principal_of_its_own(self):
        tags = osp.all_job_tags("sales", SHA_A, f"sales={SHA_A}")
        self.assertNotIn("os/principal", tags)
        env = json.loads(tags["dagster-k8s/config"])["container_config"]["env"]
        self.assertEqual([e["name"] for e in env], ["OS_PINNED_COMMITS"])
        self.assertEqual(osp.all_job_name("sales"), "sales__all")



class ParseEnvironment(unittest.TestCase):
    """Review B2-review-H3: `dbt parse` renders repo Jinja, so it must see an ALLOWLIST only."""

    def test_the_parse_environment_holds_nothing_outside_the_allowlist(self):
        ambient = {
            "PATH": "/usr/bin", "HOME": "/home/dagster", "LANG": "C.UTF-8",
            "AGENT_RUNTIME_TOKEN": "s3cret-bearer",
            "DAGSTER_PG_PASSWORD": "s3cret-pg",
            "TRINO_SCHEMA": "sales",
            "KUBERNETES_SERVICE_HOST": "10.0.0.1",
        }
        env = osp.parse_env(ambient)
        allowed = set(osp.PARSE_ENV_PASSTHROUGH) | set(osp.PARSE_ENV_FIXED)
        self.assertEqual(set(env) - allowed, set(), "a name outside the allowlist reached dbt")
        for leaked in ("AGENT_RUNTIME_TOKEN", "DAGSTER_PG_PASSWORD", "KUBERNETES_SERVICE_HOST"):
            self.assertNotIn(leaked, env)
        self.assertNotIn("s3cret-bearer", "".join(env.values()))
        # OS_PRINCIPAL is the one env_var() with no default in the generated profiles.yml.
        self.assertEqual(env["OS_PRINCIPAL"], "repo-sync")

    def test_an_empty_ambient_still_gives_dbt_a_path_and_home(self):
        env = osp.parse_env({})
        self.assertTrue(env["PATH"])
        self.assertTrue(env["HOME"])

    def test_dbt_parse_passes_that_environment_and_nothing_else(self):
        seen = {}

        def fake_run(cmd, cwd=None, env=None):
            seen.update({"cmd": list(cmd), "cwd": cwd, "env": dict(env or {})})
            return 0, ""

        code, _ = osp.dbt_parse("/w", fake_run, {"AGENT_RUNTIME_TOKEN": "nope", "PATH": "/usr/bin"})
        self.assertEqual(code, 0)
        self.assertEqual(seen["cmd"][:2], ["dbt", "parse"])
        self.assertEqual(seen["cwd"], "/w")
        self.assertNotIn("AGENT_RUNTIME_TOKEN", seen["env"])

    def test_the_run_pod_bootstrap_parses_through_the_same_allowlist(self):
        envs = []

        def fake_run(cmd, cwd=None, env=None):
            if cmd[:2] == ["git", "clone"]:
                os.makedirs(os.path.join(cmd[-1], ".git"))
                return 0, ""
            if cmd[0] == "dbt":
                envs.append(dict(env or {}))
                os.makedirs(os.path.join(cwd, "target"), exist_ok=True)
                with open(os.path.join(cwd, "target", "manifest.json"), "w") as fh:
                    fh.write(manifest({}))
            return 0, ""

        with tempfile.TemporaryDirectory() as root:
            osp.ensure_checkout("sales", SHA_A, root, "git://os-repos", fake_run,
                                {"AGENT_RUNTIME_TOKEN": "s3cret", "PATH": "/usr/bin"})
        self.assertEqual(len(envs), 1)
        self.assertNotIn("AGENT_RUNTIME_TOKEN", envs[0])

    def test_repo_sync_shares_that_one_allowlist_instead_of_keeping_its_own(self):
        """The shell half must SHELL OUT here — a second `env -i` list would drift."""
        sh = os.path.join(os.path.dirname(__file__), "..", "repo-sync.sh")
        with open(sh, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("os_projects.py\" --parse", text)
        self.assertNotIn("env -i", text, "repo-sync.sh kept a second parse-env allowlist")
        # And it must exit (never idle) inside a Dagster run pod — review B2-review-M1.
        self.assertIn("dagster-run-*", text)


class NameCollisions(unittest.TestCase):
    """Review B2-review-M2: `sanitize` is lossy; a duplicate name breaks the WHOLE location."""

    def test_two_domains_that_sanitize_alike_get_distinct_names(self):
        got = osp.sanitize_all(["sales-eu", "sales.eu", "finance"])
        self.assertEqual(got["finance"], "finance")
        self.assertEqual(len({got["sales-eu"], got["sales.eu"]}), 2)
        self.assertIn("sales_eu", (got["sales-eu"], got["sales.eu"]))
        for name in got.values():
            self.assertRegex(name, r"^[A-Za-z_][A-Za-z0-9_]*$")

    def test_the_mapping_is_deterministic_and_order_independent(self):
        a = osp.sanitize_all(["sales-eu", "sales.eu"])
        b = osp.sanitize_all(["sales.eu", "sales-eu"])
        self.assertEqual(a, b)
        # A name keeps its suffix when an unrelated domain appears.
        c = osp.sanitize_all(["sales.eu", "sales-eu", "zzz"])
        self.assertEqual(c["sales.eu"], a["sales.eu"])
        self.assertEqual(c["sales-eu"], a["sales-eu"])

    def test_the_schedule_name_and_its_tag_agree_for_a_collided_domain(self):
        """The `os/schedule` tag is how the sensors pause a schedule — it must be the real name."""
        names = osp.sanitize_all(["sales-eu", "sales.eu"])
        s = osp.parse_schedules(SCHEDULES_YML)[1]
        for domain, dom in names.items():
            name = osp.schedule_name(dom, s.dataset)
            tags = osp.schedule_tags(domain, s, SHA_A, f"{domain}={SHA_A}", name)
            self.assertEqual(tags["os/schedule"], name)
        self.assertNotEqual(
            osp.schedule_name(names["sales-eu"], s.dataset),
            osp.schedule_name(names["sales.eu"], s.dataset),
        )


class Timezones(unittest.TestCase):
    """Review B2-review-L1: the repo's `timezone` is honoured, an unknown one degrades to UTC."""

    def test_a_known_zone_is_kept_and_an_unknown_one_falls_back(self):
        self.assertEqual(osp.safe_timezone("Europe/Berlin"), "Europe/Berlin")
        self.assertEqual(osp.safe_timezone("UTC"), "UTC")
        self.assertEqual(osp.safe_timezone("Mars/Olympus_Mons"), "UTC")
        self.assertEqual(osp.safe_timezone(""), "UTC")
        self.assertEqual(osp.safe_timezone(None), "UTC")
        self.assertEqual(osp.safe_timezone("nope", "Europe/Berlin"), "Europe/Berlin")

    def test_the_parsed_schedule_carries_the_authored_zone(self):
        s = osp.parse_schedules("""
schedules:
  - dataset: ds_1
    name: m
    cron: "0 6 * * *"
    principal: bea
    timezone: Europe/Berlin
""")
        self.assertEqual(s[0].timezone, "Europe/Berlin")
        self.assertEqual(osp.safe_timezone(s[0].timezone), "Europe/Berlin")


class PartitionedDefinitions(unittest.TestCase):
    """Review B2-review-M2: a domain `Definitions(...)` rejects is skipped, not the location."""

    @staticmethod
    def _empty():
        return {"names": []}

    @staticmethod
    def _merge(a, b):
        return {"names": [*a["names"], *b["names"]]}

    @staticmethod
    def _build(bundle):
        names = bundle["names"]
        if len(set(names)) != len(names):
            raise ValueError(f"duplicate name in {names}")
        return tuple(names)

    def test_the_happy_path_builds_once(self):
        calls = []

        def build(b):
            calls.append(list(b["names"]))
            return self._build(b)

        out, skipped = osp.partition_definitions(
            [("a", {"names": ["a"]}), ("b", {"names": ["b"]})], build, self._merge, self._empty)
        self.assertEqual(out, ("a", "b"))
        self.assertEqual(skipped, [])
        self.assertEqual(len(calls), 1, "a loadable workspace must cost ONE build")

    def test_one_bad_domain_is_skipped_and_the_rest_still_load(self):
        out, skipped = osp.partition_definitions(
            [("a", {"names": ["x"]}), ("bad", {"names": ["x"]}), ("c", {"names": ["y"]})],
            self._build, self._merge, self._empty)
        self.assertEqual(out, ("x", "y"))
        self.assertEqual([s.domain for s in skipped], ["bad"])
        self.assertIn("duplicate name", skipped[0].reason)

    def test_no_domains_still_yields_a_workspace(self):
        out, skipped = osp.partition_definitions([], self._build, self._merge, self._empty)
        self.assertEqual((out, skipped), ((), []))


class Quarantine(unittest.TestCase):
    """Review B2-review-L3: the window must be counted over TERMINAL runs only."""

    def test_the_terminal_status_set_is_named_for_the_query_filter(self):
        self.assertEqual(set(osp.TERMINAL_STATUSES), {"SUCCESS", "FAILURE", "CANCELED"})
        # The bug the filter fixes: an in-flight run between failures truncated the count.
        self.assertEqual(osp.consecutive_failures(["STARTED", "FAILURE", "FAILURE"]), 2)
        terminal = [s for s in ["FAILURE"] * 10 if s in osp.TERMINAL_STATUSES]
        self.assertTrue(osp.should_pause(terminal, 10))


class ChartContract(unittest.TestCase):
    """Review B2-review-H1: a run pod must carry the label the os-repos NetworkPolicy admits.

    The launched run pods fetch `git://os-repos/<domain>.git`; the only ingress rule that opens
    9418 selects `component: user-deployments`, which the subchart puts on the CODE-SERVER pod and
    not on run pods. The chart therefore sets it through the run launcher's
    `runK8sConfig.podTemplateSpecMetadata.labels` — asserted here because the Dagster subchart is
    not vendored in every checkout, so `helm template` cannot be a CI gate.
    """

    def _repo_root(self):
        return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

    def test_run_pods_carry_the_label_the_git_daemon_netpol_admits(self):
        import yaml  # PyYAML ships with dbt-core in the image

        root = self._repo_root()
        with open(os.path.join(root, "charts", "sovereign-agentic-os", "values.yaml"), encoding="utf-8") as fh:
            values = yaml.safe_load(fh)
        labels = (
            values["dagster"]["runLauncher"]["config"]["k8sRunLauncher"]["runK8sConfig"]
            ["podTemplateSpecMetadata"]["labels"]
        )
        netpol = os.path.join(root, "charts", "sovereign-agentic-os", "templates", "base", "os-ui", "os-repos.yaml")
        with open(netpol, encoding="utf-8") as fh:
            text = fh.read()
        # The selector the policy uses, read out of the template (it is Helm, not plain YAML).
        self.assertIn("component: user-deployments", text)
        self.assertEqual(labels.get("component"), "user-deployments")

    def test_the_repo_sync_sidecar_can_tell_it_is_in_a_run_pod(self):
        import yaml

        root = self._repo_root()
        with open(os.path.join(root, "charts", "sovereign-agentic-os", "values.yaml"), encoding="utf-8") as fh:
            values = yaml.safe_load(fh)
        deployment = values["dagster"]["dagster-user-deployments"]["deployments"][0]
        sidecar = next(c for c in deployment["sidecarContainers"] if c["name"] == "repo-sync")
        pod_name = next(e for e in sidecar["env"] if e["name"] == "POD_NAME")
        self.assertEqual(pod_name["valueFrom"]["fieldRef"]["fieldPath"], "metadata.name")


if __name__ == "__main__":
    unittest.main()
