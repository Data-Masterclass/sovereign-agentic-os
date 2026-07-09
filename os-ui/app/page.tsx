/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import { currentUser } from '@/lib/core/auth';
import { homeFeed } from '@/lib/home/feed';
import HomeLauncher from '@/components/home/HomeLauncher';
import McpDrawer from '@/components/McpDrawer';

export const dynamic = 'force-dynamic';

/**
 * Home — the welcoming golden-path launcher (home-golden-path.md). Server-rendered
 * from the OPA/RLS-scoped home-feed adapter: an illustrated launcher whose copy
 * + dimming shift by the viewer's persona. Home is the front door — it orients
 * and routes into the golden paths; the live "what's moving / what needs me" view
 * lives one click away in the Cockpit (`/cockpit`).
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

  const feed = await homeFeed(user).catch(() => null);
  if (!feed) {
    return (
      <div className="home">
        <div className="content">
          <div className="stub-page">
            Could not load your home feed. The platform may be starting up — try refreshing in a moment.
          </div>
        </div>
      </div>
    );
  }
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
            Your governed space on the Sovereign Agentic OS. Pick a golden path to create something —
            or open your <Link href="/cockpit" className="home-sub-link">Cockpit</Link> to see what's
            moving and what needs you.
          </p>
        </div>
        <div className="home-persona" title="Your role shapes what Home emphasizes.">
          <span className="home-persona-stance">{feed.personaStance}</span>
          <span className="home-persona-role">{feed.personaLabel}</span>
        </div>
      </header>

      <div className="content home-content">
        {/* MCP connect CTA — prominent invite to drive the OS from Claude/ChatGPT */}
        <div className="mcp-cta-banner">
          <div className="mcp-cta-banner-text">
            <p className="mcp-cta-banner-kicker">MCP — AI-native access</p>
            <p className="mcp-cta-banner-line">
              Drive the whole OS from Claude or ChatGPT — governed as you.
            </p>
          </div>
          <McpDrawer className="mcp-cta-btn" />
        </div>

        <div className="home-sec-head">
          <h2 className="home-sec-title">Golden paths</h2>
          <p className="home-sec-sub">
            Ten ways to build. Each card explains itself, launches its flow, and links a hands-on
            tutorial. Paths your role can't act on yet are dimmed — still yours to explore.
          </p>
        </div>

        <HomeLauncher cards={feed.launcher} />

        <Link href="/cockpit" className="home-cockpit-cta">
          <span className="home-cockpit-cta-text">
            <span className="home-cockpit-cta-kicker">Your cockpit</span>
            <span className="home-cockpit-cta-line">
              What's moving and what needs you — scoped to you, ordered for a{' '}
              {feed.personaLabel.toLowerCase()}.
            </span>
          </span>
          <span className="home-cockpit-cta-go" aria-hidden="true">
            Open ◉
          </span>
        </Link>
      </div>
    </div>
  );
}
