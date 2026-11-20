# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Unit tests for os_projects.py — run with `python3 -m unittest discover -s images/extensions/dagster/tests`.

FEATURE:    Prove the platform wrapper's pure half: repo checkouts in the design-12 layout →
            projects whose definitions match the OS-recorded hash (a tampered or unrecorded one is
            refused); a broken checkout is skipped, not fatal; run-pod bootstrap clones + parses
            `data/dbt` exactly once; platform run tags; quarantine and principal pauses.
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
import re
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_projects as osp  # noqa: E402

SHA_A = "a" * 40
SHA_B = "b" * 40

def manifest(nodes):
    return json.dumps({"nodes": nodes})


DEFINITIONS = "import dagster as dg\n\ndefs = dg.Definitions()\n"


def write_project(root, domain, sha, with_manifest=True, definitions=DEFINITIONS, recorded=None):
    """A checkout in the repo layout (design 12): data/dbt, data/dagster, os/generated.yml."""
    import hashlib

    sha_dir = os.path.join(root, domain, sha)
    dbt = os.path.join(sha_dir, osp.DBT_PROJECT_DIR)
    os.makedirs(os.path.join(sha_dir, "os"), exist_ok=True)
    os.makedirs(dbt, exist_ok=True)
    if with_manifest:
        os.makedirs(os.path.join(dbt, "target"), exist_ok=True)
        with open(os.path.join(dbt, "target", "manifest.json"), "w") as fh:
            fh.write(manifest({}))
    if definitions is not None:
        path = os.path.join(sha_dir, osp.DAGSTER_DEFINITIONS_PATH)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(definitions)
        digest = recorded or hashlib.sha256(definitions.encode()).hexdigest()
        with open(os.path.join(sha_dir, osp.GENERATED_PATH), "w") as fh:
            fh.write(f"version: 1\nsha256:\n  {osp.DAGSTER_DEFINITIONS_PATH}: {digest}\n")
    link = os.path.join(root, domain, "current")
    if os.path.islink(link):
        os.unlink(link)
    os.symlink(sha, link)
    return sha_dir


class Discovery(unittest.TestCase):
    def test_n_repo_checkouts_give_n_projects_and_a_broken_one_is_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            write_project(root, "sales", SHA_A)
            write_project(root, "finance", SHA_B)
            write_project(root, "broken", SHA_A, with_manifest=False)
            write_project(root, "nodefs", SHA_A, definitions=None)
            os.makedirs(os.path.join(root, "nocurrent"))
            os.makedirs(os.path.join(root, ".mirrors"))
            projects, skipped = osp.discover(root)
            self.assertEqual([p.domain for p in projects], ["finance", "sales"])
            sales = projects[1]
            self.assertEqual(sales.sha, SHA_A)
            self.assertTrue(sales.definitions.endswith(os.path.join("sales", SHA_A, "data", "dagster", "definitions.py")))
            self.assertTrue(sales.manifest.endswith(os.path.join("data", "dbt", "target", "manifest.json")))
            reasons = {s.domain: s.reason for s in skipped}
            self.assertEqual(sorted(reasons), ["broken", "nocurrent", "nodefs"])
            self.assertIn("data/dbt/target/manifest.json", reasons["broken"])
            self.assertIn("no data/dagster/definitions.py", reasons["nodefs"])
            self.assertEqual(osp.pinned_env(projects), f"finance={SHA_B},sales={SHA_A}")

    def test_pinned_commit_bootstraps_a_run_pod_checkout_once_and_parses_data_dbt(self):
        import shutil

        calls = []
        with tempfile.TemporaryDirectory() as root:
            template = write_project(os.path.join(root, "tpl"), "x", SHA_B)

            def fake_run(cmd, cwd=None, env=None):
                calls.append((list(cmd), cwd))
                if cmd[:2] == ["git", "clone"]:
                    tmp = cmd[-1]
                    os.makedirs(os.path.join(tmp, ".git"))
                    # what the clone brings: the generated definitions and their recorded hash
                    shutil.copytree(os.path.join(template, "data", "dagster"), os.path.join(tmp, "data", "dagster"))
                    shutil.copytree(os.path.join(template, "os"), os.path.join(tmp, "os"))
                    return 0, ""
                if cmd[0] == "dbt":
                    os.makedirs(os.path.join(cwd, "target"), exist_ok=True)
                    with open(os.path.join(cwd, "target", "manifest.json"), "w") as fh:
                        fh.write(manifest({}))
                    return 0, ""
                return 0, ""
            projects, skipped = osp.discover(os.path.join(root, "co"), {"sales": SHA_A}, "git://os-repos", fake_run)
            self.assertEqual(skipped, [])
            self.assertEqual([(p.domain, p.sha) for p in projects], [("sales", SHA_A)])
            clone = [c for c in calls if c[0][:2] == ["git", "clone"]]
            self.assertEqual(clone[0][0][-2], "git://os-repos/sales.git")
            self.assertEqual([c for c in calls if c[0][0] == "dbt"][0][1], os.path.join(root, "co", "sales", SHA_A, "data", "dbt"))
            calls.clear()
            osp.discover(os.path.join(root, "co"), {"sales": SHA_A}, "git://os-repos", fake_run)
            self.assertEqual(calls, [], "second discovery: the checkout exists — no git, no dbt")

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


