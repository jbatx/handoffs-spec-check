# Security

## Reporting a problem

Please report security problems privately through GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability"). Do not open a public issue for them. We aim to reply within five working days.


## Threat model

The check exists to stop a pull request from skipping the spec it needs. The main attacker is **a pull request trying to loosen its own check**. What the check does about that:

- **Settings and goals come from the base branch.** A pull request cannot change thresholds, paths, mode or goals for itself. If the base settings will not parse, the check fails in any mode.
- **Line counts ignore `.gitattributes`.** The diff reads attributes from an empty tree, so `* -diff` or `binary` in a pull request cannot hide lines. A file that git still treats as binary because it contains a NUL byte is counted by its newlines, and a source file treated that way always needs a spec. Submodule changes, and binary files over 1 MB outside test and ignored paths, count as bigger than small. `.gitattributes` and `.gitmodules` always need a spec.
- **Renames count both paths**, so moving a file out of a sensitive folder still counts as touching it.
- **Sensitive paths win over test and ignore paths**, so naming a file like a test does not exempt it.
- **A `Change:` line in the description must name a change modified in the same pull request or an active change already on the base branch.** Names that do not exist or are archived are flagged, and a reused change gets a reviewer note. A pull request can still name an unrelated existing change; a reviewer has to catch that.
- **Untrusted text is contained.** The pull request body, labels and file paths are read from the event file, never interpolated into a shell. Output is printed between `::stop-commands::` markers, and control characters are removed from paths and names, so file names cannot inject workflow commands. Files over 256 KB are not read.
- **The job has read-only permissions** and does not persist checkout credentials.

What the check cannot do, and what covers it instead:

- **The workflow and script run from the pull request's own copy.** GitHub runs `pull_request` workflows that way. A pull request that edits `.github/` can change the check. CODEOWNERS on `/.github/` with required Code Owner review, dismissal of stale approvals and approval of the most recent push is the control. See `kit/.github/CODEOWNERS.example`.
- **Agent and editor configuration** (`.mcp.json`, `.vscode/`, `.devcontainer/`, `.husky/`, `.claude/`, `CLAUDE.md` and similar) can run commands on developer machines. The check only lists these changes for review; CODEOWNERS is the control.
- **The exemption label.** Anyone with permission to add labels can add it, including the author. The summary records the label, the reason and who triggered the run, and a reviewer must confirm the reason.
- **Form, not truth.** The check cannot tell whether a goal, ticket, risk color or test name is honest.

## Third-party code

- **OpenSpec** (`@fission-ai/openspec`, MIT) and its dependencies are installed with `npm ci --ignore-scripts` from a committed lockfile, so versions and integrity hashes are fixed and install scripts do not run. OpenSpec telemetry and its update check are turned off by environment variables.
- **GitHub Actions** `actions/checkout` and `actions/setup-node` are pinned to commit SHAs, and setup-node's package cache is off.
- The check script itself uses only Node's standard library.
