/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { Runtime, SafetyPreset, System } from '@/lib/agents/system-schema';

/**
 * Runtime + safety-preset selector — a real choice moment for course participants.
 * Two selectable cards differentiate the runtimes in plain language. Safety presets
 * are labeled with one-line consequences so the choice is never a guess.
 * When Hermes is selected an honest inline guidance strip explains what Run does,
 * where memory lives, and that OPA gates every tool call.
 */

const RUNTIMES: {
  id: Runtime;
  label: string;
  description: string;
  whenTo: string;
  icon: string;
}[] = [
  {
    id: 'langgraph',
    label: 'Structured',
    description: 'LangGraph',
    whenTo: 'Step-by-step pipelines where you want to see every decision, pause for human approval, or replay a run.',
    icon: '⬡',
  },
  {
    id: 'hermes',
    label: 'Autonomous',
    description: 'Hermes',
    whenTo: 'Long-running tasks that need to keep going without step-by-step supervision, remember past runs, and improve their own skills over time.',
    icon: '◈',
  },
];

const PRESETS: { id: SafetyPreset; label: string; consequence: string }[] = [
  { id: 'read-only',      label: 'Read-only',            consequence: 'The agent can look but never change anything.' },
  { id: 'read-propose',   label: 'Read + propose',       consequence: 'The agent suggests changes — a human approves each one before it runs.' },
  { id: 'read-bounded',   label: 'Read + bounded writes', consequence: 'The agent can write inside its own workspace, nowhere else.' },
  { id: 'full-in-scope',  label: 'Full in-scope',        consequence: 'The agent may write anywhere its grants allow — use with care.' },
];

export default function RuntimeSelector({
  system,
  canEdit,
  hermesEnabled,
  onChange,
}: {
  system: System;
  canEdit: boolean;
  hermesEnabled: boolean;
  onChange: (next: System) => void;
}) {
  const runtime = system.runtime ?? 'langgraph';
  const preset = system.safetyPreset ?? 'read-only';
  const hermesSelected = runtime === 'hermes';
  const currentPreset = PRESETS.find((p) => p.id === preset) ?? PRESETS[0];

  return (
    <div className="runtime-selector">
      {/* ---- Runtime cards ---- */}
      <div className="rs-label">Runtime</div>
      <div className="rs-cards" role="group" aria-label="Runtime">
        {RUNTIMES.map((r) => {
          const selected = runtime === r.id;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!canEdit}
              className={`rs-card${selected ? ' rs-card--selected' : ''}`}
              onClick={() => canEdit && !selected && onChange({ ...system, runtime: r.id })}
            >
              <div className="rs-card-top">
                <span className="rs-card-icon" aria-hidden>{r.icon}</span>
                <div className="rs-card-names">
                  <span className="rs-card-label">{r.label}</span>
                  <span className="rs-card-engine">{r.description}</span>
                </div>
                {selected && <span className="rs-card-check" aria-hidden>✓</span>}
              </div>
              <p className="rs-card-when">{r.whenTo}</p>
            </button>
          );
        })}
      </div>

      {/* ---- Hermes inline guidance strip ---- */}
      {hermesSelected && (
        <div className="rs-hermes-strip">
          {!hermesEnabled && (
            <div className="rs-hermes-gate">
              <span className="badge warn">Provisions on SKE only</span>
              <span>Hermes is off in this environment — your system is saved and will use Hermes when you deploy to a cluster where <code>hermes.enabled=true</code>.</span>
            </div>
          )}
          <div className="rs-hermes-facts">
            <div className="rs-hermes-fact">
              <span className="rs-fact-icon">▶</span>
              <div><strong>On Run</strong> — Hermes starts a persistent loop. It keeps going between sessions until it completes the task or you stop it.</div>
            </div>
            <div className="rs-hermes-fact">
              <span className="rs-fact-icon">◎</span>
              <div><strong>Memory</strong> — past runs and learned skills are stored in the Hermes memory store, scoped to this system only.</div>
            </div>
            <div className="rs-hermes-fact">
              <span className="rs-fact-icon">⬡</span>
              <div><strong>Every tool call is OPA-gated</strong> — the safety preset and your grants apply to Hermes exactly as they do to LangGraph. There is no bypass.</div>
            </div>
          </div>
        </div>
      )}

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
