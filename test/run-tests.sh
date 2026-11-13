#!/usr/bin/env bash
# Builds a throwaway repo (../test-repo), installs the kit with the pinned
# OpenSpec, simulates pull requests as branches, runs the check on each and
# records the output in test/results/. Run from anywhere.
set -uo pipefail

export OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 OPENSPEC_NO_UPDATE_CHECK=1 OPENSPEC_NO_COMPLETIONS=1 OPENSPEC_NO_ANIMATION=1
unset GITHUB_ACTIONS GITHUB_EVENT_PATH GITHUB_STEP_SUMMARY CI

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$root/test-repo"
results="$root/test/results"
OS="$root/node_modules/.bin/openspec"
CHECK="$root/kit/.github/actions/spec-check/spec-check.mjs"
export OPENSPEC_BIN="$OS"

rm -rf "$repo" "$results"; mkdir -p "$repo" "$results"
cd "$repo"
git init -q -b main
git config user.email "kit-test@example.invalid"; git config user.name "Kit Test"; git config commit.gpgsign false
git commit -q --allow-empty -m "before the kit" && git tag pre-kit

# ---------- base branch: OpenSpec + kit ----------
"$OS" init --tools claude --no-animation . > "$results/00-openspec-init.txt" 2>&1
rm openspec/config.yaml   # use the kit's config.yaml (schema: handoffs)
"$root/install.sh" "$repo" > "$results/00-install.txt" 2>&1
cat > openspec/goals.md <<'EOF'
# Company goals

- G-101: Cut time from signup to first invoice to under one day
- G-102: Keep monthly billing errors at zero
EOF
{ echo "== openspec schema validate handoffs"; "$OS" schema validate handoffs 2>&1; echo "== openspec schema which handoffs"; "$OS" schema which handoffs 2>&1; } > "$results/00-schema.txt"
mkdir -p src/app src/billing services/api services/web
printf 'export const add = (a, b) => a + b;\n' > src/app/util.js
printf 'export const total = (items) => items.reduce((s, i) => s + i, 0);\n' > src/billing/invoice.js
printf 'export const ping = () => "ok";\n' > services/api/index.js
printf 'export const ping = () => "ok";\n' > services/web/index.js
git add -A && git commit -qm "base: OpenSpec 2.0.0 + handoffs kit"

# Base variants for block mode
git checkout -q -b main-block-unapproved
sed -i.bak 's/"mode": "warn"/"mode": "block"/' .github/spec-check.jsonc && rm .github/spec-check.jsonc.bak
git commit -qam "turn on block mode without approval"
git checkout -q -b main-block
sed -i.bak 's/"approvedBy": "", "approvedOn": ""/"approvedBy": "CTO (test)", "approvedOn": "2026-11-13"/' .github/spec-check.jsonc && rm .github/spec-check.jsonc.bak
git commit -qam "CTO approves block mode"
git checkout -q main

