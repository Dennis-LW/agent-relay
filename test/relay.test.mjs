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
  // T3 and R1 are unreviewed when the list empties: the acceptance session reviews them inline (no separate review session)
  assert.deepEqual(log(), ["acceptance: PASS (0 follow-ups)", "R1: done", "T3: done", "review: 1 findings", "T2: done", "T1: done", "plan", "init"]);
  assert.match(fs.readFileSync(path.join(dir, ".relay", "ACCEPTANCE.md"), "utf8"), /reviewed-inline: true/);
  assert.equal(fs.existsSync(path.join(dir, ".relay", "reviews", "review-accept.md")), true);
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

test("review range starts after the last clean-context session's own commit", () => {
  const { dir } = freshRepo(PLAN);
  const subjectAt = (sha) => execFileSync("git", ["log", "-1", "--format=%s", sha], { cwd: dir, encoding: "utf8" }).trim();
  // two workers then the review gate: lastReviewHead must point at the review commit itself
  relay(dir, ["run", "--once"]);
  relay(dir, ["run", "--once"]);
  relay(dir, ["run", "--once"]);
  let state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(subjectAt(state.lastReviewHead), "review: 1 findings");
  relay(dir, ["run"]);
  state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(subjectAt(state.lastReviewHead), "acceptance: PASS (0 follow-ups)", "acceptance also counts as a review point");
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
  assert.deepEqual(cfg.models, { plan: "plan-m", worker: "w-m", review: "", accept: "", recheck: "" });
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

test("a CLI/model configuration error stops the runner at once instead of retrying", () => {
  const { dir } = freshRepo(PLAN, { maxConsecutiveFailures: 5 });
  const r = relay(dir, ["run"], { FAKE_MODE: "oldcli" });
  assert.match(r.out, /configuration error; retrying cannot help/);
  assert.match(r.out, /claude_code_version_too_old/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "state.json"), "utf8"));
  assert.equal(state.runs.length, 1);
});

