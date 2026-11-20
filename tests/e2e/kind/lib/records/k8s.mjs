/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read Kubernetes' own records: Deployments, pods' image ids, Trivy Operator reports,
 *             and a NetworkPolicy reachability probe
 * USER STORY: As AT-d I want "the app is Available, the running digest is the scanned digest, and
 *             the app cannot reach Trino" to be what the API server and the CNI say.
 * ARCHITECTURE:
 *   - kubectl get … -o json; VulnerabilityReport is the Trivy Operator CRD
 *     (aquasecurity.github.io/v1alpha1). Docs: https://aquasecurity.github.io/trivy-operator/
 *   - tcpProbe() runs a throwaway pod with the SAME labels as the workload being impersonated, so
 *     the NetworkPolicies that select that workload select the probe too, then tries a TCP
 *     connect. Calico enforces the policy (cluster.yaml disables kindnet).
 */
import { getJson, kubectl } from '../kube.mjs';
import { HopError } from '../hop.mjs';

export async function deploymentAvailable(name, ns) {
  const d = await getJson('deployment', name, ns);
  return (d.status?.conditions ?? []).some((c) => c.type === 'Available' && c.status === 'True');
}

export async function podImageIds(selector, ns) {
  const pods = await getJson('pods', null, ns);
  const [k, v] = selector.split('=');
  return pods.items.filter((p) => p.metadata.labels?.[k] === v).flatMap((p) => (p.status.containerStatuses ?? []).map((c) => c.imageID));
}

export async function vulnerabilityReports(ns) {
  return (await getJson('vulnerabilityreports.aquasecurity.github.io', null, ns)).items;
}

const PROBE_IMAGE = process.env.E2E_PROBE_IMAGE ?? 'busybox:1.36';

/**
 * true when a pod carrying `labels` in `ns` can open TCP to host:port within 5 s.
 * Uses busybox `nc -w 5` (busybox has no -z; a connect that succeeds exits 0); the image is the one the chart already uses for init containers.
 */
export async function tcpProbe({ ns, labels, host, port }) {
  const name = `e2e-probe-${Date.now().toString(36)}`;
  const labelArg = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
  const out = await kubectl(['-n', ns, 'run', name, '--rm', '-i', '--restart=Never', `--image=${PROBE_IMAGE}`, `--labels=${labelArg}`,
    '--command', '--', 'sh', '-c', `nc -w 5 ${host} ${port} </dev/null >/dev/null 2>&1 && echo PROBE-OPEN || echo PROBE-CLOSED`], { timeoutMs: 120000 });
  if (!/PROBE-(OPEN|CLOSED)/.test(out)) throw new HopError({ component: 'kubernetes', hop: 'tcp probe', reason: `probe printed no verdict: ${out.slice(0, 200)}` });
  return out.includes('PROBE-OPEN');
}
