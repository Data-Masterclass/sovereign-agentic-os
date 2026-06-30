/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { cockpitFeed } from '@/lib/home/feed';
import Cockpit from '@/components/home/Cockpit';
import TopItems from '@/components/home/TopItems';
import './cockpit.css';

export const dynamic = 'force-dynamic';

/**
 * Cockpit (`/cockpit`) — the live, governed overview that used to sit under Home.
 * Server-rendered from the OPA/RLS-scoped cockpit-feed adapter: a warm greeting,
 * a headline pulse strip, the persona-ordered modules (what-needs-me · my WIP ·
 * domain pulse · health & cost · recent activity · ask), and a scannable
 * "top items per artifact" board. Cockpit reads + routes; it never recomputes a
 * tab's numbers and never bypasses governance. Styles are scoped in cockpit.css.
 */
export default async function CockpitPage() {
  const user = await currentUser();

  if (!user) {
    return (
      <div className="cockpit-page">
        <div className="ci-shell">
          <div className="stub-page">
            Your session has ended. <Link href="/signin">Sign in</Link> to open your cockpit.
          </div>
        </div>
      </div>
    );
  }

  const feed = await cockpitFeed(user);
  const firstName = user.name.split(' ')[0] || user.name;

  const openNeeds = feed.needs.filter((n) => n.actionable).length;
  const waitingNeeds = feed.needs.length - openNeeds;
  const topTotal = feed.topItems.reduce((s, g) => s + g.count, 0);

  // A warm, honest greeting that adapts to time of day (server clock).
  const hour = new Date().getHours();
  const partOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const stats: { label: string; value: string; tone: string; href: string; hint: string }[] = [
    {
      label: openNeeds === 1 ? 'Needs you' : 'Need you',
      value: String(openNeeds),
      tone: openNeeds > 0 ? 'act' : 'calm',
      href: '/governance',
      hint: openNeeds > 0 ? 'ready to action' : 'all clear',
    },
    {
      label: 'In progress',
      value: String(feed.wip.length),
      tone: 'draft',
      href: '/data',
      hint: feed.wip.length === 1 ? 'draft in flight' : 'drafts in flight',
    },
    {
      label: 'Your items',
      value: String(topTotal),
      tone: 'gold',
      href: '#top-items',
      hint: 'across the registry',
    },
    {
      label: 'Spend',
      value: `$${feed.health.spendUsd}`,
      tone: feed.health.spendPct > 0.8 ? 'hot' : 'teal',
      href: '/monitoring',
      hint: `of $${feed.health.capUsd} cap`,
    },
  ];

  return (
    <div className="cockpit-page">
      <header className="ci-hero">
        <div className="ci-hero-text">
          <div className="ci-eyebrow">{feed.domain} · cockpit</div>
          <h1 className="ci-greeting">
            Good {partOfDay}, <span className="ci-name">{firstName}</span>.
          </h1>
          <p className="ci-sub">
            {openNeeds > 0 || waitingNeeds > 0
              ? `Here's what's moving in your domain — and the ${openNeeds + waitingNeeds} ${
                  openNeeds + waitingNeeds === 1 ? 'thing' : 'things'
                } on your plate.`
              : "Here's what's moving in your domain. Nothing is waiting on you right now."}
          </p>
        </div>
        <div className="ci-persona" title="Your role shapes how the cockpit is ordered.">
          <span className="ci-persona-stance">{feed.personaStance}</span>
          <span className="ci-persona-role">{feed.personaLabel}</span>
        </div>
      </header>

      <div className="ci-shell">
        <div className="ci-stats">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className={`ci-stat tone-${s.tone}`}>
              <span className="ci-stat-value">{s.value}</span>
              <span className="ci-stat-label">{s.label}</span>
              <span className="ci-stat-hint">{s.hint}</span>
            </Link>
          ))}
        </div>

        <div className="ci-sec-head">
          <h2 className="ci-sec-title">What's moving</h2>
          <p className="ci-sec-sub">
            Scoped to you, ordered for a {feed.personaLabel.toLowerCase()}. Each card links into its
            owning tab — the cockpit reads, it never recomputes.
          </p>
        </div>

        <Cockpit feed={feed} />

        <div className="ci-sec-head" id="top-items" style={{ scrollMarginTop: 24 }}>
          <h2 className="ci-sec-title">Top items, by type</h2>
          <p className="ci-sec-sub">
            The most-notable thing you can see in each part of the registry. Governed and scoped —
            never another domain's, never someone else's drafts.
          </p>
        </div>

        <TopItems groups={feed.topItems} />
      </div>
    </div>
  );
}
