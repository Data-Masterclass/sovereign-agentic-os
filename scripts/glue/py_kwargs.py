# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE:    GLUE-10 helper: find OS metadata in generated Python (Dagster definitions) with
#             Python's own parser (`ast`), never a regex.
# USER STORY: As the owner I want `ScheduleDefinition(..., principal='amir')` refused: OS
#             metadata in Dagster code belongs in `tags=` / `metadata=`, Dagster's documented
#             extension points (artifact contract C2).
# ARCHITECTURE:
#   - Reads a JSON list of {"path", "source"} on stdin; prints a JSON list of findings
#     {"path", "line", "detail"}. A file that does not parse is itself a finding.
#   - A finding: a keyword argument or a dict key that names an OS concept (os…, principal,
#     owner, uid) anywhere EXCEPT inside the value of a `tags=` or `metadata=` keyword.
#   - Standard library only; run with `python3 -I`.
import ast
import json
import re
import sys

OS_NAME = re.compile(r"^(os($|[_\-/.:A-Z])|x[-_]os|sovereign|principal$|owner$|uid$)", re.IGNORECASE)
EXTENSION_KWARGS = {"tags", "metadata", "op_tags", "run_tags"}


class Finder(ast.NodeVisitor):
    def __init__(self):
        self.found = []
        self.depth_in_ext = 0

    def visit_Call(self, node):
        self.visit(node.func)
        for a in node.args:
            self.visit(a)
        for kw in node.keywords:
            if kw.arg is not None and OS_NAME.search(kw.arg) and not self.depth_in_ext:
                self.found.append((kw.value.lineno, f"keyword `{kw.arg}=` — OS metadata goes in tags= / metadata="))
            if kw.arg in EXTENSION_KWARGS:
                self.depth_in_ext += 1
                self.visit(kw.value)
                self.depth_in_ext -= 1
            else:
                self.visit(kw.value)

    def visit_Dict(self, node):
        if not self.depth_in_ext:
            for k in node.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str) and OS_NAME.search(k.value):
                    self.found.append((k.lineno, f"dict key `{k.value}` outside tags= / metadata="))
        self.generic_visit(node)


def main():
    items = json.load(sys.stdin)
    out = []
    for it in items:
        try:
            tree = ast.parse(it["source"], filename=it["path"])
        except SyntaxError as e:
            out.append({"path": it["path"], "line": e.lineno or 0, "detail": f"does not parse as Python: {e.msg}"})
            continue
        f = Finder()
        f.visit(tree)
        out.extend({"path": it["path"], "line": ln, "detail": d} for ln, d in f.found)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