class GeneratedHash(unittest.TestCase):
    """C5: the code server imports a domain's definitions only when they are what the OS generated."""

    def test_a_tampered_definitions_file_is_refused_before_import(self):
        with tempfile.TemporaryDirectory() as root:
            sha_dir = write_project(root, "sales", SHA_A)
            with open(os.path.join(sha_dir, osp.DAGSTER_DEFINITIONS_PATH), "a") as fh:
                fh.write("import os\n")
            projects, skipped = osp.discover(root)
            self.assertEqual(projects, [])
            self.assertIn("differs from the OS-generated", skipped[0].reason)

    def test_no_recorded_hash_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            sha_dir = write_project(root, "sales", SHA_A)
            os.remove(os.path.join(sha_dir, osp.GENERATED_PATH))
            projects, skipped = osp.discover(root)
            self.assertEqual(projects, [])
            self.assertIn("records no sha256", skipped[0].reason)


class LayoutAgreement(unittest.TestCase):
    """The image's paths are the ones os-ui's generator writes (os-ui/core/infra/data-layout.ts)."""

    def test_the_paths_match_the_ts_constant(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "..", "..", "..", "os-ui", "core", "infra", "data-layout.ts"), encoding="utf-8") as fh:
            ts = fh.read()
        self.assertIn(f"dagsterDefinitionsPath: '{osp.DAGSTER_DEFINITIONS_PATH}'", ts)
        self.assertIn(f"dbtProjectDir: '{osp.DBT_PROJECT_DIR}'", ts)
        self.assertIn(f"generatedHashesPath: '{osp.GENERATED_PATH}'", ts)


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

