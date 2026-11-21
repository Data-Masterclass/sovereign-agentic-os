# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""The principals sensor reads the OS index snapshot repo-sync writes, so the user-code container
(and so every run pod) needs no bearer.

FEATURE:    `os_projects.read_index_file` — the snapshot, or None when it is missing, unreadable,
            or older than `max_age_seconds` (an old snapshot must not keep pausing or not pausing).
USER STORY: As a data owner I want a deactivated owner's schedules paused without any credential
            sitting where model code can read it.
ARCHITECTURE: The real repo-sync writes the file in the image test (tests/image/index_file.sh).
"""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_projects as osp  # noqa: E402


class IndexFile(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.f = os.path.join(self.d, ".os-index.json")

    def test_reads_the_snapshot_and_its_inactive_principals(self):
        doc = {"domains": [{"name": "sales", "principals": [{"id": "bea", "active": False}, {"id": "amir", "active": True}]}]}
        json.dump(doc, open(self.f, "w"))
        got = osp.read_index_file(self.f)
        self.assertEqual(got, doc)
        self.assertEqual(osp.inactive_principals(got), {"bea"})

    def test_missing_unreadable_or_stale_is_none(self):
        self.assertIsNone(osp.read_index_file(self.f))
        open(self.f, "w").write("{not json")
        self.assertIsNone(osp.read_index_file(self.f))
        json.dump({"domains": []}, open(self.f, "w"))
        old = time.time() - 3600
        os.utime(self.f, (old, old))
        self.assertIsNone(osp.read_index_file(self.f, max_age_seconds=900))
        self.assertEqual(osp.read_index_file(self.f, max_age_seconds=7200), {"domains": []})
        self.assertIsNone(osp.read_index_file(""))


if __name__ == "__main__":
    unittest.main()
