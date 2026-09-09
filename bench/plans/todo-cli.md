# Plan: todo CLI

## Goal

A small Node.js command-line todo manager: `node bin/todo.mjs add "text"`, `list`, `done <id>`, `remove <id>`, persisted to a JSON file whose path comes from the `TODO_FILE` env var (default `todos.json`). Every command is covered by tests.

## Constraints

- Plain Node.js >= 18, ESM, zero dependencies. No TypeScript, no build step.
- Tests use `node:test` and `node:assert/strict`, live in `test/`, and must not touch the real `todos.json` (use a temp file via `TODO_FILE`).
- Keep all logic in `src/`; `bin/todo.mjs` only parses argv and prints.

## Verify

`node --test`

## Tasks

- [ ] T1: storage module `src/store.mjs` with load(path) / save(path, todos)
  - Accept: `test/store.test.mjs` round-trips an array through a temp file; load of a missing file returns []
- [ ] T2: core operations `src/todos.mjs`: add(todos, text), list(todos), complete(todos, id), remove(todos, id)
  - Accept: `test/todos.test.mjs` covers all four; ids are incrementing integers; complete/remove of an unknown id throws
- [ ] T3: CLI entry `bin/todo.mjs` wiring argv to the core ops and the store
  - Accept: `test/cli.test.mjs` spawns the CLI with TODO_FILE set to a temp path and checks add/list/done/remove output
- [ ] T4: `list` output formatting: `[ ]`/`[x]` marker, id, text; `--all` shows completed, default hides them
  - Accept: cli test asserts the exact lines for a mixed list with and without `--all`
- [ ] T5: README.md documenting install, all commands and TODO_FILE
  - Accept: README.md exists and mentions every command and TODO_FILE; `node --test` still passes
