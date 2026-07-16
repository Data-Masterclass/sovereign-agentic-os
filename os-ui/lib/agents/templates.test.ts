/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, templateYaml } from './templates.ts';
import { parseSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import { CAPABILITY_CHIPS } from './capability-tools.ts';
import { ALL_MCP_TOOLS } from '@/lib/mcp/server.ts';

/** The canonical set of valid OS MCP tool names. */
const MCP_TOOL_NAMES = new Set(ALL_MCP_TOOLS.map((t) => t.name));

test('every template grants.tools ⊆ ALL_MCP_TOOLS names (no legacy leftovers)', () => {
  for (const { key } of TEMPLATES) {
    const yaml = templateYaml(key, 'Test System', 'sales');
    const sys = parseSystem(yaml);
    for (const tool of sys.grants.tools) {
      assert.ok(
        MCP_TOOL_NAMES.has(tool),
        `template '${key}': grants.tools includes legacy/unknown name '${tool}' — not in ALL_MCP_TOOLS`,
      );
    }
    // Per-agent tool lists must also be canonical (they are narrowed from grants).
    for (const agent of sys.agents) {
      for (const tool of agent.tools ?? []) {
        assert.ok(
          MCP_TOOL_NAMES.has(tool),
          `template '${key}', agent '${agent.id}': tool '${tool}' is not a canonical MCP tool name`,
        );
      }
    }
  }
});

test('every capability chip tool is a canonical MCP tool (granted chip → runtime-authorizable)', () => {
  // A chip that surfaces on the agent card must map to tools the runtime can actually
  // authorize (they must be in ALL_MCP_TOOLS, the set os-tools filters grants.tools
  // against). A chip tool absent here would surface a capability the agent can never
  // call — exactly the class of bug this whole fix closes, guarded for Files/goals too.
  for (const chip of CAPABILITY_CHIPS) {
    assert.ok(chip.tools.length > 0, `chip '${chip.id}' provisions at least one tool`);
    for (const tool of chip.tools) {
      assert.ok(
        MCP_TOOL_NAMES.has(tool),
        `capability chip '${chip.id}': tool '${tool}' is not a canonical MCP tool name`,
      );
    }
  }
});

test('every template compiles without error (grants and agent tools are consistent)', () => {
  for (const { key } of TEMPLATES) {
    const yaml = templateYaml(key, 'Test', 'sales');
    const sys = parseSystem(yaml);
    assert.doesNotThrow(() => compile(sys), `template '${key}' must compile cleanly`);
  }
});

test('starter templates are read-only (safetyPreset = read-only, no write tool grants)', () => {
  const WRITE_TOOLS = new Set([
    'create_dataset', 'add_dataset_version', 'document_dataset',
    'author_knowledge', 'publish_knowledge', 'index_knowledge',
    'upload_file', 'request_promotion', 'approve_promotion',
    'define_metric', 'create_dashboard', 'create_big_bet',
    'create_agent_system', 'commit_agent_files', 'build_agent_system',
  ]);
  for (const { key } of TEMPLATES) {
    const yaml = templateYaml(key, 'Test', 'sales');
    const sys = parseSystem(yaml);
    assert.equal(sys.safetyPreset, 'read-only', `template '${key}' must be read-only`);
    for (const tool of sys.grants.tools) {
      assert.ok(
        !WRITE_TOOLS.has(tool),
        `template '${key}': read-only preset but grants write tool '${tool}'`,
      );
    }
  }
});
