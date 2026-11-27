/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the living spec as files: parse and render epics and user stories (stories/*.md)
 * USER STORY: As a business user or a developer I want my app's epics and user stories to be plain Markdown files
 *             in the app's git tree, readable and editable in any editor, and I want a malformed file to be refused
 *             with the line and the fix, never half-read.
 * ARCHITECTURE:
 *   - Spec section 3.1 (docs/superpowers/specs/2026-11-26-app-builder-design.md). Pure: no I/O, no server import, so
 *     the UI, the receive gate, the MCP tools and the store all use the SAME parser (one validator, not two copies).
 *   - Layout (paths are APP-relative): `stories/EP-<n>[-<slug>]/_epic.md` and `stories/EP-<n>[-<slug>]/US-<m>[-<slug>].md`;
 *     `stories/README.md` is the one documentation file allowed. The slug is cosmetic, the id is authoritative, and
 *     the file name must CARRY the id (`US-3-…` holds `id: US-3`, its folder `EP-1-…` holds `epic: EP-1`), so a path can
 *     never lie about the object it holds and history can follow a story by its id.
 *   - Strict structure: front matter (`---` … `---`, only the known keys), `## Acceptance criteria`, `### AC-<n> <title>`,
 *     `- Given / When / Then` bullets in that order (`And` continues the previous keyword), `## Notes` (free text, never
 *     parsed). Every problem is a `SpecIssue { path, line, reason, fix }`.
 *   - Canonical form = the renderer's output. `parse(render(doc))` equals `doc` for every doc `validateStoryDoc` /
 *     `validateEpicDoc` accept, and `render(parse(text))` equals `text` for every canonical file (tests pin both).
 *   - Size limits (`SPEC_LIMITS`) bound every field and every file, so neither a UI save nor a push can grow a file
 *     past what a review can read.
 */
import type {
  Criterion,
  CriterionId,
  EpicDoc,
  EpicId,
  LivingSpec,
  SpecIssue,
  StoryDoc,
  StoryId,
  StoryState,
} from '@tabs/software/lib/app-builder-contracts';
import { STORIES_DIR } from '@tabs/software/lib/app-builder-contracts';

/** Hard limits for one file and its fields (bytes are UTF-8). */
export const SPEC_LIMITS = {
  fileBytes: 32 * 1024,
  title: 200,
  role: 500,
  criteria: 50,
  linesPerKeyword: 20,
  line: 500,
  notes: 16 * 1024,
  description: 8 * 1024,
  requirement: 8 * 1024,
  /** Story and epic files of one app (the git subtree read is capped at 500 files as well). */
  files: 400,
  /** Highest number in an id (`EP-999999`): keeps ids short and safely numeric. */
  maxIdNumber: 999_999,
} as const;

export const STORIES_README = `${STORIES_DIR}/README.md`;
export const EPIC_FILE = '_epic.md';

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NUM = '[1-9][0-9]{0,5}';
const EPIC_DIR_RE = new RegExp(`^EP-(${NUM})(?:-${SLUG})?$`);
const STORY_FILE_RE = new RegExp(`^US-(${NUM})(?:-${SLUG})?\\.md$`);
export const EPIC_ID_RE = new RegExp(`^EP-${NUM}$`);
export const STORY_ID_RE = new RegExp(`^US-${NUM}$`);
export const CRITERION_ID_RE = new RegExp(`^AC-${NUM}$`);

export type StoryPathInfo =
  | { kind: 'epic'; epic: EpicId; dir: string }
  | { kind: 'story'; epic: EpicId; story: StoryId; dir: string }
  | { kind: 'readme' };

/**
 * What an app-relative path under `stories/` is, or null when it is not a path the living spec allows. The regexes
 * admit only `[A-Za-z0-9-_.]` segments of a fixed shape, so `..`, an absolute path, a backslash or a hidden file can
 * never classify.
 */
export function classifyStoryPath(path: string): StoryPathInfo | null {
  if (typeof path !== 'string') return null;
  if (path === STORIES_README) return { kind: 'readme' };
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== STORIES_DIR) return null;
  const dir = parts[1];
  const d = EPIC_DIR_RE.exec(dir);
  if (!d) return null;
  const epic = `EP-${d[1]}` as EpicId;
  if (parts[2] === EPIC_FILE) return { kind: 'epic', epic, dir };
  const s = STORY_FILE_RE.exec(parts[2]);
  if (!s) return null;
  return { kind: 'story', epic, story: `US-${s[1]}` as StoryId, dir };
}

