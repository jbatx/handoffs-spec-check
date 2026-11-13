# Changelog

## 0.1.0 (unreleased)

First version, tested against OpenSpec 2.0.0.

- `handoffs` schema forked from OpenSpec's `spec-driven`: the proposal names a Goal (ID and one line), a Ticket and the Files at Risk with a readiness color; a separate `verification.md` maps every scenario to the test that proves it, with a separate calculation for money.
- Pull request spec check as a composite GitHub Action: decides whether a pull request is bigger than small from line count (renames detected), sensitive paths, services, binary files over 1 MB and submodules; lists agent instruction changes for the code owner without failing; requires an OpenSpec change, modified in the pull request or already active on the base branch, that passes `openspec validate --strict` and has the handoff fields filled in; supports a `spec-exempt` label with a required reason.
- Warn mode by default. Block mode takes effect only with a recorded approval in the settings.
- Settings and goals read from the base branch; the base settings fail closed if they cannot be parsed.
- OpenSpec installed from a committed lockfile with scripts off; telemetry off.
- `install.sh`, which never overwrites existing files.
- Test suite with unit checks and simulated pull requests, and a self-test workflow.

- small doc note
