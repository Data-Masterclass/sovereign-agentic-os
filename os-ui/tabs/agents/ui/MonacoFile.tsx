/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';
import { useMonacoTheme } from '@core/ui/useMonacoTheme';
import { sourceChangeAction } from '@tabs/agents/lib/agent-editor-view';
import { useTranslations } from '@core/i18n/client';

/**
 * One whitelisted file of an agent system, edited in Monaco and committed back to
 * the system's stored files through /api/agents/systems/{id}/files with
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
  loading: () => <LoadingEditor />,
});

function LoadingEditor() {
  const t = useTranslations('agents');
  return <div className="muted" style={{ padding: 16, fontSize: 13 }}>{t('monaco.loadingEditor')}</div>;
}

type RepoFile = { path: string; content: string; sha: string };

/** Imperative handle a host (the large agent editor) uses for Cmd/Ctrl+S. */
export type MonacoFileControl = {
  save: () => Promise<void>;
  /** The unsaved buffer, or null when clean — lets a host carry it into another editor. */
  draft: () => string | null;
};

function langFor(path: string): string {
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}


export default function MonacoFile({
  systemId,
  path,
  canEdit,
  height = 360,
  reloadSignal = 0,
  onSaved,
  readOnlyHint,
  fill = false,
  onDirtyChange,
  controlRef,
  sourceContent,
  initialDraft,
}: {
  systemId: string;
  path: string;
  canEdit: boolean;
  height?: number;
  /**
   * Foot note shown when `canEdit` is false. Defaults to a "no permission" message;
   * pass a friendlier note (e.g. "Viewing the source — click Edit to change it") when
   * read-only is a deliberate view mode rather than a permission denial.
   */
  readOnlyHint?: string;
  /**
   * Bump to tell the editor the single source changed underneath it (e.g. a canvas
   * or agent-system-chat edit). It reloads ONLY when the buffer is clean; if there
   * are unsaved edits it surfaces a "changed underneath you" notice instead of
   * silently discarding them.
   */
  reloadSignal?: number;
  /** Fired after a successful commit so the parent can re-read the single source. */
  onSaved?: () => void;
  /** Grow to fill a flex parent (the large agent editor) instead of a fixed `height`. */
  fill?: boolean;
  /** Told whenever the buffer turns dirty / clean (unsaved-changes guard). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Receives `{ save }` so a host can save on Cmd/Ctrl+S through the same PUT. */
  controlRef?: MutableRefObject<MonacoFileControl | null>;
  /**
   * This file's content as the parent currently sees it in the one source. When it
   * differs from what the editor loaded/saved, a clean buffer reloads and a dirty one
   * shows "changed underneath". Edits to OTHER parts of the source never touch it.
   */
  sourceContent?: string;
  /** Unsaved text carried in from another editor (e.g. the drawer); applied on first load. */
  initialDraft?: string;
}) {
  const t = useTranslations('agents');
  const monacoTheme = useMonacoTheme();
  const [file, setFile] = useState<RepoFile | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);

  const dirty = file !== null && value !== file.content;
  const draftRef = useRef(initialDraft);
  const fileRef = useRef(file);
  fileRef.current = file;
  const valueRef = useRef(value);
  valueRef.current = value;
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSaveMsg('');
    setStale(false);
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('monaco.openFailed', { path, status: res.status }));
      else {
        setFile(body as RepoFile);
        const draft = draftRef.current;
        draftRef.current = undefined;
        setValue(draft ?? (body as RepoFile).content);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [systemId, path, t]);

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

  // Precise variant: react only when THIS file's content in the source changed.
  useEffect(() => {
    const action = sourceChangeAction(sourceContent, fileRef.current?.content ?? null, dirtyRef.current);
    if (action === 'stale') setStale(true);
    else if (action === 'reload') void load();
  }, [sourceContent, load]);

  const save = useCallback(async () => {
    // savingRef, not the `saving` state: two quick Cmd+S presses must not send two PUTs.
    if (!file || savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setSaveMsg('');
    try {
      // A hand-edited system.yaml is where a pasted/foreign grant id lands — ask the save to say
      // which grants you cannot use (`grantWarnings`, a warning only; the save still lands).
      const check = file.path === 'system.yaml' ? '?check=grants' : '';
      const res = await fetch(`/api/agents/systems/${systemId}/files${check}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: value, sha: file.sha }),
      });
      const body = await res.json();
      if (!res.ok) setSaveMsg(`✗ ${body.error ?? t('monaco.saveFailed')}`);
      else {
        setFile({ path: file.path, content: value, sha: body.sha ?? file.sha });
        const ws = (body.grantWarnings ?? []) as { id?: string; folder?: { path: string }; message: string }[];
        const gc = body.grantCheck as { checked: boolean; reason?: string } | undefined;
        // The warning texts and the check's reason come from the server and stay verbatim.
        const main = ws.length === 0
          ? t('monaco.committed')
          : t('monaco.committedWarn', {
              count: ws.length,
              list: ws.map((w) => `${w.id ?? w.folder?.path}: ${w.message}`).join(' · '),
            });
        setSaveMsg(
          gc && !gc.checked
            ? `${main} ${t('monaco.grantCheckSkipped', { reason: gc.reason ?? t('monaco.unknownReason') })}`
            : main,
        );
        onSaved?.();
      }
    } catch (e) {
      setSaveMsg(`✗ ${(e as Error).message}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [systemId, dirty, file, value, onSaved, t]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!controlRef) return undefined;
    controlRef.current = {
      save,
      draft: () => (fileRef.current && valueRef.current !== fileRef.current.content ? valueRef.current : null),
    };
    return () => { controlRef.current = null; };
  }, [controlRef, save]);

  const editor = (
    <MonacoEditor
      height={fill ? '100%' : height}
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
        ariaLabel: t('monaco.editorAria', { path }),
      }}
    />
  );

  return (
    <div className={`code-editor${fill ? ' is-fill' : ''}`} style={fill ? undefined : { minHeight: height + 90 }}>
      <div className="code-editor-head">
        <span className="mono" style={{ fontSize: 12 }}>{path}{dirty ? ' •' : ''}</span>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {stale ? (
            <button className="badge warn" style={{ cursor: 'pointer', border: '1px solid var(--gold-line)' }} onClick={load} title={t('monaco.staleTitle')}>
              {t('monaco.stale')}
            </button>
          ) : null}
          <span className="badge muted">{langFor(path)}</span>
        </div>
      </div>
      {error ? (
        <div className="error" style={{ margin: 12 }}>{error}</div>
      ) : loading || !file ? (
        <div className="code-empty muted"><span className="spin" /> {t('monaco.loadingFile', { path })}</div>
      ) : (
        <>
          {fill ? <div className="code-editor-body"><div className="code-editor-body-inner">{editor}</div></div> : editor}
          <div className="code-editor-foot">
            <span className="hint" style={{ marginTop: 0 }}>
              {canEdit ? t('monaco.editHint') : (readOnlyHint ?? t('monaco.readOnlyHint'))}
            </span>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              {saveMsg ? (
                <span className={saveMsg.startsWith('✓') ? 'answer' : 'error'} style={{ fontSize: 12, padding: 0, background: 'none', border: 'none' }}>
                  {saveMsg}
                </span>
              ) : null}
              {canEdit ? (
                <button className="btn sm" onClick={save} disabled={saving || !dirty}>
                  {saving ? <span className="spin" /> : dirty ? t('monaco.saveCommit') : t('monaco.saved')}
                </button>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