export const idNumber = (id: string): number => Number(String(id).split('-')[1]);

/** A cosmetic file-name slug: ASCII, lower-case, hyphenated, at most 40 characters (may be empty). */
export function slugOf(title: string): string {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 40).replace(/-+$/g, '');
}

/** `stories/EP-<n>[-<slug>]/_epic.md` for a new epic. */
export function epicPath(id: EpicId, title: string): string {
  const slug = slugOf(title);
  return `${STORIES_DIR}/${id}${slug ? `-${slug}` : ''}/${EPIC_FILE}`;
}

/** The folder an epic file lives in (`stories/EP-1-x`). */
export function epicDirOf(epicFilePath: string): string {
  return epicFilePath.slice(0, epicFilePath.lastIndexOf('/'));
}

/** `stories/EP-<n>-…/US-<m>[-<slug>].md`: a new story in the folder of its epic. */
export function storyPath(epic: Pick<EpicDoc, 'path'>, id: StoryId, title: string): string {
  const slug = slugOf(title);
  return `${epicDirOf(epic.path)}/${id}${slug ? `-${slug}` : ''}.md`;
}

// ------------------------------------------------------------------ front matter ---

const issue = (path: string, line: number | undefined, reason: string, fix: string): SpecIssue => ({
  path,
  ...(line !== undefined ? { line } : {}),
  reason,
  fix,
});

/** True when a front-matter value must be written as a JSON (double-quoted) string to read back exactly. */
function needsQuote(v: string): boolean {
  return (
    v === '' ||
    /^[\s"'#&*!|>%@`{}[\],?:-]/.test(v) ||
    /\s$/.test(v) ||
    /: | #|:$/.test(v) ||
    /[\u0000-\u001f\u007f\u2028\u2029]/.test(v)
  );
}

const fmValue = (v: string): string => (needsQuote(v) ? JSON.stringify(v) : v);

type FrontMatter = { values: Record<string, string>; lines: Record<string, number>; bodyStart: number };

function parseFrontMatter(path: string, lines: string[], allowed: readonly string[], issues: SpecIssue[]): FrontMatter | null {
  if (lines[0] !== '---') {
    issues.push(issue(path, 1, 'the file does not start with front matter', "Start the file with a line '---', the keys, and another '---'."));
    return null;
  }
  const values: Record<string, string> = {};
  const at: Record<string, number> = {};
  let i = 1;
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const m = /^([a-z]+):(?: (.*))?$/.exec(line);
    if (!m) {
      issues.push(issue(path, n, `'${line.slice(0, 60)}' is not a 'key: value' line`, `Write each front-matter line as 'key: value' with one of: ${allowed.join(', ')}.`));
      continue;
    }
    const key = m[1];
    if (!allowed.includes(key)) {
      issues.push(issue(path, n, `unknown front-matter key '${key}'`, `Use only: ${allowed.join(', ')}.`));
      continue;
    }
    if (key in values) {
      issues.push(issue(path, n, `the key '${key}' appears twice`, 'Keep one line per key.'));
      continue;
    }
    let raw = m[2] ?? '';
    let value: string;
    if (raw.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'string') throw new Error('not a string');
        value = parsed;
      } catch {
        issues.push(issue(path, n, `the value of '${key}' is not a valid double-quoted string`, 'Close the quotes and escape inner quotes as \\", or write the value without quotes.'));
        continue;
      }
    } else if (raw.startsWith("'")) {
      issues.push(issue(path, n, `the value of '${key}' uses single quotes`, 'Use double quotes, or no quotes.'));
      continue;
    } else {
      const hash = raw.indexOf(' #');
      if (hash >= 0) raw = raw.slice(0, hash);
      value = raw.trim();
    }
    values[key] = value;
    at[key] = n;
  }
  if (i >= lines.length) {
    issues.push(issue(path, 1, 'the front matter is not closed', "Add a line '---' after the last key."));
    return null;
  }
  return { values, lines: at, bodyStart: i + 1 };
}

// ----------------------------------------------------------------------- stories ---