# ---------- helpers ----------
lines() { # lines <file> <count>: write <count> lines of real JS
  local f="$1" n="$2"; mkdir -p "$(dirname "$f")"; : > "$f"
  for i in $(seq 1 "$n"); do echo "export const v$i = $i * 2;" >> "$f"; done
}
spec_change() { # spec_change <name> <goal-line|""> <calc> [no-verification]
  local name="$1" goal="$2" calc="$3" d="openspec/changes/$1"
  "$OS" new change "$name" --schema handoffs > /dev/null
  mkdir -p "$d/specs/report-export"
  cat > "$d/specs/report-export/spec.md" <<'EOF'
# Spec Delta

## Purpose

Lets finance export the monthly revenue report as CSV for reconciliation.

## ADDED Requirements

### Requirement: Revenue report exports as CSV
The system SHALL export the monthly revenue report as a CSV file.

#### Scenario: Export a month with invoices
- **WHEN** a finance user exports a month that has invoices
- **THEN** the CSV has one row per invoice and a total row

#### Scenario: Export an empty month
- **WHEN** a finance user exports a month with no invoices
- **THEN** the CSV has only the header and a zero total
EOF
  { echo "# Proposal"; echo
    if [ -n "$goal" ]; then echo "## Goal"; echo; echo "**Goal:** $goal"; echo; fi
    cat <<EOF
## Ticket

**Ticket:** FIN-482

## Why

Finance rebuilds the monthly revenue report by hand, and it takes two days.

## What Changes

- Add CSV export of the monthly revenue report.

## Capabilities

### New Capabilities
- \`report-export\`: export of the monthly revenue report

## Files at Risk

| Path or module | Readiness | Why it is at risk |
|---|---|---|
| \`src/app/report.js\` | yellow | new code, partial tests |
| \`src/billing/\` | red | totals feed invoices |
EOF
  } > "$d/proposal.md"
  [ "${4:-}" = "no-verification" ] && return 0
  cat > "$d/verification.md" <<EOF
# Verification

| Scenario | Test that proves it | Separate calculation |
|---|---|---|
| Export a month with invoices | \`src/app/report.test.js\` > exports one row per invoice | $calc |
| Export an empty month | \`src/app/report.test.js\` > exports header and zero total | n/a |
EOF
}
pr() { # pr <branch>: start a simulated PR branch from main
  git checkout -q main && git checkout -q -b "$1"
}
run_case() { # run_case <id> <expect-status> <expect-exit> <base> <labels> <body> [extra env...]
  local id="$1" want="$2" wantexit="$3" base="$4" labels="$5" body="$6"; shift 6
  local out="$results/$id.txt"
  { echo "# case: $id"; echo "# base: $base   head: $(git rev-parse --abbrev-ref HEAD)   labels: [$labels]"; echo "# PR body: ${body:-<empty>}"; echo; } > "$out"
  env SPEC_CHECK_BASE="$base" SPEC_CHECK_HEAD=HEAD SPEC_CHECK_LABELS="$labels" SPEC_CHECK_PR_BODY="$body" "$@" \
    node "$CHECK" --repo "$repo" >> "$out" 2>&1
  local code=$?
  local got; got=$(grep -q "^Spec check: PASSED" "$out" && echo pass || (grep -q "^Spec check: FLAGGED" "$out" && echo flag || echo error))
  echo "# exit code: $code" >> "$out"
  local verdict=OK; { [ "$got" = "$want" ] && [ "$code" = "$wantexit" ]; } || verdict=MISMATCH
  printf '%-40s expect %-4s exit %s | got %-5s exit %s  %s\n' "$id" "$want" "$wantexit" "$got" "$code" "$verdict" | tee -a "$results/SUMMARY.txt"
}

# ---------- cases ----------
pr pr-small;            lines src/app/util.js 20; git add -A; git commit -qm small
run_case 01-small-change-passes            pass 0 main "" ""

pr pr-large-nospec;     lines src/app/report.js 450; git add -A; git commit -qm large
run_case 02-large-no-spec-warns            flag 0 main "" ""
run_case 03-large-no-spec-block-unapproved flag 0 main-block-unapproved "" ""
run_case 04-large-no-spec-blocks           flag 1 main-block "" ""

pr pr-large-spec;       lines src/app/report.js 450; spec_change add-report-export "G-101 - Finance closes the month without rebuilding reports" "n/a"; git add -A; git commit -qm "large + spec"
run_case 05-large-with-valid-spec-passes   pass 0 main-block "" ""
{ echo "== openspec validate add-report-export --strict --json"; "$OS" validate add-report-export --strict --json --no-interactive; echo "exit=$?"; } > "$results/05b-openspec-validate.txt" 2>&1

pr pr-no-goal;          lines src/app/report.js 450; spec_change add-report-export "" "n/a"; git add -A; git commit -qm "spec without goal"
run_case 06-spec-missing-goal-flags        flag 1 main-block "" ""
{ echo "== same change: openspec validate --strict alone (it does not read the proposal)"; "$OS" validate add-report-export --strict --json --no-interactive; echo "exit=$?"; } > "$results/06b-openspec-validate-no-goal.txt" 2>&1

pr pr-unknown-goal;     lines src/app/report.js 450; spec_change add-report-export "G-999 - Something nobody agreed" "n/a"; git add -A; git commit -qm "unknown goal"
run_case 07-goal-not-in-goals-file-flags   flag 0 main "" ""

pr pr-exempt;           lines src/app/generated-client.js 600; git add -A; git commit -qm "generated client"
run_case 08-exempt-with-reason-passes      pass 0 main-block "spec-exempt" "Spec-exempt: regenerated API client from the vendor schema, no behaviour change"
run_case 09-exempt-without-reason-flags    flag 1 main-block "spec-exempt" "Regenerated the client."

pr pr-billing-small;    printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; git add -A; git commit -qm "billing tweak"
run_case 10-small-money-path-no-spec-flags flag 0 main "" ""

pr pr-money-nocalc;     printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; spec_change add-report-export "G-102 - Billing totals stay correct" "n/a"; git add -A; git commit -qm "money, no calc"
run_case 11-money-without-separate-calc-flags flag 0 main "" ""

pr pr-money-calc;       printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; spec_change add-report-export "G-102 - Billing totals stay correct" "ledger total for the month equals CSV total"; git add -A; git commit -qm "money with calc"
run_case 12-money-with-separate-calc-passes pass 0 main "" ""

pr pr-multiservice;     lines services/api/index.js 15; lines services/web/index.js 15; git add -A; git commit -qm "two services"
run_case 13-two-services-no-spec-flags     flag 0 main "" ""

pr pr-bad-scenario;     lines src/app/report.js 450; spec_change add-report-export "G-101 - Finance closes the month without rebuilding reports" "n/a"
sed -i.bak 's/^- \*\*THEN\*\* the CSV has only the header and a zero total/- the CSV has only the header and a zero total/' openspec/changes/add-report-export/specs/report-export/spec.md; rm openspec/changes/add-report-export/specs/report-export/spec.md.bak
git add -A; git commit -qm "scenario without THEN"
run_case 18-strict-validate-failure-flags  flag 0 main "" ""

pr pr-bad-tables;       lines src/app/report.js 450; printf 'export const total = (items) => items.length;\n' > src/billing/invoice.js
spec_change add-report-export "G-101 - Finance closes the month without rebuilding reports" "ledger total equals CSV total"
sed -i.bak -e 's/| `src\/app\/report.js` | yellow |/| `src\/app\/report.js` | amber |/' -e '/^| `src\/billing\/` | red/d' openspec/changes/add-report-export/proposal.md; rm openspec/changes/add-report-export/proposal.md.bak
sed -i.bak '/^| Export an empty month/d' openspec/changes/add-report-export/verification.md; rm openspec/changes/add-report-export/verification.md.bak
git add -A; git commit -qm "bad readiness, missing verification row, billing not listed"
run_case 19-bad-tables-flags               flag 0 main "" ""

pr pr-no-verification; lines src/app/report.js 450; spec_change add-report-export "G-101 - Finance closes the month without rebuilding reports" "n/a" no-verification; git add -A; git commit -qm "large + spec, no verification.md"
run_case 22-large-missing-verification-md-flags flag 1 main-block "" ""
{ echo "== openspec status (verification and tasks not done)"; "$OS" status --change add-report-export --json; echo "== openspec validate --strict alone"; "$OS" validate add-report-export --strict --json --no-interactive; echo "exit=$?"; } > "$results/22b-openspec-status-validate.txt" 2>&1

# A change already merged to main, referenced from a later PR body.
git checkout -q main; spec_change add-report-export "G-101 - Finance closes the month without rebuilding reports" "n/a"; git add -A; git commit -qm "merge spec first"
pr pr-linked-by-body;   lines src/app/report.js 450; git add -A; git commit -qm "implementation only"
run_case 14-change-line-in-body-passes     pass 0 main "" "Implements the report export.
Change: add-report-export"
run_case 15-change-line-unknown-flags      flag 0 main "" "Change: does-not-exist"
git checkout -q main

pr pr-tests-only;       lines src/app/report.test.js 900; git add -A; git commit -qm "tests only"
run_case 16-test-only-lines-not-counted    pass 0 main "" ""

# Event-file path, as GitHub Actions provides it.
git checkout -q pr-exempt
base_sha=$(git rev-parse main-block); head_sha=$(git rev-parse HEAD)
cat > "$results/event.json" <<EOF
{"pull_request":{"body":"Spec-exempt: regenerated API client from the vendor schema, no behaviour change","labels":[{"name":"spec-exempt"}],"base":{"sha":"$base_sha"},"head":{"sha":"$head_sha"}}}
EOF
out="$results/17-github-event-file.txt"
GITHUB_EVENT_PATH="$results/event.json" GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$results/17-step-summary.md" node "$CHECK" --repo "$repo" > "$out" 2>&1; code=$?
echo "# exit code: $code" >> "$out"
grep -q "^Spec check: PASSED" "$out" && [ $code = 0 ] && v=OK || v=MISMATCH
printf '%-40s expect %-4s exit %s | got %-5s exit %s  %s\n' 17-github-event-file pass 0 "$(grep -q PASSED "$out" && echo pass || echo flag)" "$code" "$v" | tee -a "$results/SUMMARY.txt"

# A pull request that archives a merged change (folder moves under changes/archive/).
pr pr-archive;          "$OS" archive add-report-export --yes > "$results/21b-openspec-archive.txt" 2>&1; lines src/app/util.js 10; git add -A; git commit -qm "archive change"
run_case 21-archive-pr-not-treated-as-link pass 0 main "" ""
git checkout -q main

# The pull request that installs the kit: settings are not on the base branch yet.
git checkout -q main
run_case 20-install-pr-uses-own-settings   flag 0 pre-kit "" ""

git checkout -q main
echo; grep -c " OK$" "$results/SUMMARY.txt" | xargs echo "cases OK:"; grep -c "MISMATCH" "$results/SUMMARY.txt" | xargs echo "mismatches:"

# Keep local machine paths out of the recorded results.
for f in "$results"/*; do sed -i.bak "s#$root#<kit>#g" "$f" && rm -f "$f.bak"; done

# Fail the run (and CI) if any case did not match.
! grep -q MISMATCH "$results/SUMMARY.txt"
