/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';

/**
 * One whitelisted file of an agent system, edited in Monaco and committed back to
 * the system's (mock) Forgejo repo through /api/agents/systems/{id}/files with
 * optimistic-concurrency on the blob sha. This is one of the THREE interchangeable
 * editors over the single source (canvas · this file editor · agent-system chat);
 * a Save here surfaces in the canvas + agent editor after the parent reloads.
 *
 * Monaco is lazy-loaded (ssr:false) and pinned to a same-origin bundle
 * (public/monaco/vs) so the editor works fully offline / air-gapped.
 */
loader.config({ paths: { vs: '/monaco/vs' } });

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <div className="muted" style={{ padding: 16, fontSize: 13 }}>Loading editor…</div>,
});

type RepoFile = { path: string; content: string; sha: string };

function langFor(path: string): string {
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

function useMonacoTheme(): 'vs-dark' | 'light' {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.getAttribute('data-theme') === 'dark');
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark ? 'vs-dark' : 'light';
}

export default function MonacoFile({
  systemId,
  path,
  canEdit,
  height = 360,
  reloadSignal = 0,
  onSaved,
}: {
  systemId: string;
  path: string;
  canEdit: boolean;
  height?: number;
  /**
   * Bump to tell the editor the single source changed underneath it (e.g. a canvas
   * or agent-system-chat edit). It reloads ONLY when the buffer is clean; if there
   * are unsaved edits it surfaces a "changed underneath you" notice instead of
   * silently discarding them.
   */
  reloadSignal?: number;
  /** Fired after a successful commit so the parent can re-read the single source. */
  onSaved?: () => void;
}) {
  const monacoTheme = useMonacoTheme();
  const [file, setFile] = useState<RepoFile | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);

  const dirty = file !== null && value !== file.content;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSaveMsg('');
    setStale(false);
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Failed to open ${path} (${res.status})`);
      else {
        setFile(body as RepoFile);
        setValue((body as RepoFile).content);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [systemId, path]);

  useEffect(() => {
    load();
  }, [load]);

  // A change landed underneath us (canvas / chat edited the one source). Reload
  // when the buffer is clean; if it is dirty, flag it rather than clobber edits.
  // `dirty` is read through a ref so this only fires on a real signal bump.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    if (dirtyRef.current) setStale(true);
    else load();
  }, [reloadSignal, load]);

  const save = useCallback(async () => {
    if (!file || saving || !dirty) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: value, sha: file.sha }),
      });
      const body = await res.json();
      if (!res.ok) setSaveMsg(`✗ ${body.error ?? 'Save failed'}`);
      else {
        setFile({ path: file.path, content: value, sha: body.sha ?? file.sha });
        setSaveMsg('✓ Committed to the system repo.');
        onSaved?.();
      }
    } catch (e) {
      setSaveMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [systemId, dirty, file, saving, value, onSaved]);

  return (
    <div className="code-editor" style={{ minHeight: height + 90 }}>
      <div className="code-editor-head">
        <span className="mono" style={{ fontSize: 12 }}>{path}{dirty ? ' •' : ''}</span>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {stale ? (
            <button className="badge warn" style={{ cursor: 'pointer', border: '1px solid var(--gold-line)' }} onClick={load} title="The single source changed (canvas/chat). Reload and discard your edits.">
              changed underneath — reload ↻
            </button>
          ) : null}
          <span className="badge muted">{langFor(path)}</span>
        </div>
      </div>
      {error ? (
        <div className="error" style={{ margin: 12 }}>{error}</div>
      ) : loading || !file ? (
        <div className="code-empty muted"><span className="spin" /> Loading {path}…</div>
      ) : (
        <>
          <MonacoEditor
            height={height}
            language={langFor(path)}
            value={value}
            onChange={(v) => setValue(v ?? '')}
            theme={monacoTheme}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              readOnly: !canEdit,
              wordWrap: 'on',
            }}
          />
          <div className="code-editor-foot">
            <span className="hint" style={{ marginTop: 0 }}>
              {canEdit ? 'Edits commit to the system’s single source — the canvas reflects them.' : 'Read-only — you cannot edit this system.'}
            </span>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              {saveMsg ? (
                <span className={saveMsg.startsWith('✓') ? 'answer' : 'error'} style={{ fontSize: 12, padding: 0, background: 'none', border: 'none' }}>
                  {saveMsg}
                </span>
              ) : null}
              {canEdit ? (
                <button className="btn sm" onClick={save} disabled={saving || !dirty}>
                  {saving ? <span className="spin" /> : dirty ? 'Save & commit' : 'Saved'}
                </button>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
