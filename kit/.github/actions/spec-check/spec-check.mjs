#!/usr/bin/env node
// Handoffs spec check. Flags a pull request that is bigger than small and has
// no valid OpenSpec change in it. It checks form, not truth: it confirms the
// fields exist and the spec validates, not that any of it is right.
//
// Inputs (arguments win over environment, environment wins over the event file):
//   --repo <dir>        repository root (default: cwd)
//   --base <rev>        SPEC_CHECK_BASE      base commit of the pull request
//   --head <rev>        SPEC_CHECK_HEAD      head commit (default: HEAD)
//   --body-file <path>  SPEC_CHECK_PR_BODY   pull request description (text)
//   --labels <a,b>      SPEC_CHECK_LABELS    comma-separated label names
//   --config <path>     SPEC_CHECK_CONFIG    (default: .github/spec-check.jsonc)
//   --bootstrap         SPEC_CHECK_BOOTSTRAP=true  use this PR's settings when the base has none
//   --openspec <path>   OPENSPEC_BIN         openspec executable (default: openspec)
//   --json              print the result as JSON
//   GITHUB_EVENT_PATH   pull_request event, used for anything not given above
//
// Exit codes:
//   0  passed, or flagged in warn mode
//   1  flagged in approved block mode; or the settings file on the base branch
//      cannot be parsed (fails closed in any mode)
//   2  the checker itself failed while in approved block mode

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, lstatSync, appendFileSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const MAX_READ = 256 * 1024;
const CHANGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPEC_DIRS = /^openspec\/(?:changes|specs)\//i;
// A value is a stub when the whole value is one of these (any case)...
const EMPTY_VALUES = new Set(['', 'n/a', 'na', 'none', 'no', 'tbd', 'tbc', 'tba', 'todo', 'xxx', 'fixme',
  'later', 'pending', 'unknown', 'not applicable', 'nope', '-', '--', '?', '...']);
// ...or it is an obvious stub. Markers are case-sensitive and must lead the
// value, so "share a todo list" and the ticket "TODO-123" are real values.
const STUBS = [
  /<(?!https?:\/\/)[^>]*>/,                              // <goal>, <ticket> (autolinks are fine)
  /^(?:TODO|TBD|TBC|TBA|XXX|FIXME)(?:$|[\s:,.;(])/,       // "TBD - ask finance"
  /^[A-Za-z]+-X{2,}$/,                                     // FIN-XXX
  /^X{3,}$/i,
  /^(?:see|ask|check)\s+(?:slack|the thread|thread|chat|teams|jira|ticket|above|below|later)\b/i,
];
// A separate calculation that starts with one of these is not a calculation.
// Files git sees as binary (a NUL byte is enough) but named like source code.
const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rb|java|kt|scala|groovy|cs|php|sql|sh|ps1|bat|rs|swift|c|cc|cpp|h|hpp|m|mm|lua|dart|ex|exs|erl|hs|ml|r|jl|pl|tf)$/i;
const NO_CALC = /^(?:no|none|n\/a|na|not applicable|nope)\b/i;

export const DEFAULTS = {
  mode: 'warn',
  blockingApproval: { approvedBy: '', approvedOn: '' },
  thresholds: { nonTestLinesChanged: 400, servicesTouched: 2, binaryBytes: 1048576 },
  requireLinkedChangeTouched: false,
  alwaysNeedsSpec: [], alwaysReview: [], moneyPaths: [], services: [], testPaths: [], ignorePaths: [],
  goals: { file: '', idPattern: '[A-Z][A-Z0-9]*-[0-9]+' },
  ticketPattern: '',
  exemptLabel: 'spec-exempt',
};

class FailClosed extends Error {}

// ---------- small helpers ----------
export const sanitize = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
export const stripMd = s => String(s ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
export const lf = s => s.replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n');
// Removes <!-- --> comments in one pass; an unclosed comment runs to the end.
export function noComments(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf('<!--', i);
    if (start === -1) return out + s.slice(i);
    out += s.slice(i, start);
    const end = s.indexOf('-->', start + 4);
    if (end === -1) return out;
    i = end + 3;
  }
}

export function isFilled(v) {
  const c = stripMd(v);
  if (!c || c.includes('<!--')) return false;
  if (EMPTY_VALUES.has(c.toLowerCase().replace(/[.!]+$/, ''))) return false;
  return !STUBS.some(re => re.test(c));
}

export const isRealCalc = v => isFilled(v) && !NO_CALC.test(stripMd(v));