const AS_RE = /^As an? \*\*(.*?)\*\* I want \*\*(.*?)\*\* so that \*\*(.*?)\*\*\.$/;
const AC_RE = /^### (AC-[0-9]+)(?: (.*))?$/;
const BULLET_RE = /^- (Given|When|Then|And) (.*)$/;
const KEYWORD_ORDER = { given: 0, when: 1, then: 2 } as const;
type Keyword = keyof typeof KEYWORD_ORDER;

const STORY_KEYS = ['id', 'epic', 'title', 'state'] as const;
const EPIC_KEYS = ['id', 'title'] as const;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const toLines = (content: string): string[] => content.replace(/\r\n/g, '\n').split('\n');

/** Parse one story file. On ANY issue the story is not returned: a file is read whole or refused. */
export function parseStoryFile(path: string, content: string): { story: StoryDoc } | { issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const where = classifyStoryPath(path);
  if (!where || where.kind !== 'story') {
    return { issues: [issue(path, undefined, 'this is not a story file path', 'Put a story at stories/EP-<n>-<name>/US-<m>-<name>.md.')] };
  }
  if (typeof content !== 'string') return { issues: [issue(path, undefined, 'the file has no text content', 'Write the story as Markdown text.')] };
  if (byteLength(content) > SPEC_LIMITS.fileBytes) {
    return { issues: [issue(path, undefined, `the file is larger than ${SPEC_LIMITS.fileBytes} bytes`, 'Shorten the notes or split the story.')] };
  }
  const lines = toLines(content);
  const fm = parseFrontMatter(path, lines, STORY_KEYS, issues);
  if (!fm) return { issues };
  const v = fm.values;
  for (const k of STORY_KEYS) if (!(k in v)) issues.push(issue(path, 1, `the front matter has no '${k}'`, `Add '${k}: …' to the front matter.`));
  if (v.id !== undefined) {
    if (!STORY_ID_RE.test(v.id)) issues.push(issue(path, fm.lines.id, `'${v.id}' is not a story id`, "A story id looks like 'US-3'. Ids are assigned by the OS; keep the one the file has."));
    else if (v.id !== where.story) issues.push(issue(path, fm.lines.id, `the file name says ${where.story} but the front matter says ${v.id}`, `Name the file ${v.id}-<name>.md, or restore 'id: ${where.story}'.`));
  }
  if (v.epic !== undefined) {
    if (!EPIC_ID_RE.test(v.epic)) issues.push(issue(path, fm.lines.epic, `'${v.epic}' is not an epic id`, "An epic id looks like 'EP-1'."));
    else if (v.epic !== where.epic) issues.push(issue(path, fm.lines.epic, `the story is in the folder of ${where.epic} but says 'epic: ${v.epic}'`, `Move the file into the folder of ${v.epic}, or write 'epic: ${where.epic}'.`));
  }
  if (v.title !== undefined) checkTitle(path, fm.lines.title, v.title, issues);
  if (v.state !== undefined && v.state !== 'draft' && v.state !== 'agreed') {
    issues.push(issue(path, fm.lines.state, `'${v.state}' is not a story state`, "Write 'state: draft' or 'state: agreed' (built and verified are derived from the tests, never written)."));
  }

  let asA = '';
  let iWant = '';
  let soThat = '';
  let i = fm.bodyStart;
  let sawAs = false;
  // 1 — the "As a … I want … so that …" line (optional) before the criteria heading.
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line === '## Acceptance criteria') break;
    const m = AS_RE.exec(line);
    if (m && !sawAs) {
      [asA, iWant, soThat] = [m[1], m[2], m[3]];
      sawAs = true;
      continue;
    }
    issues.push(
      issue(
        path,
        i + 1,
        line.startsWith('## ') ? `unexpected section '${line.slice(0, 60)}' before '## Acceptance criteria'` : 'unexpected text before \'## Acceptance criteria\'',
        sawAs || line.startsWith('## ')
          ? "Keep the order: the 'As a' line, '## Acceptance criteria', then '## Notes'. Free text belongs under '## Notes'."
          : "Write the story line as: As a **<role>** I want **<goal>** so that **<benefit>**.",
      ),
    );
  }
  if (i >= lines.length) {
    issues.push(issue(path, lines.length, "the story has no '## Acceptance criteria' section", "Add a line '## Acceptance criteria' (it may be empty while the story is a draft)."));
    return { issues };
  }
  // 2 — the criteria, until '## Notes' or the end.
  const criteria: Criterion[] = [];
  const seen = new Map<string, number>();
  let cur: (Criterion & { line: number; last: Keyword | null }) | null = null;
  const close = () => {
    if (!cur) return;
    for (const k of ['given', 'when', 'then'] as const) {
      if (cur[k].length === 0) issues.push(issue(path, cur.line, `${cur.id} has no '${k[0].toUpperCase()}${k.slice(1)}' line`, `Add '- ${k[0].toUpperCase()}${k.slice(1)} …' to ${cur.id} (each criterion needs Given, When and Then).`));
    }
    criteria.push({ id: cur.id, title: cur.title, given: cur.given, when: cur.when, then: cur.then });
    cur = null;
  };
  let notesAt = -1;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line.trim() === '') continue;
    if (line === '## Notes') {
      notesAt = i;
      break;
    }
    if (line.startsWith('## ')) {
      issues.push(issue(path, n, `unknown section '${line.slice(0, 60)}'`, "A story has exactly two sections: '## Acceptance criteria' and '## Notes'."));
      continue;
    }
    const ac = AC_RE.exec(line);
    if (ac) {
      close();
      const id = ac[1];
      if (!CRITERION_ID_RE.test(id)) issues.push(issue(path, n, `'${id}' is not a criterion id`, "A criterion id looks like 'AC-1'."));
      if (seen.has(id)) issues.push(issue(path, n, `${id} appears twice in this story (first at line ${seen.get(id)})`, 'Give each criterion its own id; the OS assigns the next free one.'));
      seen.set(id, n);
      cur = { id: id as CriterionId, title: (ac[2] ?? '').trim(), given: [], when: [], then: [], line: n, last: null };
      checkLine(path, n, cur.title, 'criterion title', SPEC_LIMITS.title, issues);
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b && cur) {
      const word = b[1].toLowerCase() as Keyword | 'and';
      const text = b[2].trim();
      checkLine(path, n, text, `${b[1]} line`, SPEC_LIMITS.line, issues);
      if (word === 'and') {
        if (!cur.last) {
          issues.push(issue(path, n, "'And' has no Given, When or Then before it", "Start with '- Given …'; 'And' continues the previous keyword."));
          continue;
        }
        cur[cur.last].push(text);
      } else {
        if (cur.last && KEYWORD_ORDER[word] < KEYWORD_ORDER[cur.last]) {
          issues.push(issue(path, n, `'${b[1]}' comes after '${cur.last[0].toUpperCase()}${cur.last.slice(1)}'`, 'Keep the order Given, When, Then; use And to add a line to the current keyword.'));
          continue;
        }
        if (cur.last === word) {
          issues.push(issue(path, n, `a second '${b[1]}' in ${cur.id}`, `Write '- And …' to add another ${b[1]} line.`));
          continue;
        }
        cur[word].push(text);
        cur.last = word;
      }
      for (const k of ['given', 'when', 'then'] as const) {
        if (cur[k].length > SPEC_LIMITS.linesPerKeyword) {
          issues.push(issue(path, n, `${cur.id} has more than ${SPEC_LIMITS.linesPerKeyword} ${k} lines`, 'Split the criterion into smaller ones.'));
          cur[k].length = SPEC_LIMITS.linesPerKeyword;
        }
      }
      continue;
    }
    issues.push(
      issue(
        path,
        n,
        cur ? `'${line.slice(0, 60)}' is not a Given/When/Then line` : `'${line.slice(0, 60)}' is not a criterion heading`,
        cur ? "Write each line as '- Given …', '- When …', '- Then …' or '- And …'; free text belongs under '## Notes'." : "Start a criterion with '### AC-<n> <title>'.",
      ),
    );
  }
  close();
  if (criteria.length > SPEC_LIMITS.criteria) {
    issues.push(issue(path, undefined, `the story has more than ${SPEC_LIMITS.criteria} acceptance criteria`, 'Split the story.'));
  }
  // 3 — notes: everything after '## Notes', verbatim (trailing whitespace dropped).
  const notes = notesAt >= 0 ? lines.slice(notesAt + 1).join('\n').replace(/\s+$/, '') : '';
  if (byteLength(notes) > SPEC_LIMITS.notes) issues.push(issue(path, notesAt + 1, `the notes are longer than ${SPEC_LIMITS.notes} bytes`, 'Shorten the notes.'));
  for (const [label, text] of [['role', asA], ['goal', iWant], ['benefit', soThat]] as const) checkLine(path, undefined, text, `the ${label}`, SPEC_LIMITS.role, issues);
  if (issues.length > 0) return { issues };
  return {
    story: {
      id: v.id as StoryId,
      epic: v.epic as EpicId,
      title: v.title,
      asA,
      iWant,
      soThat,
      state: v.state as StoryState,
      criteria,
      notes,
      path,
    },
  };
}

