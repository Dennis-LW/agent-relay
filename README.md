# claude-relay

Run long, multi-step coding tasks as a **relay of short, fresh Claude Code sessions** — plan → worker → review → acceptance — with all state kept in git. Quality does not decay over a long context, and a rate-limit pause is just a pause.

[繁體中文](README.zh-TW.md)

## Why

A single long Claude Code session slowly gets worse: the context fills with stale reasoning, earlier mistakes become "facts", and one usage-limit hit ends the whole run. Compaction delays this; it does not fix it.

The fix is structural: **make every session short and put the state outside the session.**

```
PLAN.md ──► runner ──► fresh session: do task T1, verify, commit, tick, hand off
                 └───► fresh session: do task T2 ...
                 └───► fresh session: REVIEW the last 3 commits, add fix tasks
                 └───► fresh session: do task T3 ...
                 └───► fresh session: ACCEPTANCE — check the whole goal, add follow-ups
```

- `PLAN.md` holds the task list; tick marks are the progress.
- `HANDOFF.md` is the note each session leaves for the next one.
- Each task ends in a git commit. The runner trusts commits and tick marks, not what a session claims.
- Rate limited? The runner backs off and retries. Nothing is lost.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH)
- Node.js ≥ 18 (already present wherever Claude Code runs)
- git

Works on macOS, Linux and Windows. No dependencies.

## Install

### As a Claude Code plugin (recommended)

```
claude plugin marketplace add okshoptw/claude-relay
claude plugin install relay@claude-relay
```

This gives you the `/relay` skill in every project.

### Manual

Clone the repo and copy or symlink `skills/relay` into `~/.claude/skills/relay`.

### CLI only

```
npm install -g github:okshoptw/claude-relay
relay help
```

## Quick start

Inside Claude Code, in the project you want to work on:

```
/relay plan  Build a REST API for invoices: CRUD, PDF export, tests. Use FastAPI.
```

Claude explores the codebase and writes `.relay/PLAN.md` — small tasks in dependency order, each with an `Accept:` line — and asks you to confirm. Commit it. Then:

```
/relay run
```

The runner starts in the background. Come back later:

```
/relay status
```

Or from a terminal:

```
node ~/.claude/skills/relay/scripts/relay.mjs status   # or just `relay status` if installed via npm
```

## The plan contract

```markdown
# Plan: Invoice API

## Goal
A user can create, list, update and delete invoices and download a PDF.

## Constraints
- Work on branch feat/invoices. Python 3.12, FastAPI, pytest.
- Do not touch the auth module.

## Verify
`pytest -q`

## Tasks
- [ ] T1: Add Invoice model and migration
  - Accept: `pytest tests/test_models.py` passes; migration applies on a fresh db
- [ ] T2: CRUD endpoints for /invoices
  - Accept: tests for all four verbs pass; OpenAPI shows the routes
- [ ] T3: PDF export endpoint
  - Accept: GET /invoices/{id}/pdf returns application/pdf for a seeded invoice
```

Rules that make relays work:

- **One task = one fresh session.** If you cannot describe the diff in a few sentences, split it.
- **Order is dependency order.** The runner always takes the first open task.
- **Every task has an observable Accept condition.**
- **Constraints capture what a fresh session cannot know.**

Any markdown file with `- [ ]` items under a heading containing "Tasks" works, so you can point `plan` at an existing task file (for example an OpenSpec `tasks.md`).

## What each session does

| session | when | contract |
| --- | --- | --- |
| worker | for each open task | do only this task → run verify → commit → tick `[x]` → overwrite HANDOFF |
| review | every `reviewEvery` completed tasks | read the diff with a clean context, write `.relay/reviews/*.md`, append `R<n>` fix tasks for high/medium findings; never edits code |
| acceptance | when no open tasks remain | re-check every Accept line and the Goal for real, write `.relay/ACCEPTANCE.md`, append `A<n>` follow-ups; never edits code |

A task counts as done only if the tick mark changed **and** HEAD moved. A worker that cannot finish leaves the task open (or marks it `[-]` blocked) and explains why in HANDOFF.

## CLI

```
relay init [--plan <path>] [--verify "<cmd>"]   create .relay/ in the current project
relay status                                    progress, next task, runner state, handoff
relay next                                      print the next open task
relay run [--once] [--dry-run] [--detach]       run the loop (foreground by default)
relay stop                                      stop a background runner
```

## Configuration (`.relay/config.json`)

| key | default | meaning |
| --- | --- | --- |
| `plan` | `.relay/PLAN.md` | task file |
| `handoff` | `.relay/HANDOFF.md` | handoff note |
| `verify` | `""` | command that must pass before a task is ticked |
| `claude` | `claude` | CLI executable |
| `model` | `""` | `--model` for sessions |
| `permissionMode` | `acceptEdits` | `--permission-mode` for sessions |
| `extraArgs` | `[]` | extra CLI args, e.g. `["--effort", "high"]` |
| `sessionTimeoutMinutes` | `45` | hard kill per session |
| `reviewEvery` | `3` | review after this many tasks (0 = never) |
| `acceptance` | `true` | run the acceptance session at the end |
| `maxAcceptanceRounds` | `2` | cap on acceptance → follow-up loops |
| `maxConsecutiveFailures` | `5` | give up after this many failures in a row |
| `retryBaseMinutes` / `retryMaxMinutes` | `5` / `60` | rate-limit backoff |
| `commitRequired` | `true` | require a new commit per task |
| `notes` | `""` | free text appended to every prompt |

## Permissions and safety

Sessions run headless with `--permission-mode acceptEdits`: file edits are auto-approved, Bash commands still follow your allow/deny rules. For fully unattended runs you may set `"permissionMode": "bypassPermissions"` — only inside a sandbox you trust. Workers are told never to push and never to rewrite history.

Every session's prompt and result are written to `.relay/logs/`.

## Limits

- Usage limits are per account, not per session. Relay does not get you more quota; it makes waiting for the reset automatic and lossless.
- The background runner is a local process. Sleep or shutdown stops it; `relay run` resumes from the plan. For a machine-independent loop, drive `relay run --once` from a scheduler of your choice.
- Session quality still depends on task size. Big vague tasks give big vague results.

## License

MIT
