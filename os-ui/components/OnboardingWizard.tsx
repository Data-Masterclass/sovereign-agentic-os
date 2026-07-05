/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';

interface OnboardingWizardProps {
  user: { id: string; name: string; role: Role; domains: string[] };
  onDone: () => void;
}

const ROLE_BLURB: Record<Role, string> = {
  'creator': 'As an Agentic Leader you build and run your own agents, apps and artifacts, and use everything shared into your domain.',
  builder: 'As a builder you can author Personal artifacts and promote your best work to Shared.',
  domain_admin: 'As a domain admin you approve domain work and administer the users of your own domain(s) — inviting, editing and assigning roles up to builder.',
  admin: 'As an admin you can certify artifacts to the Marketplace and manage users across domains.',
};

const GOLDEN_PATHS = [
  'Ask an agent',
  'Query the lakehouse',
  'Build a dashboard',
  'Ship software',
  'Train a model',
];

export default function OnboardingWizard({ user, onDone }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const total = 4;

  const finish = useCallback(() => onDone(), [onDone]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  const next = () => setStep((s) => Math.min(total - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <div className="wiz-backdrop" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="wiz-card">
        <button type="button" className="wiz-skip" onClick={finish}>
          Skip
        </button>

        <div className="wiz-body">
          {step === 0 && (
            <>
              <div className="wiz-eyebrow">Welcome</div>
              <h2 className="wiz-title">Hello, {user.name}</h2>
              <p className="wiz-text">
                This is your governed workspace on the Sovereign Agentic OS — a calm, central place
                to create, store, and use your data, agents, and dashboards.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <div className="wiz-eyebrow">Your context</div>
              <h2 className="wiz-title">Where you stand</h2>
              <div className="wiz-chips">
                <span className="chip">{user.role}</span>
                {user.domains.map((d) => (
                  <span key={d} className="chip">
                    {d}
                  </span>
                ))}
              </div>
              <p className="wiz-text">{ROLE_BLURB[user.role]}</p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="wiz-eyebrow">30-second tour</div>
              <h2 className="wiz-title">Where to start</h2>
              <p className="wiz-text">
                On Home you'll find the golden-path launcher — your fastest way in:
              </p>
              <div className="wiz-chips">
                {GOLDEN_PATHS.map((p) => (
                  <span key={p} className="chip">
                    {p}
                  </span>
                ))}
              </div>
              <p className="wiz-text">
                New here? Open <strong>Tutorials</strong> for guided walkthroughs of each path.
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <div className="wiz-eyebrow">Ready</div>
              <h2 className="wiz-title">You're all set</h2>
              <p className="wiz-text">
                Your workspace is ready. Pick a golden path on Home whenever you'd like to begin.
              </p>
            </>
          )}
        </div>

        <div className="wiz-foot">
          <div className="wiz-dots">
            {Array.from({ length: total }).map((_, i) => (
              <span key={i} className={`wiz-dot${i === step ? ' active' : ''}`} />
            ))}
          </div>
          <div className="wiz-actions">
            {step > 0 && (
              <button type="button" className="btn ghost sm" onClick={back}>
                Back
              </button>
            )}
            {step < total - 1 ? (
              <button type="button" className="btn sm" onClick={next}>
                Next
              </button>
            ) : (
              <button type="button" className="btn sm" onClick={finish}>
                Get started
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
