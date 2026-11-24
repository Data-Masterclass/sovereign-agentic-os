/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one list of tool-SHAPED words that are not MCP tools
 * USER STORY: As a maintainer I want the claim checks and the surface matrix to agree on which
 *             `verb_noun` words in guides and examples are not tools, so one list is kept, not two.
 * ARCHITECTURE: test fixture only, read by `core/mcp/claims.test.ts` and `core/mcp/surface-matrix.test.ts`.
 *   Each entry needs a reason; never add a dead tool here.
 */

export const NOT_TOOLS: Readonly<Record<string, string>> = {
  promote_certify: 'approval kind (core/policy/approvals.ts)',
  run_jobs: 'the run-store table',
  run_events: 'the run-store table',
  adopt_ab12cd: 'a placeholder action-adoption id (`adopt_…`) in revoke_action_adoption\'s example',
  load_toolset: 'the toolset loader, not an OS tool',
  rollback_to_snapshot: 'an Iceberg procedure',
  list_changed: 'the MCP `listChanged` capability, written in snake case',
  refresh_token: 'an OAuth token field',
  run_1b4e28ba: 'a run id in a worked example',
  run_1b4e: 'a run id in a worked example, shortened',
};
