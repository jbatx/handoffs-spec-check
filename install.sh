#!/usr/bin/env bash
# Installs handoffs-spec-check into a repository. Never overwrites anything
# that already exists (including a broken symlink); it lists those so you can
# merge them by hand.
# Usage: ./install.sh /path/to/your-repo
set -euo pipefail

target="${1:?usage: ./install.sh /path/to/your-repo}"
kit="$(cd "$(dirname "$0")/kit" && pwd)"
[ -d "$target/.git" ] || { echo "Not a git repository: $target" >&2; exit 1; }

skipped=()
while IFS= read -r -d '' src; do
  rel="${src#"$kit"/}"
  dest="$target/$rel"
  if [ -e "$dest" ] || [ -L "$dest" ]; then skipped+=("$rel"); continue; fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "added   $rel"
done < <(find "$kit" -name node_modules -prune -o -type f -print0)

for rel in "${skipped[@]+"${skipped[@]}"}"; do echo "exists  $rel (not changed; merge by hand)"; done
cat <<'EOF'

handoffs-spec-check copied. Next:
  1. Replace the placeholder goals in openspec/goals.md with real goal IDs.
  2. Set thresholds in .github/spec-check.jsonc (mode stays "warn").
  3. Merge .github/CODEOWNERS.example into .github/CODEOWNERS and set branch protection.
  4. In this first pull request only, set bootstrap: 'true' in .github/workflows/spec-check.yml.
  5. Open the pull request for the CTO to approve.
EOF
