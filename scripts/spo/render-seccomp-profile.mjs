#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder build platform (workstream C1) - the approved seccomp fallback for the build pod.
// USER STORY: As the platform owner I want the build pod's seccomp profile to be the container runtime's default plus
//   exactly the namespace and mount syscalls rootless BuildKit needs, derived reproducibly from upstream, so a reviewer
//   can see every syscall that was added and why.
// ARCHITECTURE: input = moby/profiles `seccomp/default.json` (Apache-2.0, the default profile Docker and BuildKit
//   apply; containerd's RuntimeDefault is generated from the same rules), pinned by tag and sha256. The rules whose
//   condition is a capability the build pod does NOT have are dropped (the pod gets no capability beyond Pod Security
//   `baseline`), arch conditions are kept as plain names (unknown names are ignored per arch), and ADDED is allowed on
//   top. Output: charts/sovereign-agentic-os/files/seccomp/buildkit-rootless.json in the security-profiles-operator
//   SeccompProfile `spec` shape (https://github.com/kubernetes-sigs/security-profiles-operator). Run with --check in
//   CI to fail when the committed file differs from a fresh render.
//
//   Why each addition (spec 6.1): RuntimeDefault refuses clone/unshare with CLONE_NEWUSER and mount without
//   CAP_SYS_ADMIN, so rootlesskit cannot create the nested user namespace in which buildkitd and runc hold capabilities
//   over their OWN namespaces only (never the node's; the pod already runs with `hostUsers: false`). Proof log:
//   "[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: operation not permitted".
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBY_PROFILES_TAG = 'seccomp/v0.3.0';
const MOBY_DEFAULT_URL = `https://raw.githubusercontent.com/moby/profiles/${MOBY_PROFILES_TAG}/seccomp/default.json`;
// Allowed unconditionally on top of the kept rules (the minimum rootless BuildKit needs):
export const ADDED = [
  // runc assembles each build step's root filesystem inside its own mount namespace (classic mount API only)
  'mount', 'umount2', 'pivot_root',
  // runc sets the build container's hostname in its own UTS namespace
  'sethostname', 'setdomainname',
];
// Allowed only WITHOUT CLONE_NEWNET (argument filter): the nested user namespace (rootlesskit) and the build
// containers' mount/UTS/IPC namespaces (runc) are needed; a NETWORK namespace is not (buildkitd and every build step use
// the pod's network, `--net=host` / `--oci-worker-net=host`), and an unprivileged network namespace is where most of
// the kernel's userns attack surface lives (nf_tables, packet sockets, virtual devices).
export const NS_WITHOUT_NET = ['clone', 'unshare'];
export const CLONE_NEWNET = 0x40000000;
// The new mount API answers ENOSYS (callers, runc included, fall back to mount(2)); it is extra filesystem-context
// attack surface (fsconfig) the build does not need.
export const ENOSYS_MOUNT_API = ['fsopen', 'fsconfig', 'fsmount', 'fspick', 'move_mount', 'open_tree', 'mount_setattr'];
// Socket families: AF_UNSPEC/AF_UNIX/AF_INET (moby's "< 3" rule), AF_INET6, and AF_NETLINK for NETLINK_ROUTE only
// (address/interface listing: getifaddrs, Go's net.Interfaces). Every other family moby allows is dropped.
export const AF_INET6 = 10; export const AF_NETLINK = 16; export const NETLINK_ROUTE = 0;
// Capabilities the build pod has (containerd's default set, all within Pod Security baseline): rules conditioned on
// them stay; rules conditioned on any other capability are dropped.
const POD_CAPS = new Set(['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FSETID', 'CAP_FOWNER', 'CAP_MKNOD', 'CAP_NET_RAW', 'CAP_SETGID',
  'CAP_SETUID', 'CAP_SETFCAP', 'CAP_SETPCAP', 'CAP_NET_BIND_SERVICE', 'CAP_SYS_CHROOT', 'CAP_KILL', 'CAP_AUDIT_WRITE']);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'charts', 'sovereign-agentic-os', 'files', 'seccomp', 'buildkit-rootless.json');
const PIN_FILE = join(here, 'versions.env');

function pinnedSha() {
  const m = readFileSync(PIN_FILE, 'utf8').match(/^MOBY_SECCOMP_DEFAULT_SHA256=([0-9a-f]{64})$/m);
  if (!m) throw new Error(`MOBY_SECCOMP_DEFAULT_SHA256 missing in ${PIN_FILE}`);
  return m[1];
}