class PerSchedulePinning(unittest.TestCase):
    """Review B2-review-L4: a run pod checks out ITS domain, not every domain."""

    def test_pinned_one_pins_exactly_one_domain_and_round_trips(self):
        pin = osp.pinned_one("sales", "b" * 40)
        self.assertEqual(pin, "sales=" + "b" * 40)
        self.assertEqual(osp.parse_pinned(pin), {"sales": "b" * 40})

    def test_the_platform_run_tag_carries_only_its_own_domain_and_the_jobs_principal(self):
        tags = osp.platform_run_tags("sales", "c" * 40, osp.pinned_one("sales", "c" * 40), {"os/principal": "bea"})
        env = {e["name"]: e["value"] for e in json.loads(tags["dagster-k8s/config"])["container_config"]["env"]}
        self.assertEqual(osp.parse_pinned(env["OS_PINNED_COMMITS"]), {"sales": "c" * 40}, "one domain per run pod")
        self.assertEqual(env["OS_PRINCIPAL"], "bea")
        self.assertEqual(env["DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME"], "bea", "dlt writes as the same principal")
        self.assertEqual(tags["os/commit"], "c" * 40)

    def test_a_malformed_principal_is_dropped_never_passed_on(self):
        for bad in ("bea admin", "-bea", "bea'", "x" * 65, ""):
            tags = osp.platform_run_tags("sales", SHA_A, osp.pinned_one("sales", SHA_A), {"os/principal": bad})
            env = {e["name"] for e in json.loads(tags["dagster-k8s/config"])["container_config"]["env"]}
            self.assertEqual(env, {"OS_PINNED_COMMITS"}, bad)

    def test_repo_py_pins_per_domain_not_per_workspace(self):
        """A source tripwire: `wrap_domain` must derive its pin from its OWN project."""
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "repo.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("pinned = osp.pinned_one(p.domain, p.sha)", src)


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


