---
name: relay
description: Run a long, multi-step coding task as a relay of short fresh agent sessions (plan → worker sessions → review → acceptance) with durable state in git. Works with Claude Code, OpenAI Codex CLI, Gemini CLI or any CLI agent. Use when the user wants to hand over a big job (build a feature/system end to end, large refactor, long migration) to run unattended, wants to avoid long-session quality decay, or wants work to resume automatically after rate limits. Subcommands - /relay plan, /relay run, /relay status, /relay stop.
---

# Relay

Long single sessions degrade: the context fills with stale reasoning, the model starts trusting its own earlier mistakes, and one rate-limit hit ends everything. Relay fixes this by making **sessions short and state external**:

- `PLAN.md` — the task list (`- [ ] T1: ...` items with acceptance criteria). Progress lives here as tick marks.
- `HANDOFF.md` — a short note the last session leaves for the next one. Overwritten, never appended.
- git commits — the hard state. One task, one commit.
- A tiny zero-dependency Node runner (`scripts/relay.mjs`) that starts one headless agent session per task (Claude Code by default; Codex CLI, Gemini CLI or any custom command via the `agent` setting), checks that the task was ticked and committed, inserts a clean-context **review** session every N tasks, runs an **acceptance** session at the end, and waits/retries when the API is rate-limited.

The runner never trusts what a session says; it only trusts observable side effects (tick mark + new commit).

## Locating the runner

The runner lives next to this file: `scripts/relay.mjs`. Resolve it from this skill's directory (as a Claude Code plugin that is `${CLAUDE_PLUGIN_ROOT}/skills/relay/scripts/relay.mjs`; as a Codex skill it is `~/.codex/skills/relay/scripts/relay.mjs`). Call it with `node`, which is present wherever these CLIs are installed. In the commands below, `RELAY` stands for that full path.

This skill file is plain Agent Skills format, so the same instructions apply whether you are Claude, Codex, Gemini or another model: you write the plan, the runner drives the sessions.

## Subcommands

### `/relay plan <description or path to a requirements doc>`

You produce the plan; the runner does not. Steps:

1. If `.relay/config.json` does not exist, run `node RELAY init` (add `--verify "<cmd>"` if you already know the project's test command; add `--plan <path>` if the project already keeps a task file elsewhere, e.g. an OpenSpec `tasks.md`; add `--agent codex` / `--agent gemini` if the sessions should run on a different CLI than the one you are).
2. Explore the codebase enough to write a realistic plan. Read CLAUDE.md / AGENTS.md and follow project conventions.
3. Write the plan file following `templates/PLAN.md`. Rules that make relays work:
   - **Task size**: one task must be finishable and verifiable inside a single fresh session in well under the session timeout (default 45 min). If you cannot describe the diff in a few sentences, split it.
   - **Order = dependency order.** The runner always takes the first open task. Backend contract before frontend consumer, schema before code that uses it.
   - **Every task has an `Accept:` line** stating an observable condition (a test that passes, a command output, a file that exists). Vague tasks produce vague work.
   - **Constraints section** captures anything a fresh session would not know: branch to work on, style rules, files not to touch, conventions.
   - **Verify section** is one command that must pass after every task. If the project has none, make the first task create one.
   - Use ids `T1, T2, ...`. Review sessions append `R<n>`, acceptance appends `A<n>`; do not use those prefixes yourself.
4. Set `verify` in `.relay/config.json` if not already set, and `notes` for any platform-specific instructions workers need (e.g. "activate the venv with ...").
5. Show the user the task list and ask them to confirm before running. Suggest they commit the plan.

### `/relay run`

Start the loop. Prefer detached so it outlives this session:

```
node RELAY run --detach
```

Foreground (`node RELAY run`) is fine when the user wants to watch, and `--once` runs a single task, `--dry-run` prints the next worker prompt without calling Claude. Before starting:

- Make sure the plan is committed and the working tree is clean; workers commit after each task and a dirty tree makes the commit check unreliable.
- Tell the user which agent the sessions will run on (`agent` in config) and its unattended mode: Claude Code uses `--permission-mode acceptEdits` by default (set `"permissionMode": "bypassPermissions"` only in a trusted sandbox); Codex runs `codex exec --full-auto`; Gemini runs with `--yolo`.
- Tell the user how to follow progress: `node RELAY status`, `.relay/runner.out`, `.relay/logs/`.

The runner keeps going through rate limits: a limited session counts as a failure, it waits with exponential backoff (5 min → 60 min cap) and tries again. It gives up after `maxConsecutiveFailures` in a row; `relay run` again resumes from the plan.

### `/relay status`

Run `node RELAY status` and summarise for the user: done/open counts, next task, whether the runner is alive, recent outcomes, the current handoff. If failures are piling up, open the newest `.relay/logs/*.result.md` and explain the cause.

### `/relay stop`

Run `node RELAY stop`. The runner stops between sessions; a session in flight is terminated.

## When you are a worker/review/acceptance session

If the environment variable `RELAY_KIND` (or `CLAUDE_RELAY`) is set, you were started by the runner. The prompt you received is the contract; follow it exactly, do one thing, tick, commit, hand off, stop. Do not invoke `/relay` recursively.

## Config reference (`.relay/config.json`)

| key | default | meaning |
| --- | --- | --- |
| `plan` | `.relay/PLAN.md` | task file (any markdown with `- [ ]` items under a `## Tasks` heading) |
| `handoff` | `.relay/HANDOFF.md` | handoff note path |
| `verify` | `""` | command every session must pass before ticking |
| `agent` | `claude` | `claude` \| `codex` \| `gemini` \| `custom` |
| `command` | `[]` | for `custom`: argv; `{prompt}` is substituted, otherwise the prompt is piped to stdin |
| `claude` | `claude` | executable override for the chosen preset (e.g. a full path) |
| `model` | `""` | model flag for sessions (empty = CLI default) |
| `permissionMode` | `acceptEdits` | Claude Code `--permission-mode` |
| `extraArgs` | `[]` | extra CLI args passed to every session |
| `sessionTimeoutMinutes` | `45` | hard kill per session |
| `reviewEvery` | `3` | review session after this many completed tasks (0 = never) |
| `acceptance` | `true` | run the acceptance session when all tasks are ticked |
| `maxAcceptanceRounds` | `2` | acceptance may add follow-ups; cap the loop |
| `maxConsecutiveFailures` | `5` | give up after this many failures in a row |
| `retryBaseMinutes` / `retryMaxMinutes` | `5` / `60` | rate-limit backoff |
| `commitRequired` | `true` | a task counts as done only if HEAD moved |
| `notes` | `""` | free text appended to every prompt |

## Using an existing task file (e.g. OpenSpec)

Point `plan` at the existing file. The parser only needs a heading containing "Tasks" followed by `- [ ] ...` items; nested `- Accept:` lines are optional but strongly recommended. Ids are taken from a leading `T1:` / `1.` style token when present.
