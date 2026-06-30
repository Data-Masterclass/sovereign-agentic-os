/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import AgentChat from '@/components/AgentChat';

/**
 * Tacit-knowledge panel — the workflow-level tacit doc (sibling tacit.md). Capture
 * the practitioners' hidden know-how ANY way: paste notes, upload a transcript, or
 * record-stub (a mocked in-app transcription), then let the knowledge agent
 * COMPRESS it into clean markdown (reuses AgentChat). The compressed reply lands in
 * the editor; Save commits it to tacit.md. The transcription backend is stubbed in
 * kind; paste/upload are fully real.
 */

export default function TacitPanel({
  workflowId,
  initialTacit,
  canEdit,
}: {
  workflowId: string;
  initialTacit: string;
  canEdit: boolean;
}) {
  const [tacit, setTacit] = useState(initialTacit);
  const [raw, setRaw] = useState(''); // the captured-but-not-yet-compressed source
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Refresh from the server on mount so re-entering the tab shows the latest
  // saved tacit.md (this panel saves independently of the parent reload).
  useEffect(() => {
    let live = true;
    fetch(`/api/knowledge/workflows/${workflowId}/tacit`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d && typeof d.tacit === 'string') setTacit(d.tacit); })
      .catch(() => null);
    return () => { live = false; };
  }, [workflowId]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw((r) => (r ? `${r}\n\n${text}` : text));
    if (fileRef.current) fileRef.current.value = '';
  }

  // Record-stub: the real mic+transcription is wired on STACKIT; in kind we emit a
  // deterministic stub transcript so the capture → compress flow is demonstrable.
  function recordStub() {
    setRecording(true);
    setTimeout(() => {
      const stub =
        '[transcription stub] So the thing nobody writes down is that the bank portal ' +
        'truncates long notes, and Friday afternoon submissions slip to next week. ' +
        'Also the income date in section four is the usual reason a package bounces.';
      setRaw((r) => (r ? `${r}\n\n${stub}` : stub));
      setRecording(false);
    }, 900);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}/tacit`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tacit }),
      });
      const data = await res.json();
      if (!res.ok) setMsg(`✗ ${data.error ?? 'Save failed'}`);
      else setMsg('✓ Saved to tacit.md');
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tacit-panel">
      <p className="hint" style={{ marginTop: 0 }}>
        The practitioners&rsquo; hidden know-how. Capture it any way — paste, upload a transcript,
        or record — then the knowledge agent compresses it into clean markdown.
      </p>

      {/* Current tacit.md */}
      <div className="section-title">Tacit knowledge (tacit.md)</div>
      <textarea
        className="tacit-editor mono"
        rows={10}
        value={tacit}
        disabled={!canEdit}
        onChange={(e) => setTacit(e.target.value)}
        placeholder="The compressed tacit knowledge lives here. Capture raw notes below and compress them, or edit directly."
      />
      {canEdit && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          {msg ? <span className={msg.startsWith('✓') ? 'hint' : 'error'} style={{ margin: 0 }}>{msg}</span> : <span />}
          <button className="btn" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spin" /> : 'Save tacit.md'}
          </button>
        </div>
      )}

      {canEdit && (
        <>
          {/* Capture */}
          <div className="section-title" style={{ marginTop: 24 }}>Capture raw notes</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Upload transcript / .md</button>
            <input ref={fileRef} type="file" accept=".txt,.md,.vtt,.srt,text/*" onChange={onUpload} style={{ display: 'none' }} />
            <button className="btn ghost sm" onClick={recordStub} disabled={recording}>
              {recording ? <span className="spin" /> : '● Record (stub)'}
            </button>
          </div>
          <textarea
            className="tacit-raw"
            rows={5}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Paste raw notes / interview transcript here, or use Upload / Record above…"
          />

          {/* Compress with the knowledge agent */}
          <div className="section-title" style={{ marginTop: 20 }}>Compress with the knowledge agent</div>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Send the raw capture and the agent returns clean, compressed tacit markdown. Its reply
            lands in the editor above — review, then Save.
          </p>
          <AgentChat
            agent="knowledge"
            label="knowledge agent"
            placeholder={raw ? 'Press Send to compress the captured notes…' : 'Paste or capture notes above first…'}
            starters={raw ? [`Compress these notes into clean tacit-knowledge markdown:\n\n${raw.slice(0, 400)}`] : []}
            onAssistant={(content) => setTacit(content)}
          />
        </>
      )}

      <style>{TacitStyles}</style>
    </div>
  );
}

const TacitStyles = `
.tacit-editor, .tacit-raw {
  width: 100%;
  font-size: 12.5px; line-height: 1.55; resize: vertical;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 11px;
}
.tacit-raw { font-family: var(--font-body); font-size: 13px; }
`;
