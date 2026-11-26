/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Cluster: the real nodes, read from the Kubernetes API (design 00 §6).
 * USER STORY: As an operator I want the Platform page to list the nodes the platform really runs
 *             on — or say why it cannot — instead of a made-up node.
 * ARCHITECTURE: GET /api/v1/nodes with os-ui's ServiceAccount (ClusterRole `get,list nodes`,
 *   charts/.../os-ui/os-ui-nodes.yaml). 403 → `forbidden`, no cluster → `unreachable`; the page
 *   renders the reason. The pool is the node's own pool label when it has one.
 *   `readNodeList(enabled)`: with the list OFF by config (`osUI.nodesReader.enabled=false`) the API
 *   is not called and the answer is `nodesOff` — a deliberate setting, not a failure.
 */
import { k8s } from '@core/infra/k8s';
import type { Fetched } from '@core/adapters/_contract';

export type NodeView = {
  name: string;
  ready: boolean;
  roles: string;
  pool: string | null;
  cpu: string;
  mem: string;
  kubelet: string;
};

const POOL_LABELS = ['node.kubernetes.io/pool', 'ske.stackit.cloud/pool', 'cloud.google.com/gke-nodepool', 'eks.amazonaws.com/nodegroup', 'kubernetes.azure.com/agentpool'];

type K8sNode = {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { conditions?: { type: string; status: string }[]; allocatable?: Record<string, string>; nodeInfo?: { kubeletVersion?: string } };
};

export function nodeView(n: K8sNode): NodeView {
  const labels = n.metadata?.labels ?? {};
  const roles = Object.keys(labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.slice('node-role.kubernetes.io/'.length)).join(',') || 'worker';
  const pool = POOL_LABELS.map((k) => labels[k]).find(Boolean) ?? null;
  return {
    name: n.metadata?.name ?? '?',
    ready: (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    roles,
    pool,
    cpu: n.status?.allocatable?.cpu ?? '?',
    mem: n.status?.allocatable?.memory ?? '?',
    kubelet: n.status?.nodeInfo?.kubeletVersion ?? '?',
  };
}

/** The Kubernetes API call (`k8s` in production; a test passes a stub answering 403 etc.). */
type NodesCall = (method: string, path: string) => Promise<{ status: number; body: Record<string, unknown> }>;

export async function readNodes(call: NodesCall = k8s): Promise<Fetched<NodeView[]>> {
  const at = new Date().toISOString();
  const r = await call('GET', '/api/v1/nodes');
  if (r.status === 0) return { ok: false, reason: 'unreachable', detail: 'the Kubernetes API is not reachable from os-ui', at };
  if (r.status === 401) return { ok: false, reason: 'unauthorized', detail: 'the Kubernetes API rejected os-ui\'s ServiceAccount token', at };
  if (r.status === 403) return { ok: false, reason: 'forbidden', detail: 'os-ui may not read nodes: the ClusterRole with get/list nodes is missing', at };
  if (r.status !== 200) return { ok: false, reason: 'invalid', detail: `GET /api/v1/nodes answered ${r.status}`, at };
  return { ok: true, value: ((r.body.items as K8sNode[] | undefined) ?? []).map(nodeView), at };
}

/** The node part of the Platform components response. Off by config → `nodesOff`, no API call. */
export type NodeList = {
  nodes: NodeView[];
  nodesOff: boolean;
  nodesError: { reason: string; detail: string } | null;
};

export async function readNodeList(enabled: boolean, call: NodesCall = k8s): Promise<NodeList> {
  if (!enabled) return { nodes: [], nodesOff: true, nodesError: null };
  const r = await readNodes(call);
  return r.ok
    ? { nodes: r.value, nodesOff: false, nodesError: null }
    : { nodes: [], nodesOff: false, nodesError: { reason: r.reason, detail: r.detail } };
}
