/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * HomeTalkToOs — the Home-screen entry point into the ONE global Sovereign OS Assistant.
 *
 * It does NOT own an assistant: it dispatches `os-assistant:open` (optionally seeding the typed
 * intent), which the globally-mounted <OsAssistant/> listens for — so there is a single assistant
 * instance and no duplicate drawer/state. Empty submit still opens the assistant; a typed line is
 * sent immediately, so Home reads as "tell the OS what you want to do" and the answer is already
 * underway when the drawer opens.
 */
export default function HomeTalkToOs() {
  const [q, setQ] = useState('');

  const open = (prompt?: string) => {
    window.dispatchEvent(new CustomEvent('os-assistant:open', { detail: { prompt } }));
  };

  return (
    <section className="home-talk" aria-label="Talk to the OS">
      <div className="home-talk-text">
        <p className="home-talk-kicker">✦ Talk to the OS</p>
        <p className="home-talk-line">What do you want to build or do today?</p>
      </div>
      <form
        className="home-talk-form"
        onSubmit={(e) => { e.preventDefault(); open(q.trim() || undefined); setQ(''); }}
      >
        <input
          className="home-talk-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. build an app to track campaign performance, or summarise last week's data…"
          aria-label="Ask the OS to do something"
        />
        <button className="home-talk-btn" type="submit">Ask the OS</button>
      </form>
    </section>
  );
}