export function render(moby) {
  const keep = (g) => {
    const inc = g.includes || {}; const exc = g.excludes || {};
    if (inc.caps && !inc.caps.every((c) => POD_CAPS.has(c))) return false;
    if (exc.caps && exc.caps.some((c) => POD_CAPS.has(c))) return false;
    return true;
  };
  const syscalls = [];
  for (const g of moby.syscalls) {
    if (!keep(g)) continue;
    // socket: replaced below by the minimal family list; clone with a namespace mask: replaced by NS_WITHOUT_NET.
    if (g.names.length === 1 && ['socket', 'clone'].includes(g.names[0]) && g.args) continue;
    const r = { action: g.action, names: g.names.filter((n) => !ENOSYS_MOUNT_API.includes(n) && !NS_WITHOUT_NET.includes(n) && n !== 'setns') };
    if (g.errnoRet !== undefined) r.errnoRet = g.errnoRet;
    if (g.args) r.args = g.args.map((a) => ({ index: a.index, value: a.value, valueTwo: a.valueTwo ?? 0, op: a.op }));
    syscalls.push(r);
  }
  // clone3 stays ENOSYS (from the kept rule): its flags live in a struct a filter cannot read, so callers fall back to
  // clone, whose flags argument the rule below CAN read.
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: [...ADDED] });
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: [...NS_WITHOUT_NET], args: [{ index: 0, value: CLONE_NEWNET, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }] });
  // setns joins only namespaces the process already holds a descriptor for; never a network namespace.
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['setns'], args: [{ index: 1, value: CLONE_NEWNET, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }] });
  syscalls.push({ action: 'SCMP_ACT_ERRNO', errnoRet: 38, names: [...ENOSYS_MOUNT_API] });
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['socket'], args: [{ index: 0, value: 3, valueTwo: 0, op: 'SCMP_CMP_LT' }] });
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['socket'], args: [{ index: 0, value: AF_INET6, valueTwo: 0, op: 'SCMP_CMP_EQ' }] });
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['socket'], args: [{ index: 0, value: AF_NETLINK, valueTwo: 0, op: 'SCMP_CMP_EQ' }, { index: 2, value: NETLINK_ROUTE, valueTwo: 0, op: 'SCMP_CMP_EQ' }] });
  // NO NESTED FILTER: installing a further seccomp filter answers EINVAL ("this kernel has no seccomp filter"). Our runc
  // is built without libseccomp (LGPL), so it cannot apply the profile BuildKit would generate for each build step;
  // BuildKit probes with prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER) (containerd pkg/seccomp IsEnabled) and, told EINVAL,
  // generates none. Every build step still runs under THIS filter, which the kernel inherits into every process of
  // the pod; nothing inside can loosen it, and with this rule nothing can stack another on top either.
  for (const r of syscalls) r.names = r.names.filter((n) => n !== 'prctl' && n !== 'seccomp');
  const PR_SET_SECCOMP = 22; const EINVAL = 22;
  syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['prctl'], args: [{ index: 0, value: PR_SET_SECCOMP, valueTwo: 0, op: 'SCMP_CMP_NE' }] });
  syscalls.push({ action: 'SCMP_ACT_ERRNO', errnoRet: EINVAL, names: ['prctl'], args: [{ index: 0, value: PR_SET_SECCOMP, valueTwo: 0, op: 'SCMP_CMP_EQ' }] });
  syscalls.push({ action: 'SCMP_ACT_ERRNO', errnoRet: EINVAL, names: ['seccomp'] });
  for (let i = syscalls.length - 1; i >= 0; i--) if (syscalls[i].names.length === 0) syscalls.splice(i, 1);
  // No `architectures`: the filter then holds the node's native architecture only, so a foreign-ABI syscall hits the
  // bad-arch action. (Listing moby's whole archMap fails on arm64: libseccomp refuses a big-endian arch, EDOM; and the
  // build never needs a compat ABI.)
  return { defaultAction: moby.defaultAction, syscalls };
}

async function main() {
  const res = await fetch(MOBY_DEFAULT_URL);
  if (!res.ok) throw new Error(`${MOBY_DEFAULT_URL}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  const want = pinnedSha();
  if (got !== want) throw new Error(`moby default.json sha256 ${got} != pinned ${want}`);
  const text = JSON.stringify(render(JSON.parse(body.toString('utf8'))), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh render; run node scripts/spo/render-seccomp-profile.mjs`); process.exit(1); }
    console.log('seccomp profile up to date');
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
