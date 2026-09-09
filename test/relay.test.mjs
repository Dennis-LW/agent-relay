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

test("per-role models reach the agent: {model} in a custom command, RELAY_MODEL in env, model recorded per run", () => {
  const { dir } = freshRepo(PLAN, {
    model: "default-m",
    models: { worker: "worker-m", review: "review-m" },
    command: [process.execPath, FAKE, "--model", "{model}"],
  });
  const r = relay(dir, ["run"]);
  assert.equal(r.code, 0, r.out);
  const calls = fs.readFileSync(path.join(dir, ".relay", "fake-calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byRole = Object.fromEntries(calls.map((c) => [c.role, c]));
  assert.deepEqual(byRole.worker.argv, ["--model", "worker-m"]);
  assert.equal(byRole.worker.model, "worker-m");
  assert.deepEqual(byRole.review.argv, ["--model", "review-m"]);
  assert.deepEqual(byRole.accept.argv, ["--model", "default-m"], "unset role falls back to `model`");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(state.runs.find((x) => x.kind === "review").model, "review-m");
  assert.match(relay(dir, ["status"]).out, /worker=worker-m\s+review=review-m\s+accept=default-m/);
});

test("custom command: a bare {model} argument and its flag are dropped when no model is set", () => {
  const { dir } = freshRepo(PLAN, { command: [process.execPath, FAKE, "--model", "{model}", "--x"] });
  relay(dir, ["run", "--once"]);
  const call = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "fake-calls.log"), "utf8").trim().split("\n")[0]);
  assert.deepEqual(call.argv, ["--x"]);
});

test("relay init --models validates roles and writes them; relay plan runs one session on the plan model", () => {
  const { dir } = freshRepo(PLAN);
  const bad = relay(dir, ["init", "--models", "planner=x"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /unknown role "planner"/);
  const ok = relay(dir, ["init", "--models", "plan=plan-m,worker=w-m"]);
  assert.equal(ok.code, 0, ok.out);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "config.json"), "utf8"));
  assert.deepEqual(cfg.models, { plan: "plan-m", worker: "w-m", review: "", accept: "" });
  assert.deepEqual(cfg.command, [process.execPath, FAKE], "init keeps existing config keys");

  const r = relay(dir, ["plan", "build", "a", "widget"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /plan written: .relay\/PLAN.md \(2 open tasks\)/);
  assert.match(fs.readFileSync(path.join(dir, ".relay", "PLAN.md"), "utf8"), /^# Plan: build a widget/);
  const call = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "fake-calls.log"), "utf8").trim().split("\n").pop());
  assert.equal(call.kind, "plan");
  assert.equal(call.model, "plan-m");
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(st.runs.at(-1).kind, "plan", "plan session usage is recorded like any other");
  assert.equal(st.runs.at(-1).model, "plan-m");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).includes("PLAN.md"), true, "plan is left uncommitted for review");
});

test("per-role efforts: {effort} in a custom command, RELAY_EFFORT in env, fallback to `effort`", () => {
  const { dir } = freshRepo(PLAN, {
    effort: "medium",
    efforts: { worker: "low", review: "high" },
    command: [process.execPath, FAKE, "--effort", "{effort}", "--model", "{model}"],
  });
  const r = relay(dir, ["run"]);
  assert.equal(r.code, 0, r.out);
  const calls = fs.readFileSync(path.join(dir, ".relay", "fake-calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byRole = Object.fromEntries(calls.map((c) => [c.role, c]));
  assert.deepEqual(byRole.worker.argv, ["--effort", "low"], "no model set: --model {model} dropped");
  assert.equal(byRole.worker.effort, "low");
  assert.deepEqual(byRole.review.argv, ["--effort", "high"]);
  assert.deepEqual(byRole.accept.argv, ["--effort", "medium"]);
  assert.match(relay(dir, ["status"]).out, /worker=\(cli default\)\/low\s+review=\(cli default\)\/high/);
  const init = relay(dir, ["init", "--efforts", "plan=high,bogus=x"]);
  assert.equal(init.code, 1);
  assert.match(init.out, /--efforts: unknown role "bogus"/);
});
