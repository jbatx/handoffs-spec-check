# Contributing

Thanks for helping. Please open an issue before a pull request, so we can agree on the problem and the approach before anyone writes code. Small fixes to typos or docs can skip that step.

## Run the tests

You need Node.js 22.12 or newer, git 2.40 or newer and bash.

```bash
npm ci
npm test            # unit checks, then simulated pull requests in a throwaway repo
npm run test:unit   # unit checks only
```

`npm test` builds `test-repo/`, runs every case and writes outputs to `test/results/`. It exits non-zero if any case does not match what it expects. Neither folder is committed.

## Pull requests

- Add or update a test case in `test/run-tests.sh` or `test/unit.mjs` for every behavior change.
- Keep the check free of runtime dependencies. It runs on Node's standard library and the pinned OpenSpec CLI.
- If you change the OpenSpec version, update both `package.json` files and the lockfile under `kit/.github/actions/spec-check/openspec/`. The tests confirm they agree.
- Keep templates short enough to read on one screen.
- Write docs in plain sentences.

By contributing, you agree that your work is released under the MIT License in [LICENSE](LICENSE).
