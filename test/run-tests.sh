#!/usr/bin/env bash
# Builds a throwaway repo (../test-repo), installs the kit with the pinned
# OpenSpec, simulates pull requests as branches, runs the check on each and
# records the output in test/results/. Exits non-zero if any case mismatches.
set -uo pipefail

export OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 OPENSPEC_NO_UPDATE_CHECK=1 OPENSPEC_NO_COMPLETIONS=1 OPENSPEC_NO_ANIMATION=1
unset GITHUB_ACTIONS GITHUB_EVENT_PATH GITHUB_STEP_SUMMARY CI SPEC_CHECK_BOOTSTRAP

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$root/test-repo"
results="$root/test/results"
OS="$root/node_modules/.bin/openspec"
CHECK="$root/kit/.github/actions/spec-check/spec-check.mjs"
export OPENSPEC_BIN="$OS"
CFG=.github/spec-check.jsonc

rm -rf "$repo" "$results"; mkdir -p "$repo" "$results"
record() { # record <id> <OK|MISMATCH> <detail>
  printf '%-46s %-9s %s\n' "$1" "$2" "$3" | tee -a "$results/SUMMARY.txt"
}

# ---------- unit checks and version pin ----------
node "$root/test/unit.mjs" > "$results/00-unit.txt" 2>&1 && record 00-unit-checks OK "$(grep -c '^OK' "$results/00-unit.txt") parsing checks" || record 00-unit-checks MISMATCH "see 00-unit.txt"
pin_root=$(node -p "require('$root/package.json').devDependencies['@fission-ai/openspec']")
pin_action=$(node -p "require('$root/kit/.github/actions/spec-check/openspec/package.json').dependencies['@fission-ai/openspec']")
pin_lock=$(node -p "require('$root/kit/.github/actions/spec-check/openspec/package-lock.json').packages['node_modules/@fission-ai/openspec'].version")
[ "$pin_root" = "$pin_action" ] && [ "$pin_action" = "$pin_lock" ] && [ "$("$OS" --version)" = "$pin_lock" ] \
  && record 00-openspec-pin-matches-lockfile OK "$pin_lock" || record 00-openspec-pin-matches-lockfile MISMATCH "$pin_root/$pin_action/$pin_lock"

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
for i in $(seq 1 250); do echo "export const legacy$i = $i;" >> src/app/legacy.js; done
mkdir -p tests/helpers; for i in $(seq 1 450); do echo "export const helper$i = $i;" >> tests/helpers/big.js; done
printf '{\n  "name": "demo",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n' > package.json
printf '# Agent notes\n\nRun the tests before you commit.\n' > CLAUDE.md
git add -A && git commit -qm "base: OpenSpec 2.0.0 + handoffs-spec-check"

