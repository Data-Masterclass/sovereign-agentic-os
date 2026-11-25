# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# image-inventory.py — runs INSIDE a built image (`python -I -`) and prints, as one JSON document,
# everything scripts/license-gate-image.mjs needs to judge the image's licences:
#   python    every installed distribution (importlib.metadata over the interpreter's sys.path):
#             name, version, License-Expression, License classifiers, short License field
#   embedded  components listed in the CycloneDX SBOMs a wheel ships in *.dist-info/sboms/ (e.g. the
#             Rust crates compiled into litellm's rust_bridge native module), with their licences
#   npm       every package.json under the node_modules trees given in argv (the Prisma CLI)
#   forbidden every trace of the proprietary LiteLLM enterprise code: an importable `litellm_enterprise`,
#             a distribution of that name, or a file/directory named like it anywhere under the scanned roots;
#             and every trace of the Langfuse Enterprise Edition (images/extensions/langfuse-oss): the
#             `@langfuse/ee` package, a web/src/ee, worker/src/ee or worker/dist/ee directory, or a module
#             path of web/src/ee or worker/src/ee inside built output (.next/, dist/). Langfuse's MIT
#             packages/shared/.../server/ee is not a trace (its root LICENSE names only those directories).
# Standard library only, so it runs on any CPython >= 3.9 image. Reads files; writes nothing.
#
# ROOTFS MODE (IMAGE_INVENTORY_ROOTFS=<dir>): for an image WITHOUT Python (the Langfuse images are
# node:alpine). scripts/license-gate-image.mjs --rootfs exports the image's filesystem to <dir> and runs
# this script on the host; every scanned path is read under <dir> and reported as the path inside the
# image. The host interpreter's own distributions are not listed (the image has no Python).
import importlib.metadata as md
import importlib.util
import json
import os
import sys

NODE_ROOTS = [a for a in sys.argv[1:] if a]
FORBIDDEN_DISTS = {"litellm-enterprise", "litellm_enterprise", "litellm-admin-mcp"}
FORBIDDEN_NAMES = ("litellm_enterprise", "litellm-enterprise")
SCAN_ROOTS = ["/app", "/opt", "/usr/local/lib", "/usr/lib/python3", "/root", "/srv"]
# Tests point the path scan at a fixture tree (scripts/tests/license-gate.test.mjs); never set in an image run.
if os.environ.get("IMAGE_INVENTORY_SCAN_ROOTS"):
    SCAN_ROOTS = os.environ["IMAGE_INVENTORY_SCAN_ROOTS"].split(os.pathsep)
ROOTFS = os.environ.get("IMAGE_INVENTORY_ROOTFS", "").rstrip("/")

def host(p):
    """The path to read: under the exported rootfs in ROOTFS mode."""
    return ROOTFS + p if ROOTFS else p

def inside(p):
    """The path to report: as seen inside the image."""
    return p[len(ROOTFS):] or "/" if ROOTFS and p.startswith(ROOTFS) else p

out = {"python": [], "embedded": [], "npm": [], "forbidden": [],
       "pythonVersion": "none (rootfs)" if ROOTFS else sys.version.split()[0]}

seen = set()
for dist in ([] if ROOTFS else md.distributions()):
    m = dist.metadata
    name = m.get("Name") or ""
    key = (name.lower(), dist.version)
    if not name or key in seen:
        continue
    seen.add(key)
    out["python"].append({
        "name": name,
        "version": dist.version,
        "license_expression": m.get("License-Expression") or "",
        "classifier": [c for c in (m.get_all("Classifier") or []) if c.startswith("License ::")],
        "license": (m.get("License") or "")[:400],
    })
    if name.lower().replace("_", "-") in FORBIDDEN_DISTS:
        out["forbidden"].append(f"distribution {name}=={dist.version}")
    # Embedded SBOMs (PEP 770): components compiled INTO this wheel, with their own licences.
    for f in dist.files or []:
        p = str(f)
        if ".dist-info/sboms/" in p and p.endswith(".json"):
            try:
                doc = json.loads(f.read_text())
            except Exception as exc:  # an unreadable SBOM must not pass silently
                out["embedded"].append({"name": f"{name}:{p}", "version": "?", "expression": "", "error": str(exc)})
                continue
            for c in doc.get("components", []):
                exprs = []
                for lic in c.get("licenses", []):
                    if lic.get("expression"):
                        exprs.append(lic["expression"])
                    elif lic.get("license"):
                        exprs.append(lic["license"].get("id") or lic["license"].get("name") or "")
                expr = " AND ".join(f"({e})" if (" OR " in e and len(exprs) > 1) else e for e in exprs if e)
                out["embedded"].append({"name": f"{name}/{c.get('name')}", "version": c.get("version", "?"), "expression": expr})

