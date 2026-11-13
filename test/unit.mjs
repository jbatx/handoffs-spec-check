// Unit checks for the parsing pieces of spec-check.mjs. Prints one line per
// check and exits non-zero on any failure. Run: node test/unit.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonc, withDefaults, matcher, globToRegex, isFilled, field, table,
  changeNamesInBody, exemptReasonInBody, goalIds, isRealCalc, lf, noComments,
} from '../kit/.github/actions/spec-check/spec-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = withDefaults(parseJsonc(readFileSync(path.join(root, 'kit/.github/spec-check.jsonc'), 'utf8')));
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'OK      ' : 'MISMATCH'} ${name}`); if (!ok) failed++; };
const throws = fn => { try { fn(); return false; } catch { return true; } };

// JSONC
check('jsonc: inline // comment after a value', parseJsonc('{"a": 1, // note\n"b": 2}').b === 2);
check('jsonc: // and /* inside a string are kept', parseJsonc('{"u": "https://x.example/a/*b*/"}').u === 'https://x.example/a/*b*/');
check('jsonc: block comment and trailing commas', parseJsonc('{/* c */"a": [1, 2,], }').a.length === 2);
check('jsonc: escaped quote in string', parseJsonc('{"q": "say \\"hi\\" // not a comment"}').q === 'say "hi" // not a comment');
check('jsonc: broken file throws', throws(() => parseJsonc('{"a": 1')));
check('settings: missing exemptLabel defaults to spec-exempt', withDefaults({}).exemptLabel === 'spec-exempt');
check('settings: empty exemptLabel defaults to spec-exempt', withDefaults({ exemptLabel: '' }).exemptLabel === 'spec-exempt');
check('settings: wrong type throws', throws(() => withDefaults({ ignorePaths: 'docs/**' })));
check('settings: unknown mode throws', throws(() => withDefaults({ mode: 'off' })));
check('settings: requireLinkedChangeTouched defaults to false', withDefaults({}).requireLinkedChangeTouched === false);
check('settings: requireLinkedChangeTouched must be true or false', throws(() => withDefaults({ requireLinkedChangeTouched: 'yes' })));

// Globs (using the shipped defaults)
const always = matcher(cfg.alwaysNeedsSpec), review = matcher(cfg.alwaysReview), ignored = matcher(cfg.ignorePaths), test = matcher(cfg.testPaths);
check('glob: case-insensitive (src/Billing/Invoice.js)', always('src/Billing/Invoice.js'));
check('glob: unclosed { is literal and does not hang', globToRegex('src/{weird/**').test('src/{weird/x.js'));
check('glob: db/migrate/ needs a spec', always('db/migrate/20261113_add.rb'));
for (const p of ['src/oauth/x.ts', 'lib/authz/policy.go', 'app/sso/saml.py', 'svc/authentication/a.js', '.gitattributes', 'sub/.gitattributes', '.gitmodules'])
  check(`glob: ${p} needs a spec`, always(p));
for (const p of ['web/session/store.js', 'src/ui/sessions/list.tsx'])
  check(`glob: ${p} does not need a spec (session dropped from defaults)`, !always(p));
for (const p of ['CLAUDE.md', 'pkg/CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.agents/skills/x/SKILL.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'src/prompts/system.txt'])
  check(`glob: ${p} is in alwaysReview, not alwaysNeedsSpec`, review(p) && !always(p));
for (const p of ['.mcp.json', '.vscode/settings.json', '.devcontainer/devcontainer.json', '.husky/pre-commit'])
  check(`glob: ${p} is in alwaysReview`, review(p));
for (const p of ['logo.png', 'web/img/a.JPG', 'fonts/x.woff2', 'docs/spec.pdf', 'bun.lockb', 'media/clip.mov'])
  check(`glob: ${p} is ignored`, ignored(p));
for (const p of ['Cargo.lock', 'api/poetry.lock', 'Pipfile.lock', 'Gemfile.lock', 'go.sum', 'composer.lock', 'packages.lock.json', 'pubspec.lock', 'mix.lock'])
  check(`glob: ${p} is ignored`, ignored(p));
check('glob: root dist/ ignored', ignored('dist/app.js'));
check('glob: nested src/dist/ not ignored', !ignored('src/dist/app.js'));
check('glob: nested src/vendor/ not ignored', !ignored('src/vendor/lib.js'));
check('glob: docs/ markdown ignored', ignored('docs/guide.md'));
check('glob: root README.md ignored', ignored('README.md'));
check('glob: markdown anywhere ignored (src/app/notes.md)', ignored('src/app/notes.md'));
check('glob: markdown in a money path still needs a spec', always('src/billing/README.md'));
check('glob: test file recognised', test('src/app/report.test.js'));
check('glob: root spec/ (RSpec) is tests', test('spec/models/user_spec.rb'));
check('glob: src/api/spec/openapi-handlers.js is code', !test('src/api/spec/openapi-handlers.js'));
check('glob: src/api/spec/handlers.spec.ts is a test', test('src/api/spec/handlers.spec.ts'));
check('glob: a newline in a file name does not evade a pattern', always('src/billing/a\n::error::x.js'));

// Placeholders and values
for (const v of ['XXX', 'TBD', 'todo', 'TODO', 'N/A', 'later', 'none', 'no', '-', '<ticket>', '<goal>', 'TBD - ask finance', 'TODO: fill in', 'FIN-XXX', 'See Slack', 'see the thread', '<!-- fill me -->', ''])
  check(`value "${v}" counts as empty`, !isFilled(v));
for (const v of ['FIN-482', 'TODO-123', 'Let users share a todo list', 'Fix the TBD flag in exports', '<https://tracker.example/FIN-482>', '`src/a.test.js` > adds totals', 'ledger total equals CSV total'])
  check(`value "${v}" counts as filled`, isFilled(v));
for (const v of ['no', 'None yet', 'N/A (no money)', 'not applicable', 'Nope', 'n/a'])
  check(`separate calculation "${v}" does not count`, !isRealCalc(v));
for (const v of ['ledger total equals CSV total', 'normalised balance recomputed from events'])
  check(`separate calculation "${v}" counts`, isRealCalc(v));

// Line endings and comments
check('lf: U+2028, U+2029 and NEL become newlines', lf('a\u2028b\u2029c\u0085d\r\ne').split('\n').length === 5);
check('noComments: removes comments, unclosed runs to end', noComments('a<!-- x -->b<!-- y') === 'ab');
check('noComments: linear on many unclosed openers', (() => { const t = Date.now(); noComments('<!--'.repeat(200000)); return Date.now() - t < 500; })());

// Fields
check('field: "- **Goal:** G-1 - x" bullet', field(['- **Goal:** G-1 - Grow'], 'Goal') === 'G-1 - Grow');
check('field: "**Goal**: G-1 - x"', field(['**Goal**: G-1 - Grow'], 'Goal') === 'G-1 - Grow');
check('field: long line with no colon returns fast', (() => { const t = Date.now(); field(['Goal ' + ' '.repeat(50000) + 'x'], 'Goal'); return Date.now() - t < 200; })());
check('goals file: placeholder lines are not IDs', goalIds('- G-1: <company goal>\n- G-2: Real goal', '[A-Z][A-Z0-9]*-[0-9]+').size === 1);

// Body lines
const names = changeNamesInBody('Change: a-one\n**Change:** `b-two`\n- Change: c-three\n* **Change:** d-four');
check('body: Change line variants (plain, bold, backticks, bullets)', names.join(',') === 'a-one,b-two,c-three,d-four');
check('body: Spec-exempt bullet with bold', exemptReasonInBody('- **Spec-exempt:** generated client, no behaviour change') === 'generated client, no behaviour change');

// Tables by header name
const t = table(['| Test that proves it | Separate calculation | Scenario |', '|---|---|---|', '| `a.test.js` > x | n/a | Export |']);
check('table: columns found by header, any order', t.rows[0][t.col(/scenario/)] === 'Export' && t.col(/test/, t.col(/scenario/)) === 0);

if (failed) { console.log(`${failed} unit check(s) failed`); process.exit(1); }
console.log('all unit checks passed');
