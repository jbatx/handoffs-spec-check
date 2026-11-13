# handoffs-spec-check

When AI writes more of the code, two handoffs decide whether that speed turns into results:

- **Intent**: the work starts from a company goal. Every change that gets a spec names the goal it serves, by ID, and the ticket it came from.
- **Review**: the reviewer can see what proves the change and what it could break. Every scenario in the spec names the test that proves it, and the change lists the files and modules at risk.

handoffs-spec-check helps with both. It is an independent add-on for [OpenSpec](https://github.com/Fission-AI/OpenSpec), the open-source spec tool by the OpenSpec Contributors. It is not affiliated with or endorsed by the OpenSpec project.

Everything installs into your repository and runs in your own CI; the check makes no external API calls. When the GitHub Action runs, it downloads Node.js and the pinned OpenSpec packages from npm.

## What it does

It has two parts.

**1. An OpenSpec schema called `handoffs`.** It is a fork of OpenSpec's built-in `spec-driven` schema. Its flow is proposal, then specs and design, then verification, then tasks.

| File | Section | What goes in it |
|---|---|---|
| proposal.md | Goal | `**Goal:** G-101 - one line`. The ID comes from `openspec/goals.md`. |
| proposal.md | Ticket | `**Ticket:** FIN-482`, an ID or a link. |
| proposal.md | Files at Risk | A table of paths or modules, each with a readiness of red, yellow or green. |
| verification.md | (whole file) | One row per scenario in the specs: the test that proves it and, for money or balances, a separate calculation that checks the number another way. |

`verification.md` requires the specs, so it is written once the scenarios exist. Tasks require it, so every test it names gets a task.

**2. A pull request check.** On each pull request it:

1. Diffs the pull request against the merge base with the base branch. The repository's `.gitattributes` is not used for the diff, so marking files `-diff` or `binary` does not hide their lines. A file git treats as binary anyway (one NUL byte is enough) outside test and ignored paths is checked by size first. Up to 1 MB, it is counted by its newlines when it has a source-code extension (`.js`, `.vue`, `.py`, `.go` and similar) or is mostly text (under 5% control bytes in its first 64 KB); other binaries, such as images or `.wasm`, are not counted. A source file treated as binary always counts as bigger than small. Files under `ignorePaths`, including all markdown such as `src/**/*.md`, are not counted at all.
   - **Renames** are detected, so a pure rename counts as zero lines. A file moved out of a test or ignored path into code counts in full. Both the old and the new path are checked against `alwaysNeedsSpec` and `moneyPaths`, so a move out of a sensitive folder still counts.
2. Decides whether the change is bigger than small. Any one of these makes it so:
   - non-test lines changed at or above your threshold (400 by default);
   - any file under a path that always needs a spec (money, login, permissions, migrations, `.gitattributes` and `.gitmodules` by default, tests included);
   - files in at least as many services as your threshold (2 by default);
   - **a binary file over 1 MB** that is not under `testPaths` or `ignorePaths`. Common images, fonts, media, PDFs and `bun.lockb` are ignored by default, and binary test fixtures fall under `testPaths`;
   - any submodule change.
3. Lists agent and editor configuration (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agents/`, `.cursor/`, `.github/copilot-instructions.md`, `prompts/`, `.mcp.json`, `.vscode/`, `.devcontainer/`, `.husky/`) for the reviewer as "agent instructions changed; code owner should review". These never fail a pull request on their own, and their lines still count toward size. Some of these files can run commands on a developer's machine, so CODEOWNERS review is the real control for them; `kit/.github/CODEOWNERS.example` covers them.
4. Looks for the OpenSpec change behind the work: a change folder, `openspec/changes/<name>/`, modified in this pull request, or a `Change: <name>` line in the description naming an active change already on the base branch (write the spec first, ship the code later). A name that does not exist, or names an archived change, is flagged. When a change existed before this pull request and its proposal and specs were not touched, the reviewer gets a note: "existing change, created before this PR". When a large pull request passes only because it names such a change, the headline says so: "PASSED (linked by name to existing change: X)". Set `requireLinkedChangeTouched` to `true` to flag that case instead.
5. For each change: runs `openspec validate <name> --type change --strict`, then checks the proposal has a Goal whose ID is in your goals file, a Ticket, and at least one Files at Risk row with a valid color, and that `verification.md` has a row naming a test for every scenario. When the pull request touches money paths, `verification.md` must name at least one separate calculation. A change marked `skip_specs: true` is flagged when the pull request is bigger than small.
6. Accepts the `spec-exempt` label instead of a spec, but only with a line `Spec-exempt: <reason>` in the description.
7. Writes a summary to the job log and the run summary.

A value counts as unfilled when the whole value is a stub such as `TODO`, `TBD`, `XXX`, `N/A`, `later` or `none`, when it starts with an upper-case marker followed by a space or colon (`TBD - ask finance`), when it is an ID stub like `FIN-XXX`, a `<placeholder>` or "see Slack". Ordinary words are fine: "share a todo list" and the ticket `TODO-123` both count as filled.

## What it can't stop

- **It checks form, not truth.** It confirms the Goal, Ticket, Files at Risk and verification table are filled in and the spec validates. Someone can fill every field with something plausible and wrong.
- **It does not check that named tests exist or pass.** A test name in `verification.md` is text. Your test suite and your reviewers decide whether it is real.
- **It cannot judge the goal, the risk colors or the separate calculation.** Code review must hold people to honest answers.
- **Changes can be copied or reused.** A pull request can name any active change already on the base branch, or copy another change's files into a new folder, and the check will accept it if the form is right. The "existing change" note helps, but a reviewer has to confirm the change actually describes this work.
- **The exemption label is a trust decision.** Anyone who can add labels can add `spec-exempt`, including the pull request's own author. The summary records the label, the reason and who triggered the run; a reviewer must confirm the reason.
- **Agent and editor configuration is only listed.** A change to `CLAUDE.md`, `.mcp.json` or a git hook never fails the check; CODEOWNERS review is what stops a harmful one.
- **The script and workflow run from the pull request's own copy**, because GitHub runs pull request workflows that way. Settings and goals are read from the base branch, but only CODEOWNERS review stops someone editing the check itself. See [SECURITY.md](SECURITY.md).

It also leaves OpenSpec's verify workflow (`/openspec-verify-change`) as it is. That workflow is not in OpenSpec 2.0.0's default `core` profile (propose, explore, apply, update, sync, archive); add it with `openspec config profile`. Its own instructions describe it as advisory.

## Install

Requires Node.js 22.12 or newer and git 2.40 or newer (for `--attr-source`). The action installs Node.js; GitHub's hosted Ubuntu runners ship a newer git.

1. Install OpenSpec at the pinned version, turn telemetry off and set up the project:
   ```bash
   npm install --save-dev --save-exact @fission-ai/openspec@2.0.0
   npx openspec config set telemetry.enabled false
   npx openspec init
   ```
2. Copy the files in. The script never overwrites a file, or a symlink, that already exists; it lists them so you can merge by hand (usually `openspec/config.yaml`):
   ```bash
   ./install.sh /path/to/your-repo
   npx openspec schema validate handoffs
   ```
3. **Replace the placeholder goals in `openspec/goals.md`** with real goal IDs, one per line (`- G-101: one line`). Lines that still hold a `<placeholder>` do not count as goals.
4. **Set the readiness color meanings** in `openspec/config.yaml`. The ones shipped are examples for the team to replace.
5. Merge `.github/CODEOWNERS.example` into `.github/CODEOWNERS` with the CTO's handle. In branch protection for the default branch, turn on: require a pull request, require review from Code Owners, dismiss stale pull request approvals when new commits are pushed, and require approval of the most recent reviewable push.
6. In this first pull request only, add `with: bootstrap: 'true'` to the `uses: ./.github/actions/spec-check` step, because the base branch has no settings yet. Remove it before merging. Without it the first pull request is flagged with "not on the base branch", which is expected.

### Files it adds

```
.github/spec-check.jsonc                    settings: thresholds, paths, mode
.github/actions/spec-check/action.yml       composite action
.github/actions/spec-check/spec-check.mjs   the check (Node, no dependencies)
.github/actions/spec-check/openspec/        package.json and package-lock.json pinning OpenSpec
.github/workflows/spec-check.yml            runs the action on pull requests
.github/CODEOWNERS.example                  who approves changes to all of the above
openspec/config.yaml                        schema: handoffs, plus context and rules for the AI
openspec/goals.md                           company goals and their IDs (placeholders)
openspec/schemas/handoffs/                  the schema, its templates and OpenSpec's license notice
```

## Configure

Everything is in `.github/spec-check.jsonc`. It accepts comments and trailing commas. The team sets the thresholds; the defaults are a starting point.

| Setting | Default | Meaning |
|---|---|---|
| `thresholds.nonTestLinesChanged` | 400 | A pull request at or above this many lines added plus deleted, excluding tests and ignored paths, needs a spec |
| `thresholds.servicesTouched` | 2 | A pull request touching at least this many services needs a spec |
| `thresholds.binaryBytes` | 1048576 (1 MB) | A binary file larger than this, outside `testPaths` and `ignorePaths`, needs a spec |
| `alwaysNeedsSpec` | billing, payments, ledger, auth, authentication, authz, oauth, sso, login, permissions, rbac, migrations, migrate, `*.sql`, `.gitattributes`, `.gitmodules` | Any change here needs a spec, including test and markdown files |
| `alwaysReview` | `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agents/`, `.cursor/`, `.github/copilot-instructions.md`, `prompts/`, `.mcp.json`, `.vscode/`, `.devcontainer/`, `.husky/` | Never fails; always listed for the code owner; counts toward size |
| `requireLinkedChangeTouched` | `false` | When `true`, a large pull request that only names an existing change, without touching it, is flagged |
| `moneyPaths` | billing, payments, ledger | Touching these requires a separate calculation in `verification.md`. Values starting with no, none, n/a, not applicable or nope do not count |
| `testPaths` | `test/`, `tests/`, `__tests__/`, a root `spec/` (RSpec), and files named `*.test.*`, `*.spec.*`, `*_spec.rb`, `*_test.go`, `test_*.py`, `*_test.py` | Left out of the line count. A `spec/` folder deeper in the tree counts as code unless its files are named like tests |
| `ignorePaths` | `openspec/`, `docs/`, root `dist/` and `vendor/`, all `*.md`, lockfiles including `bun.lockb`, snapshots, common images, fonts, media and PDFs | Left out of the line count |
| `goals.file` | `openspec/goals.md` | Set to `""` to skip the ID lookup |
| `ticketPattern` | none | Optional regular expression for the Ticket value |
| `exemptLabel` | `spec-exempt` | Used when the setting is missing or empty |

Path patterns ignore case. `**/x/**` matches at any depth, `x/**` and `/x` match from the repository root, and a pattern with no `/` matches a file name at any depth. `alwaysNeedsSpec` wins over `testPaths` and `ignorePaths`. Files under `openspec/changes/` and `openspec/specs/` are the specs themselves and never count as code. A symlink is judged by its own path, so a link under an ignored path is ignored even if it points at code; edits to the target file still count under the target's own path.

`openspec/config.yaml` holds context and rules that OpenSpec adds to the AI's instructions when it writes a proposal, spec, verification or tasks. They guide the writing and enforce nothing.

### Where settings come from

The check reads `.github/spec-check.jsonc` and `openspec/goals.md` from the pull request's base branch, so a pull request cannot loosen its own check or add its own goal. A change to either takes effect after it merges. If the base copy of the settings will not parse, the check fails in any mode until someone fixes it on the base branch. When the base branch has no settings yet, the check flags the pull request unless `bootstrap: true` is set; with or without bootstrap, if the pull request's own copy will not parse, the check fails. If bootstrap is left on after the settings reach the base branch, it is ignored and the summary asks you to remove it.

## Warn and block

- **`"mode": "warn"`** (the default). A pull request without the spec it needs gets a warning and a summary, and the check passes.
- **`"mode": "block"`**. A flagged pull request fails the check. This only takes effect when `blockingApproval.approvedBy` and `approvedOn` are filled in; otherwise the check keeps warning and says why. With CODEOWNERS on the settings file, blocking cannot be switched on without the CTO's approval on record.

Warn mode can still fail the job: when the base settings file will not parse, when Node.js or the OpenSpec packages cannot be installed, when GitHub itself fails the step, and when the base branch has no settings while the pull request's own copy turns on approved block mode. If the check script hits any other error, it warns in warn mode and fails only in approved block mode.

To make the check required, add it as a required status check in branch protection once the team has run it in warn mode long enough to trust the thresholds.

## Telemetry and version pin

OpenSpec collects anonymous usage statistics unless told not to. The action sets `OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1` and `OPENSPEC_NO_UPDATE_CHECK=1` on every call, and OpenSpec also turns telemetry off when `CI` is set. On developer machines, run `openspec config set telemetry.enabled false` or set `OPENSPEC_TELEMETRY=0`.

This add-on is tested against [OpenSpec 2.0.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v2.0.0). The action installs it with `npm ci --ignore-scripts` from `.github/actions/spec-check/openspec/package-lock.json`, so the version and every dependency are fixed. To move to a newer OpenSpec, update that lockfile and run the tests below. A schema fork is a snapshot: improvements to OpenSpec's built-in schema reach `handoffs` only when someone ports them.

The GitHub Actions it uses are pinned to commit SHAs (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0 with its package cache off).

## Tests

```bash
npm ci
npm test
```

This runs the unit checks in `test/unit.mjs`, confirms the OpenSpec pin matches the action's lockfile, builds a throwaway repository in `test-repo/`, simulates pull requests as branches and runs the check on each. Outputs go to `test/results/` (not committed), with expected and actual results in `test/results/SUMMARY.txt`. The script exits non-zero on any mismatch.

`.github/workflows/self-test.yml` runs the same tests on every push and pull request. On pull requests it also runs the composite action against this repository in warn mode, so the action is exercised end to end.

## Contributing, security, changes

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## Credit and license

Built on [OpenSpec](https://github.com/Fission-AI/OpenSpec) by the OpenSpec Contributors, MIT License. The `handoffs` schema is derived from OpenSpec's `spec-driven` schema; its notice is in `kit/openspec/schemas/handoffs/LICENSE-openspec.txt`.

handoffs-spec-check is released under the MIT License. See [LICENSE](LICENSE).
