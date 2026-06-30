/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import { useUser } from '@/lib/useUser';
import { listTutorials } from '@/lib/tutorials/registry';
import { framingForRole, framingFor } from '@/lib/tutorials/engine';
import type { IllustrationId } from '@/lib/tutorials/types';
import Illustration from './Illustration';
import TutorialLink from './TutorialLink';

/**
 * The Home golden-path launcher: one illustrated card per path. Each card offers
 * two doors — DO IT (the role-aware primary action, deep-linking into the tab)
 * and LEARN IT ("How it works" → the same tutorial the tab header opens). The
 * illustration motif is taken from the tutorial's hook so Home and the overlay
 * share one visual language.
 */
export default function HomeLauncher() {
  const { user } = useUser();
  const role = framingForRole(user?.role);
  const tutorials = listTutorials();

  return (
    <div className="launcher">
      {tutorials.map((t) => {
        const f = framingFor(t, role);
        const art = t.hook.illustration as IllustrationId;
        return (
          <div className="launch-card" key={t.key}>
            <div className="launch-art">
              <Illustration id={art} size={64} />
            </div>
            <h3 className="launch-title">{t.title}</h3>
            <p className="launch-line">{t.tagline}</p>
            <div className="launch-actions">
              <Link className="launch-go" href={t.route}>
                {f.verb} →
              </Link>
              <TutorialLink tutorial={t.key} variant="card" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
