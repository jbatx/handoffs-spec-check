#!/usr/bin/env node
// Spec check for pull requests. Flags a pull request that is bigger than
// small and has no valid, linked OpenSpec change. It checks form, not truth:
// it confirms the fields exist and the spec validates, not that they are right.
//
// Inputs (arguments win over environment, environment wins over the event file):
//   --repo <dir>        repository root (default: cwd)
//   --base <rev>        SPEC_CHECK_BASE   base commit of the pull request
//   --head <rev>        SPEC_CHECK_HEAD   head commit (default: HEAD)
//   --body-file <path>  SPEC_CHECK_PR_BODY (text) pull request description
//   --labels <a,b>      SPEC_CHECK_LABELS  comma-separated label names
//   --config <path>     SPEC_CHECK_CONFIG  (default: .github/spec-check.jsonc)
//   --openspec <path>   OPENSPEC_BIN       openspec executable (default: openspec)
//   --json              print the result as JSON
//   GITHUB_EVENT_PATH   pull_request event, used for anything not given above
// Exit codes: 0 pass or warn, 1 flagged in approved block mode, 2 checker error in block mode.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const CHANGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /<[^>]*>/;
const EMPTY_VALUES = new Set(['', 'n/a', 'na', 'none', 'tbd', 'todo', '-', '?']);

// ---------- inputs ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function readInputs() {
  const args = parseArgs(process.argv.slice(2));
  let event = {};
  if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request ?? {};
  }
  const body = args['body-file'] ? readFileSync(args['body-file'], 'utf8')
    : process.env.SPEC_CHECK_PR_BODY ?? event.body ?? '';
  const labelsRaw = args.labels ?? process.env.SPEC_CHECK_LABELS;
  const labels = labelsRaw !== undefined
    ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : (event.labels ?? []).map(l => l.name);
  return {
    repo: path.resolve(args.repo ?? process.cwd()),
    base: args.base ?? process.env.SPEC_CHECK_BASE ?? event.base?.sha,
    head: args.head ?? process.env.SPEC_CHECK_HEAD ?? event.head?.sha ?? 'HEAD',
    body: body ?? '',
    labels,
    configPath: args.config ?? process.env.SPEC_CHECK_CONFIG ?? '.github/spec-check.jsonc',
    openspec: args.openspec ?? process.env.OPENSPEC_BIN ?? 'openspec',
    json: Boolean(args.json),
  };
}

// ---------- helpers ----------
function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function gitShow(repo, rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: repo, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function globToRegex(glob, { prefixOnly = false } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, end).split(',').map(escape).join('|') + ')'; i = end; }
    else re += escape(c);
  }
  return new RegExp('^' + re + (prefixOnly ? '(?=/)' : '$'));
  function escape(s) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
}

function matcher(globs = []) {
  const res = globs.map(g => (g.includes('/') ? globToRegex(g) : { test: p => globToRegex(g).test(path.posix.basename(p)) }));
  return p => res.some(r => r.test(p));
}

function loadJsonc(text) {
  return JSON.parse(text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'));
}

function clean(s) {
  return (s ?? '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

function isFilled(v) {
  const c = clean(v);
  return !EMPTY_VALUES.has(c.toLowerCase()) && !PLACEHOLDER.test(c);
}

// ---------- diff ----------
function diffFiles(repo, base, head) {
  const out = git(repo, ['diff', '--numstat', '-z', '-M', `${base}...${head}`]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [add, del, p] = parts[i].split('\t');
    let file = p;
    if (p === '') { i += 2; file = parts[i]; } // rename: "A\tD\t\0old\0new"
    const lines = (add === '-' ? 0 : Number(add)) + (del === '-' ? 0 : Number(del));
    files.push({ path: file, lines });
  }
  return files;
}

// ---------- proposal parsing ----------
function sections(md) {
  const text = md.replace(/<!--[\s\S]*?-->/g, '');
  const map = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h && !line.startsWith('###')) { cur = clean(h[1]).toLowerCase(); map[cur] = []; continue; }
    if (cur) map[cur].push(line);
  }
  return map;
}

function fieldValue(lines, name) {
  const re = new RegExp(`^\\s*[*_]*${name}[*_]*\\s*:\\s*[*_]*\\s*(.*)$`, 'i');
  for (const l of lines ?? []) { const m = l.match(re); if (m) return m[1].trim(); }
  return null;
}

function tableRows(lines) {
  const rows = (lines ?? []).filter(l => l.trim().startsWith('|'))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  return rows.filter((r, i) => i > 0 && !r.every(c => /^:?-+:?$/.test(c)));
}

function scenarioNames(changeDir) {
  const names = [];
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/^####\s+Scenario:\s*(.+?)\s*#*\s*$/gm)) names.push(clean(m[1]));
      }
    }
  };
  walk(path.join(changeDir, 'specs'));
  return names;
}

