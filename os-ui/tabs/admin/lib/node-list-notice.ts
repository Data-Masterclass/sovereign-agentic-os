/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Cluster: the note above the node cards (WP-05).
 * USER STORY: As a platform admin I want to tell "the node list is switched off on this install"
 *             apart from "os-ui should read the nodes and cannot", so a deliberate setting is not
 *             shown as a red failure and a real failure is never hidden.
 * ARCHITECTURE: Pure, client-safe (no k8s import) — OverviewHealth.tsx renders what this returns
 *   from the /api/platform-admin/components body. `nodesOff` (osUI.nodesReader.enabled=false →
 *   OS_NODE_LIST=false) → a NEUTRAL note; a `nodesError` while the list is on → an ERROR (fail
 *   honest). Off wins: with the list off os-ui never calls the API, so there is no error to show.
 */

export type NodesErrorBody = { reason: string; detail: string };

export type NodeListNotice =
  | { tone: 'neutral'; text: string }
  | { tone: 'error'; text: string }
  | null;

export const NODE_LIST_OFF_TEXT = 'Node list is off on this install';

export function nodeListNotice(body: { nodesOff?: boolean; nodesError?: NodesErrorBody | null }): NodeListNotice {
  if (body.nodesOff === true) return { tone: 'neutral', text: NODE_LIST_OFF_TEXT };
  if (body.nodesError) return { tone: 'error', text: `Nodes not readable (${body.nodesError.reason}): ${body.nodesError.detail}` };
  return null;
}
