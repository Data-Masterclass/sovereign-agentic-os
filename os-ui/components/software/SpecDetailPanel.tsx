/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { AppEpic, AppStory } from '@/lib/software/apps';
import { deriveStoryChecklist, deriveEpicOverview, type ChecklistItem } from '@/lib/software/story-spec';
import type { SpecNode } from './SpecTree';

/**
 * SpecDetailPanel — the ALWAYS-VISIBLE right panel for the Build stage. It shows the
 * selected node's Design spec at all times:
 *
 *   • BEFORE build — just the spec ("what this should do").
 *   • AFTER build  — the SAME spec with each item ticked honestly against what actually
 *     got built (pending if unverifiable, never fake-ticked; a story is "built" only
 *     when its Build run committed → status 'done'), plus a short built overview.
 *
 * Clicking an EPIC shows a roll-up of its stories' built-state; a STORY shows its
 * features' built-state + spec; a FEATURE shows that feature's spec line + built/pending.
 * All built-state derivation is pure (lib/software/story-spec.ts) so it can never fake a tick.
 */

function ItemRow({ item }: { item: ChecklistItem }) {
  return (
    <li className="sdp-item">
      <span className={`sdp-tick ${item.built ? 'on' : ''}`} aria-hidden="true">{item.built ? '✓' : '○'}</span>
      <span className="sdp-item-text">{item.text}</span>
      <span className={`badge ${item.built ? 'ok' : 'muted'}`} style={{ fontSize: 10 }}>{item.built ? 'built' : 'pending'}</span>
      <style jsx>{`
        .sdp-item { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 0; }
        .sdp-tick { width: 16px; text-align: center; color: var(--text-faint); }
        .sdp-tick.on { color: var(--ok, #2f9e44); font-weight: 700; }
        .sdp-item-text { flex: 1; min-width: 0; }
      `}</style>
    </li>
  );
}

function ChecklistBlock({ story }: { story: AppStory }) {
  const c = deriveStoryChecklist(story);
  const built = story.status === 'done';
  if (c.total === 0) {
    return <p className="hint" style={{ marginTop: 8 }}>No spec authored for this story yet — add its features, NFRs and rules in Design.</p>;
  }
  const byKind = (k: ChecklistItem['kind']) => c.items.filter((i) => i.kind === k);
  const SECTIONS: { kind: ChecklistItem['kind']; label: string }[] = [
    { kind: 'feature', label: 'Features' },
    { kind: 'nfr', label: 'Non-functional requirements' },
    { kind: 'rule', label: 'Rules' },
  ];
  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <span className={`badge ${built ? 'ok' : 'muted'}`}>{built ? 'built ✓' : 'not built yet'}</span>
        <span className="muted" style={{ fontSize: 12 }}>{c.built} / {c.total} spec item{c.total === 1 ? '' : 's'} built</span>
      </div>
      {!built ? (
        <p className="hint" style={{ marginTop: 6 }}>
          These are the spec items this story should satisfy. They tick off only once a Build run commits code for the story — nothing is marked built until it honestly is.
        </p>
      ) : null}
      {SECTIONS.map((s) => {
        const rows = byKind(s.kind);
        if (rows.length === 0) return null;
        return (
          <div key={s.kind} style={{ marginTop: 10 }}>
            <div className="comp-label" style={{ margin: 0 }}>{s.label}</div>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
              {rows.map((it, i) => <ItemRow key={i} item={it} />)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function SpecDetailPanel({ node, epics }: { node: SpecNode; epics: AppEpic[] }) {
  // Resolve the node to its data.
  if (node.kind === 'app') {
    const stories = epics.flatMap((e) => e.stories ?? []);
    const total = stories.length;
    const done = stories.filter((s) => s.status === 'done').length;
    return (
      <div className="sdp">
        <div className="comp-label" style={{ margin: 0 }}>Whole app</div>
        <p className="hint" style={{ marginTop: 4 }}>Select a story or feature on the left to see its spec and built-state.</p>
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="badge muted">{epics.length} EPIC{epics.length === 1 ? '' : 's'}</span>
          <span className={`badge ${done > 0 ? 'ok' : 'muted'}`}>{done} / {total} stor{total === 1 ? 'y' : 'ies'} built</span>
        </div>
        <style jsx>{`.sdp { }`}</style>
      </div>
    );
  }

  const epic = epics.find((e) => e.id === node.epicId);
  if (!epic) return <div className="sdp"><p className="hint" style={{ margin: 0 }}>Selection not found — it may have been removed.</p></div>;

  if (node.kind === 'epic') {
    const o = deriveEpicOverview(epic);
    return (
      <div className="sdp">
        <div className="comp-label" style={{ margin: 0 }}>EPIC · {epic.title.trim() || 'Untitled'}</div>
        {epic.description ? <p className="hint" style={{ marginTop: 4 }}>{epic.description}</p> : null}
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`badge ${o.storiesBuilt > 0 ? 'ok' : 'muted'}`}>{o.storiesBuilt} / {o.storiesTotal} stor{o.storiesTotal === 1 ? 'y' : 'ies'} built</span>
          <span className="muted" style={{ fontSize: 12 }}>{o.itemsBuilt} / {o.itemsTotal} spec items</span>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(epic.stories ?? []).map((s) => {
            const c = deriveStoryChecklist(s);
            return (
              <div key={s.id} className="sdp-rollup">
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{s.title.trim() || 'Untitled story'}</span>
                <span className={`badge ${s.status === 'done' ? 'ok' : 'muted'}`} style={{ fontSize: 10 }}>{s.status === 'done' ? 'done ✓' : 'to do'}</span>
                <span className="muted" style={{ fontSize: 11 }}>{c.built}/{c.total}</span>
              </div>
            );
          })}
        </div>
        <style jsx>{`
          .sdp-rollup { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: var(--panel); }
        `}</style>
      </div>
    );
  }

  const story = (epic.stories ?? []).find((s) => s.id === node.storyId);
  if (!story) return <div className="sdp"><p className="hint" style={{ margin: 0 }}>Story not found.</p></div>;

  if (node.kind === 'story') {
    return (
      <div className="sdp">
        <div className="comp-label" style={{ margin: 0 }}>Story · {story.title.trim() || 'Untitled'}</div>
        {story.asA || story.iWant || story.soThat ? (
          <p className="hint" style={{ marginTop: 4 }}>
            As a <strong>{story.asA || '…'}</strong> I want <strong>{story.iWant || '…'}</strong> so that <strong>{story.soThat || '…'}</strong>.
          </p>
        ) : null}
        <ChecklistBlock story={story} />
      </div>
    );
  }

  // Feature-level detail.
  const feature = story.spec?.features?.[node.index];
  const built = story.status === 'done';
  return (
    <div className="sdp">
      <div className="comp-label" style={{ margin: 0 }}>Feature · in {story.title.trim() || 'Untitled story'}</div>
      <p style={{ marginTop: 8, fontSize: 14 }}>{feature ?? '(feature removed)'}</p>
      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
        <span className={`badge ${built ? 'ok' : 'muted'}`}>{built ? 'built ✓' : 'pending'}</span>
        {!built ? <span className="muted" style={{ fontSize: 12 }}>Ticks once this story&apos;s Build run commits — never fake-ticked.</span> : null}
      </div>
    </div>
  );
}
