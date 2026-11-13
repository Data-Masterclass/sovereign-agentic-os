/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { System } from '@tabs/agents/lib/system-schema';
import { AGENT_SAFETY_PRESETS } from '@tabs/agents/lib/access-levels';

/**
 * Safety-preset selector, plus one honest line about the runtime.
 *
 * A5 removed the runtime CHOICE. There used to be two cards here — "Structured
 * (LangGraph)" and "Autonomous (Hermes)" — but Hermes never executed a system in this
 * OS, so the second card was a promise the product did not keep. Every system now runs
 * as a real LangGraph StateGraph, and what remains a genuine choice moment is the safety
 * preset: how far the team may write without a human.
 */

// The safety-preset copy lives in ONE shared const (lib/agents/access-levels.ts)
// so RuntimeSelector and SimpleBuilder can never drift or contradict each other.
const PRESETS = AGENT_SAFETY_PRESETS;

export default function RuntimeSelector({
  system,
  canEdit,
  onChange,
}: {
  system: System;
  canEdit: boolean;
  onChange: (next: System) => void;
}) {
  const preset = system.safetyPreset ?? 'read-only';
  const currentPreset = PRESETS.find((p) => p.id === preset) ?? PRESETS[0];

  return (
    <div className="runtime-selector">
      {/* ---- Runtime: one engine, stated plainly ---- */}
      <div className="rs-label">Runtime</div>
      <div className="rs-engine-fact">
        <span className="rs-card-icon" aria-hidden>⬡</span>
        <div>
          <strong>LangGraph</strong> — this team compiles to a real graph: one node per agent,
          the edges you drew, the guards you wrote. Every step is checkpointed, so a run can
          pause for your approval and continue where it stopped.
        </div>
      </div>

      {/* ---- Safety preset ---- */}
      <div className="rs-preset-section">
        <div className="rs-label">Safety preset</div>
        <div className="rs-preset-grid">
          {PRESETS.map((p) => {
            const selected = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canEdit}
                className={`rs-preset-option${selected ? ' rs-preset-option--selected' : ''}`}
                onClick={() => canEdit && !selected && onChange({ ...system, safetyPreset: p.id })}
              >
                <div className="rs-preset-top">
                  <span className="rs-preset-name">{p.label}</span>
                  {selected && <span className="rs-preset-check" aria-hidden>✓</span>}
                </div>
                <p className="rs-preset-consequence">{p.consequence}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
