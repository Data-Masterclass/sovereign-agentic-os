/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import { currentUser } from '@core/kernel/auth';
import { homeFeed } from '@tabs/home/lib/feed';
import HomeLauncher from '@tabs/home/ui/HomeLauncher';
import HomeTalkToOs from '@tabs/home/ui/HomeTalkToOs';
import McpDrawer from '@tabs/admin/ui/McpDrawer';

export const dynamic = 'force-dynamic';

/**
 * Home — the welcoming golden-path launcher (home-golden-path.md). Server-rendered
 * from the OPA/RLS-scoped home-feed adapter: an illustrated launcher whose copy
 * + dimming shift by the viewer's persona. Home is the front door — it orients
 * and routes into the golden paths.
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
            Your governed space on the Sovereign Agentic OS. Pick a golden path to create something.
          </p>
        </div>
        <div className="home-persona" title="Your role shapes what Home emphasizes.">
          <span className="home-persona-stance">{feed.personaStance}</span>
          <span className="home-persona-role">{feed.personaLabel}</span>
        </div>
      </header>

      <div className="content home-content">
        {/* Talk to the OS — the front-door assistant entry: type intent, it opens the one global
            OS Assistant already answering. */}
        <HomeTalkToOs />

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
            Ten ways to build. Each card explains itself and launches its flow. Paths your role
            can't act on yet are dimmed — still yours to explore.
          </p>
        </div>

        <HomeLauncher cards={feed.launcher} />
      </div>
    </div>
  );
}
