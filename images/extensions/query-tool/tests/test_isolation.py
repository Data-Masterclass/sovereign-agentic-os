# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""The tripwire for the Part F isolation defect (F-4). Run with:

    python3 -m unittest discover -s images/extensions/query-tool/tests

FEATURE:    Keep ONE discovery pass honest. Four modules share one `app` module and one fake
            `trino`; the old failure mode was invisible — every file passed alone, seven tests
            failed together, and nothing said why.
USER STORY: As a maintainer I want a module that FAILS when someone reintroduces private stubs or
            leaves `app` monkeypatched, instead of a future reviewer rediscovering it by running
            the files in a different order.
ARCHITECTURE:
  - Named `test_isolation` so alphabetical discovery places it AFTER the three suites that patch
    `app` (`test_app_concurrency`, `test_bearer`, `test_execute_guard`) and before the one that
    needs a clean `app` (`test_query_budget`). A patch that outlives its module is caught HERE,
    at the seam, rather than as a mystery assertion in the budget suite.
  - The source scan is a static tripwire: a per-module `setdefault` into `sys.modules` is exactly
    the call that let the first importer win, so no module here may contain it. The needle is
    assembled at runtime so this file does not match itself.
"""
import os
import sys
import unittest

import _stubs

STUB = _stubs.install()

import app  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))


def _test_sources():
    for name in sorted(os.listdir(_HERE)):
        if name.startswith("test_") and name.endswith(".py"):
            with open(os.path.join(_HERE, name), encoding="utf-8") as fh:
                yield name, fh.read()


class SharedStubsAreTheOnlyStubs(unittest.TestCase):
    def test_no_module_installs_its_own_stubs(self):
        needle = "sys.modules" + ".setdefault"  # assembled so this very file is not an offender
        offenders = [n for n, src in _test_sources() if needle in src]
        self.assertEqual(
            offenders, [],
            "a per-module setdefault stub is what made one discovery pass fail — "
            "use `_stubs.install()` so every module shares one fake trino and one `app`",
        )

    def test_every_module_goes_through_the_shared_installer(self):
        missing = [n for n, src in _test_sources() if "import _stubs" not in src]
        self.assertEqual(
            missing, [],
            "every module here must import `_stubs` — it is what puts the package dir on sys.path "
            "and installs the one set of runtime fakes",
        )

    def test_there_is_exactly_one_app_and_one_fake_trino(self):
        self.assertIs(sys.modules["app"], app, "two `app` modules means two sets of module state")
        self.assertIs(app.trino, sys.modules["trino"], "`app` is bound to a different fake trino")
        # Behavioural, not structural: the connect `app` would call must record into THIS handle.
        # When it does not, a second stub is installed and a recorder somewhere is dead — which is
        # exactly how the original defect presented (empty CONNECTS, `0 != 1`).
        before = len(STUB.connects)
        app.trino.dbapi.connect(probe="isolation")
        self.assertEqual(
            len(STUB.connects), before + 1,
            "app's trino.connect does not record into the shared stub — a second stub is installed",
        )
        self.assertEqual(STUB.connects[-1], {"probe": "isolation"})
        STUB.reset()


class NoSuiteLeavesAppPatched(unittest.TestCase):
    """Runs after the three patching suites — a leaked monkeypatch fails here, by name."""

    def test_run_query_and_run_execute_are_the_real_ones(self):
        for knob in ("run_query", "run_execute"):
            fn = getattr(app, knob)
            self.assertEqual(
                getattr(fn, "__module__", None), "app",
                f"app.{knob} is still a test double — a suite patched it and did not restore it "
                "(snapshot with `_stubs.snapshot_app` in setUp, restore in tearDown)",
            )

    def test_the_bearer_token_is_back_to_its_default(self):
        self.assertEqual(
            app.SERVICE_BEARER_TOKEN, "",
            "a suite left SERVICE_BEARER_TOKEN set — every later handler test would get a 401",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
