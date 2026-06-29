/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';

/**
 * In-browser code editor for the Software golden path (Layer 3), shown beside
 * the OpenCode build assistant. A file tree of the app's Forgejo repo on the
 * left, a Monaco editor on the right; Save commits back to Forgejo.
 *
 * Monaco is LAZY-LOADED (next/dynamic, ssr:false) so it never runs at SSR time
 * and stays out of the initial bundle. All repo access goes through the
 * Builder/Admin-gated server route at /api/software/{id}/files — no Forgejo
 * URL, credential or token ever reaches the browser.
 *
 * SOVEREIGNTY / air-gap: @monaco-editor/loader defaults to loading the Monaco
 * `vs/` bundle from the jsDelivr CDN. We pin it to a SAME-ORIGIN path served from
 * this app (public/monaco/vs, populated by scripts/copy-monaco.mjs at build time
 * — see package.json `prebuild`). No external network fetch is made for the
 * editor, so it works fully offline / air-gapped.
 */
loader.config({ paths: { vs: '/monaco/vs' } });

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <div className="muted" style={{ padding: 16, fontSize: 13 }}>Loading editor…</div>,
});

type FileMeta = { mode: 'live' | 'offline'; branch: string; files: string[] };
type RepoFile = { path: string; content: string; sha: string };

function langFor(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'py':
      return 'python';
    default:
      return 'plaintext';
  }
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

export default function CodePanel({ appId, repoFullName }: { appId: string; repoFullName: string }) {
  const monacoTheme = useMonacoTheme();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [treeError, setTreeError] = useState('');
  const [treeLoading, setTreeLoading] = useState(true);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<RepoFile | null>(null);
  const [value, setValue] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const dirty = file !== null && value !== file.content;

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError('');
    try {
      const res = await fetch(`/api/software/${appId}/files`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setTreeError(body.error ?? `Failed to load files (${res.status})`);
      else setMeta(body as FileMeta);
    } catch (e) {
      setTreeError((e as Error).message);
    } finally {
      setTreeLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const openFile = useCallback(
    async (path: string) => {
      setSelected(path);
      setFile(null);
      setValue('');
      setFileError('');
      setSaveMsg('');
      setFileLoading(true);
      try {
        const res = await fetch(`/api/software/${appId}/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) setFileError(body.error ?? `Failed to open file (${res.status})`);
        else {
          setFile(body as RepoFile);
          setValue((body as RepoFile).content);
        }
      } catch (e) {
        setFileError((e as Error).message);
      } finally {
        setFileLoading(false);
      }
    },
    [appId],
  );

  const save = useCallback(async () => {
    if (!file || saving || !dirty) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`/api/software/${appId}/files`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: value, sha: file.sha, message }),
      });
      const body = await res.json();
      if (!res.ok) setSaveMsg(`✗ ${body.error ?? 'Save failed'}`);
      else {
        setFile({ path: file.path, content: value, sha: body.sha ?? file.sha });
        setMessage('');
        setSaveMsg('✓ Committed to Forgejo.');
      }
    } catch (e) {
      setSaveMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [appId, dirty, file, message, saving, value]);

  return (
    <div className="code-panel">
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        View, edit and commit <strong>{repoFullName}</strong> in-browser. Save writes a commit to the
        app&apos;s Forgejo repo on <span className="mono">main</span>; CI → Harbor → Argo CD pick it up.
      </p>

      <div className="code-grid">
        <aside className="code-tree">
          <div className="code-tree-head">
            <span>Files</span>
            <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={loadTree} disabled={treeLoading}>
              {treeLoading ? <span className="spin" /> : 'Refresh'}
            </button>
          </div>
          {treeError ? (
            <div className="error" style={{ margin: 8 }}>{treeError}</div>
          ) : treeLoading && !meta ? (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>Loading…</div>
          ) : meta && meta.files.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>
              {meta.mode === 'offline'
                ? 'Repo is offline — no files to show.'
                : 'No files in this repo yet.'}
            </div>
          ) : (
            <ul className="code-filelist">
              {meta?.files.map((f) => (
                <li key={f}>
                  <button
                    className={`code-fileitem${selected === f ? ' active' : ''}`}
                    onClick={() => openFile(f)}
                    title={f}
                  >
                    {f}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="code-editor">
          {!selected ? (
            <div className="code-empty muted">Select a file to view and edit its code.</div>
          ) : fileError ? (
            <div className="error" style={{ margin: 12 }}>{fileError}</div>
          ) : fileLoading || !file ? (
            <div className="code-empty muted"><span className="spin" /> Loading {selected}…</div>
          ) : (
            <>
              <div className="code-editor-head">
                <span className="mono" style={{ fontSize: 12 }}>
                  {file.path}{dirty ? ' •' : ''}
                </span>
                <span className="badge muted">{langFor(file.path)}</span>
              </div>
              <MonacoEditor
                height={420}
                language={langFor(file.path)}
                value={value}
                onChange={(v) => setValue(v ?? '')}
                theme={monacoTheme}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
              <div className="code-editor-foot">
                <input
                  className="code-commit-msg"
                  placeholder={`Commit message (default: Edit ${file.path}…)`}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                  {saveMsg ? (
                    <span className={saveMsg.startsWith('✓') ? 'answer' : 'error'} style={{ fontSize: 12, padding: 0, background: 'none', border: 'none' }}>
                      {saveMsg}
                    </span>
                  ) : null}
                  <button className="btn" onClick={save} disabled={saving || !dirty}>
                    {saving ? <span className="spin" /> : dirty ? 'Save & commit' : 'Saved'}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