if not ROOTFS and importlib.util.find_spec("litellm_enterprise") is not None:
    out["forbidden"].append("module litellm_enterprise is importable")

def enterprise_dir(dirpath, name):
    """A plain `enterprise/` directory where LiteLLM's enterprise code lives or is imported from:
    inside the litellm package (litellm/enterprise, litellm/proxy/enterprise), at the top of a
    site-packages directory (`import enterprise`), or the upstream image's /app/enterprise."""
    if name != "enterprise":
        return False
    parent = os.path.basename(dirpath)
    grand = os.path.basename(os.path.dirname(dirpath))
    return (parent == "litellm" or (parent == "proxy" and grand == "litellm")
            or parent in ("site-packages", "dist-packages") or dirpath.rstrip("/") == "/app")


# Langfuse Enterprise Edition (images/extensions/langfuse-oss). Langfuse's root LICENSE puts ee/, web/src/ee/
# and worker/src/ee/ under the Enterprise License; compiled, the worker keeps the layout (worker/dist/ee) and
# Next.js keeps module paths in its chunks.
LANGFUSE_EE_CODE = (b"web/src/ee/", b"worker/src/ee/", b"@langfuse/ee/")
# Next.js production chunks keep no module paths, so the web image is also searched for the EE FINGERPRINTS:
# string literals of the EE sources that occur nowhere in Langfuse's MIT source. They are computed from the
# upstream checkout at build time (images/extensions/langfuse-oss/prepare-source.mjs, Dockerfile target
# `ee-fingerprints`) and handed in as a file; nothing of the EE code is kept in this repository.
LANGFUSE_FINGERPRINTS = []
if os.environ.get("IMAGE_INVENTORY_LANGFUSE_FINGERPRINTS"):
    with open(os.environ["IMAGE_INVENTORY_LANGFUSE_FINGERPRINTS"], "rb") as fh:
        LANGFUSE_FINGERPRINTS = [l.strip() for l in fh.read().split(b"\n") if len(l.strip()) >= 24]

def langfuse_ee_dir(dirpath, name):
    if name != "ee":
        return False
    parent = os.path.basename(dirpath)
    grand = os.path.basename(os.path.dirname(dirpath))
    return (parent == "@langfuse"
            or (parent == "src" and grand in ("web", "worker"))
            or (parent == "dist" and grand == "worker"))

def built_output(path):
    return ("/.next/" in path or "/worker/dist/" in path) and path.endswith((".js", ".mjs", ".cjs", ".json", ".html"))


for root in SCAN_ROOTS:
    for dirpath, dirnames, filenames in os.walk(host(root)):
        if "/proc" in dirpath:
            continue
        for n in dirnames + filenames:
            if n.lower().startswith(FORBIDDEN_NAMES):
                out["forbidden"].append(f"path {inside(os.path.join(dirpath, n))}")
        for n in dirnames:
            if enterprise_dir(inside(dirpath), n):
                out["forbidden"].append(f"enterprise directory {inside(os.path.join(dirpath, n))}")
            if langfuse_ee_dir(dirpath, n):
                kind = "langfuse ee package" if os.path.basename(dirpath) == "@langfuse" else "langfuse ee directory"
                out["forbidden"].append(f"{kind} {inside(os.path.join(dirpath, n))}")
        for n in filenames:
            p = os.path.join(dirpath, n)
            if built_output(p) and not os.path.islink(p):
                try:
                    if os.path.getsize(p) > 64 * 1024 * 1024:
                        continue
                    with open(p, "rb") as fh:
                        data = fh.read()
                except OSError:
                    continue
                if any(s in data for s in LANGFUSE_EE_CODE):
                    out["forbidden"].append(f"langfuse ee code {inside(p)}")
                elif any(s in data for s in LANGFUSE_FINGERPRINTS):
                    out["forbidden"].append(f"langfuse ee code {inside(p)} (fingerprint)")

for root in NODE_ROOTS:
    for dirpath, dirnames, filenames in os.walk(host(root)):
        parent = os.path.dirname(dirpath)
        is_pkg = os.path.basename(parent) == "node_modules" or (
            os.path.basename(parent).startswith("@") and os.path.basename(os.path.dirname(parent)) == "node_modules")
        if "package.json" in filenames and is_pkg:
            try:
                pkg = json.load(open(os.path.join(dirpath, "package.json")))
            except Exception:
                continue
            lic = pkg.get("license") or pkg.get("licenses") or ""
            if isinstance(lic, dict):
                lic = lic.get("type", "")
            if isinstance(lic, list):
                lic = " OR ".join(x.get("type", "") if isinstance(x, dict) else str(x) for x in lic)
            out["npm"].append({"name": pkg.get("name") or os.path.basename(dirpath), "version": pkg.get("version", "0.0.0"),
                               "expression": lic, "path": inside(dirpath)})

json.dump(out, sys.stdout)
