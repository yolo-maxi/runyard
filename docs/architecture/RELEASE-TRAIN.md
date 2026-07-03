# Release-train status (`scripts/release-train.mjs`)

Deterministic branch/gate state for the release train, so the host watchdog or
an operator can poll a machine-readable answer to "where is the train and what
is the next concrete action" instead of scraping agent chat prose.

```
node scripts/release-train.mjs status [--json] [--base <ref>] [--dir <path>]
node scripts/release-train.mjs gate <id> [--dir <path>]
node scripts/release-train.mjs record <id> --pass|--fail [--note <text>] [--dir <path>]
pnpm release:train            # alias for `status`
```

All decision logic is pure and unit-tested in `src/releaseTrain.js`
(`tests/release-train.test.js`); the script only collects git facts and reads
or writes the evidence file (`tests/release-train-script.test.js` covers it
end-to-end against a throwaway repo).

## What `status` reports

- **branch / head / versions** — current branch, full+short HEAD SHA, HEAD
  subject, `package.json` version, the train version parsed from a
  `runyard/vX.Y.Z-*` branch name, and any tags at HEAD.
- **working tree** — dirty/clean plus dirty path count.
- **base** — ahead/behind vs `origin/main` (override with `--base`); `null`
  when the ref doesn't resolve, never fake zeros.
- **upstream** — ahead/behind vs the branch's upstream; `null` when unset.
- **gates** — evidence per release gate (see below).
- **blockers** — gates that FAILED at this HEAD, or a detached HEAD.
- **nextAction** — exactly one `{ id, summary, command }`, from a fixed
  priority ladder: `attach-branch` → `commit-or-stash` → `sync-base` →
  `fix-gate` → `run-gate` → `push-branch` → `record-ci-evidence` →
  `cut-release`.
- **ready** — true only when there are no blockers and the next action is
  `cut-release`.

`--json` emits the full report under schema
`runyard.release-train.status/1`; without it you get the same content as
human-readable text. Exit code is 0 whenever the report renders — consumers
read `blockers` / `ready` / `nextAction` from the JSON.

## Gates and evidence

The gates mirror what `.github/workflows/release.yml` / `images.yml` enforce:

| gate            | kind  | how evidence is produced                                  |
| --------------- | ----- | --------------------------------------------------------- |
| `test`          | local | `gate test` runs `pnpm test`                              |
| `build`         | local | `gate build` runs `pnpm build`                            |
| `diff-check`    | local | `gate diff-check` runs `git diff --check`                 |
| `sandbox-smoke` | ci    | runs only on a real Actions kernel — after a green run, `record sandbox-smoke --pass --note <run-url>` |

`gate <id>` runs the gate's command with inherited stdio, records pass/fail,
and exits with the gate's exit code. `record` is for results produced
elsewhere (CI, another machine).

Evidence lives at `data/release-evidence.json` (gitignored; override with
`RUNYARD_RELEASE_EVIDENCE_FILE`), one latest entry per gate, keyed to the
**full HEAD SHA the gate ran against**. Evidence recorded at any other commit
shows as `stale` and never counts — a green gate cannot be inherited across
new commits. A `fail` recorded at the current HEAD is a blocker until the gate
is re-run green.

## Watchdog loop

```sh
node scripts/release-train.mjs status --json | jq '{ready, blockers, next: .nextAction}'
# if nextAction.id == "run-gate": run the printed command, then re-poll
node scripts/release-train.mjs gate test
```

Every next action comes with the exact command to run, so the loop needs no
interpretation of prose.