function checkTitle(path: string, line: number | undefined, title: string, issues: SpecIssue[]): void {
  if (!title.trim()) issues.push(issue(path, line, 'the title is empty', "Write 'title: <a short name>'."));
  checkLine(path, line, title, 'the title', SPEC_LIMITS.title, issues);
}

function checkLine(path: string, line: number | undefined, text: string, what: string, max: number, issues: SpecIssue[]): void {
  if (text.length > max) issues.push(issue(path, line, `${what} is longer than ${max} characters`, `Shorten ${what}.`));
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) issues.push(issue(path, line, `${what} contains a line break or a control character`, `Write ${what} on one line.`));
}

/** Render a story in canonical form. The doc must pass `validateStoryDoc` (the store refuses to render one that does not). */
export function renderStoryFile(s: Omit<StoryDoc, 'path'> & { path?: string }): string {
  const blocks: string[] = [
    ['---', `id: ${fmValue(s.id)}`, `epic: ${fmValue(s.epic)}`, `title: ${fmValue(s.title)}`, `state: ${fmValue(s.state)}`, '---'].join('\n'),
  ];
  if (s.asA || s.iWant || s.soThat) {
    const article = /^[aeiou]/i.test(s.asA) ? 'an' : 'a';
    blocks.push(`As ${article} **${s.asA}** I want **${s.iWant}** so that **${s.soThat}**.`);
  }
  blocks.push('## Acceptance criteria');
  for (const c of s.criteria) {
    const out = [`### ${c.id}${c.title ? ` ${c.title}` : ''}`];
    for (const [word, list] of [['Given', c.given], ['When', c.when], ['Then', c.then]] as const) {
      list.forEach((text, i) => out.push(`- ${i === 0 ? word : 'And'} ${text}`));
    }
    blocks.push(out.join('\n'));
  }
  if (s.notes) blocks.push(`## Notes\n${s.notes}`);
  // The front matter is followed directly by the body (spec 3.1 example); the blocks are separated by one empty line.
  return `${blocks[0]}\n${blocks.slice(1).join('\n\n')}\n`;
}

