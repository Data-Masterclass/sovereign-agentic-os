/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { stripThinking } from '@/lib/agents/agent-chat-response';
import Markdown from '@/components/Markdown';
import BuildDiff, { type FileChange } from './BuildDiff';
import ProgressStepper from '@/components/core/ProgressStepper';
import { deriveBuildProgress } from './build-progress';
import { summarizeChanges } from '@/lib/software/build-changeset';
import type { ActivityLine } from '@/lib/software/build-activity';
import { consumeBuildStream, type BuildStreamEvent } from '@/lib/software/build-stream';
import {
  ACTION_MODE,
  actionPrompt,
  targetLabel,
  type BuildAction,
  type BuildTarget,
  type TargetEpic,
} from '@/lib/software/build-target';
import type { ChatRunMode } from '@/lib/software/chat-modes';

export type { FileChange };
export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type BuildMode = 'plan' | 'build';

/** One rendered activity row: the human line + its raw tool I/O (details on demand). */
type FeedItem = { line: ActivityLine; raw?: { tool: string; args: unknown; result: string } };

/**
 * The Software BUILD-stage chat — a Build-lane-owned variant of AgentChat that
 * (1) sends the current {mode, story} to the per-app chat route, and (2) surfaces
 * the per-run before/after CHANGESET the route returns as inline diffs. Plan mode
 * runs the assistant read-only (the route enforces the read-only tool allowlist);
 * Build mode executes end-to-end and reports its file changes. Kept separate from
 * the shared AgentChat so the shared component stays generic.
 */