function readCapped(file) {
  const size = lstatSync(file).size;
  if (size > MAX_READ) return { tooLarge: true, size };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return { text: lf(buf.toString('utf8')) };
  } finally { closeSync(fd); }
}

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function gitShow(repo, rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return r.status === 0 ? lf(r.stdout) : null;
}

// ---------- globs ----------
// "**/x/**" any depth; "x/**" from the repo root; "/x" the root only;
// a pattern with no "/" matches the file name at any depth. Case-insensitive.
export function globToRegex(glob, { prefixOnly = false } = {}) {
  const esc = s => s.replace(/[.+^${}()|[\]\\?*]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += esc(c); continue; } // unclosed: literal
      re += '(?:' + glob.slice(i + 1, end).split(',').map(esc).join('|') + ')';
      i = end;
    } else re += esc(c);
  }
  // 's': a file name may contain a newline, and it must still match.
  return new RegExp('^' + re + (prefixOnly ? '(?=/)' : '$'), 'is');
}

export function matcher(globs = []) {
  const tests = globs.map(g => {
    if (g.startsWith('/')) return globToRegex(g.slice(1));
    if (g.includes('/')) return globToRegex(g);
    const re = globToRegex(g);
    return { test: p => re.test(p.slice(p.lastIndexOf('/') + 1)) };
  });
  return p => tests.some(t => t.test(p));
}