/**
 * Field-level validation of a story about to be rendered (a UI or MCP save). Reports what would not read back
 * exactly, or would break the structure: line breaks in one-line fields, `**` in the story line, empty keywords.
 */
export function validateStoryDoc(s: Omit<StoryDoc, 'path'>, path = '(new story)'): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!STORY_ID_RE.test(String(s.id))) issues.push(issue(path, undefined, `'${s.id}' is not a story id`, "A story id looks like 'US-3'."));
  if (!EPIC_ID_RE.test(String(s.epic))) issues.push(issue(path, undefined, `'${s.epic}' is not an epic id`, "An epic id looks like 'EP-1'."));
  if (s.state !== 'draft' && s.state !== 'agreed') issues.push(issue(path, undefined, `'${String(s.state)}' is not a story state`, 'Use draft or agreed.'));
  checkTitle(path, undefined, String(s.title ?? ''), issues);
  if (s.title !== String(s.title ?? '').trim()) issues.push(issue(path, undefined, 'the title starts or ends with spaces', 'Trim the title.'));
  for (const [label, text] of [['role', s.asA], ['goal', s.iWant], ['benefit', s.soThat]] as const) {
    const t = String(text ?? '');
    checkLine(path, undefined, t, `the ${label}`, SPEC_LIMITS.role, issues);
    if (t.includes('**')) issues.push(issue(path, undefined, `the ${label} contains '**'`, `Remove '**' from the ${label}; the file marks the parts of the story line with it.`));
    if (t !== t.trim()) issues.push(issue(path, undefined, `the ${label} starts or ends with spaces`, `Trim the ${label}.`));
  }
  if (!Array.isArray(s.criteria)) issues.push(issue(path, undefined, 'criteria is not a list', 'Send criteria as a list.'));
  else {
    if (s.criteria.length > SPEC_LIMITS.criteria) issues.push(issue(path, undefined, `more than ${SPEC_LIMITS.criteria} acceptance criteria`, 'Split the story.'));
    const seen = new Set<string>();
    for (const c of s.criteria) {
      if (!CRITERION_ID_RE.test(String(c.id))) issues.push(issue(path, undefined, `'${c.id}' is not a criterion id`, "A criterion id looks like 'AC-1'."));
      if (seen.has(c.id)) issues.push(issue(path, undefined, `${c.id} appears twice`, 'Give each criterion its own id.'));
      seen.add(c.id);
      const title = String(c.title ?? '');
      checkLine(path, undefined, title, `the title of ${c.id}`, SPEC_LIMITS.title, issues);
      if (title !== title.trim()) issues.push(issue(path, undefined, `the title of ${c.id} starts or ends with spaces`, 'Trim it.'));
      for (const k of ['given', 'when', 'then'] as const) {
        const list = Array.isArray(c[k]) ? c[k] : [];
        const word = `${k[0].toUpperCase()}${k.slice(1)}`;
        if (list.length === 0) issues.push(issue(path, undefined, `${c.id} has no ${word} line`, `Add at least one ${word} line to ${c.id}.`));
        if (list.length > SPEC_LIMITS.linesPerKeyword) issues.push(issue(path, undefined, `${c.id} has more than ${SPEC_LIMITS.linesPerKeyword} ${word} lines`, 'Split the criterion.'));
        for (const line of list) {
          const t = String(line ?? '');
          if (!t.trim()) issues.push(issue(path, undefined, `${c.id} has an empty ${word} line`, 'Fill it in or remove it.'));
          if (t !== t.trim()) issues.push(issue(path, undefined, `a ${word} line of ${c.id} starts or ends with spaces`, 'Trim it.'));
          checkLine(path, undefined, t, `a ${word} line of ${c.id}`, SPEC_LIMITS.line, issues);
        }
      }
    }
  }
  const notes = String(s.notes ?? '');
  if (notes !== notes.replace(/\s+$/, '')) issues.push(issue(path, undefined, 'the notes end with whitespace', 'Trim the end of the notes.'));
  if (byteLength(notes) > SPEC_LIMITS.notes) issues.push(issue(path, undefined, `the notes are longer than ${SPEC_LIMITS.notes} bytes`, 'Shorten the notes.'));
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(notes)) issues.push(issue(path, undefined, 'the notes contain a control character', 'Remove it.'));
  if (/^\n/.test(notes)) issues.push(issue(path, undefined, 'the notes start with an empty line', 'Remove the leading empty line.'));
  return issues;
}

