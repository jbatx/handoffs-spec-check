#!/usr/bin/env bash
# Copies the kit into a repository. Never overwrites a file that already exists;
# it lists those so you can merge them by hand.
# Usage: ./install.sh /path/to/client-repo
set -euo pipefail

target="${1:?usage: ./install.sh /path/to/client-repo}"
kit="$(cd "$(dirname "$0")/kit" && pwd)"
[ -d "$target/.git" ] || { echo "Not a git repository: $target" >&2; exit 1; }

skipped=()
while IFS= read -r -d '' src; do
  rel="${src#"$kit"/}"
  dest="$target/$rel"
  if [ -e "$dest" ]; then skipped+=("$rel"); continue; fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "added   $rel"
done < <(find "$kit" -type f -print0)

for rel in "${skipped[@]+"${skipped[@]}"}"; do echo "exists  $rel (not changed; merge by hand)"; done
cat <<'EOF'

Next:
  1. Fill in openspec/goals.md with real goal IDs.
  2. Set thresholds in .github/spec-check.jsonc (mode stays "warn").
  3. Merge .github/CODEOWNERS.example into .github/CODEOWNERS.
  4. Open a pull request with these files for the CTO to approve.
EOF
