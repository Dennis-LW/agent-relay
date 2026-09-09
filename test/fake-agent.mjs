#!/usr/bin/env node
// A token-free stand-in for an agent CLI. Reads the prompt on stdin and acts
// according to RELAY_KIND and FAKE_MODE so the runner loop can be tested in
// milliseconds without calling any model.
//   FAKE_MODE=ok       worker ticks + commits, review appends one R task, accept passes
//   FAKE_MODE=noop     does nothing (worker "forgot" to tick/commit)
//   FAKE_MODE=denied   like noop but reports a permission denial for git commit
//   FAKE_MODE=quota    is_error with a result text mentioning "quota" (must NOT look rate-limited)
//   FAKE_MODE=ratelimit real Claude Code usage-limit message
import fs from "node:fs";
import { execSync } from "node:child_process";

const kind = process.env.RELAY_KIND || "";
const mode = process.env.FAKE_MODE || "ok";
const promptText = fs.readFileSync(0, "utf8");
const plan = ".relay/PLAN.md";
// Record how we were invoked so tests can assert per-role models.
fs.mkdirSync(".relay", { recursive: true });
// In parallel mode each worker runs in its own worktree, so log to the shared file via FAKE_LOG.
const callLog = process.env.FAKE_LOG || ".relay/fake-calls.log";
fs.appendFileSync(callLog, JSON.stringify({ kind, role: process.env.RELAY_ROLE, model: process.env.RELAY_MODEL, effort: process.env.RELAY_EFFORT, argv: process.argv.slice(2), cwd: process.cwd(), at: Date.now() }) + "\n");
const sh = (c) => execSync(c, { stdio: "pipe" });
const out = (o) => console.log(JSON.stringify(o));
const usage = { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 300 };
const okJson = { result: "ok", is_error: false, total_cost_usd: 0.01, num_turns: 3, duration_ms: 1200, usage, modelUsage: { fake: {} } };

function main() {
if (mode === "noop") return out(okJson);
if (mode === "denied")
  return out({ ...okJson, permission_denials: [{ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m 'T1: x'" } }] });
if (mode === "quota") return out({ result: "Task is to implement a per-user quota check; tests are broken so I stopped.", is_error: true });
if (mode === "oldcli")
  return out({ result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.63 does not support this model; version 2.1.251 or newer is required.","details":{"error_code":"claude_code_version_too_old"}}}', is_error: true });
if (mode === "ratelimit") return out({ result: "Claude AI usage limit reached|1757400000", is_error: true });

if (kind === "plan") {
  const m = promptText.match(/## Request\n\n(.+)/);
  fs.writeFileSync(plan, `# Plan: ${m ? m[1] : "?"}\n\n## Goal\nx\n\n## Verify\n\`true\`\n\n## Tasks\n- [ ] T1: one\n  - Accept: a\n- [ ] T2: two\n  - Accept: b\n`);
  fs.writeFileSync(".relay/CONTEXT.md", "# Context\n\nfake project brief\n");
} else if (kind.startsWith("worker-")) {
  const id = kind.slice("worker-".length);
  fs.writeFileSync(`out-${id}.txt`, `work for ${id}\n`);
  if (process.env.FAKE_SHARED) fs.writeFileSync("shared.txt", `${id}\n`); // provoke a real merge conflict
  if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));
  const s = fs.readFileSync(plan, "utf8");
  const re = new RegExp(`^- \\[ \\] (${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:.].*)$`, "m");
  fs.writeFileSync(plan, s.replace(re, "- [x] $1"));
  fs.writeFileSync(".relay/HANDOFF.md", `# Handoff\n\ndid ${id}\n`);
  sh(`git add -A && git commit -qm "${id}: done"`);
} else if (kind === "review") {
  fs.mkdirSync(".relay/reviews", { recursive: true });
  fs.writeFileSync(".relay/reviews/review-test.md", "1 finding\n");
  fs.appendFileSync(plan, "- [ ] R1: fix something found in review\n  - Accept: out-R1.txt exists\n");
  sh(`git add -A && git commit -qm "review: 1 findings"`);
} else if (kind === "accept") {
  const reviewed = /have NOT been reviewed yet/.test(promptText);
  if (reviewed) {
    fs.mkdirSync(".relay/reviews", { recursive: true });
    fs.writeFileSync(".relay/reviews/review-accept.md", "reviewed inside acceptance\n");
  }
  fs.writeFileSync(".relay/ACCEPTANCE.md", `PASS (reviewed-inline: ${reviewed})\n`);
  let n = 0;
  if (process.env.FAKE_ACCEPT_ADD) {
    fs.appendFileSync(plan, "- [ ] A1: follow-up from acceptance\n  - Accept: out-A1.txt exists\n");
    n = 1;
  }
  sh(`git add -A && git commit -qm "acceptance: PASS (${n} follow-ups)"`);
} else if (kind === "recheck") {
  const m = promptText.match(/Follow-up tasks to re-verify:\n\n([\s\S]*?)\n\n## Project context/);
  fs.appendFileSync(".relay/ACCEPTANCE.md", `## Recheck\n${m ? m[1] : "(no followups block)"}\n`);
  sh(`git add -A && git commit -qm "recheck: PASS (0 follow-ups)"`);
} else if (kind === "plan") {
  // handled above
}
out(okJson);
}
main();