function goalIds(text, idPattern) {
  const ids = new Set();
  const re = new RegExp(`^\\s*[-*]?\\s*[*_]*(${idPattern})[*_]*\\s*[:\\-]\\s*(.+)$`);
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const m = line.match(re);
    if (m && isFilled(m[2])) ids.add(m[1]);
  }
  return ids;
}

// ---------- checks on one change ----------
function checkChange(name, ctx) {
  const problems = [];
  const dir = path.join(ctx.repo, 'openspec', 'changes', name);
  if (!existsSync(dir)) return { name, problems: [`openspec/changes/${name}/ does not exist at the head commit`] };

  const r = spawnSync(ctx.openspec, ['validate', name, '--strict', '--json', '--no-interactive'], {
    cwd: ctx.repo, encoding: 'utf8',
    env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', OPENSPEC_NO_COMPLETIONS: '1' },
  });
  if (r.error) throw new Error(`could not run openspec (${ctx.openspec}): ${r.error.message}`);
  let validate;
  try { validate = JSON.parse(r.stdout); } catch { validate = null; }
  const item = validate?.items?.[0];
  if (r.status !== 0 || !item?.valid) {
    const issues = item?.issues ?? validate?.status ?? [{ message: (r.stderr || r.stdout).trim() }];
    problems.push(`openspec validate ${name} --strict failed: ` + issues.map(i => `${i.level ?? i.severity}: ${i.message}`).join(' | '));
  }

  const proposalPath = path.join(dir, 'proposal.md');
  if (!existsSync(proposalPath)) {
    problems.push('proposal.md is missing (openspec validate does not check for it)');
    return { name, problems, validated: item?.valid === true };
  }
  const sec = sections(readFileSync(proposalPath, 'utf8'));
  const cfg = ctx.config;

  // Goal: ID + one line
  const goal = fieldValue(sec.goal, 'Goal');
  const goalMatch = goal && clean(goal).match(new RegExp(`^(${cfg.goals.idPattern})\\s*[-:–—]\\s*(.+)$`));
  if (!sec.goal) problems.push('Goal section is missing');
  else if (!goalMatch || !isFilled(goalMatch[2])) problems.push('Goal must read "**Goal:** <ID> - <one line>" with a real ID and line');
  else if (ctx.goals && !ctx.goals.has(goalMatch[1])) problems.push(`Goal ID ${goalMatch[1]} is not in ${cfg.goals.file}`);

  // Ticket
  const ticket = fieldValue(sec.ticket, 'Ticket');
  if (!sec.ticket || !isFilled(ticket)) problems.push('Ticket is missing or still a placeholder');
  else if (cfg.ticketPattern && !new RegExp(cfg.ticketPattern).test(clean(ticket))) problems.push(`Ticket "${clean(ticket)}" does not match ${cfg.ticketPattern}`);

  // Files at risk
  const risk = tableRows(sec['files at risk']);
  const goodRisk = risk.filter(r => isFilled(r[0]) && /^(red|yellow|green)$/i.test(clean(r[1])));
  if (!sec['files at risk']) problems.push('Files at Risk section is missing');
  else if (goodRisk.length === 0) problems.push('Files at Risk needs at least one row with a path and a readiness of red, yellow or green');
  for (const r of risk) if (isFilled(r[0]) && !/^(red|yellow|green)$/i.test(clean(r[1]))) problems.push(`Files at Risk row "${clean(r[0])}" has readiness "${clean(r[1])}" (use red, yellow or green)`);

  // Verification (verification.md): every scenario names its test
  const verificationPath = path.join(dir, 'verification.md');
  const hasVerification = existsSync(verificationPath);
  const rows = hasVerification
    ? tableRows(readFileSync(verificationPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').split('\n'))
    : [];
  const byScenario = new Map(rows.map(r => [clean(r[0]).toLowerCase(), r]));
  const scenarios = scenarioNames(dir);
  if (scenarios.length && !hasVerification) problems.push(`verification.md is missing (${scenarios.length} scenario(s) in specs/ need a test named)`);
  else for (const s of scenarios) {
    const row = byScenario.get(s.toLowerCase());
    if (!row) problems.push(`verification.md has no row for scenario "${s}"`);
    else if (!isFilled(row[1])) problems.push(`verification.md row "${s}" does not name a test`);
  }
  if (ctx.touchesMoney && !rows.some(r => isFilled(r[2]))) {
    problems.push('This pull request touches money paths; verification.md must name at least one separate calculation');
  }

  // Advisory: sensitive paths touched but not listed
  const listed = goodRisk.map(r => clean(r[0]).replace(/\*+$/, '').replace(/\/$/, '')).filter(Boolean);
  const unlisted = ctx.sensitiveFiles.filter(f => !listed.some(l => f.includes(l)));
  return { name, problems, validated: item?.valid === true, unlisted };
}

// ---------- main ----------
function run(inp) {
  const notes = [];
  if (!inp.base) throw new Error('no base commit: pass --base, set SPEC_CHECK_BASE, or run on a pull_request event');

  let cfgText = gitShow(inp.repo, inp.base, inp.configPath);
  if (cfgText === null) {
    const local = path.join(inp.repo, inp.configPath);
    if (!existsSync(local)) throw new Error(`config ${inp.configPath} not found at base or in the working tree`);
    cfgText = readFileSync(local, 'utf8');
    notes.push(`Config is not on the base branch yet; using this pull request's copy of ${inp.configPath}.`);
  }
  const config = loadJsonc(cfgText);
  config.goals = { file: '', idPattern: '[A-Z][A-Z0-9]*-[0-9]+', ...(config.goals ?? {}) };

  let mode = config.mode === 'block' ? 'block' : 'warn';
  if (mode === 'block' && !(config.blockingApproval?.approvedBy && config.blockingApproval?.approvedOn)) {
    mode = 'warn';
    notes.push('mode is "block" but blockingApproval.approvedBy/approvedOn are empty, so the check only warns.');
  }

  const files = diffFiles(inp.repo, inp.base, inp.head);
  const isTest = matcher(config.testPaths);
  const isIgnored = matcher(config.ignorePaths);
  const isAlways = matcher(config.alwaysNeedsSpec);
  const isMoney = matcher(config.moneyPaths);
  const counted = files.filter(f => !isTest(f.path) && !isIgnored(f.path));
  const lines = counted.reduce((n, f) => n + f.lines, 0);
  const sensitiveFiles = counted.filter(f => isAlways(f.path)).map(f => f.path);
  const serviceRes = (config.services ?? []).map(g => globToRegex(g, { prefixOnly: true }));
  const services = new Set();
  for (const f of counted) for (const re of serviceRes) { const m = f.path.match(re); if (m) services.add(m[0]); }

  const reasons = [];
  const t = config.thresholds ?? {};
  if (t.nonTestLinesChanged && lines >= t.nonTestLinesChanged) reasons.push(`${lines} non-test lines changed (threshold ${t.nonTestLinesChanged})`);
  if (sensitiveFiles.length) reasons.push(`touches paths that always need a spec: ${sensitiveFiles.slice(0, 5).join(', ')}${sensitiveFiles.length > 5 ? ', ...' : ''}`);
  if (t.servicesTouched && services.size >= t.servicesTouched) reasons.push(`touches ${services.size} services: ${[...services].join(', ')}`);
  const big = reasons.length > 0;

  // Linked changes: change folders in the diff, plus "Change: <name>" lines in the body.
  const linked = new Map();
  for (const f of files) {
    const m = f.path.match(/^openspec\/changes\/([^/]+)\//);
    if (!m || m[1] === 'archive' || linked.has(m[1])) continue;
    if (existsSync(path.join(inp.repo, 'openspec', 'changes', m[1]))) linked.set(m[1], 'in this pull request');
    else notes.push(`openspec/changes/${m[1]}/ was removed or archived in this pull request, so it does not count as a linked change.`);
  }
  for (const m of inp.body.matchAll(/^[ \t]*Change:[ \t]*(\S+)[ \t]*$/gim)) {
    if (!linked.has(m[1])) linked.set(m[1], 'named in the PR body');
  }
  const badNames = [...linked.keys()].filter(n => !CHANGE_NAME.test(n));
  for (const n of badNames) linked.delete(n);

  let goals = null;
  if (config.goals.file) {
    let g = gitShow(inp.repo, inp.base, config.goals.file);
    if (g === null && existsSync(path.join(inp.repo, config.goals.file))) {
      g = readFileSync(path.join(inp.repo, config.goals.file), 'utf8');
      notes.push(`${config.goals.file} is not on the base branch yet; using this pull request's copy.`);
    }
    if (g === null) notes.push(`${config.goals.file} not found; goal IDs are not looked up.`);
    else goals = goalIds(g, config.goals.idPattern);
  }

  const ctx = { repo: inp.repo, openspec: inp.openspec, config, goals, sensitiveFiles, touchesMoney: counted.some(f => isMoney(f.path)) };
  const changes = [...linked.keys()].map(n => ({ ...checkChange(n, ctx), source: linked.get(n) }));
  const problems = badNames.map(n => `"${n}" is not a valid change name (lowercase kebab-case)`);
  for (const c of changes) for (const p of c.problems) problems.push(`${c.name}: ${p}`);

  // Exemption
  const exemptLabel = (config.exemptLabel ?? 'spec-exempt').toLowerCase();
  const hasLabel = inp.labels.some(l => l.toLowerCase() === exemptLabel);
  const reasonMatch = inp.body.match(/^[ \t]*Spec-exempt:[ \t]*(.+)$/im);
  const exemptReason = reasonMatch && isFilled(reasonMatch[1]) && clean(reasonMatch[1]).length >= 10 ? clean(reasonMatch[1]) : null;
  if (hasLabel && !exemptReason) problems.push(`label "${config.exemptLabel}" needs a reason: add a line "Spec-exempt: <one-line reason>" to the PR body`);

  let status;
  if (problems.length) status = 'flag';
  else if (!big) status = 'pass';
  else if (changes.length) status = 'pass';
  else if (hasLabel && exemptReason) status = 'pass';
  else { status = 'flag'; problems.push('bigger than small with no linked change: add openspec/changes/<name>/ to this pull request, or a "Change: <name>" line to its description'); }

  const advisories = [];
  for (const c of changes) if (c.unlisted?.length) advisories.push(`${c.name}: sensitive paths changed but not under Files at Risk: ${c.unlisted.join(', ')}`);

  return {
    status, mode, big, reasons, lines, filesCounted: counted.length, services: [...services],
    exempt: hasLabel && exemptReason ? exemptReason : null,
    changes: changes.map(c => ({ name: c.name, source: c.source, validated: c.validated, problems: c.problems })),
    problems, advisories, notes,
  };
}

// GitHub workflow-command escaping
const escData = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function report(res, inp) {
  const flagged = res.status === 'flag';
  const head = flagged
    ? `Spec check: FLAGGED (${res.mode === 'block' ? 'blocking' : 'warn mode, not blocking'})`
    : 'Spec check: PASSED';
  const out = [head, '',
    `Size: ${res.lines} non-test lines in ${res.filesCounted} files${res.services.length ? `; services: ${res.services.join(', ')}` : ''}`,
    res.big ? `Bigger than small because: ${res.reasons.join('; ')}` : 'Small change: no spec needed.'];
  if (res.exempt) out.push(`Exempt (spec-exempt label): ${res.exempt}`);
  for (const c of res.changes) out.push(`Linked change: ${c.name} (${c.source}): ${c.problems.length ? 'has problems' : 'validates; has Goal, Ticket, Files at Risk and verification.md'}`);
  if (res.problems.length) { out.push('', 'To fix:'); for (const p of res.problems) out.push(`- ${p}`); }
  if (res.advisories.length) { out.push('', 'For the reviewer (does not affect the result):'); for (const a of res.advisories) out.push(`- ${a}`); }
  if (res.notes.length) { out.push('', 'Notes:'); for (const n of res.notes) out.push(`- ${n}`); }
  out.push('', 'This check confirms the spec exists and is filled in. It does not confirm the spec is right; review does that.');
  const text = out.join('\n');

  if (inp.json) console.log(JSON.stringify(res, null, 2));
  else console.log(text);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const level = flagged ? (res.mode === 'block' ? 'error' : 'warning') : 'notice';
    console.log(`::${level} title=${escProp(head)}::${escData(res.problems.slice(0, 3).join(' / ') || 'OK')}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
}

let inp;
try {
  inp = readInputs();
  const res = run(inp);
  report(res, inp);
  process.exit(res.status === 'flag' && res.mode === 'block' ? 1 : 0);
} catch (err) {
  // A broken checker never blocks in warn mode; in block mode it fails loudly.
  let blocking = false;
  try {
    const i = inp ?? readInputs();
    const t = gitShow(i.repo, i.base, i.configPath) ?? readFileSync(path.join(i.repo, i.configPath), 'utf8');
    const c = loadJsonc(t);
    blocking = c.mode === 'block' && Boolean(c.blockingApproval?.approvedBy && c.blockingApproval?.approvedOn);
  } catch { /* config unreadable: treat as warn */ }
  const msg = `Spec check could not run: ${err.message}`;
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::${blocking ? 'error' : 'warning'}::${escData(msg)}` : msg);
  process.exit(blocking ? 2 : 0);
}