// ------------------------------------------------------------------------- epics ---

const REQUIREMENT_HEADINGS = [
  ['technical', '### Technical'],
  ['ux', '### UX'],
  ['governance', '### Governance'],
] as const;

/** Parse one `_epic.md`. On ANY issue the epic is not returned. */
export function parseEpicFile(path: string, content: string): { epic: EpicDoc } | { issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const where = classifyStoryPath(path);
  if (!where || where.kind !== 'epic') {
    return { issues: [issue(path, undefined, 'this is not an epic file path', 'Put an epic at stories/EP-<n>-<name>/_epic.md.')] };
  }
  if (typeof content !== 'string') return { issues: [issue(path, undefined, 'the file has no text content', 'Write the epic as Markdown text.')] };
  if (byteLength(content) > SPEC_LIMITS.fileBytes) {
    return { issues: [issue(path, undefined, `the file is larger than ${SPEC_LIMITS.fileBytes} bytes`, 'Shorten the description or the requirements.')] };
  }
  const lines = toLines(content);
  const fm = parseFrontMatter(path, lines, EPIC_KEYS, issues);
  if (!fm) return { issues };
  const v = fm.values;
  for (const k of EPIC_KEYS) if (!(k in v)) issues.push(issue(path, 1, `the front matter has no '${k}'`, `Add '${k}: …' to the front matter.`));
  if (v.id !== undefined) {
    if (!EPIC_ID_RE.test(v.id)) issues.push(issue(path, fm.lines.id, `'${v.id}' is not an epic id`, "An epic id looks like 'EP-1'."));
    else if (v.id !== where.epic) issues.push(issue(path, fm.lines.id, `the folder says ${where.epic} but the front matter says ${v.id}`, `Name the folder ${v.id}-<name>, or restore 'id: ${where.epic}'.`));
  }
  if (v.title !== undefined) checkTitle(path, fm.lines.title, v.title, issues);

  let i = fm.bodyStart;
  const desc: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '## Requirements') break;
    if (line.startsWith('## ')) issues.push(issue(path, i + 1, `unexpected section '${line.slice(0, 60)}'`, "An epic has its description, then '## Requirements' with '### Technical', '### UX' and '### Governance'."));
    else desc.push(line);
  }
  if (i >= lines.length) {
    issues.push(issue(path, lines.length, "the epic has no '## Requirements' section", "Add '## Requirements' with '### Technical', '### UX' and '### Governance' (each may be empty)."));
    return { issues };
  }
  const reqs: Record<'technical' | 'ux' | 'governance', string[]> = { technical: [], ux: [], governance: [] };
  let section = -1;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line.startsWith('### ') || line.startsWith('## ')) {
      const next = REQUIREMENT_HEADINGS.findIndex(([, h]) => h === line);
      if (next !== section + 1) {
        issues.push(issue(path, n, next < 0 ? `unknown heading '${line.slice(0, 60)}'` : `'${line}' is out of order`, "Use exactly '### Technical', '### UX', '### Governance', in that order."));
        continue;
      }
      section = next;
      continue;
    }
    if (section < 0) {
      if (line.trim() !== '') issues.push(issue(path, n, "text between '## Requirements' and '### Technical'", "Put it under '### Technical', '### UX' or '### Governance'."));
      continue;
    }
    reqs[REQUIREMENT_HEADINGS[section][0]].push(line);
  }
  if (section !== REQUIREMENT_HEADINGS.length - 1) {
    issues.push(issue(path, lines.length, `the requirements are missing '${REQUIREMENT_HEADINGS[section + 1][1]}'`, "Add '### Technical', '### UX' and '### Governance' (each may be empty)."));
  }
  const description = desc.join('\n').trim();
  const requirements = {
    technical: reqs.technical.join('\n').trim(),
    ux: reqs.ux.join('\n').trim(),
    governance: reqs.governance.join('\n').trim(),
  };
  if (byteLength(description) > SPEC_LIMITS.description) issues.push(issue(path, undefined, `the description is longer than ${SPEC_LIMITS.description} bytes`, 'Shorten it.'));
  for (const [k, t] of Object.entries(requirements)) {
    if (byteLength(t) > SPEC_LIMITS.requirement) issues.push(issue(path, undefined, `the ${k} requirements are longer than ${SPEC_LIMITS.requirement} bytes`, 'Shorten them.'));
  }
  if (issues.length > 0) return { issues };
  return { epic: { id: v.id as EpicId, title: v.title, description, requirements, path } };
}