test("acceptance follow-ups are re-verified by a recheck session on the worker model, scoped to the new tasks", () => {
  const { dir, log } = freshRepo(PLAN, { reviewEvery: 0, models: { worker: "w-m", accept: "a-m" }, command: [process.execPath, FAKE, "--model", "{model}"] });
  const r = relay(dir, ["run"], { FAKE_ACCEPT_ADD: "1" });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(log().slice(0, 3), ["recheck: PASS (0 follow-ups)", "A1: done", "acceptance: PASS (1 follow-ups)"]);
  const calls = fs.readFileSync(path.join(dir, ".relay", "fake-calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rc = calls.find((c) => c.kind === "recheck");
  assert.equal(rc.role, "recheck");
  assert.deepEqual(rc.argv, ["--model", "w-m"], "recheck falls back to the worker model");
  assert.equal(calls.find((c) => c.kind === "accept").argv[1], "a-m");
  const acc = fs.readFileSync(path.join(dir, ".relay", "ACCEPTANCE.md"), "utf8");
  assert.match(acc, /## Recheck\n- A1: follow-up from acceptance/);
  assert.doesNotMatch(acc.split("## Recheck")[1], /T1:/, "recheck scope excludes tasks accepted in round 1");
  assert.match(acc, /reviewed-inline: false/, "reviewEvery=0 means no inline review either");
  assert.match(r.out, /recheck round 2\/2/);
});

test("CONTEXT.md written by the plan session is injected into worker prompts", () => {
  const { dir } = freshRepo(PLAN);
  relay(dir, ["init", "--models", "plan=p"]);
  relay(dir, ["plan", "anything"]);
  assert.equal(fs.readFileSync(path.join(dir, ".relay", "CONTEXT.md"), "utf8").includes("fake project brief"), true);
  const dry = relay(dir, ["run", "--dry-run"]).out;
  assert.match(dry, /## Project context\n\n# Context\n\nfake project brief/);
});

test("relay add inserts a task (end, or after an id), commits only the plan, and the running loop picks it up", () => {
  const { dir, log } = freshRepo(PLAN);
  let r = relay(dir, ["add", "extra", "work", "--accept", "out-T4.txt exists"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /added T4: extra work, committed/);
  r = relay(dir, ["add", "squeeze in", "--after", "T1", "--id", "T9", "--accept", "out-T9.txt exists"]);
  assert.match(r.out, /added T9: squeeze in \(after T1\), committed/);
  const plan = fs.readFileSync(path.join(dir, ".relay", "PLAN.md"), "utf8");
  const ids = [...plan.matchAll(/^- \[ \] (T\d+):/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ["T1", "T9", "T2", "T3", "T4"]);
  assert.equal(log()[0], "plan: add T9");
  assert.equal(relay(dir, ["add", "dup", "--id", "T9"]).code, 1);
  // insert while the runner is between tasks: the next loop iteration sees it
  relay(dir, ["run", "--once"]);
  relay(dir, ["add", "late", "--after", "T9", "--id", "T5", "--accept", "x"]);
  assert.match(relay(dir, ["next"]).out, /^T9: squeeze in/);
  r = relay(dir, ["run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(relay(dir, ["status"]).out, / 0 open \/ 0 skipped/);
  for (const id of ["T4", "T9", "T5"]) assert.equal(fs.existsSync(path.join(dir, `out-${id}.txt`)), true, `${id} was executed`);
});

test("relay init --profile applies review cadence and is reported", () => {
  const { dir } = freshRepo(PLAN);
  assert.equal(relay(dir, ["init", "--profile", "medium"]).code, 1);
  relay(dir, ["init", "--profile", "light"]);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".relay", "config.json"), "utf8"));
  assert.equal(cfg.reviewEvery, 0);
  assert.equal(cfg.profile, "light");
  assert.match(relay(dir, ["status"]).out, /Profile:\s+light \(review every ∞/);
  relay(dir, ["init", "--profile", "thorough"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".relay", "config.json"), "utf8")).reviewEvery, 1);
});

const PAR_PLAN = `# Plan: parallel

## Verify
\`true\`

## Tasks
- [ ] T1: base
- [ ] T2: independent
  - Depends: none
  - Accept: out-T2.txt exists
- [ ] T3: needs both
  - Accept: out-T3.txt exists
  - Depends: T1, T2
`;

test("parallel: independent tasks run concurrently in worktrees, adjacent plan ticks auto-merge, dependents wait", () => {
  const { dir, log } = freshRepo(PAR_PLAN, { parallel: 2, reviewEvery: 0, acceptance: false });
  const logFile = path.join(dir, "calls.log");
  const r = relay(dir, ["run"], { FAKE_LOG: logFile, FAKE_SLEEP_MS: "400" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /parallel batch: T1, T2/);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const t1 = calls.find((c) => c.kind === "worker-T1");
  const t2 = calls.find((c) => c.kind === "worker-T2");
  const t3 = calls.find((c) => c.kind === "worker-T3");
  const real = (p) => fs.realpathSync(p);
  assert.notEqual(t1.cwd, t2.cwd, "each worker gets its own worktree");
  assert.ok(/relay-wt-/.test(t1.cwd) && /relay-wt-/.test(t2.cwd), "workers ran in temporary worktrees");
  assert.ok(Math.abs(t1.at - t2.at) < 350, `T1 and T2 started together (${Math.abs(t1.at - t2.at)}ms apart)`);
  assert.ok(t3.at > Math.max(t1.at, t2.at) + 350, "T3 waited for both");
  assert.equal(real(t3.cwd), real(dir), "a lone runnable task runs sequentially in the main tree");
  for (const id of ["T1", "T2", "T3"]) assert.equal(fs.existsSync(path.join(dir, `out-${id}.txt`)), true, `${id} merged`);
  assert.match(relay(dir, ["status"]).out, /3 done \/ 0 open/);
  assert.match(r.out, /task T2 done.*auto-resolved .*\.relay\/PLAN\.md/, "adjacent tick lines conflict and are resolved");
  const planAfter = fs.readFileSync(path.join(dir, ".relay", "PLAN.md"), "utf8");
  assert.equal((planAfter.match(/^- \[x\]/gm) || []).length, 3, "all three ticks survive the auto-merge");
  assert.doesNotMatch(planAfter, /<<<<<<<|>>>>>>>/);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 1, "worktrees cleaned up");
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: dir, encoding: "utf8" }), /relay\//);
  // the batch leaves one combined note (T3 then overwrites it, as any later worker does)
  assert.ok(log().includes("handoff: combine T1, T2"), log().join(" | "));
  const combined = execFileSync("git", ["show", "HEAD~1:.relay/HANDOFF.md"], { cwd: dir, encoding: "utf8" });
  assert.match(combined, /## From T1\n\ndid T1/, "T1's handoff survives the batch");
  assert.match(combined, /## From T2\n\ndid T2/);
});

test("parallel: a real file conflict aborts that merge and the task is retried alone", () => {
  const { dir } = freshRepo(PAR_PLAN, { parallel: 2, reviewEvery: 0, acceptance: false });
  const r = relay(dir, ["run"], { FAKE_SHARED: "1", FAKE_LOG: path.join(os.tmpdir(), `relay-calls-${process.pid}.log`) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /task T2: merge conflict in shared.txt; will retry alone/);
  assert.match(r.out, /\] task T2: independent\n/, "T2 re-run sequentially afterwards");
  assert.match(relay(dir, ["status"]).out, /3 done \/ 0 open/);
  assert.equal(fs.readFileSync(path.join(dir, "shared.txt"), "utf8").trim(), "T3");
});

const AUTO_PLAN = `# Plan: auto

## Verify
\`true\`

## Tasks
- [ ] T1: store
  - Files: src/store.mjs, test/store.test.mjs
  - Depends: none
- [ ] T2: logic
  - Files: src/todos.mjs
  - Depends: none
- [ ] T3: readme touches store dir
  - Files: README.md, src/
  - Depends: none
- [ ] T4: no files line
  - Depends: none
- [ ] T5: wiring
  - Files: bin/todo.mjs
  - Depends: T1, T2
`;

test("parallel auto: batches only tasks with satisfied Depends and disjoint Files; unknown Files stay sequential", () => {
  const { dir } = freshRepo(AUTO_PLAN, { parallel: "auto", parallelMax: 3, reviewEvery: 0, acceptance: false });
  const r = relay(dir, ["run"], { FAKE_LOG: path.join(os.tmpdir(), `relay-auto-${process.pid}.log`) });
  assert.equal(r.code, 0, r.out);
  // batch 1: T3's "src/" overlaps T1/T2's files and T4 has no Files line, so both are left out.
  // batch 2: T3 and T5 (deps now satisfied) are disjoint; T4 (unknown files) still runs alone.
  assert.match(r.out, /parallel batch: T1, T2 \(auto: independent, disjoint Files\)/);
  const batches = [...r.out.matchAll(/parallel batch: ([^\n(]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(batches, ["T1, T2", "T3, T5"]);
  assert.match(r.out, /\] task T4: no files line\n/, "T4 ran sequentially");
  assert.match(relay(dir, ["status"]).out, /5 done \/ 0 open/);
  // a plan without Depends lines never goes parallel in auto mode
  const { dir: seq } = freshRepo(PLAN, { parallel: "auto", reviewEvery: 0, acceptance: false });
  assert.doesNotMatch(relay(seq, ["run"]).out, /parallel batch/);
  assert.match(relay(seq, ["status"]).out, /3 done \/ 0 open/);
});

test("parallel auto: stays sequential for an hour after a rate limit", () => {
  const { dir } = freshRepo(AUTO_PLAN, { parallel: "auto", reviewEvery: 0, acceptance: false });
  const sp = path.join(dir, ".relay", "state.json");
  fs.writeFileSync(sp, JSON.stringify({ lastRateLimitAt: new Date().toISOString(), runs: [] }));
  const r = relay(dir, ["run", "--once"]);
  assert.doesNotMatch(r.out, /parallel batch/);
  assert.match(r.out, /task T1 done/);
});
