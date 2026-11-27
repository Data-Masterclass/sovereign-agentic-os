/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    App Builder (F) - the client's view of the App Builder switch, for labels and one Platform tab
 * USER STORY: As a user on an install with the App Builder on I see Dev | Prod in the header and the admin sees
 *             Platform → Go-live rules; on an install with it off nothing on screen changes and no extra request is made.
 * ARCHITECTURE:
 *   - NO request of its own. The header toggle already asks `/api/prefs/view-surface` once per page; that GET adds
 *     `appBuilder: true` ONLY when the switch is on (with it off the response is byte-identical to before), and
 *     `useViewSurface` publishes what it saw here. Any component (the Platform strip) reads it with
 *     `useAppBuilderFlag()`, which re-renders when the answer arrives.
 *   - UI only: hiding is never the boundary. Every App Builder route and MCP tool refuses with `app_builder_disabled`
 *     server-side while the switch is off (core/kernel/app-builder-flag.ts).
 *   - Default false until the answer arrives: the pre-App-Builder labels, never a flash of the new ones.
 */
'use client';

import { useEffect, useState } from 'react';

const EVENT = 'os:app-builder-flag';
let known = false;

/** Called by `useViewSurface` with what `/api/prefs/view-surface` said. */
export function publishAppBuilderFlag(on: boolean): void {
  if (on === known) return;
  known = on;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** Is the App Builder on, as far as this page has learned? (false until the header's preference read answers) */
export function useAppBuilderFlag(): boolean {
  const [on, setOn] = useState(known);
  useEffect(() => {
    setOn(known);
    const onChange = (e: Event) => setOn((e as CustomEvent).detail === true);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return on;
}
