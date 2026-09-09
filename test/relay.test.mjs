// Run with: node --test test/
// Exercises the runner loop end to end with test/fake-agent.mjs; no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, "..", "skills", "relay", "scripts", "relay.mjs");
const FAKE = path.join(HERE, "fake-agent.mjs");

function relay(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [RELAY, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

function freshRepo(planText, cfgOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  relay(dir, ["init", "--agent", "custom", "--verify", "true"]);
  const cfgPath = path.join(dir, ".relay", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  Object.assign(cfg, { command: [process.execPath, FAKE], reviewEvery: 2, sessionTimeoutMinutes: 1, ...cfgOverrides });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, ".relay", "PLAN.md"), planText);
  git("add", "-A");
  git("commit", "-qm", "plan");
  return { dir, git, log: () => execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n") };
}

const PLAN = `# Plan: smoke

## Goal
smoke

## Verify
\`true\`

## Tasks
- [ ] T1: first
  - Accept: out-T1.txt exists
- [ ] T2: second
  - Accept: out-T2.txt exists
- [ ] T3: third
  - Accept: out-T3.txt exists
`;

test("happy path: workers, review gate inserts R task, acceptance ends the loop", () => {
  const { dir, log } = freshRepo(PLAN);
  const r = relay(dir, ["run"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(log(), ["acceptance: PASS", "R1: done", "T3: done", "review: 1 findings", "T2: done", "T1: done", "plan", "init"]);
  const plan = fs.readFileSync(path.join(dir, ".relay", "PLAN.md"), "utf8");
  assert.equal((plan.match(/^- \[x\]/gm) || []).length, 4);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(state.runs.length, 6);
  assert.equal(state.runs[0].tokens.output, 300, "usage is recorded per run");
  assert.equal(state.runs[0].costUsd, 0.01);
  const status = relay(dir, ["status"]).out;
  assert.match(status, /Usage:\s+6 sessions, \$0\.06/);
  assert.match(status, /4 done \/ 0 open/);
});

test("review range excludes the review commit and starts after it", () => {
  const { dir, git } = freshRepo(PLAN);
  relay(dir, ["run"]);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  const subject = execFileSync("git", ["log", "-1", "--format=%s", state.lastReviewHead], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(subject, "review: 1 findings");
  void git;
});

test("worker that neither ticks nor commits counts as a failure and the runner gives up", () => {
  const { dir } = freshRepo(PLAN, { maxConsecutiveFailures: 1 });
  const r = relay(dir, ["run"], { FAKE_MODE: "noop" });
  assert.match(r.out, /giving up after 1 consecutive failures \(task not ticked\)/);
});

test("permission denial stops immediately and names the denied command", () => {
  const { dir } = freshRepo(PLAN, { maxConsecutiveFailures: 5 });
  const r = relay(dir, ["run"], { FAKE_MODE: "denied" });
  assert.match(r.out, /DENIED permission for: Bash\(git add -A && git commit/);
  assert.match(r.out, /allowedTools/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(state.runs.length, 1, "no retries after a denial");
});

test("an error mentioning 'quota' in the task text is not treated as a rate limit", () => {
  const { dir } = freshRepo(PLAN, { maxConsecutiveFailures: 1 });
  const r = relay(dir, ["run"], { FAKE_MODE: "quota" });
  assert.match(r.out, /giving up after 1 consecutive failures \(exit 0\)/);
  assert.doesNotMatch(r.out, /rate-limited/);
});

test("the real usage-limit message is detected as a rate limit", () => {
  const { dir } = freshRepo(PLAN, { maxConsecutiveFailures: 1 });
  const r = relay(dir, ["run"], { FAKE_MODE: "ratelimit" });
  assert.match(r.out, /\(rate-limited\)/);
});

test("plan parser: OpenSpec-style numbered sub-headings under a Tasks heading", () => {
  const openspec = `# Tasks
## 1. Setup
- [ ] 1.1 Create project skeleton
- [x] 1.2 Add CI
## 2. Implementation Tasks
- [ ] 2.1 Build API
  - Accept: curl works
## Notes
- [ ] this is not a task
`;
  const { dir } = freshRepo(openspec);
  const s = relay(dir, ["status"]).out;
  assert.match(s, /1 done \/ 2 open \/ 0 skipped \(total 3\)/);
  assert.match(relay(dir, ["next"]).out, /1\.1 Create project skeleton/);
});

test("dry-run prints the worker prompt with the task body and does not touch git", () => {
  const { dir, log } = freshRepo(PLAN);
  const r = relay(dir, ["run", "--dry-run"]);
  assert.match(r.out, /## Your task\n\nT1: first\n  - Accept: out-T1\.txt exists/);
  assert.equal(log()[0], "plan");
});
