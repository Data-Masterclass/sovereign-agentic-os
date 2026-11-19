/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The "Show technical details" gate and its switch
 * USER STORY: As a user I want pages free of panels about the OS's internals; as an engineer I
 *             want them back with one switch in My Settings.
 * ARCHITECTURE:
 *   - `TechnicalDetailsOnly` wraps a panel whose whole purpose is showing internals. Its
 *     children are not mounted while the opt-in is off, so such a panel fetches nothing and
 *     takes no space; a panel's own lazy loading is unchanged once it is mounted.
 *   - `TechnicalDetailsToggle` is the one switch (My Settings → Appearance). Both read the
 *     same hook, so flipping the switch updates every open page.
 */
'use client';

import type { ReactNode } from 'react';
import { useTechnicalDetails } from '@core/ui/useTechnicalDetails';

/** Renders its children only for users who switched "Show technical details" on. */
export function TechnicalDetailsOnly({ children }: { children: ReactNode }) {
  const { on } = useTechnicalDetails();
  return on ? <>{children}</> : null;
}

/** The opt-in switch. Off by default; remembered on this device. */
export function TechnicalDetailsToggle() {
  const { on, setOn } = useTechnicalDetails();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Show technical details"
      className={'switch' + (on ? ' on' : '')}
      onClick={() => setOn(!on)}
    >
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}
