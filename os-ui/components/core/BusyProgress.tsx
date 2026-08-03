/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import ProgressStepper from './ProgressStepper';

/**
 * BusyProgress — the OS-wide in-flight surface for a SINGLE-SHOT long operation (one
 * request that persists/builds/verifies server-side, e.g. saving a metric or a
 * dashboard). Wraps the core ProgressStepper so every tab wears the same calm progress
 * UX instead of a silently disabled button.
 *
 * HONESTY: a single round-trip has no observable sub-steps, so this never fakes
 * checkmark progress — it shows ONE live (shimmering) step, a sentence naming what the
 * server is actually doing, and a real elapsed counter against the typical duration.
 * Operations with REAL streamed signals (Software/Agents builds) keep driving
 * ProgressStepper directly with their derived steps — use this only where there is
 * nothing finer-grained to observe. Mount while in flight; unmount (or replace with the
 * result) when the request settles.
 */
export default function BusyProgress({
  label,
  detail,
  typicalSeconds,
}: {
  /** What is running — "Saving metric". */
  label: string;
  /** What the server is doing, in plain language (shown as the live commentary). */
  detail?: string;
  /** The honest expectation — "typically ~30 s". Omit when unknown. */
  typicalSeconds?: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const timing = `${elapsed} s elapsed${typicalSeconds ? ` · typically ~${typicalSeconds} s` : ''}`;
  return (
    <ProgressStepper
      steps={[{ key: 'op', label, state: 'active' }]}
      active
      commentary={detail ? `${detail} — ${timing}` : timing}
    />
  );
}
