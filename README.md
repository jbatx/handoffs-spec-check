# OpenSpec handoffs kit

An add-on for [OpenSpec](https://github.com/Fission-AI/OpenSpec) that covers two handoffs where the gains from AI coding tend to leak:

- **Intent.** Every spec'd change names the company goal it serves (by ID) and its ticket.
- **Review.** Every scenario names the test that proves it, and the change lists the files and modules at risk.

It has two parts: an OpenSpec schema called `handoffs`, and a pull request check that warns when a large change has no spec. Everything installs into your repository. Nothing runs on anyone else's servers except your own GitHub Actions runner.

## What it does

**The `handoffs` schema** is a fork of OpenSpec's built-in `spec-driven` schema. Its flow is proposal, then specs and design, then verification, then tasks.

| File | Section | What goes in it |
|---|---|---|
| proposal.md | Goal | `**Goal:** G-101 - one line`. The ID comes from `openspec/goals.md`. |
| proposal.md | Ticket | `**Ticket:** FIN-482` (ID or URL). |
| proposal.md | Files at Risk | A table of paths or modules, each with a readiness of red, yellow or green. |
| verification.md | (whole file) | A table with one row per scenario in the specs: the test that proves it, and, for money or balances, a separate calculation that checks the number another way. |

`verification.md` is its own artifact. It requires the specs, so it is written once the scenarios exist, and tasks require it, so every test it names gets a task. Specs and design work as in `spec-driven`.

**The spec check** runs on each pull request. It:

1. Measures the diff against the base branch, leaving out tests and ignored paths (lockfiles, docs, `openspec/`).
2. Decides whether the change is bigger than small. Any one of these makes it so: more non-test lines than your threshold; any change under a path that always needs a spec (money, login, permissions, migrations by default); or more than one service touched.
3. If it is, looks for a linked change: a folder `openspec/changes/<name>/` in the diff, or a line `Change: <name>` in the pull request description.
4. Runs `openspec validate <name> --strict` on each linked change, then checks the proposal has a real Goal (and that its ID is in your goals file), a Ticket, at least one Files at Risk row with a valid color, and a `verification.md` with a row naming a test for every scenario. When the pull request touches money paths, at least one separate calculation must be named.
5. Accepts a `spec-exempt` label, but only with a line `Spec-exempt: <reason>` in the description.
6. Writes a plain summary to the job log and the run summary.

## What it does not do

- **It checks form, not truth.** It confirms the Goal, Ticket, Files at Risk and verification.md are filled in and the spec validates. It cannot tell whether the goal is the right one, the risk colors are honest, or the named tests exist and prove anything. Review does that.
- **It does not run your tests** or read test files.
- **It does not replace OpenSpec's own verify step.** The `/openspec-verify-change` skill (an agent workflow, not a CLI command, and not in OpenSpec's default `core` profile) describes itself as advisory. This kit leaves it that way.
- **It does not make anything a rule on its own.** It ships in warn mode, and blocking needs a recorded approval (below).

## Install

Requires Node.js 22.12 or newer and git.

1. Install OpenSpec at the pinned version and turn telemetry off:
   ```bash
   npm install --save-dev --save-exact @fission-ai/openspec@2.0.0
   npx openspec config set telemetry.enabled false
   npx openspec init
   ```
2. Copy the kit into the repository. It never overwrites a file; it lists any that already exist so you can merge them by hand (usually `openspec/config.yaml`):
   ```bash
   ./install.sh /path/to/your-repo
   ```
3. Fill in `openspec/goals.md` with real goal IDs, one per line (`- G-101: one line`).
4. Merge `.github/CODEOWNERS.example` into `.github/CODEOWNERS` with the CTO's handle, and turn on "Require review from Code Owners" for the default branch.
5. Open a pull request with these files for the CTO to approve. On that first pull request the settings are not on the base branch yet, so the check uses the pull request's own copy and says so. After it merges, settings come from the base branch.

Then check the schema: `npx openspec schema validate handoffs`.

### Files it adds

```
.github/spec-check.jsonc                 settings (thresholds, paths, mode)
.github/actions/spec-check/action.yml    composite action: installs pinned OpenSpec, runs the check
.github/actions/spec-check/spec-check.mjs  the check (Node, no dependencies)
.github/workflows/spec-check.yml         runs the action on pull requests
.github/CODEOWNERS.example               who approves changes to the above
openspec/config.yaml                     schema: handoffs, plus context and rules for the AI
openspec/goals.md                        company goals and their IDs
openspec/schemas/handoffs/               the schema and its templates
```

