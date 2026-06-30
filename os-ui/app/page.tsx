/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { homeFeed } from '@/lib/home/feed';
import HomeLauncher from '@/components/home/HomeLauncher';
import Cockpit from '@/components/home/Cockpit';

export const dynamic = 'force-dynamic';

/**
 * Home — the welcoming launcher + cockpit (home-golden-path.md). Server-rendered
 * from the OPA/RLS-scoped home-feed adapter: an illustrated golden-path launcher
 * (centerpiece) surrounded by personalized cockpit modules whose content +
 * ordering shift by the viewer's persona. Home orients + routes; it never
 * recomputes a tab's numbers and never bypasses governance.
 */
export default async function HomePage() {
  const user = await currentUser();

  // Middleware guards this route, but stay graceful if the session just expired.
  if (!user) {
    return (
      <div className="home">
        <div className="content">
          <div className="stub-page">
            Your session has ended. <Link href="/signin">Sign in</Link> to open your domain.
          </div>
        </div>
      </div>
    );
  }

  const feed = await homeFeed(user);
  const firstName = user.name.split(' ')[0] || user.name;

  return (
    <div className="home">
      {/* Warm, editorial hero — Fraunces display, not the OS topbar chrome. */}
      <header className="home-hero">
        <div className="home-hero-text">
          <div className="home-eyebrow">{feed.domain} · domain home</div>
          <h1 className="home-greeting">
            Welcome back, <span className="home-name">{firstName}</span>.
          </h1>
          <p className="home-sub">
            Your governed space on the Sovereign Agentic OS. Pick a golden path to create something, or
            see what needs you below.
          </p>
        </div>
        <div className="home-persona" title="Your role shapes what Home emphasizes.">
          <span className="home-persona-stance">{feed.personaStance}</span>
          <span className="home-persona-role">{feed.personaLabel}</span>
        </div>
      </header>

      <div className="content home-content">
        <div className="home-sec-head">
          <h2 className="home-sec-title">Golden paths</h2>
          <p className="home-sec-sub">
            Ten ways to build. Each card explains itself, launches its flow, and links a hands-on
            tutorial. Paths your role can't act on yet are dimmed — still yours to explore.
          </p>
        </div>

        <HomeLauncher cards={feed.launcher} />

        <div className="home-sec-head" style={{ marginTop: 36 }}>
          <h2 className="home-sec-title">Your cockpit</h2>
          <p className="home-sec-sub">
            What's moving and what needs you — scoped to you, ordered for a {feed.personaLabel.toLowerCase()}.
          </p>
        </div>

        <Cockpit feed={feed} />
      </div>
    </div>
  );
}
