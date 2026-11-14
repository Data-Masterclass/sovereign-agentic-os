/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `os.appsmith` — the built-in LangGraph system behind the agentic app builder
 * USER STORY: As the owner who asked why well-described user stories do not become good software I
 *             want the builder to be a real, inspectable agent system — planner, coder, build,
 *             reviewer, bounded — that an engineer can read as a `system.yaml` and run from the
 *             Agents tab, not a hidden prompt inside a route.
 * ARCHITECTURE:
 *   - ONE source of truth for the built-in system: the yaml below. It is a normal `system.yaml` —
 *     parsed by `system-schema.ts`, compiled by `langgraph-compile.ts`, executed by the engine as
 *     the signed-in user, with the governed tool gates and the hold rules unchanged.
 *   - WHY A GUARDED LOOP, not a supervisor: the three handoffs route on DECLARED boolean channels
 *     the agents write with the engine's built-in `os_set_state` tool, so the team advances on
 *     EVIDENCE (the plan exists · the tree compiled and committed · the stories scored) and a
 *     reviewer FAIL routes straight back to the coder. The bound is the engine's own per-run step
 *     budget plus `APPSMITH_MAX_ITERATIONS`, which the software-side harness enforces.
 *   - THE BUILD TOOL IS `commit`: the software commit door runs the compile gate BEFORE any write
 *     and returns the exact diagnostics as a typed 422, so "build" and "write" are the same
 *     governed call and a red tree can never land. That is the feedback loop the single-shot
 *     builder never had.
 *   - MODEL TIERS: a `system.yaml` addresses LiteLLM aliases, not OS model roles, so the coder
 *     node names `sovereign-default` (the exec/code tier) here. The software-side harness
 *     (`tabs/software/lib/builder/loop-server.ts`) resolves the OS `coder` ROLE instead, which
 *     falls back to the reasoning tier when a deployment has not pinned a code model. Both paths
 *     are deliberate and documented; neither invents a third model surface.
 *   - `decide_deploy` is deliberately NOT granted: a run may build, commit and verify, but a
 *     go-live stays a human Builder decision.
 */

/** The stable id of the built-in system, as the Agents catalogue and the run door see it. */
export const APPSMITH_SYSTEM_ID = 'os.appsmith';

/** The loop bound this system is run under (mirrors `MAX_BUILDER_ITERATIONS` in the harness). */
export const APPSMITH_MAX_ITERATIONS = 4;

/** The five state channels the three handoffs route on. Declared, so the agents can write them. */
export const APPSMITH_CHANNELS = ['plan_ready', 'build_ok', 'build_failed', 'stories_passed', 'stories_failed'] as const;

export const APPSMITH_YAML = `version: '1'
system:
  name: App Smith
  domain: platform
  visibility: Shared
  description: Builds a governed OS app from its user stories — plan, code, compile, review, loop.
runtime: langgraph
safety_preset: read-propose
entrypoint: planner
state:
  channels:
    messages: add_messages
    # The four phase gates the handoffs below route on. Each is written by the agent whose turn
    # it follows, with the engine's built-in os_set_state tool. Declared type = what the tool
    # accepts; the default is false until that agent sets it.
    plan_ready: boolean      # planner: the build plan is complete and the coder can start
    build_ok: boolean        # coder: the tree COMPILED and the files are committed
    build_failed: boolean    # coder: the compile gate rejected the tree (nothing was written)
    stories_passed: boolean  # reviewer: every acceptance check derived from the stories passed
    stories_failed: boolean  # reviewer: at least one acceptance check is unmet — back to the coder
grants:
  data: []
  knowledge: []
  metrics: []
  tools:
    - get_software
    - read_app_files
    - get_dataset
    - commit
    - verify_software
  connections: []
routing:
  overrides: {}
agents:
  - id: planner
    role: Turns the user stories into a concrete file-by-file build plan
    model: sovereign-reasoning
    tools: [get_software, read_app_files, get_dataset]
    agent_md: |
      # Planner — App Smith
      You are given the app's USER STORIES and its GRANTED context: the datasets with their REAL
      columns and real sample rows, the metric definitions, the OS SDK and UI API surfaces
      extracted from source, the design tokens, and one exemplar app.

      Produce a SHORT, concrete plan and nothing else:
        1. the files to write, with their exact paths under src/;
        2. for each file, the story it satisfies and the granted dataset or metric it reads;
        3. where os.records is used, for any story that CAPTURES data;
        4. the smallest design that satisfies every acceptance check you were given.

      Do NOT write code. NEVER invent a dataset id, a metric id or a column name — a reference
      outside the grants fails the governed gate and wastes the whole build. When the plan is
      complete, set plan_ready — that is what hands control to the coder.
    memory_md: '# Memory'
  - id: coder
    role: Writes the code and commits it through the governed, compile-gated door
    model: sovereign-default
    tools: [commit, read_app_files, get_dataset]
    agent_md: |
      # Coder — App Smith
      Execute the plan with \`commit\`. The commit door runs the COMPILE GATE (tsc plus a bundle
      pass over the merged tree) BEFORE it writes anything: a red gate returns the exact
      diagnostics and writes NOTHING. That is your feedback loop — read the file, line and code,
      fix exactly those errors against the API surface you were given, and commit again.

      Rules: complete, runnable files only (never a placeholder or a TODO); import the SDK as
      '@sovereign-os/app-sdk' and the UI as '@sovereign-os/ui', using only the exports and props
      listed in your brief; reference only the granted ids and real columns; give every fetch an
      honest loading, empty and error state; never embed a secret — the signed-in session IS the
      credential.

      When a commit SUCCEEDS, set build_ok — that hands control to the reviewer. If you cannot
      make the tree compile, set build_failed and say precisely which diagnostics defeated you.
      Never end your turn with known-red diagnostics and never claim a build that did not land.
    memory_md: '# Memory'
  - id: reviewer
    role: Scores the committed app against the acceptance checks derived from the stories
    model: sovereign-reasoning
    tools: [verify_software, read_app_files]
    agent_md: |
      # Reviewer — App Smith
      You are shown the acceptance checks DERIVED FROM THE USER STORIES and how they scored:
      one compile check, a route and a render check per story, and one manual check per
      non-functional requirement and per business rule.

      Decide: PASS only when every machine-decidable check passed. A MANUAL check is for a human
      and is not yours to pass or fail. A build that merely compiles is NOT done.

      On a PASS set stories_passed and report what landed: the app, the files, the preview and
      exactly which checks remain for the human. On a FAIL set stories_failed and give the coder a
      numbered list of the unmet checks with the evidence — that routes control back to the coder.
    memory_md: '# Memory'
edges:
  - { from: planner, to: coder, type: handoff, when: plan_ready }
  - { from: coder, to: reviewer, type: handoff, when: build_ok }
  - { from: reviewer, to: coder, type: handoff, when: stories_failed }
schedule:
  kind: manual
`;
