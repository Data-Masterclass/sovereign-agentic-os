/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import { currentUser } from '@core/kernel/auth';
import { homeFeed } from '@tabs/home/lib/feed';
import HomeLauncher from '@tabs/home/ui/HomeLauncher';
import HomeChat from '@tabs/home/ui/HomeChat';
import McpDrawer from '@tabs/admin/ui/McpDrawer';
import { getTranslations } from '@core/i18n/server';

export const dynamic = 'force-dynamic';

/**
 * Home — the welcoming golden-path launcher (home-golden-path.md). Server-rendered
 * from the OPA/RLS-scoped home-feed adapter: an illustrated launcher whose copy
 * + dimming shift by the viewer's persona. Home is the front door — it orients
 * and routes into the golden paths.
 *
 * I18N: converted (wave 2) — strings from the `home` namespace (`home.page.*`, `home.persona.*`).
 */
export default async function HomePage() {
  const user = await currentUser();
  const t = await getTranslations('home');

  // Middleware guards this route, but stay graceful if the session just expired.
  if (!user) {
    return (
      <div className="home">
        <div className="content">
          <div className="stub-page">
            {t.rich('page.sessionEnded', { link: (c) => <Link href="/signin">{c}</Link> })}
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
            {t('page.feedFailed')}
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
          <div className="home-eyebrow">{t('page.eyebrow', { domain: feed.domain })}</div>
          <h1 className="home-greeting">
            {t.rich('page.welcome', { firstName, name: (c) => <span className="home-name">{c}</span> })}
          </h1>
        </div>
        <div className="home-persona" title={t('page.personaTitle')}>
          <span className="home-persona-stance">{t(`persona.stance.${feed.persona}`)}</span>
          <span className="home-persona-role">{t(`persona.label.${feed.persona}`)}</span>
        </div>
      </header>

      <div className="content home-content">
        {/* Golden paths — compact, one row; the chat below has the space. */}
        <HomeLauncher cards={feed.launcher} compact />

        {/* The chat: runs the governed tools as the user, asks before it writes. */}
        <HomeChat firstName={firstName} />

        <div className="mcp-cta-banner mcp-cta-slim">
          <div className="mcp-cta-banner-text">
            <p className="mcp-cta-banner-kicker">{t('page.mcpKicker')}</p>
          </div>
          <McpDrawer className="mcp-cta-btn" />
        </div>
      </div>
    </div>
  );
}