# ---------- helpers ----------
lines() { # lines <file> <count>: write <count> lines of real JS
  local f="$1" n="$2"; mkdir -p "$(dirname "$f")"; : > "$f"
  for i in $(seq 1 "$n"); do echo "export const v$i = $i * 2;" >> "$f"; done
}
base_variant() { # base_variant <branch> <sed-expression>: settings change on top of main
  git checkout -q main && git checkout -q -b "$1"
  sed -i.bak "$2" "$CFG" && rm "$CFG.bak"
  git commit -qam "settings: $1"; git checkout -q main
}
spec_change() { # spec_change <name> <goal-line|""> <calc> [no-verification]
  local name="$1" goal="$2" calc="$3" d="openspec/changes/$1"
  "$OS" new change "$name" --schema handoffs > /dev/null 2>&1
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
GOAL1="G-101 - Finance closes the month without rebuilding reports"
pr() { git checkout -q main && git checkout -q -b "$1"; }   # start a simulated PR branch
commit() { git add -A && git commit -qm "$1"; }
# run_case <id> <pass|flag|error> <exit> <base> <labels> <body> [must-contain] [ENV=value ...]
run_case() {
  local id="$1" want="$2" wantexit="$3" base="$4" labels="$5" body="$6" must="${7:-}"; shift 6; [ $# -gt 0 ] && shift
  local out="$results/$id.txt"
  { echo "# case: $id"; echo "# base: $base   head: $(git rev-parse --abbrev-ref HEAD)   labels: [$labels]"; echo "# PR body: ${body:-<empty>}"; echo; } > "$out"
  env SPEC_CHECK_BASE="$base" SPEC_CHECK_HEAD=HEAD SPEC_CHECK_LABELS="$labels" SPEC_CHECK_PR_BODY="$body" "$@" \
    node "$CHECK" --repo "$repo" >> "$out" 2>&1
  local code=$? got
  if grep -q "^Spec check: PASSED" "$out"; then got=pass; elif grep -q "^Spec check: FLAGGED" "$out"; then got=flag; else got=error; fi
  echo "# exit code: $code" >> "$out"
  local verdict=OK
  [ "$got" = "$want" ] && [ "$code" = "$wantexit" ] || verdict=MISMATCH
  [ -n "$must" ] && ! grep -qF -- "$must" "$out" && verdict=MISMATCH
  record "$id" "$verdict" "expect $want/exit $wantexit, got $got/exit $code${must:+, contains \"$must\"}"
}

# ---------- base variants ----------
base_variant main-block-unapproved 's/"mode": "warn"/"mode": "block"/'
git checkout -q main-block-unapproved && git checkout -q -b main-block
sed -i.bak 's/"approvedBy": "", "approvedOn": ""/"approvedBy": "CTO (test)", "approvedOn": "2026-11-13"/' "$CFG" && rm "$CFG.bak"
git commit -qam "CTO approves block mode"; git checkout -q main
base_variant main-broken-config 's/"mode": "warn",/"mode": "warn" "oops",/'
base_variant main-no-exempt-label '/"exemptLabel"/d'
git checkout -q -b main-advanced main; lines src/app/later.js 450; commit "base moves on after the PR branched"; git checkout -q main

# ---------- cases: size and links ----------
pr pr-small;            lines src/app/util.js 20; commit small
run_case 01-small-change-passes            pass 0 main "" ""
run_case 02-merge-base-ignores-newer-base-commits pass 0 main-advanced "" "" "21 non-test lines"

pr pr-large-nospec;     lines src/app/report.js 450; commit large
run_case 03-large-no-spec-warns            flag 0 main "" "" "450 non-test lines changed, at or above the threshold of 400"
run_case 04-block-unapproved-only-warns    flag 0 main-block-unapproved "" "" "only warns"
run_case 05-large-no-spec-blocks           flag 1 main-block "" ""
run_case 06-broken-base-settings-fail-closed error 1 main-broken-config "" "" "failed closed"
run_case 07-exempt-label-missing-from-settings pass 0 main-no-exempt-label "spec-exempt" "Spec-exempt: generated code only, reviewed by hand" 'Exempt by label "spec-exempt"'

pr pr-exactly-400;      lines src/app/exact.js 400; commit "exactly 400"
run_case 08-exactly-at-threshold-flags     flag 0 main "" "" "400 non-test lines changed, at or above"

pr pr-large-spec;       lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"; commit "large + spec"
run_case 09-large-with-valid-spec-passes   pass 0 main-block "" "" "validates; has Goal, Ticket, Files at Risk, verification.md covering 2 scenarios"
run_case 10-change-named-and-modified-passes pass 0 main "" '- **Change:** `add-report-export`' "modified in this pull request and named in the PR body"
{ echo "== openspec validate add-report-export --type change --strict --json"; "$OS" validate add-report-export --type change --strict --json --no-interactive; echo "exit=$?"; } > "$results/09b-openspec-validate.txt" 2>&1

pr pr-tests-only;       lines src/app/report.test.js 900; commit "tests only"
run_case 11-test-only-lines-not-counted    pass 0 main "" ""

pr pr-docs;             mkdir -p docs; lines docs/guide.md 450; commit "docs only"
run_case 12-docs-folder-not-counted        pass 0 main "" ""
pr pr-nested-md;        lines src/app/notes.md 450; commit "markdown in src"
run_case 13-markdown-anywhere-not-counted  pass 0 main "" "" "0 non-test lines"
pr pr-spec-dir-code;    lines src/api/spec/openapi-handlers.js 450; commit "code in a folder named spec"
run_case 13b-spec-folder-code-is-counted   flag 0 main "" "" "450 non-test lines"

pr pr-multiservice;     lines services/api/index.js 15; lines services/web/index.js 15; commit "two services"
run_case 14-two-services-no-spec-flags     flag 0 main "" "touches 2 services"

# ---------- cases: paths that always need a spec ----------
pr pr-billing-small;    printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; commit "billing tweak"
run_case 15-small-money-path-no-spec-flags flag 0 main "" "" "always need a spec: src/billing/invoice.js"
pr pr-billing-test;     lines src/billing/__tests__/invoice.test.js 5; commit "billing test"
run_case 16-test-under-money-path-flags    flag 0 main "" "" "src/billing/__tests__/invoice.test.js"
pr pr-rename;           git mv src/billing/invoice.js src/app/invoice.js; commit "move invoice out of billing"
run_case 17-rename-out-of-money-path-flags flag 0 main "" "" "always need a spec: src/billing/invoice.js"
pr pr-tab-path;         printf 'x\n' > "$(printf 'src/billing/a\tb.js')"; commit "tab in a file name"
run_case 18-tab-in-file-name-still-matched flag 0 main "" "" "always need a spec: src/billing/a b.js"
pr pr-test-to-code;     mkdir -p src/app; git mv tests/helpers/big.js src/app/big.js; commit "move a test helper into code"
run_case 18b-rename-from-test-path-counts-whole-file flag 0 main "" "" "450 non-test lines"
pr pr-case;             mkdir -p src/Payments; echo "export const x = 1;" > src/Payments/Refund.js; commit "mixed-case path"
run_case 19-case-insensitive-paths-flag    flag 0 main "" "" "src/Payments/Refund.js"

# ---------- cases: bypass attempts ----------
pr pr-gitattributes;    printf '* -diff\n' > .gitattributes; lines src/app/report.js 450; commit "hide the diff"
run_case 20-gitattributes-cannot-hide-lines flag 0 main "" "" "451 non-test lines in 2 files"
pr pr-binary-big;       { printf 'BIN\000'; head -c 1200000 /dev/zero; } > src/app/model.bin; commit "large binary"
run_case 21-binary-over-1mb-flags          flag 0 main "" "" "binary files over 1.0 MB: src/app/model.bin (1.1 MB)"
pr pr-nul-code;         { printf 'const a = 1; // \000\n'; for i in $(seq 2 900); do echo "export const v$i = $i;"; done; } > src/payload.js; commit "NUL byte in a source file"
run_case 21c-nul-byte-source-file-counted  flag 0 main "" "" "900 non-test lines"
run_case 21d-nul-byte-source-file-named    flag 0 main "" "" "source files that git treats as binary (they contain a NUL byte): src/payload.js"
pr pr-nul-data;         { printf 'key=\000\n'; for i in $(seq 2 900); do echo "key$i=$i"; done; } > src/settings.cfg; commit "NUL byte in a data file"
run_case 21e-nul-byte-data-file-counted    flag 0 main "" "" "900 non-test lines"
pr pr-nul-vue;          mkdir -p src/ui; { printf '<template>\000</template>\n'; for i in $(seq 2 5000); do echo "<p>line $i</p>"; done; } > src/ui/Page.vue; commit "NUL byte in a .vue file"
run_case 21f-nul-byte-vue-file-counted     flag 0 main "" "" "5000 non-test lines"
pr pr-wasm;             mkdir -p web; head -c 204800 /dev/urandom > web/app.wasm; commit "200 KB wasm"
run_case 21g-random-wasm-under-1mb-passes  pass 0 main "" "" "0 non-test lines"
pr pr-big-nul-js;       { printf 'x\000\n'; head -c 1500000 /dev/zero | tr '\0' 'a'; } > src/huge.js; commit "1.5 MB source file with a NUL"
run_case 21h-big-binary-source-flagged-by-size flag 0 main "" "" "binary files over 1.0 MB: src/huge.js (1.4 MB)"
pr pr-binary-small;     printf 'BIN\000\001\002\003payload' > src/app/blob.dat; commit "small binary"
run_case 21b-small-binary-passes           pass 0 main "" ""
pr pr-submodule;        git update-index --add --cacheinfo "160000,$(git rev-parse pre-kit),libs/vendored"; git commit -qm "add submodule"
run_case 22-submodule-flags                flag 0 main "" "" "changes submodules: libs/vendored"
pr pr-skip-specs;       lines src/app/report.js 450; "$OS" new change refactor-report --schema handoffs > /dev/null 2>&1
printf 'skip_specs: true\n' >> openspec/changes/refactor-report/.openspec.yaml; cp "$repo/openspec/schemas/handoffs/templates/proposal.md" openspec/changes/refactor-report/proposal.md; commit "skip_specs on a big PR"
run_case 23-skip-specs-on-big-pr-flags     flag 0 main "" "" "declares skip_specs: true, but this pull request is bigger than small"
pr pr-inject;           printf 'x\n' > "src/billing/a
::error::injected.js"; commit "newline in a file name"
run_case 24-workflow-command-injection-contained flag 0 main "" "" "::stop-commands::" GITHUB_ACTIONS=true
if grep -q "^::error::injected" "$results/24-workflow-command-injection-contained.txt"; then record 24b-no-injected-command-line MISMATCH "found"; else record 24b-no-injected-command-line OK "no line starts with ::error::injected"; fi

# ---------- cases: proposal and verification content ----------
pr pr-no-goal;          lines src/app/report.js 450; spec_change add-report-export "" "n/a"; commit "spec without goal"
run_case 25-spec-missing-goal-flags        flag 1 main-block "" "" "Goal section is missing"
{ echo "== same change: openspec validate --strict alone (it does not read the proposal)"; "$OS" validate add-report-export --type change --strict --json --no-interactive; echo "exit=$?"; } > "$results/25b-openspec-validate-no-goal.txt" 2>&1
pr pr-unknown-goal;     lines src/app/report.js 450; spec_change add-report-export "G-999 - Something nobody agreed" "n/a"; commit "unknown goal"
run_case 26-goal-not-in-goals-file-flags   flag 0 main "" "" "Goal ID G-999 is not in openspec/goals.md"
pr pr-ticket-tbd;       lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
sed -i.bak 's/\*\*Ticket:\*\* FIN-482/**Ticket:** TBD/' openspec/changes/add-report-export/proposal.md; rm openspec/changes/add-report-export/proposal.md.bak; commit "ticket TBD"
run_case 27-ticket-tbd-flags               flag 0 main "" "" "Ticket is missing or still a placeholder"
pr pr-ticket-link;      lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
sed -i.bak 's#\*\*Ticket:\*\* FIN-482#- **Ticket:** <https://tracker.example/FIN-482>#' openspec/changes/add-report-export/proposal.md; rm openspec/changes/add-report-export/proposal.md.bak; commit "ticket autolink"
run_case 28-ticket-autolink-passes         pass 0 main "" ""
pr pr-crlf;             lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
for f in proposal.md verification.md; do sed -i.bak 's/$/\r/' "openspec/changes/add-report-export/$f"; rm "openspec/changes/add-report-export/$f.bak"; done; commit "CRLF line endings"
run_case 29-crlf-files-pass                pass 0 main "" ""
pr pr-reordered;        lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
cat > openspec/changes/add-report-export/verification.md <<'EOF'
| Test that proves it | Scenario | Separate calculation |
|---|---|---|
| `src/app/report.test.js` > exports one row per invoice | Export a month with invoices | n/a |
| `src/app/report.test.js` > exports header and zero total | Export an empty month | n/a |
EOF
commit "columns in another order"
run_case 30-verification-columns-by-header-pass pass 0 main "" ""
pr pr-bad-scenario;     lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
sed -i.bak 's/^- \*\*THEN\*\* the CSV has only the header and a zero total/- the CSV has only the header and a zero total/' openspec/changes/add-report-export/specs/report-export/spec.md; rm openspec/changes/add-report-export/specs/report-export/spec.md.bak; commit "scenario without THEN"
run_case 31-strict-validate-failure-flags  flag 0 main "" "" "missing a THEN step"
pr pr-bad-tables;       lines src/app/report.js 450; printf 'export const total = (items) => items.length;\n' > src/billing/invoice.js
spec_change add-report-export "$GOAL1" "ledger total equals CSV total"
sed -i.bak -e 's/| `src\/app\/report.js` | yellow |/| `src\/app\/report.js` | amber |/' -e '/^| `src\/billing\/` | red/d' openspec/changes/add-report-export/proposal.md; rm openspec/changes/add-report-export/proposal.md.bak
sed -i.bak '/^| Export an empty month/d' openspec/changes/add-report-export/verification.md; rm openspec/changes/add-report-export/verification.md.bak; commit "bad tables"
run_case 32-bad-tables-flags               flag 0 main "" "" 'verification.md has no row for scenario "Export an empty month"'
pr pr-no-verification;  lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a" no-verification; commit "no verification.md"
run_case 33-large-missing-verification-md-flags flag 1 main-block "" "" "verification.md is missing"
pr pr-big-verification; lines src/app/report.js 450; spec_change add-report-export "$GOAL1" "n/a"
head -c 300000 /dev/zero | tr '\0' 'x' >> openspec/changes/add-report-export/verification.md; commit "oversized verification.md"
run_case 34-oversized-file-not-read-flags  flag 0 main "" "" "verification.md is over 256 KB"

# ---------- cases: money ----------
pr pr-money-nocalc;     printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; spec_change add-report-export "G-102 - Billing totals stay correct" "n/a"; commit "money, n/a"
run_case 35-money-calc-na-flags            flag 0 main "" "" "must name at least one separate calculation"
pr pr-money-no;         printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; spec_change add-report-export "G-102 - Billing totals stay correct" "no"; commit "money, no"
run_case 36-money-calc-no-flags            flag 0 main "" "" "must name at least one separate calculation"
pr pr-money-calc;       printf 'export const total = (items) => items.reduce((s, i) => s + i.amount, 0);\n' > src/billing/invoice.js; spec_change add-report-export "G-102 - Billing totals stay correct" "ledger total for the month equals CSV total"; commit "money with calc"
run_case 37-money-with-separate-calc-passes pass 0 main "" ""

# ---------- ordinary pull requests: all must pass ----------
pr pr-p01;  lines src/app/feature.js 40; commit "40-line feature"
run_case P01-forty-line-feature-passes     pass 0 main "" ""
pr pr-p02;  mkdir -p docs; lines docs/setup.md 300; echo "More notes." >> README.md; lines src/app/NOTES.md 200; commit "docs"
run_case P02-docs-pr-passes                pass 0 main "" ""
pr pr-p03;  sed -i.bak 's/1.3.0/1.3.1/' package.json && rm package.json.bak; lines package-lock.json 2000; { printf 'lockb\000'; head -c 300000 /dev/zero; } > bun.lockb; commit "dependency bump"
run_case P03-dependency-bump-passes        pass 0 main "" "" "2 non-test lines"
pr pr-p04;  git mv src/app/legacy.js src/app/modern.js; commit "pure rename"
run_case P04-pure-rename-250-lines-passes  pass 0 main "" "" "0 non-test lines"
pr pr-p05;  echo "Prefer small pull requests." >> CLAUDE.md; commit "one-line CLAUDE.md edit"
run_case P05-claude-md-edit-passes-with-note pass 0 main "" "" "agent instructions changed; code owner should review: CLAUDE.md"
pr pr-p06;  mkdir -p web/img; { printf '\211PNG\r\n\032\n\000\000'; head -c 400000 /dev/zero; } > web/img/hero.png; commit "add a png"
run_case P06-png-passes                    pass 0 main "" ""
pr pr-p07;  mkdir -p tests/fixtures; { printf 'FIX\000'; head -c 2000000 /dev/zero; } > tests/fixtures/sample.bin; commit "binary test fixture"
run_case P07-binary-test-fixture-passes    pass 0 main "" ""
pr pr-p08;  lines src/ui/session/panel.js 20; commit "UI under session/"
run_case P08-ui-under-session-passes       pass 0 main "" ""
pr pr-p10;  lines src/app/share.js 450; spec_change add-sharing "G-101 - Let users share a todo list" "n/a"; commit "todo list goal"
run_case P10-todo-list-goal-passes         pass 0 main "" ""
pr pr-p11;  lines src/app/share.js 450; spec_change add-sharing "$GOAL1" "n/a"
sed -i.bak 's/\*\*Ticket:\*\* FIN-482/**Ticket:** TODO-123/' openspec/changes/add-sharing/proposal.md; rm openspec/changes/add-sharing/proposal.md.bak; commit "TODO-123 ticket"
run_case P11-ticket-todo-123-passes        pass 0 main "" ""

# ---------- cases: exemption ----------
pr pr-exempt;           lines src/app/generated-client.js 600; commit "generated client"
run_case 38-exempt-with-reason-passes      pass 0 main-block "spec-exempt" "Spec-exempt: regenerated API client from the vendor schema, no behaviour change" "A reviewer must confirm the reason"
run_case 39-exempt-without-reason-flags    flag 1 main-block "spec-exempt" "Regenerated the client." 'label "spec-exempt" needs a reason'
run_case 40-exempt-reason-placeholder-flags flag 1 main-block "spec-exempt" "Spec-exempt: TBD" 'needs a reason'
base_sha=$(git rev-parse main-block); head_sha=$(git rev-parse HEAD)
cat > "$results/event.json" <<EOF
{"sender":{"login":"some-reviewer"},"pull_request":{"body":"Spec-exempt: regenerated API client from the vendor schema, no behaviour change","labels":[{"name":"spec-exempt"}],"base":{"sha":"$base_sha"},"head":{"sha":"$head_sha"}}}
EOF
run_case 41-github-event-file-records-actor pass 0 "$base_sha" "" "" "triggered by some-reviewer" GITHUB_EVENT_PATH="$results/event.json" GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$results/41-step-summary.html" SPEC_CHECK_LABELS= SPEC_CHECK_PR_BODY=

# ---------- cases: a change merged earlier ----------
git checkout -q main; spec_change add-report-export "$GOAL1" "n/a"; commit "merge spec first"
pr pr-linked-by-body;   lines src/app/report.js 450; commit "implementation only"
run_case 42-spec-first-large-pr-passes-with-note pass 0 main "" "Implements the report export.
Change: add-report-export" "existing change, created before this PR"
run_case 42b-linked-by-name-shown-in-headline pass 0 main "" "Change: add-report-export" "Spec check: PASSED (linked by name to existing change: add-report-export)"
base_variant main-require-touch 's/"requireLinkedChangeTouched": false/"requireLinkedChangeTouched": true/'
git checkout -q pr-linked-by-body
run_case 42c-require-linked-change-touched-flags flag 0 main-require-touch "" "Change: add-report-export" "requires a large pull request to touch its change"
run_case 43-change-line-unknown-flags      flag 0 main "" "Change: does-not-exist" "openspec/changes/does-not-exist/ does not exist"
pr pr-spec-first-small; lines src/app/feature.js 20; commit "small implementation step"
run_case P09-spec-first-change-line-small-pr-passes pass 0 main "" "Change: add-report-export"
pr pr-archive;          "$OS" archive add-report-export --yes > "$results/44b-openspec-archive.txt" 2>&1; lines src/app/util.js 10; commit "archive change"
run_case 44-archive-pr-not-treated-as-link pass 0 main "" "" "Small change: no spec needed."
run_case 44b-archived-change-named-flags   flag 0 main "" "Change: add-report-export" "that change is archived"
run_case 44c-suffix-of-archived-name-does-not-exist flag 0 main "" "Change: report-export" "openspec/changes/report-export/ does not exist"

# ---------- cases: installing the check ----------
git checkout -q main
run_case 45-install-pr-without-bootstrap-flags flag 0 pre-kit "" "" "is not on the base branch"
run_case 46-install-pr-with-bootstrap-uses-pr-copy flag 0 pre-kit "" "" "Bootstrap: .github/spec-check.jsonc" SPEC_CHECK_BOOTSTRAP=true
git checkout -q pr-small
run_case 46b-bootstrap-left-on-adds-note   pass 0 main "" "" "Remove bootstrap from the workflow" SPEC_CHECK_BOOTSTRAP=true
pr pr-broken-own-settings; printf '{ "mode": ' > "$CFG"; commit "broken settings in the install PR"
run_case 46c-no-base-settings-and-broken-pr-copy-fails error 1 pre-kit "" "" "in this pull request cannot be used"
git checkout -q main

# ---------- install.sh: broken symlinks are not overwritten ----------
tmp="$root/test-repo-install"; rm -rf "$tmp"; mkdir -p "$tmp/openspec" && git -C "$tmp" init -q
ln -s does-not-exist "$tmp/openspec/goals.md"
"$root/install.sh" "$tmp" > "$results/47-install-dangling-symlink.txt" 2>&1
if [ -L "$tmp/openspec/goals.md" ] && grep -q "exists  openspec/goals.md" "$results/47-install-dangling-symlink.txt" && ! grep -q node_modules "$results/47-install-dangling-symlink.txt"; then
  record 47-install-keeps-dangling-symlink OK "left in place and listed; node_modules not copied"
else record 47-install-keeps-dangling-symlink MISMATCH "see 47-install-dangling-symlink.txt"; fi
rm -rf "$tmp"

git -C "$repo" checkout -q main
echo; echo "cases OK: $(grep -c ' OK ' "$results/SUMMARY.txt")"; echo "mismatches: $(grep -c 'MISMATCH' "$results/SUMMARY.txt")"

# Keep local machine paths out of the recorded results.
for f in "$results"/*; do sed -i.bak "s#$root#<kit>#g" "$f" && rm -f "$f.bak"; done

! grep -q MISMATCH "$results/SUMMARY.txt"