export function renderEpicFile(e: Omit<EpicDoc, 'path'> & { path?: string }): string {
  const blocks: string[] = [['---', `id: ${fmValue(e.id)}`, `title: ${fmValue(e.title)}`, '---'].join('\n')];
  if (e.description) blocks.push(e.description);
  blocks.push('## Requirements');
  for (const [k, h] of REQUIREMENT_HEADINGS) blocks.push(e.requirements[k] ? `${h}\n${e.requirements[k]}` : h);
  return `${blocks[0]}\n${blocks.slice(1).join('\n\n')}\n`;
}

export function validateEpicDoc(e: Omit<EpicDoc, 'path'>, path = '(new epic)'): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!EPIC_ID_RE.test(String(e.id))) issues.push(issue(path, undefined, `'${e.id}' is not an epic id`, "An epic id looks like 'EP-1'."));
  checkTitle(path, undefined, String(e.title ?? ''), issues);
  if (e.title !== String(e.title ?? '').trim()) issues.push(issue(path, undefined, 'the title starts or ends with spaces', 'Trim the title.'));
  const texts: [string, string, number][] = [
    ['description', String(e.description ?? ''), SPEC_LIMITS.description],
    ['technical requirements', String(e.requirements?.technical ?? ''), SPEC_LIMITS.requirement],
    ['UX requirements', String(e.requirements?.ux ?? ''), SPEC_LIMITS.requirement],
    ['governance requirements', String(e.requirements?.governance ?? ''), SPEC_LIMITS.requirement],
  ];
  for (const [label, t, max] of texts) {
    if (t !== t.trim()) issues.push(issue(path, undefined, `the ${label} start or end with whitespace`, 'Trim them.'));
    if (byteLength(t) > max) issues.push(issue(path, undefined, `the ${label} are longer than ${max} bytes`, 'Shorten them.'));
    if (/^#{2,3} /m.test(t)) issues.push(issue(path, undefined, `the ${label} contain a line starting with '## ' or '### '`, 'Use a different heading level (#### or deeper) or plain text; ## and ### structure the file.'));
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) issues.push(issue(path, undefined, `the ${label} contain a control character`, 'Remove it.'));
  }
  return issues;
}

