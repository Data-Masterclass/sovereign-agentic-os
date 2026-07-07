/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import AgentSystems from '@/components/agents/AgentSystems';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

export default function AgentsPage() {
  return (
    <>
      <PageHeader title="Agents" crumb="Governed agent systems — LangGraph & autonomous Hermes" tutorial="agents" />
      <div className="content">
        <p className="lead">
          Author agent systems against their real artifacts — drag the canvas or edit
          <span className="mono"> system.yaml</span> (and use <strong>Ask the OS</strong> for
          natural-language help) — then Build to
          execute and verify them across LangGraph, LiteLLM, OPA, and Langfuse. Pick a runtime per
          system: <strong>LangGraph</strong> for structured, human-in-the-loop graphs, or the
          autonomous <strong>Hermes</strong> runtime (long-running, persistent memory, self-improving
          skills) — both consume the same governed tool plane, so neither bypasses OPA.
        </p>

        <div {...anchorAttr(ANCHORS.agents.sandbox)}>
          <AgentSystems />
        </div>
      </div>
    </>
  );
}
