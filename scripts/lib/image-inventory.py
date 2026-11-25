# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# image-inventory.py — runs INSIDE a built image (`python -I -`) and prints, as one JSON document,
# everything scripts/license-gate-image.mjs needs to judge the image's licences:
#   python    every installed distribution (importlib.metadata over the interpreter's sys.path):
#             name, version, License-Expression, License classifiers, short License field
#   embedded  components listed in the CycloneDX SBOMs a wheel ships in *.dist-info/sboms/ (e.g. the
#             Rust crates compiled into litellm's rust_bridge native module), with their licences
#   npm       every package.json under the node_modules trees given in argv (the Prisma CLI), with the licence
#             files in the package directory (`licenceFiles`: LICENSE*, LICENCE*, COPYING*, NOTICE*); and every
#             package VENDORED inside another one's dist/compiled/ tree (Next.js ships e.g. @vercel/og there):
#             named <vendor>/compiled/<name>, judged by its own declaration, or by the vendor's when it has none
#   licenceTexts  the file names in IMAGE_INVENTORY_LICENCE_TEXTS (a directory inside the image), if given, and
#             licenceManifest: the lines of packages-without-licence-file.txt NEXT TO that directory (written by
#             images/extensions/langfuse-oss/ship-licence-files.mjs), or null when the image has no such file
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
import re
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

LICENCE_FILE = re.compile(r"^(licen[cs]e|copying|notice)", re.I)

def licence_of(pkg):
    lic = pkg.get("license") or pkg.get("licenses") or ""
    if isinstance(lic, dict):
        lic = lic.get("type", "")
    if isinstance(lic, list):
        lic = " OR ".join(x.get("type", "") if isinstance(x, dict) else str(x) for x in lic)
    return lic

def read_pkg(dirpath):
    try:
        with open(os.path.join(dirpath, "package.json")) as fh:
            return json.load(fh)
    except Exception:
        return None

def licence_files(dirpath, names=None):
    try:
        names = os.listdir(dirpath) if names is None else names
    except OSError:
        return []
    return sorted(f for f in names if LICENCE_FILE.match(f))

for root in NODE_ROOTS:
    for dirpath, dirnames, filenames in os.walk(host(root)):
        if "package.json" not in filenames:
            continue
        parent = os.path.dirname(dirpath)
        is_pkg = os.path.basename(parent) == "node_modules" or (
            os.path.basename(parent).startswith("@") and os.path.basename(os.path.dirname(parent)) == "node_modules")
        if is_pkg:
            pkg = read_pkg(dirpath)
            if pkg is None:
                continue
            out["npm"].append({"name": pkg.get("name") or os.path.basename(dirpath), "version": pkg.get("version", "0.0.0"),
                               "expression": licence_of(pkg), "path": inside(dirpath),
                               "licenceFiles": licence_files(dirpath, filenames)})
        elif "/dist/compiled/" in dirpath:
            # A package vendored by another (e.g. next/dist/compiled/@vercel/og, MPL-2.0): judged like any package.
            vroot = dirpath[:dirpath.index("/dist/compiled/")]
            vendor = read_pkg(vroot) or {}
            pkg = read_pkg(dirpath)
            if pkg is None:
                continue
            rel = dirpath[len(vroot) + len("/dist/compiled/"):]
            vname = vendor.get("name") or os.path.basename(vroot)
            vat = f"{vname}@{vendor.get('version', '?')}"
            own = licence_of(pkg)
            entry = {"name": f"{vname}/compiled/{pkg.get('name') or rel}", "version": pkg.get("version") or vendor.get("version", "0.0.0"),
                     "expression": own or licence_of(vendor), "path": inside(dirpath),
                     "licenceFiles": licence_files(dirpath, filenames), "vendoredIn": vat}
            if not own:
                # No declaration of its own: part of the vendor's build, under the vendor's licence and its text.
                entry["declaredBy"] = f"{vat} (vendored in its dist/compiled/, no own declaration)"
                entry["licenceFiles"] = entry["licenceFiles"] or licence_files(vroot)
            out["npm"].append(entry)

if os.environ.get("IMAGE_INVENTORY_LICENCE_TEXTS"):
    d = host(os.environ["IMAGE_INVENTORY_LICENCE_TEXTS"])
    out["licenceTexts"] = sorted(os.listdir(d)) if os.path.isdir(d) else []
    m = os.path.join(os.path.dirname(d.rstrip("/")), "packages-without-licence-file.txt")
    out["licenceManifest"] = [l.strip() for l in open(m) if l.strip()] if os.path.isfile(m) else None

json.dump(out, sys.stdout)