// ------------------------------------------------------------------- the spec ---

/** One file of the stories subtree (path app-relative, e.g. `stories/EP-1-x/US-3-y.md`). */
export type SpecFile = { path: string; content: string };

/**
 * Parse every file of the stories subtree into the living spec. Files with issues are left out of the spec and
 * their issues returned; duplicate ids (two folders for one epic, one story id twice) and stories whose epic has no
 * `_epic.md` are issues naming both paths. Epics and stories are ordered by their number.
 */
export function parseLivingSpec(files: SpecFile[], sha: string): { spec: LivingSpec; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const epics = new Map<EpicId, EpicDoc>();
  const stories = new Map<StoryId, StoryDoc>();
  const epicDirs = new Map<EpicId, string>();
  const storyFiles = files.filter((f) => f.path !== STORIES_README);
  if (storyFiles.length > SPEC_LIMITS.files) {
    issues.push(issue(STORIES_DIR, undefined, `the living spec has ${storyFiles.length} files, more than ${SPEC_LIMITS.files}`, 'Archive finished epics outside stories/.'));
  }
  // Epics first, so story checks can see every folder.
  const sorted = [...storyFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const where = classifyStoryPath(f.path);
    if (!where) {
      issues.push(issue(f.path, undefined, 'this file is not part of the living spec layout', 'Keep only stories/EP-<n>-<name>/_epic.md, stories/EP-<n>-<name>/US-<m>-<name>.md and stories/README.md under stories/.'));
      continue;
    }
    if (where.kind === 'epic') {
      const dir = epicDirs.get(where.epic);
      if (dir !== undefined && dir !== where.dir) {
        issues.push(issue(f.path, undefined, `${where.epic} has two folders: stories/${dir} and stories/${where.dir}`, `Keep one folder for ${where.epic}; move the stories of the other into it.`));
        continue;
      }
      epicDirs.set(where.epic, where.dir);
      const r = parseEpicFile(f.path, f.content);
      if ('issues' in r) issues.push(...r.issues);
      else epics.set(r.epic.id, r.epic);
    }
  }
  for (const f of sorted) {
    const where = classifyStoryPath(f.path);
    if (!where || where.kind !== 'story') continue;
    const dir = epicDirs.get(where.epic);
    if (dir === undefined) {
      issues.push(issue(f.path, undefined, `the folder of ${where.epic} has no ${EPIC_FILE}`, `Add stories/${where.dir}/${EPIC_FILE} (id: ${where.epic}).`));
      continue;
    }
    if (dir !== where.dir) {
      issues.push(issue(f.path, undefined, `${where.epic} has two folders: stories/${dir} and stories/${where.dir}`, `Move this story into stories/${dir}/.`));
      continue;
    }
    const prior = stories.get(where.story);
    if (prior) {
      issues.push(issue(f.path, undefined, `the story id ${where.story} is used twice: ${prior.path} and ${f.path}`, 'Give one of them a new id (create it in the OS, which assigns the next free id) and remove the copy.'));
      continue;
    }
    const r = parseStoryFile(f.path, f.content);
    if ('issues' in r) issues.push(...r.issues);
    else stories.set(r.story.id, r.story);
  }
  const byNum = <T extends { id: string }>(a: T, b: T) => idNumber(a.id) - idNumber(b.id);
  return { spec: { sha, epics: [...epics.values()].sort(byNum), stories: [...stories.values()].sort(byNum) }, issues };
}

/** The first issue as one human line (`path:line: reason. fix`), for push output and API errors. */
export function issueLine(i: SpecIssue): string {
  return `${i.path}${i.line !== undefined ? `:${i.line}` : ''}: ${i.reason}. ${i.fix}`;
}