class ParseErrorSummary(unittest.TestCase):
    """Live incident 2026-11 (track H): the log said only "failed dbt parse", never WHICH error."""

    # Captured verbatim from `os_projects.py --parse` in ghcr.io/aborek/sovereign-os/dagster:0.3.1
    # (dbt-core 1.9.11) on a generated project whose rule was recorded twice.
    DBT_DUPLICATE_TEST = (
        "INFO:trino.auth:keyring module not found. OAuth2 token will not be stored in keyring.\n"
        "21:59:39  Encountered an error:\n"
        "Compilation Error\n"
        '  dbt found two data_tests with the name "not_null_gold_goods_receipts_po_number" defined on column "po_number" in "models.gold_goods_receipts".\n'
        "  \n"
        "  Since these resources have the same name, dbt will be unable to find the correct resource\n"
        "  when running tests.\n"
    )

    def test_names_the_error_kind_and_message(self):
        got = osp.parse_error_summary(self.DBT_DUPLICATE_TEST)
        self.assertTrue(got.startswith("Compilation Error: dbt found two data_tests with the name"), got)
        self.assertIn("not_null_gold_goods_receipts_po_number", got)
        self.assertNotIn("keyring", got)

    def test_a_one_line_error_and_empty_output(self):
        self.assertEqual(osp.parse_error_summary("12:00:00  Runtime Error: No dbt_project.yml found"), "Runtime Error: No dbt_project.yml found")
        self.assertEqual(osp.parse_error_summary(""), "no output from dbt parse")
        self.assertEqual(len(osp.parse_error_summary("Error " + "x" * 2000)), 400)

    def test_repo_sync_logs_the_summary_on_a_failed_parse(self):
        sh = os.path.join(os.path.dirname(__file__), "..", "repo-sync.sh")
        with open(sh, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('os_projects.py" --error-summary', text)
        self.assertRegex(text, r'failed dbt parse — schedules keep running \$\{current:-nothing\} — \$why')


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


class SanitizeGolden(unittest.TestCase):
    """The shared collision golden — asserted here AND by core/infra/dagster.test.ts (B3)."""

    def test_sanitize_all_matches_the_shared_golden(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "sanitize-collisions.golden.json"), encoding="utf-8") as fh:
            golden = json.load(fh)
        self.assertEqual(osp.sanitize_all(golden["inputs"]), golden["expected"])
        # The property the OS depends on: a name never changes because an unrelated domain appeared.
        subset = [n for n in golden["inputs"] if n != "finance"]
        for name in subset:
            if list(golden["inputs"]).count(name) == 1 and osp.sanitize(name) not in {osp.sanitize(o) for o in subset if o != name}:
                self.assertEqual(osp.sanitize_all(subset)[name], golden["expected"][name], name)


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

    def test_every_dagster_image_reference_carries_the_same_tag(self):
        """Part F / checklist D10: the OS's Dagster image is referenced in FOUR places in
        values.yaml — the user-deployment image, the repo-sync sidecar's inline
        `<repo>:<tag>@<digest>`, and the webserver and daemon image blocks. Repository, tag and
        digest must agree in all four. A bump that
        misses one silently runs a code location and its run pods on DIFFERENT images, which is
        exactly the "no driver, 0 runs" failure mode D10 exists to catch. The row claimed this
        was asserted here and it was not; now it is.
        """
        import yaml

        root = self._repo_root()
        path = os.path.join(root, "charts", "sovereign-agentic-os", "values.yaml")
        with open(path, encoding="utf-8") as fh:
            values = yaml.safe_load(fh)

        refs = []  # (where, repository, tag, digest)
        deployment = values["dagster"]["dagster-user-deployments"]["deployments"][0]
        img = deployment["image"]
        refs.append(("user-deployment image", img["repository"], str(img["tag"]), img.get("digest")))
        sidecar = next(c for c in deployment["sidecarContainers"] if c["name"] == "repo-sync")
        m = re.match(r"^([^:@]+(?::\d+)?/[^:@]+):([^@]+)(?:@(sha256:[0-9a-f]{64}))?$", sidecar["image"])
        self.assertIsNotNone(m, "the repo-sync sidecar image is not repo:tag[@digest]: %s" % sidecar["image"])
        refs.append(("repo-sync sidecar image", m.group(1), m.group(2), m.group(3)))
        for block in ("dagsterWebserver", "dagsterDaemon"):
            image = values["dagster"][block]["image"]
            refs.append(("%s image" % block, image["repository"], str(image["tag"]), image.get("digest")))
        self.assertEqual(len(refs), 4, "expected FOUR image references; the chart changed shape")
        for where, repo, _, _ in refs:
            self.assertTrue(repo.endswith("/sovereign-os/dagster") or repo == "sovereign-os/dagster",
                            "%s no longer runs the OS's Dagster image: %s" % (where, repo))
        for field, idx in (("repository", 1), ("tag", 2), ("digest", 3)):
            distinct = sorted({str(r[idx]) for r in refs})
            self.assertEqual(
                len(distinct), 1,
                "the Dagster image %s disagrees across values.yaml: %s" % (field, ", ".join("%s=%s" % (r[0], r[idx]) for r in refs)),
            )
        distinct = [refs[0][2]]
        # And it must be the OS's own image, never an upstream dagster tag.
        self.assertRegex(distinct[0], r"^\d+\.\d+\.\d+$", "the OS Dagster image tag is not a semver")

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


class ParseVerdict(unittest.TestCase):
    """Only dbt's own refusal is cached by repo-sync; anything that did not finish is retried (WP-03)."""

    def test_dbt_refusal_is_cached(self):
        out = "06:24:58  Encountered an error:\nParsing Error\n  'label' is a required property"
        self.assertTrue(osp.is_dbt_refusal(2, out))
        self.assertTrue(osp.is_dbt_refusal(1, "Compilation Error in model x"))

    def test_timeout_signal_and_not_run_are_not_refusals(self):
        self.assertFalse(osp.is_dbt_refusal(osp.RC_TIMEOUT, "dbt did not finish within 600s (timed out)"))
        self.assertFalse(osp.is_dbt_refusal(-9, ""), "an OOM kill")
        self.assertFalse(osp.is_dbt_refusal(osp.RC_NOT_RUN, "[Errno 2] No such file or directory: 'dbt'"))
        self.assertFalse(osp.is_dbt_refusal(1, ""), "exit 1 with no dbt error text")

    def test_run_reports_a_timeout_as_rc_timeout(self):
        code, out = osp._run(["sleep", "5"], timeout=0.2)
        self.assertEqual(code, osp.RC_TIMEOUT)
        self.assertIn("timed out", out)