export default function BuildChat({
  appId,
  appName,
  mode,
  target,
  epics,
  initialMessages = [],
  onBuilt,
  onRunStart,
  onRunEnd,
  onModeChange,
  onAction,
  lastAction = null,
  showDetails = false,
  actions = ['design', 'build', 'test', 'review'],
  buildTrigger = 0,
}: {
  appId: string;
  appName: string;
  mode: BuildMode;
  /** The tree-selected scope this chat acts on (General / an EPIC / a story). */
  target: BuildTarget | null;
  /** The designed epics — for the action prompts + scope labels. */
  epics: TargetEpic[];
  initialMessages?: ChatMessage[];
  /** Called after a BUILD run that changed files, so the parent can mark the story done + reload. */
  onBuilt?: (changes: FileChange[]) => void;
  /** A run started streaming (the parent can mark the targeted story "building"). */
  onRunStart?: () => void;
  /** The run ended; `failed` is true when it errored. `runMode` says what kind of run it was. */
  onRunEnd?: (failed: boolean, runMode: ChatRunMode) => void;
  /** Design/Build action buttons flip the parent's Plan ⇄ Build toggle through this. */
  onModeChange?: (mode: BuildMode) => void;
  /** Records which action ran for the selected node (the "last: …" hint). */
  onAction?: (action: BuildAction) => void;
  /** The action that last ran for the selected node, if any. */
  lastAction?: BuildAction | null;
  /** Builders may reveal the raw tool I/O behind each activity line ("show details"). */
  showDetails?: boolean;
  /**
   * The scope actions to offer above the chat. Defaults to all four
   * (Design · Build · Test · Review). The redesigned Build stage passes NO
   * actions ([]) because its ONE primary "Build this user story" button lives in
   * the main area above the chat — the chat is for feedback + improvements only.
   */
  actions?: BuildAction[];
  /**
   * A monotonic counter the parent bumps to fire a BUILD run of the current
   * target from OUTSIDE the chat (the Build stage's one "Build this user story"
   * button). Ignored while a run is loading or when no target is selected.
   */
  buildTrigger?: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialMessages.map((m) => (m.role === 'assistant' ? { ...m, content: stripThinking(m.content) } : m)),
  );
  const [lastChanges, setLastChanges] = useState<FileChange[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  // Live run state: the plan + the append-only activity feed for the CURRENT run.
  const [planText, setPlanText] = useState('');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string, runMode: ChatRunMode = mode) => {
      const content = text.trim();
      if (!content || loading) return;
      setError('');
      setStopped(false);
      // Reset the live run surfaces for this new turn.
      setPlanText('');
      setFeed([]);
      setLastChanges([]);
      const next: ChatMessage[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setLoading(true);
      onRunStart?.();
      // The run's honest outcome for the parent: failed on any surfaced error.
      let failed = false;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const scrollDown = () =>
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      try {
        const res = await fetch(`/api/apps/${appId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: 'software', messages: next, mode: runMode, target: target ?? undefined }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          // A pre-stream failure (auth/404/400) returns JSON, not a stream.
          let msg = `The assistant is unavailable right now (error ${res.status}).`;
          try {
            const j = await res.json();
            if (j?.error) msg = String(j.error);
          } catch {
            /* keep the generic message */
          }
          setError(msg);
          failed = true;
          return;
        }

        // Consume the SSE stream: append the plan + each activity line AS it lands,
        // then apply the terminal payload (final assistant bubble + committed diff).
        await consumeBuildStream(res, (e: BuildStreamEvent) => {
          if (e.type === 'plan') {
            setPlanText(e.text);
          } else if (e.type === 'activity') {
            setFeed((f) => [...f, { line: e.line, raw: e.raw }]);
            scrollDown();
          } else if (e.type === 'error') {
            setError(e.message);
            failed = true;
          } else if (e.type === 'final') {
            const changes = Array.isArray(e.changes) ? e.changes : [];
            // Prefer the calm closing summary; the plan + actions already streamed
            // into the live feed above, so the bubble need not repeat the full wall.
            const bubble = stripThinking(e.finalText || e.content);
            setMessages((m) => [...m, { role: 'assistant', content: bubble }]);
            setLastChanges(changes);
            if (runMode === 'build' && changes.length > 0) onBuilt?.(changes);
          }
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') setStopped(true);
        else {
          setError((e as Error).message);
          failed = true;
        }
      } finally {
        abortRef.current = null;
        setLoading(false);
        onRunEnd?.(failed, runMode);
        scrollDown();
      }
    },
    [appId, loading, messages, mode, target, onBuilt, onRunStart, onRunEnd],
  );

  // One of the four scope actions (Design · Build · Test · Review) for the
  // selected node: Design/Build also flip the Plan ⇄ Build toggle (Design maps
  // to Plan); Test/Review run as read-only prompt modes without moving it.
  const runAction = useCallback(
    (action: BuildAction) => {
      if (!target || loading) return;
      if (action === 'design') onModeChange?.('plan');
      if (action === 'build') onModeChange?.('build');
      onAction?.(action);
      void send(actionPrompt(action, epics, target), ACTION_MODE[action]);
    },
    [target, loading, epics, onModeChange, onAction, send],
  );

  // The Build stage's external "Build this user story" button bumps `buildTrigger`;
  // fire a BUILD run of the current target (never on mount — the ref guards the
  // initial value). Honest no-op when a run is in flight or nothing is selected.
  const lastTrigger = useRef(buildTrigger);
  useEffect(() => {
    if (buildTrigger === lastTrigger.current) return;
    lastTrigger.current = buildTrigger;
    if (!target || loading) return;
    onModeChange?.('build');
    onAction?.('build');
    void send(actionPrompt('build', epics, target), 'build');
  }, [buildTrigger, target, loading, epics, onModeChange, onAction, send]);

  const planning = mode === 'plan';
  const label = planning ? 'plan assistant' : 'build assistant';

  // The live BUILD stepper — so a build RUN visibly shows itself building (Plan → Generate
  // → Commit → Preview) instead of a silent spinner. Only for BUILD runs (plan/test/review
  // are read-only and never commit); derived from the same live signals the chat holds.
  const buildProgress = deriveBuildProgress({
    running: loading && !planning,
    hasPlan: !!planText,
    activityCount: feed.length,
    committed: lastChanges.length > 0,
    previewed: false,
    failed: !!error,
  });
  const showBuildStepper = !planning && (loading || feed.length > 0 || planText || lastChanges.length > 0);

  // The four scope actions. Build is PRIMARY (gold) — it's the verb that ships
  // code; Design · Test · Review are secondary (ghost) but full-size, not tiny.
  const ALL_ACTIONS: { key: BuildAction; label: string; title: string; primary?: boolean }[] = [
    { key: 'design', label: 'Design', title: 'Refine the design of the selection (Plan mode — no code changes)' },
    { key: 'build', label: 'Build', title: 'Implement the selection — commits real code', primary: true },
    { key: 'test', label: 'Test', title: 'Critically test the selection against the committed code (read-only)' },
    { key: 'review', label: 'Review', title: 'Review what has been built — risks + feature ideas (read-only)' },
  ];
  const ACTIONS = ALL_ACTIONS.filter((a) => actions.includes(a.key));

  return (
    <div className="chat claude">
      {/* Scope action bar — appears when a node is selected in the tree. Full-size,
          prominent controls: Build primary, the rest comfortably-clickable ghosts. */}
      {target && ACTIONS.length > 0 ? (
        <div className="sw-build-actionbar">
          <div className="sw-build-actionbar-scope">
            <span className="comp-label" style={{ fontSize: 11 }}>Working on</span>
            <strong style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {targetLabel(epics, target)}
            </strong>
            {lastAction ? <span className="badge muted" style={{ fontSize: 10 }}>last: {lastAction}</span> : null}
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                className={a.primary ? 'btn' : 'btn ghost'}
                disabled={loading}
                title={a.title}
                onClick={() => runAction(a.key)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="chat-log" style={{ minHeight: 360 }} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            {planning
              ? 'Plan mode — the assistant discusses and drafts an implementation plan. It makes no code changes.'
              : `Describe what to build or change in ${appName}. Build mode commits real code and shows you the diff.`}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="bubble-role">{m.role === 'user' ? 'You' : label}</div>
              <div className="bubble-body">
                {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : m.content}
              </div>
            </div>
          ))
        )}
        {/* LIVE ACTIVITY FEED — the plan + each governed tool step as it happens,
            so the run is legible while it works instead of a silent spinner. The live
            BUILD stepper + current-step line + STOP live UNDER the Build button (below
            the form), not here — so the running status stays put while the transcript
            (plan text + activity lines) scrolls in the log. */}
        {loading || feed.length > 0 || planText ? (
          <div className="bubble assistant">
            <div className="bubble-role row" style={{ gap: 8, alignItems: 'center' }}>
              <span>{label}</span>
              {loading ? <span className="spin" style={{ width: 12, height: 12 }} /> : null}
            </div>
            <div className="bubble-body">
              {planText ? (
                <div style={{ marginBottom: feed.length ? 10 : 0 }}>
                  <div className="section-title" style={{ fontSize: 11, marginBottom: 4 }}>Plan</div>
                  <Markdown muted>{planText}</Markdown>
                </div>
              ) : null}
              {feed.length > 0 ? (
                <ul className="build-activity" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                  {feed.map((it, i) => (
                    <ActivityRow key={i} item={it} showDetails={showDetails} />
                  ))}
                </ul>
              ) : null}
              {loading && feed.length === 0 && !planText ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {planning ? 'Planning…' : 'Building…'} the model can take a moment on the first message.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
      {stopped ? <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Stopped.</div> : null}

      {/* The per-run changeset — before/after diffs of what this Build run committed. */}
      {!planning && lastChanges.length > 0 ? (
        <BuildDiff changes={lastChanges} summary={summarizeChanges(lastChanges)} />
      ) : null}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} style={{ marginTop: 12 }}>
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={planning ? 'Ask the assistant to plan a change (no code is written)…' : `Describe what to build or change in ${appName}…`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); }
          }}
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send.</div>
          {loading ? (
            <button className="btn ghost" type="button" onClick={stop}>Stop</button>
          ) : (
            <button className="btn" type="submit" disabled={!input.trim()}>{planning ? 'Plan' : 'Build'}</button>
          )}
        </div>
      </form>

      {/* LIVE BUILD STATUS — directly under the Build button, fixed (does not scroll with
          the chat). The Plan → Generate → Commit → Preview stepper, the current-step line,
          and the STOP control live here while a build RUN is active, then briefly settle to
          "Build committed." and clear when the run is fully idle. The transcript (plan text,
          activity lines, the reasoning-escalation label) stays in the chat log above. */}
      {showBuildStepper ? (
        <div
          className="sw-build-live"
          style={{
            marginTop: 12,
            padding: '10px 14px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'var(--panel)',
          }}
        >
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <span className="comp-label" style={{ fontSize: 11 }}>Build status</span>
            {loading ? (
              <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>Stop</button>
            ) : null}
          </div>
          <ProgressStepper
            steps={buildProgress.steps}
            active={buildProgress.active}
            done={buildProgress.done}
            ok={buildProgress.ok}
            commentary={
              error ? 'Build stopped — see the error above.'
                : loading ? (planText && feed.length === 0 ? 'Planning the change…' : 'Generating & committing code…')
                  : lastChanges.length > 0 ? 'Build committed.' : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One activity line: a chip-style row with the plain-language text; errors read as
 * a warning tone. Builders get a "details" toggle that reveals the raw tool I/O
 * (args + result) so they can debug without leaving the feed.
 */
function ActivityRow({
  item,
  showDetails,
}: {
  item: FeedItem;
  showDetails: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { line, raw } = item;
  return (
    <li>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <span
          className={`chip ${line.isError ? 'warn' : ''}`}
          style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
        >
          {line.text}
        </span>
        {showDetails && raw ? (
          <button
            type="button"
            className="sw-quiet-link"
            style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'hide details' : 'show details'}
          </button>
        ) : null}
      </div>
      {open && raw ? (
        <pre
          className="card"
          style={{ margin: '6px 0 0', padding: 8, fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {`→ ${raw.tool}(${JSON.stringify(raw.args)})\n${raw.result}`}
        </pre>
      ) : null}
    </li>
  );
}
