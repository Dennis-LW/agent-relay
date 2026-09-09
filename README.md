# agent-relay

Run long, multi-step coding tasks as a **relay of short, fresh agent sessions** — plan → worker → review → acceptance — with all state kept in git. Quality does not decay over a long context, and a rate-limit pause is just a pause.

Works with **Claude Code** (default), **OpenAI Codex CLI**, **Gemini CLI**, or any CLI agent you can run headless. The skill itself is in the open [Agent Skills](https://agentskills.io) `SKILL.md` format.

[繁體中文](README.zh-TW.md)

## Why

A single long agent session slowly gets worse: the context fills with stale reasoning, earlier mistakes become "facts", and one usage-limit hit ends the whole run. Compaction delays this; it does not fix it.

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

- At least one agent CLI on PATH: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`) or [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
- Node.js ≥ 18 (all three CLIs ship via npm, so it is already there)
- git

Works on macOS, Linux and Windows. No dependencies.

## Install

### As a Claude Code plugin (recommended)

```
claude plugin marketplace add Dennis-LW/agent-relay
claude plugin install relay@agent-relay
```

This gives you the `/relay` skill in every project.

### Codex CLI

Codex reads skills from `~/.codex/skills`. Clone the repo and copy or symlink `skills/relay` there:

```
git clone https://github.com/Dennis-LW/agent-relay
ln -s "$PWD/agent-relay/skills/relay" ~/.codex/skills/relay     # Windows: mklink /D
```

Then in a project: `relay init --agent codex` (or set `"agent": "codex"` in `.relay/config.json`). Sessions run as `codex exec --full-auto`.

### Gemini CLI or any other agent

Use the CLI directly for planning and the runner for execution: `relay init --agent gemini` runs sessions as `gemini --yolo -p <prompt>`. For anything else set `"agent": "custom"` and `"command": ["my-agent", "--auto", "{prompt}"]` (omit `{prompt}` to pipe it on stdin). The runner only needs the agent to edit files, run commands and commit; success is judged by the tick mark and the new commit, not by the agent's output.

### Manual (Claude Code)

Clone the repo and copy or symlink `skills/relay` into `~/.claude/skills/relay`.

### CLI only

```
npm install -g github:Dennis-LW/agent-relay
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
relay init [--plan <path>] [--verify "<cmd>"] [--agent <name>]   create .relay/ in the current project
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
| `agent` | `claude` | `claude` \| `codex` \| `gemini` \| `custom` |
| `command` | `[]` | for `custom`: argv; `{prompt}` is substituted, otherwise the prompt is piped to stdin |
| `claude` | `claude` | executable override for the chosen preset (e.g. a full path) |
| `model` | `""` | model flag for sessions |
| `permissionMode` | `acceptEdits` | Claude Code `--permission-mode` |
| `extraArgs` | `[]` | extra CLI args passed to every session |
| `sessionTimeoutMinutes` | `45` | hard kill per session |
| `reviewEvery` | `3` | review after this many tasks (0 = never) |
| `acceptance` | `true` | run the acceptance session at the end |
| `maxAcceptanceRounds` | `2` | cap on acceptance → follow-up loops |
| `maxConsecutiveFailures` | `5` | give up after this many failures in a row |
| `retryBaseMinutes` / `retryMaxMinutes` | `5` / `60` | rate-limit backoff |
| `commitRequired` | `true` | require a new commit per task |
| `notes` | `""` | free text appended to every prompt |

## Permissions and safety

Sessions run headless. Claude Code uses `--permission-mode acceptEdits` (edits auto-approved, Bash still follows your allow/deny rules; set `"permissionMode": "bypassPermissions"` only inside a sandbox you trust). Codex runs `exec --full-auto` and Gemini runs `--yolo`, which are their unattended modes. Workers are told never to push and never to rewrite history.

Every session's prompt and result are written to `.relay/logs/`.

## Limits

- Usage limits are per account, not per session. Relay does not get you more quota; it makes waiting for the reset automatic and lossless.
- The background runner is a local process. Sleep or shutdown stops it; `relay run` resumes from the plan. For a machine-independent loop, drive `relay run --once` from a scheduler of your choice.
- Session quality still depends on task size. Big vague tasks give big vague results.

## Related work

agent-relay is a descendant of the [Ralph Wiggum loop](https://paddo.dev/blog/ralph-wiggum-autonomous-loops/): a `while` loop that starts a fresh agent for each task and keeps progress in a file. Good community implementations include [coleam00/ralph-loop-quickstart](https://github.com/coleam00/ralph-loop-quickstart), [frankbria/ralph-claude-code](https://github.com/frankbria/ralph-claude-code) and [harrymunro/ralph-wiggum](https://github.com/harrymunro/ralph-wiggum). (Anthropic's [ralph-wiggum plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) keeps one session running instead, which is the thing this project avoids.)

What agent-relay adds:

- cross-platform Node runner instead of bash, and any CLI agent instead of Claude Code only;
- separate clean-context **review** and **acceptance** sessions, not just a worker loop;
- success judged by observable side effects (tick + commit), never by the agent's own report;
- rate-limit backoff built into the loop, so helpers like [claude-auto-continue](https://github.com/Anonymousmirror/claude-auto-continue) or [resume-after-limit](https://github.com/carlaost/resume-after-limit) are not needed;
- `/relay plan` lets the agent write the plan in the required format instead of hand-writing a PRD.

## License

MIT