// ---------- settings ----------
// JSON with // and /* */ comments and trailing commas. Strings are respected.
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unclosed /* comment');
      i = end + 1; out += ' '; continue;
    }
    out += c;
  }
  let clean = '';
  inStr = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) { clean += c; if (c === '\\') clean += out[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; clean += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (/\s/.test(out[j] ?? '')) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    clean += c;
  }
  return JSON.parse(clean);
}

export function withDefaults(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings must be a JSON object');
  const c = { ...DEFAULTS, ...raw };
  c.thresholds = { ...DEFAULTS.thresholds, ...(raw.thresholds ?? {}) };
  c.goals = { ...DEFAULTS.goals, ...(raw.goals ?? {}) };
  c.blockingApproval = { ...DEFAULTS.blockingApproval, ...(raw.blockingApproval ?? {}) };
  for (const k of ['alwaysNeedsSpec', 'alwaysReview', 'moneyPaths', 'services', 'testPaths', 'ignorePaths']) {
    if (!Array.isArray(c[k]) || !c[k].every(x => typeof x === 'string')) throw new Error(`"${k}" must be a list of strings`);
  }
  for (const k of ['nonTestLinesChanged', 'servicesTouched', 'binaryBytes']) {
    if (typeof c.thresholds[k] !== 'number' || c.thresholds[k] < 0) throw new Error(`thresholds.${k} must be a number`);
  }
  if (typeof c.exemptLabel !== 'string' || !c.exemptLabel.trim()) c.exemptLabel = DEFAULTS.exemptLabel;
  if (typeof c.requireLinkedChangeTouched !== 'boolean') throw new Error('"requireLinkedChangeTouched" must be true or false');
  if (c.mode !== 'warn' && c.mode !== 'block') throw new Error('"mode" must be "warn" or "block"');
  new RegExp(c.goals.idPattern);
  if (c.ticketPattern) new RegExp(c.ticketPattern);
  return c;
}

const approvedBlock = c => c?.mode === 'block' && Boolean(c.blockingApproval?.approvedBy && c.blockingApproval?.approvedOn);

// ---------- inputs ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--bootstrap') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// An empty environment variable counts as not set.
const env = name => (process.env[name] === undefined || process.env[name] === '' ? undefined : process.env[name]);

function readInputs() {
  const args = parseArgs(process.argv.slice(2));
  let event = {};
  if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  }
  const pr = event.pull_request ?? {};
  const body = args['body-file'] ? readFileSync(args['body-file'], 'utf8') : env('SPEC_CHECK_PR_BODY') ?? pr.body ?? '';
  const labelsRaw = args.labels ?? env('SPEC_CHECK_LABELS');
  const labels = labelsRaw !== undefined
    ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : (pr.labels ?? []).map(l => l.name);
  return {
    repo: path.resolve(args.repo ?? process.cwd()),
    base: args.base ?? env('SPEC_CHECK_BASE') ?? pr.base?.sha,
    head: args.head ?? env('SPEC_CHECK_HEAD') ?? pr.head?.sha ?? 'HEAD',
    body: lf(String(body ?? '')).slice(0, MAX_READ),
    labels,
    actor: event.sender?.login ? sanitize(event.sender.login) : null,
    configPath: args.config ?? env('SPEC_CHECK_CONFIG') ?? '.github/spec-check.jsonc',
    bootstrap: Boolean(args.bootstrap) || /^(1|true|yes)$/i.test(process.env.SPEC_CHECK_BOOTSTRAP ?? ''),
    openspec: args.openspec ?? env('OPENSPEC_BIN') ?? 'openspec',
    json: Boolean(args.json),
  };
}

function loadSettings(inp, notes, problems) {
  const baseText = gitShow(inp.repo, inp.base, inp.configPath);
  if (baseText !== null) {
    if (inp.bootstrap) notes.push(`bootstrap is on, but ${inp.configPath} is on the base branch, so it is ignored. Remove bootstrap from the workflow.`);
    try { return withDefaults(parseJsonc(baseText)); } catch (e) {
      throw new FailClosed(`the settings file ${inp.configPath} on the base branch cannot be used (${e.message}). Fix it on the base branch; the check fails until then.`);
    }
  }
  const local = path.join(inp.repo, inp.configPath);
  let prCopy = null;
  if (existsSync(local)) {
    try { prCopy = withDefaults(parseJsonc(readCapped(local).text ?? '')); } catch (e) {
      throw new FailClosed(`the settings file ${inp.configPath} in this pull request cannot be used (${e.message}).`);
    }
  }
  if (inp.bootstrap && prCopy) {
    notes.push(`Bootstrap: ${inp.configPath} is not on the base branch, so this pull request's copy is used.`);
    return prCopy;
  }
  problems.push(`${inp.configPath} is not on the base branch. If this pull request installs the check, set the action input bootstrap: true for it; otherwise restore the file on the base branch.`);
  return prCopy ?? withDefaults({});
}

// ---------- diff ----------
export function diffFiles(repo, base, head) {
  const mb = git(repo, ['merge-base', base, head]).trim();
  // Read attributes from an empty tree, so a pull request's .gitattributes
  // (for example "* -diff") cannot hide lines from the count.
  const emptyTree = git(repo, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
  const pre = [`--attr-source=${emptyTree}`, 'diff'];
  const post = ['-z', '-M', '--no-ext-diff', '--no-textconv', mb, head];
  // --raw: modes, blob ids and, for renames, both paths.
  const meta = new Map();
  const raw = git(repo, [...pre, '--raw', ...post]).split('\0');
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].startsWith(':')) continue;
    const [oldMode, newMode, oldSha, newSha, status] = raw[i].slice(1).split(' ');
    const oldPath = /^[RC]/.test(status) ? raw[++i] : null;
    const p = raw[++i];
    meta.set(p, { oldPath, oldSha, newSha, submodule: oldMode === '160000' || newMode === '160000' });
  }
  const files = [];
  const parts = git(repo, [...pre, '--numstat', ...post]).split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [add, del, ...rest] = parts[i].split('\t');
    let p = rest.join('\t');
    if (p === '') { i++; p = parts[++i]; } // rename: "A\tD\t", old path, new path
    const m = meta.get(p) ?? {};
    const binary = add === '-' || del === '-';
    files.push({ path: p, oldPath: m.oldPath ?? null, oldSha: m.oldSha, newSha: m.newSha, lines: binary ? 0 : Number(add) + Number(del), binary, submodule: m.submodule === true });
  }
  return files;
}

const ZERO_SHA = /^0+$/;
function blobSize(repo, sha) {
  if (!sha || ZERO_SHA.test(sha)) return 0;
  return Number(git(repo, ['cat-file', '-s', sha]).trim());
}
// True when under 5% of the first 64 KB are control bytes other than tab,
// newline and carriage return: a text file with a stray NUL, not real binary.
function mostlyText(repo, sha) {
  if (!sha || ZERO_SHA.test(sha)) return false;
  const r = spawnSync('git', ['cat-file', 'blob', sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git cat-file blob ${sha} failed`);
  const buf = r.stdout.subarray(0, 64 * 1024);
  if (!buf.length) return true;
  let control = 0;
  for (const b of buf) if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) control++;
  return control / buf.length < 0.05;
}
function blobLines(repo, sha) {
  if (!sha || ZERO_SHA.test(sha)) return 0;
  const text = git(repo, ['cat-file', 'blob', sha]);
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// ---------- markdown parsing ----------
function sections(md) {
  const map = {};
  let cur = null;
  for (const line of noComments(md).split('\n')) {
    const h = line.match(/^##[ \t]+([^#\n][^\n]*)$/);
    if (h) { cur = stripMd(h[1].replace(/[ \t]#+[ \t]*$/, '')).toLowerCase(); map[cur] = []; continue; }
    if (cur) map[cur].push(line);
  }
  return map;
}

export function field(lines, name) {
  const re = new RegExp(`^(?:[-+][ \\t]+)?${name}[ \\t]*:[ \\t]*(.*)$`, 'i');
  for (const l of lines ?? []) { const m = stripMd(l).match(re); if (m) return m[1].trim(); }
  return null;
}

export function table(lines) {
  const rows = (lines ?? []).filter(l => l.trim().startsWith('|'))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim()));
  if (!rows.length) return null;
  const header = rows[0].map(h => stripMd(h).toLowerCase());
  const body = rows.slice(1).filter(r => !r.every(c => /^:?-+:?$/.test(c)));
  const col = (re, not = -1) => header.findIndex((h, i) => i !== not && re.test(h));
  return { header, rows: body, col };
}

function scenarioNames(changeDir, problems) {
  const names = [];
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.md')) {
        const r = readCapped(p);
        if (r.tooLarge) { problems.push(`${path.relative(changeDir, p)} is over ${MAX_READ / 1024} KB and was not read`); continue; }
        for (const m of r.text.matchAll(/^####[ \t]+Scenario:[ \t]*(.+)$/gm)) names.push(stripMd(m[1].replace(/[ \t]#+[ \t]*$/, '')));
      }
    }
  };
  walk(path.join(changeDir, 'specs'));
  return names;
}

export function goalIds(text, idPattern) {
  const ids = new Set();
  const re = new RegExp(`^(?:[-+][ \\t]+)?(${idPattern})[ \\t]*[:\\-][ \\t]*(.+)$`);
  for (const line of noComments(lf(text)).split('\n')) {
    const m = stripMd(line).match(re);
    if (m && isFilled(m[2])) ids.add(m[1]);
  }
  return ids;
}

export function changeNamesInBody(body) {
  const names = [];
  for (const line of body.split('\n')) {
    const m = stripMd(line).match(/^(?:[-+][ \t]+)?Change[ \t]*:[ \t]*(\S+)$/i);
    if (m) names.push(sanitize(m[1]));
  }
  return names;
}

export function exemptReasonInBody(body) {
  for (const line of body.split('\n')) {
    const m = stripMd(line).match(/^(?:[-+][ \t]+)?Spec-exempt[ \t]*:[ \t]*(.+)$/i);
    if (m) return sanitize(m[1]).trim();
  }
  return null;
}

// ---------- checks on one change ----------
function checkChange(name, ctx) {
  const problems = [];
  const have = [];
  const dir = path.join(ctx.repo, 'openspec', 'changes', name);
  if (!existsSync(dir)) return { name, problems: [`openspec/changes/${name}/ does not exist at the head commit`], have };

  const metaPath = path.join(dir, '.openspec.yaml');
  const skipSpecs = existsSync(metaPath) && /^skip_specs:[ \t]*true[ \t]*$/m.test(readCapped(metaPath).text ?? '');
  if (skipSpecs && ctx.big) problems.push('declares skip_specs: true, but this pull request is bigger than small, so the change needs spec deltas');

  const r = spawnSync(ctx.openspec, ['validate', name, '--type', 'change', '--strict', '--json', '--no-interactive'], {
    cwd: ctx.repo, encoding: 'utf8',
    env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', OPENSPEC_NO_COMPLETIONS: '1' },
  });
  if (r.error) throw new Error(`could not run openspec (${ctx.openspec}): ${r.error.message}`);
  let validate = null;
  try { validate = JSON.parse(r.stdout); } catch { /* reported below */ }
  const item = validate?.items?.[0];
  if (r.status !== 0 || !item?.valid) {
    const issues = item?.issues ?? validate?.status ?? [{ message: (r.stderr || r.stdout).trim() }];
    problems.push(`openspec validate ${name} --strict failed: ` + issues.map(i => `${i.level ?? i.severity}: ${sanitize(i.message)}`).join(' | '));
  }
  const validated = r.status === 0 && item?.valid === true;

  const proposalPath = path.join(dir, 'proposal.md');
  if (!existsSync(proposalPath)) {
    problems.push('proposal.md is missing (openspec validate does not check for it)');
    return { name, problems, have, validated };
  }
  const proposal = readCapped(proposalPath);
  if (proposal.tooLarge) { problems.push(`proposal.md is over ${MAX_READ / 1024} KB and was not read`); return { name, problems, have, validated }; }
  const sec = sections(proposal.text);
  const cfg = ctx.config;

  // Goal: ID + one line
  const goal = field(sec.goal, 'Goal');
  const goalMatch = goal?.match(new RegExp(`^(${cfg.goals.idPattern})[ \\t]*[-:\u2013\u2014][ \\t]*(\\S.*)$`));
  if (!sec.goal) problems.push('Goal section is missing');
  else if (!goalMatch || !isFilled(goalMatch[2])) problems.push('Goal must read "**Goal:** <ID> - <one line>" with a real ID and line');
  else if (ctx.goals && !ctx.goals.has(goalMatch[1])) problems.push(`Goal ID ${sanitize(goalMatch[1])} is not in ${cfg.goals.file}`);
  else have.push('Goal');

  // Ticket
  const ticket = field(sec.ticket, 'Ticket');
  const ticketValue = ticket?.replace(/^<(https?:\/\/[^>]+)>$/i, '$1');
  if (!sec.ticket || !isFilled(ticket)) problems.push('Ticket is missing or still a placeholder');
  else if (cfg.ticketPattern && !new RegExp(cfg.ticketPattern).test(ticketValue)) problems.push(`Ticket "${sanitize(ticketValue)}" does not match ${cfg.ticketPattern}`);
  else have.push('Ticket');

  // Files at Risk
  const risk = table(sec['files at risk']);
  let listed = [];
  if (!sec['files at risk']) problems.push('Files at Risk section is missing');
  else if (!risk) problems.push('Files at Risk has no table');
  else {
    const pc = risk.col(/path|module|file/);
    const rc = risk.col(/readiness|ready|colou?r/);
    if (pc < 0 || rc < 0) problems.push('Files at Risk table needs a "Path or module" column and a "Readiness" column');
    else {
      const ok = risk.rows.filter(r => isFilled(r[pc]) && /^(red|yellow|green)$/i.test(stripMd(r[rc])));
      for (const r of risk.rows) {
        if (isFilled(r[pc]) && !/^(red|yellow|green)$/i.test(stripMd(r[rc]))) problems.push(`Files at Risk row "${sanitize(stripMd(r[pc]))}" has readiness "${sanitize(stripMd(r[rc]))}" (use red, yellow or green)`);
      }
      if (!ok.length) problems.push('Files at Risk needs at least one row with a path and a readiness of red, yellow or green');
      else have.push('Files at Risk');
      listed = ok.map(r => stripMd(r[pc]).replace(/\*+$/, '').replace(/\/$/, '').toLowerCase()).filter(Boolean);
    }
  }

  // verification.md: every scenario names its test
  const scenarios = scenarioNames(dir, problems);
  const vPath = path.join(dir, 'verification.md');
  let calcs = 0;
  if (existsSync(vPath)) {
    const v = readCapped(vPath);
    const t = v.tooLarge ? null : table(noComments(v.text).split('\n'));
    if (v.tooLarge) problems.push(`verification.md is over ${MAX_READ / 1024} KB and was not read`);
    else if (!t) problems.push('verification.md has no table');
    else {
      const sc = t.col(/scenario/);
      const tc = t.col(/test/, sc);
      const cc = t.col(/calc|separate/);
      if (sc < 0 || tc < 0) problems.push('verification.md table needs a "Scenario" column and a "Test that proves it" column');
      else {
        const byScenario = new Map(t.rows.map(r => [stripMd(r[sc]).toLowerCase(), r]));
        const before = problems.length;
        for (const s of scenarios) {
          const row = byScenario.get(s.toLowerCase());
          if (!row) problems.push(`verification.md has no row for scenario "${sanitize(s)}"`);
          else if (!isFilled(row[tc])) problems.push(`verification.md row "${sanitize(s)}" does not name a test`);
        }
        if (problems.length === before) have.push(`verification.md covering ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`);
        if (cc >= 0) calcs = t.rows.filter(r => isRealCalc(r[cc])).length;
      }
    }
  } else if (scenarios.length) {
    problems.push(`verification.md is missing (${scenarios.length} scenario(s) in specs/ need a test named)`);
  } else have.push('no scenarios (so no verification.md needed)');
  if (ctx.touchesMoney && calcs === 0) {
    problems.push('this pull request touches money paths; verification.md must name at least one separate calculation (values starting with no, none, n/a, not applicable or nope do not count)');
  }

  // Advisory: sensitive paths changed but not listed
  const unlisted = ctx.sensitiveFiles.filter(f => !listed.some(l => f.toLowerCase().includes(l)));
  return { name, problems, have, unlisted, skipSpecs, validated };
}

