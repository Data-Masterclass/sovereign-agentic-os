/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * BUILD TARGET + ACTION derivation for the Build stage (pure, unit-tested).
 *
 * The epic/story tree selects ONE node as the scope every chat action runs on:
 *   • General (kind 'app')  — the synthetic super-epic covering the ENTIRE app;
 *   • an EPIC (kind 'epic') — build/test/review its stories as a unit;
 *   • a story (kind 'story') — the single-story target the Build lane always had.
 *
 * Four actions act on that scope — Design · Build · Test · Review — each mapping
 * to a chat run mode (Design = the existing Plan machinery; Test/Review are
 * read-only prompt modes; only Build may commit). The label + prompt derivation
 * lives here so the buttons, the chat, and the route all say the same thing.
 */

export type BuildTarget =
  | { kind: 'app' }
  | { kind: 'epic'; epicId: string }
  | { kind: 'story'; epicId: string; storyId: string };

export type BuildAction = 'design' | 'build' | 'test' | 'review';

/** The chat run mode each action executes in (Design maps to Plan; only Build writes). */
export const ACTION_MODE: Record<BuildAction, 'plan' | 'build' | 'test' | 'review'> = {
  design: 'plan',
  build: 'build',
  test: 'test',
  review: 'review',
};

/** The minimal epic/story shapes the derivation needs. */
export type TargetStory = { id: string; title: string };
export type TargetEpic = { id: string; title: string; stories: TargetStory[] };

/** A stable per-node key (for "last action ran" bookkeeping). */
export function targetKey(target: BuildTarget): string {
  if (target.kind === 'app') return 'app';
  if (target.kind === 'epic') return `epic:${target.epicId}`;
  return `story:${target.epicId}:${target.storyId}`;
}

/** Human label for the selected scope — used by buttons, prompts and hints. */
export function targetLabel(epics: TargetEpic[], target: BuildTarget): string {
  if (target.kind === 'app') return 'the whole app';
  const epic = epics.find((e) => e.id === target.epicId);
  const epicTitle = epic?.title?.trim() || 'Untitled EPIC';
  if (target.kind === 'epic') return `the EPIC “${epicTitle}”`;
  const story = epic?.stories.find((s) => s.id === target.storyId);
  const storyTitle = story?.title?.trim() || 'Untitled story';
  return `the story “${epicTitle} › ${storyTitle}”`;
}

/**
 * The chat prompt each action sends for the selected scope. Grounded phrasing:
 * Test and Review must read the committed code — never fabricate execution.
 */
export function actionPrompt(action: BuildAction, epics: TargetEpic[], target: BuildTarget): string {
  const label = targetLabel(epics, target);
  switch (action) {
    case 'design':
      return `Refine the design of ${label}: review its stories and requirements and propose concrete improvements.`;
    case 'build':
      if (target.kind === 'story') {
        return `Build ${label}. Implement it end-to-end to its acceptance criteria.`;
      }
      if (target.kind === 'epic') {
        return `Build ${label}: implement its stories in order, each to its acceptance criteria.`;
      }
      return 'Build the whole app: implement the remaining to-do stories in order, each to its acceptance criteria.';
    case 'test':
      return (
        `Act as a critical tester of ${label}: read the committed code for it, identify defects, ` +
        'verify the acceptance criteria of its stories, run through edge cases mentally, and report ' +
        'PASS/FAIL per story with concrete findings grounded in the files you actually read.'
      );
    case 'review':
      return (
        `Review what has been built for ${label}: summarize the implemented functionality file-by-file, ` +
        'flag risks or problems, and propose 3-5 concrete improvement or feature ideas.'
      );
  }
}
