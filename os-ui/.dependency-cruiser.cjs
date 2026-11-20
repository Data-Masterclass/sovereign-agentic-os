/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The import-graph half of the glue-discipline CI rules (design 00 §8.3), checked by
 *             dependency-cruiser (MIT, https://github.com/sverweij/dependency-cruiser) instead of
 *             a hand-written regex checker.
 * USER STORY: As a maintainer I want CI to refuse a change that lets a tab or the agent engine
 *             reach a component, or a component credential, other than through its adapter — and
 *             a kernel that imports a tab, or a tab that imports another tab.
 * ARCHITECTURE:
 *   - Run by `scripts/check-glue.mjs` (never on its own in CI): it counts the violations per rule
 *     and ratchets them against `scripts/structure-baseline.json` → `glue`. Every rule here is
 *     `error`; the ratchet, not the severity, is what lets today's backlog through.
 *   - Rule names are the ratchet keys: `GLUE-<n>-…` matches the rule number in 00 §8.3.
 *   - The text rules (fetch(, catch {}, version literals, setInterval, …) live in check-glue.mjs,
 *     because they are not imports.
 */
module.exports = {
  forbidden: [
    {
      name: 'GLUE-1-ADAPTER-DOOR',
      comment: 'Only core/adapters/** may import a component client (undici, pg, child_process). 00 §8.3 rule 1.',
      severity: 'error',
      from: { path: '^(core|tabs|worker|app)/', pathNot: ['^core/adapters/', '\\.test\\.tsx?$', '/fixtures/', '^core/testing/'] },
      to: { path: ['(^|/)node_modules/(undici|pg)/', '^(node:)?child_process$'] },
    },
    {
      name: 'GLUE-2-CREDENTIAL-BOUNDARY',
      comment:
        'The agent runtime, the agent engine and the worker must never reach a module that holds the ' +
        'LiteLLM master key or the Keycloak admin secret, not even transitively. 00 §8.3 rule 2.',
      severity: 'error',
      from: { path: '^(core/runtime|tabs/agents/lib/engine|worker)/', pathNot: '\\.test\\.tsx?$' },
      to: {
        path: ['^core/infra/litellm-(admin|write)\\.ts$', '^core/adapters/(litellm|keycloak)/(write|admin)\\.ts$'],
        reachable: true,
      },
    },
    {
      name: 'GLUE-9-KERNEL-TAB-ISOLATION',
      comment: 'The kernel (core/) never imports a tab. 00 §8.3 rule 9 (was CORE-INDEPENDENCE in check-structure.mjs).',
      severity: 'error',
      from: { path: '^core/' },
      to: { path: '^tabs/' },
    },
    {
      name: 'GLUE-9-KERNEL-TAB-ISOLATION',
      comment: 'A tab never imports another tab. 00 §8.3 rule 9 (was TAB-ISOLATION in check-structure.mjs).',
      severity: 'error',
      from: { path: '^tabs/([^/]+)/' },
      to: { path: '^tabs/', pathNot: '^tabs/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.next|public|vendor)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.d.ts'],
    },
  },
};