// ---------- main ----------
export function run(inp) {
  const notes = [];
  const problems = [];
  if (!inp.base) throw new Error('no base commit: pass --base, set SPEC_CHECK_BASE, or run on a pull_request event');
  const config = loadSettings(inp, notes, problems);
  inp.config = config;

  let mode = config.mode;
  if (mode === 'block' && !approvedBlock(config)) {
    mode = 'warn';
    notes.push('mode is "block" but blockingApproval.approvedBy and approvedOn are empty, so the check only warns.');
  }

  const files = diffFiles(inp.repo, inp.base, inp.head);
  const isTest = matcher(config.testPaths);
  const isIgnored = matcher(config.ignorePaths);
  const isAlways = matcher(config.alwaysNeedsSpec);
  const isReview = matcher(config.alwaysReview);
  const isMoney = matcher(config.moneyPaths);
  const code = p => !SPEC_DIRS.test(p);
  const excluded = p => isTest(p) || isIgnored(p);
  const both = f => (f.oldPath ? [f.oldPath, f.path] : [f.path]);   // renames: old and new path
  const uniq = a => [...new Set(a)].map(sanitize);
  for (const f of files) {
    f.review = both(f).some(isReview);
    // Git reports any file with a NUL byte as binary with no line count. Size
    // first: anything over binaryBytes is flagged by size and never read.
    // Under it, source files and mostly-text files are counted by newlines;
    // other binaries (images, wasm, archives) are left to the size rule.
    if (f.binary && !f.submodule && !excluded(f.path)) {
      f.size = Math.max(blobSize(inp.repo, f.newSha), blobSize(inp.repo, f.oldSha));
      f.code = CODE_EXT.test(f.path);
      const sha = f.newSha && !ZERO_SHA.test(f.newSha) ? f.newSha : f.oldSha;
      if (f.size <= config.thresholds.binaryBytes && (f.code || mostlyText(inp.repo, sha))) {
        f.lines = blobLines(inp.repo, f.oldSha) + blobLines(inp.repo, f.newSha);
      }
    }
    // A file renamed out of a test or ignored path into code counts in full.
    if (f.oldPath && !f.binary && excluded(f.oldPath) && !excluded(f.path)) f.lines = blobLines(inp.repo, f.newSha);
  }
  // alwaysReview files count toward size even when ignorePaths matches them.
  const counted = files.filter(f => !f.submodule && (f.review || !excluded(f.path)));
  const lines = counted.reduce((n, f) => n + f.lines, 0);
  // alwaysNeedsSpec wins over testPaths and ignorePaths.
  const sensitiveFiles = uniq(files.flatMap(f => both(f).filter(p => code(p) && isAlways(p))));
  const reviewFiles = uniq(files.flatMap(f => both(f).filter(isReview)));
  const binaries = files.filter(f => f.size > config.thresholds.binaryBytes)
    .map(f => `${sanitize(f.path)} (${(f.size / 1048576).toFixed(1)} MB)`);
  const binaryCode = uniq(files.filter(f => f.code).map(f => f.path));
  const submodules = uniq(files.filter(f => f.submodule).map(f => f.path));
  const serviceRes = config.services.map(g => globToRegex(g.replace(/^\//, ''), { prefixOnly: true }));
  const services = new Set();
  for (const f of counted) for (const re of serviceRes) { const m = f.path.match(re); if (m) services.add(sanitize(m[0])); }

  const list = a => a.slice(0, 5).join(', ') + (a.length > 5 ? `, and ${a.length - 5} more` : '');
  const reasons = [];
  const t = config.thresholds;
  if (t.nonTestLinesChanged && lines >= t.nonTestLinesChanged) reasons.push(`${lines} non-test lines changed, at or above the threshold of ${t.nonTestLinesChanged}`);
  if (sensitiveFiles.length) reasons.push(`touches paths that always need a spec: ${list(sensitiveFiles)}`);
  if (t.servicesTouched && services.size >= t.servicesTouched) reasons.push(`touches ${services.size} services: ${[...services].join(', ')}`);
  if (binaries.length) reasons.push(`binary files over ${(t.binaryBytes / 1048576).toFixed(1)} MB: ${list(binaries)}`);
  if (binaryCode.length) reasons.push(`source files that git treats as binary (they contain a NUL byte): ${list(binaryCode)}`);
  if (submodules.length) reasons.push(`changes submodules: ${list(submodules)}`);
  const big = reasons.length > 0;

  // Linked changes: change folders modified in this diff.
  const linked = new Map();
  for (const f of files) {
    const m = f.path.match(/^openspec\/changes\/([^/]+)\//);
    if (!m || m[1] === 'archive' || linked.has(m[1])) continue;
    const name = sanitize(m[1]);
    if (!CHANGE_NAME.test(name)) { problems.push(`"${name}" is not a valid change name (lowercase kebab-case)`); continue; }
    if (existsSync(path.join(inp.repo, 'openspec', 'changes', name))) linked.set(name, 'modified in this pull request');
    else notes.push(`openspec/changes/${name}/ was removed or archived in this pull request, so it does not count as a linked change.`);
  }
  // "Change: <name>" lines name a change modified here, or an active change
  // already on the base branch (spec first, code later).
  const onBase = name => spawnSync('git', ['cat-file', '-e', `${inp.base}:openspec/changes/${name}`], { cwd: inp.repo }).status === 0;
  const archiveDir = path.join(inp.repo, 'openspec', 'changes', 'archive');
  const archived = name => existsSync(archiveDir) && readdirSync(archiveDir).some(d => d === name || d.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)?.[1] === name);
  for (const name of changeNamesInBody(inp.body)) {
    if (!CHANGE_NAME.test(name)) problems.push(`"${name}" in the PR body is not a valid change name (lowercase kebab-case)`);
    else if (linked.has(name)) linked.set(name, 'modified in this pull request and named in the PR body');
    else if (existsSync(path.join(inp.repo, 'openspec', 'changes', name)) && onBase(name)) linked.set(name, 'named in the PR body');
    else if (archived(name)) problems.push(`"${name}" is named in the PR body, but that change is archived; name an active change`);
    else problems.push(`"${name}" is named in the PR body, but openspec/changes/${name}/ does not exist`);
  }

  let goals = null;
  if (config.goals.file) {
    let g = gitShow(inp.repo, inp.base, config.goals.file);
    if (g === null && inp.bootstrap && existsSync(path.join(inp.repo, config.goals.file))) {
      g = readCapped(path.join(inp.repo, config.goals.file)).text ?? null;
      notes.push(`Bootstrap: ${config.goals.file} is not on the base branch, so this pull request's copy is used.`);
    }
    if (g === null) problems.push(`goals file ${config.goals.file} is not on the base branch, so goal IDs cannot be checked`);
    else goals = goalIds(g.slice(0, MAX_READ), config.goals.idPattern);
  }

  const ctx = { repo: inp.repo, openspec: inp.openspec, config, goals, big, sensitiveFiles,
    touchesMoney: files.some(f => both(f).some(p => code(p) && isMoney(p))) };
  const changes = [...linked.keys()].map(n => ({ ...checkChange(n, ctx), source: linked.get(n) }));
  for (const c of changes) for (const p of c.problems) problems.push(`${c.name}: ${p}`);

  // Exemption: label plus a one-line reason in the body.
  const label = config.exemptLabel;
  const hasLabel = inp.labels.some(l => l.toLowerCase() === label.toLowerCase());
  const reasonRaw = exemptReasonInBody(inp.body);
  const exemptReason = reasonRaw && isFilled(reasonRaw) && reasonRaw.length >= 10 ? reasonRaw : null;
  if (hasLabel && !exemptReason) problems.push(`label "${label}" needs a reason: add a line "Spec-exempt: <one-line reason>" (10 characters or more) to the PR body`);

  // Changes named in the body but not touched by this pull request.
  const byName = changes.filter(c => c.source === 'named in the PR body').map(c => c.name);
  const touched = changes.filter(c => c.source !== 'named in the PR body');
  if (big && byName.length && config.requireLinkedChangeTouched && !touched.length) {
    problems.push(`linked by name only to existing change ${byName.join(', ')}; this repository requires a large pull request to touch its change (requireLinkedChangeTouched)`);
  }
  let status;
  if (problems.length) status = 'flag';
  else if (!big || changes.length || (hasLabel && exemptReason)) status = 'pass';
  else { status = 'flag'; problems.push('bigger than small with no change in it: add openspec/changes/<name>/ to this pull request'); }

  const advisories = [];
  if (reviewFiles.length) advisories.push(`agent instructions changed; code owner should review: ${list(reviewFiles)}`);
  for (const c of changes) {
    const touchedCore = files.some(f => f.path === `openspec/changes/${c.name}/proposal.md` || f.path.startsWith(`openspec/changes/${c.name}/specs/`));
    if (onBase(c.name) && !touchedCore) advisories.push(`${c.name}: existing change, created before this PR (its proposal and specs were not changed here)`);
    if (c.unlisted?.length) advisories.push(`${c.name}: sensitive paths changed but not under Files at Risk: ${c.unlisted.join(', ')}`);
  }

  return {
    linkedByNameOnly: big && !touched.length && !(hasLabel && exemptReason) ? byName : [],
    status, mode, big, reasons, lines, filesCounted: counted.length, services: [...services], binaries, submodules,
    exempt: hasLabel && exemptReason ? { label, reason: exemptReason, actor: inp.actor } : null,
    changes: changes.map(c => ({ name: c.name, source: c.source, validated: c.validated === true, has: c.have, problems: c.problems })),
    problems, advisories, notes,
  };
}

// ---------- output ----------
const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const html = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(res) {
  const flagged = res.status === 'flag';
  const head = flagged ? `Spec check: FLAGGED (${res.mode === 'block' ? 'blocking' : 'warn mode, not blocking'})`
    : `Spec check: PASSED${res.linkedByNameOnly.length ? ` (linked by name to existing change: ${res.linkedByNameOnly.join(', ')})` : ''}`;
  const out = [head, '',
    `Size: ${res.lines} non-test lines in ${res.filesCounted} files${res.services.length ? `; services: ${res.services.join(', ')}` : ''}`,
    res.big ? `Bigger than small because: ${res.reasons.join('; ')}` : 'Small change: no spec needed.'];
  if (res.exempt) {
    out.push(`Exempt by label "${res.exempt.label}"${res.exempt.actor ? ` (this run was triggered by ${res.exempt.actor})` : ''}. Reason: ${res.exempt.reason}`);
    out.push('Anyone who can add labels can add this one. A reviewer must confirm the reason.');
  }
  for (const c of res.changes) {
    out.push(`Change ${c.name} (${c.source}): ${c.problems.length ? 'has problems, listed below' : `${c.validated ? 'validates; ' : ''}has ${c.has.join(', ')}`}`);
  }
  if (res.problems.length) { out.push('', 'To fix:'); for (const p of res.problems) out.push(`- ${p}`); }
  if (res.advisories.length) { out.push('', 'For the reviewer (does not affect the result):'); for (const a of res.advisories) out.push(`- ${a}`); }
  if (res.notes.length) { out.push('', 'Notes:'); for (const n of res.notes) out.push(`- ${n}`); }
  out.push('', 'This check confirms the spec exists and is filled in. It does not confirm the spec is right; review does that.');
  return { head, text: out.join('\n') };
}

function emit(res, inp) {
  const { head, text } = render(res);
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  // Paths, names and reasons come from the pull request. Stop GitHub from
  // reading workflow commands in them while they are printed.
  const token = randomUUID();
  if (inActions) console.log(`::stop-commands::${token}`);
  console.log(inp.json ? JSON.stringify(res, null, 2) : text);
  if (inActions) console.log(`::${token}::`);
  if (inActions) {
    const level = res.status === 'flag' ? (res.mode === 'block' ? 'error' : 'warning') : 'notice';
    console.log(`::${level} title=${escProp(head)}::${escData(res.problems.slice(0, 3).join(' / ') || 'OK')}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `<pre>\n${html(text)}\n</pre>\n`);
}

function main() {
  let inp = null;
  try {
    inp = readInputs();
    const res = run(inp);
    emit(res, inp);
    process.exit(res.status === 'flag' && res.mode === 'block' ? 1 : 0);
  } catch (err) {
    const inActions = process.env.GITHUB_ACTIONS === 'true';
    if (err instanceof FailClosed) {
      const msg = `Spec check failed closed: ${err.message}`;
      console.log(inActions ? `::error::${escData(msg)}` : msg);
      process.exit(1);
    }
    const blocking = approvedBlock(inp?.config);
    const msg = `Spec check could not run: ${sanitize(err.message)}`;
    console.log(inActions ? `::${blocking ? 'error' : 'warning'}::${escData(msg)}` : msg);
    process.exit(blocking ? 2 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