## Configure

Everything is in `.github/spec-check.jsonc`. The team sets the thresholds; the defaults are a starting point only.

| Setting | Default | Meaning |
|---|---|---|
| `thresholds.nonTestLinesChanged` | 400 | Lines added plus deleted, excluding tests and ignored paths |
| `thresholds.servicesTouched` | 2 | Distinct services touched, using the `services` patterns |
| `alwaysNeedsSpec` | billing, payments, ledger, auth, login, permissions, rbac, migrations, `*.sql` | Any non-test change here needs a spec |
| `moneyPaths` | billing, payments, ledger | Touching these requires a separate calculation in verification.md |
| `testPaths`, `ignorePaths` | common test and lockfile patterns | Left out of the size count |
| `goals.file` | `openspec/goals.md` | Set to `""` to skip the ID lookup |
| `ticketPattern` | none | Optional regular expression for the Ticket value |
| `exemptLabel` | `spec-exempt` | Needs a `Spec-exempt: <reason>` line too |

`openspec/config.yaml` holds context and rules that OpenSpec adds to the AI's instructions when it writes a proposal, spec or tasks. They guide the writing; they enforce nothing. The readiness color meanings in it are placeholders for the team to replace.

### Who can change the settings

The check reads `.github/spec-check.jsonc` and `openspec/goals.md` from the pull request's base branch, so a pull request cannot loosen its own check or add its own goal. A change to them takes effect after it merges. The workflow and the script run from the pull request's own copy (GitHub runs pull request workflows that way), so CODEOWNERS review on `.github/` is what protects them. Use it.

## Warn and block

- **`"mode": "warn"`** (the default). A flagged pull request gets a warning and a summary. The check never fails.
- **`"mode": "block"`**. A flagged pull request fails the check. This only takes effect when `blockingApproval.approvedBy` and `approvedOn` are filled in; otherwise the check keeps warning and says why. Combined with CODEOWNERS, blocking cannot be switched on without the CTO's approval on record.

To make the check required, add it as a required status check in branch protection after the team has run it in warn mode long enough to trust the thresholds.

If the checker itself breaks (missing config, git error), it warns in warn mode and fails only in approved block mode.

## Telemetry and version pin

OpenSpec collects anonymous usage statistics unless told not to. The action sets `OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1` and `OPENSPEC_NO_UPDATE_CHECK=1` on every call, and OpenSpec also turns telemetry off when `CI` is set. On developer machines, run `openspec config set telemetry.enabled false` or set `OPENSPEC_TELEMETRY=0`.

The kit is tested against **OpenSpec 2.0.0** (released 2026-11-11). The action installs exactly that version (`openspec-version` input). OpenSpec 2.0 replaced the `/opsx:*` commands with skills (`/openspec-propose` and so on); this kit does not depend on either. Before moving to a new OpenSpec version, run `npm test` in this kit: it rebuilds a throwaway repository and runs every case. A schema fork is a snapshot, so improvements to OpenSpec's built-in schema do not reach `handoffs` until someone ports them.

The GitHub Actions it uses are pinned to commit SHAs (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0).

## Tests

```bash
npm install
npm test
```

This creates `test-repo/`, simulates pull requests as branches, runs the check with the pull request details passed as environment variables (and once through a GitHub event file), and writes each output to `test/results/`. `test/results/SUMMARY.txt` lists expected and actual results, and the script exits non-zero on any mismatch.

When this folder is its own repository, `.github/workflows/self-test.yml` runs the same tests on every push and pull request. On pull requests it also runs the kit's composite action against the repository itself, in warn mode, so the action is exercised end to end without ever failing the build.

## Credit and license

Built on [OpenSpec](https://github.com/Fission-AI/OpenSpec) by the OpenSpec Contributors (MIT). The `handoffs` schema is derived from OpenSpec's `spec-driven` schema; its notice is in `kit/openspec/schemas/handoffs/LICENSE-openspec.txt`. This kit is not affiliated with or endorsed by the OpenSpec project.

MIT License. See `LICENSE`.
