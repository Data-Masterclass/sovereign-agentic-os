/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_MCP_TOOLS } from './server.ts';
import { loadGuide } from '@/lib/tabs/guides';

/**
 * Guide ↔ tool-SCHEMA drift guard (P0 A5). The name-level guard (discovery.test.ts)
 * catches a guide invoking a tool that doesn't exist; this one catches the subtler
 * drift where the guide's copy-pasteable examples pass ARG KEYS the tool's real
 * `inputSchema` doesn't have (e.g. the old `create_dataset({tier})`,
 * `add_dataset_version({tier})` vs `layer`, `request_promotion({id})` without `kind`).
 * Every worked example must be executable as written: its keys ⊆ the schema's
 * properties, and the schema's `required` keys must all be present.
 */

type Schema = { properties?: Record<string, unknown>; required?: string[] };

/** Extract every `tool_name({ ... })` call (balanced braces) from a markdown text. */
export function extractCalls(md: string): { tool: string; args: string }[] {
  const out: { tool: string; args: string }[] = [];
  const re = /\b([a-z_][a-z0-9_]*)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    // Balance-scan from the `{` that the regex stopped on.
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < md.length; i++) {
      const ch = md[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          out.push({ tool: m[1], args: md.slice(start, i + 1) });
          break;
        }
      }
    }
  }
  return out;
}

/** The TOP-LEVEL keys of a balanced `{ ... }` object literal (nested keys ignored). */
export function topLevelKeys(objText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') { depth--; continue; }
    if (depth === 1) {
      const rest = objText.slice(i);
      const km = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (km) {
        keys.push(km[1]);
        i += km[0].length - 1;
      }
    }
  }
  return keys;
}

test('data guide: every example call matches the real tool inputSchema (arg-key drift)', () => {
  const md = loadGuide('data');
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t.inputSchema as Schema]));
  // Code fences AND inline backticked invocations — both are copy-paste surfaces.
  const fenced = (md.match(/```[\s\S]*?```/g) ?? []).join('\n');
  const inline = (md.match(/`[^`]+`/g) ?? []).join('\n');
  const calls = extractCalls(`${fenced}\n${inline}`);
  assert.ok(calls.length >= 5, `expected several worked-example calls, found ${calls.length}`);
  for (const call of calls) {
    const schema = byName.get(call.tool);
    assert.ok(schema, `data guide invokes "${call.tool}" which is not a registered tool`);
    const props = new Set(Object.keys(schema!.properties ?? {}));
    const keys = topLevelKeys(call.args);
    for (const k of keys) {
      assert.ok(props.has(k), `data guide: ${call.tool}({ ${k} }) — "${k}" is not in the tool's inputSchema (${[...props].join(', ') || 'no args'})`);
    }
    for (const req of schema!.required ?? []) {
      assert.ok(keys.includes(req), `data guide: ${call.tool}(...) example is missing required arg "${req}"`);
    }
  }
});
