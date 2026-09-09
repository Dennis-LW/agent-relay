#!/usr/bin/env node
// A/B benchmark: the same plan built by (a) a relay of fresh sessions and
// (b) one long `claude -p` session, N times each, on throw-away git repos.
// Records tokens/cost per arm, runs the plan's Verify command, and asks a
// clean judge session to grade the resulting diff.
//
//   node bench/bench.mjs --yes [--plan bench/plans/todo-cli.md | --describe "<what to build>" --verify "<cmd>"]
//                        [--arms relay,single]
//                        [--runs 1] [--model claude-sonnet-5] [--models worker=a,review=b,accept=c]
//                        [--efforts worker=medium,review=high] [--judge-model <model>]
//                        [--out bench/results/<timestamp>] [--keep]
//
// This spends real tokens. Without --yes it only prints the estimate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RELAY = path.join(ROOT, "skills", "relay", "scripts", "relay.mjs");

const args = parse(process.argv.slice(2));
const planFile = path.resolve(args.plan || path.join(HERE, "plans", "todo-cli.md"));
const arms = (args.arms || "relay,single").split(",").map((s) => s.trim());
const runs = Number(args.runs || 1);
const model = args.model || "claude-sonnet-5";
// --models worker=a,review=b,accept=c overrides --model per role for the relay arm
const roleModels = Object.fromEntries((args.models ? String(args.models).split(",") : []).map((kv) => kv.split("=").map((x) => x.trim())));
const roleEfforts = Object.fromEntries((args.efforts ? String(args.efforts).split(",") : []).map((kv) => kv.split("=").map((x) => x.trim())));
const judgeModel = args["judge-model"] || roleModels.review || model;
const outDir = path.resolve(args.out || path.join(HERE, "results", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
const timeoutMin = Number(args.timeout || 45);

// --describe: instead of a fixed plan, each relay repo gets its plan written by a
// `relay plan` session on the plan role's model, so planning is measured too.
const describe = args.describe ? String(args.describe) : "";
const planText = describe ? "" : fs.readFileSync(planFile, "utf8");
const tasks = describe ? Number(args["expect-tasks"] || 5) : (planText.match(/^- \[ \] /gm) || []).length;
const verify = describe ? String(args.verify || "node --test") : (planText.match(/^#{1,6}\s+verify\s*\n+\s*`?([^`\n]+)`?/im) || [])[1]?.trim() || "";
if (!tasks || !verify) die("plan needs '- [ ]' tasks and a '## Verify' section (or use --describe with --verify)");
if (describe && arms.includes("single")) die("--describe only supports the relay arm (the single arm needs a fixed plan)");

// Rough, deliberately pessimistic: ~$0.60 per Sonnet worker session on a small task.
const workerModel = roleModels.worker || model;
const perSession = /haiku/i.test(workerModel) ? 0.15 : /fable|mythos/i.test(workerModel) ? 5 : /opus/i.test(workerModel) ? 2.5 : 0.6;
const relaySessions = tasks + Math.ceil(tasks / 3) + 1;
const est = { relay: relaySessions * perSession, single: perSession * Math.max(2, tasks * 0.6) };
const judgeEst = 0.3 * arms.length * runs;
const total = arms.reduce((s, a) => s + (est[a] || 0), 0) * runs + judgeEst;
console.log(describe ? `describe: ${describe} (planned by models.plan; ~${tasks} tasks expected, verify: ${verify})` : `plan: ${path.relative(ROOT, planFile)} (${tasks} tasks, verify: ${verify})`);
console.log(`arms: ${arms.join(", ")} × ${runs} run(s), model ${model}${Object.keys(roleModels).length ? ` (relay roles: ${Object.entries(roleModels).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}, judge ${judgeModel}`);
console.log(`rough cost estimate: ~$${total.toFixed(0)} (${arms.map((a) => `${a} ≈ $${(est[a] || 0).toFixed(1)}/run`).join(", ")}, judge ≈ $${judgeEst.toFixed(1)})`);
console.log(`note: on a subscription this is drawn from your usage limit instead of billed.`);
if (!args.yes) {
  console.log("\nre-run with --yes to start.");
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });

const results = [];
for (let run = 1; run <= runs; run++) {
  for (const arm of arms) {
    const label = `${arm}-${run}`;
    console.log(`\n=== ${label} ===`);
    const repo = seedRepo(label);
    const t0 = Date.now();
    let usage;
    if (arm === "relay") usage = runRelay(repo);
    else if (arm === "single") usage = runSingle(repo);
    else die(`unknown arm ${arm}`);
    const wallMs = Date.now() - t0;
    const verifyRes = spawnSync(verify, { cwd: repo, shell: true, encoding: "utf8" });
    const base = git(repo, ["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0];
    const commits = Number(git(repo, ["rev-list", "--count", `${base}..HEAD`]));
    const diffStat = git(repo, ["diff", "--shortstat", base, "HEAD"]);
    const plan = fs.readFileSync(path.join(repo, ".relay", "PLAN.md"), "utf8");
    const ticked = (plan.match(/^- \[x\]/gim) || []).length;
    const totalTasks = (plan.match(/^- \[[ x-]\]/gim) || []).length;
    console.log(`verify ${verifyRes.status === 0 ? "PASS" : "FAIL"}; ${ticked}/${totalTasks} ticked; ${commits} commits; ${diffStat}`);
    const judge = runJudge(repo, base);
    const row = { label, arm, run, repo, wallMs, usage, verifyPass: verifyRes.status === 0, ticked, totalTasks, commits, diffStat, judge };
    results.push(row);
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(outDir, `${label}.verify.txt`), verifyRes.stdout + verifyRes.stderr);
    if (!args.keep) fs.rmSync(repo, { recursive: true, force: true }), (row.repo = "(deleted; use --keep)");
  }
}
fs.writeFileSync(path.join(outDir, "summary.md"), summary(results));
console.log(`\n${summary(results)}\nwritten to ${path.relative(process.cwd(), outDir)}/`);

// ---------------------------------------------------------------------------

function seedRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-bench-${label}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "bench@relay"]);
  git(dir, ["config", "user.name", "bench"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bench-target", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"), 'import { test } from "node:test";\ntest("smoke", () => {});\n');
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\ntodos.json\n.relay/logs/\n.relay/state.json\n.relay/runner.*\n");
  fs.mkdirSync(path.join(dir, ".relay"));
  fs.writeFileSync(path.join(dir, ".relay", "PLAN.md"), planText || "# Plan\n\n## Tasks\n");
  fs.writeFileSync(path.join(dir, ".relay", "HANDOFF.md"), "# Handoff\n\n(no sessions have run yet)\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init: seed + plan"]);
  return dir;
}

function runRelay(repo) {
  fs.writeFileSync(
    path.join(repo, ".relay", "config.json"),
    JSON.stringify({ agent: "claude", model, models: roleModels, efforts: roleEfforts, verify, reviewEvery: 3, acceptance: true, sessionTimeoutMinutes: timeoutMin, maxConsecutiveFailures: 2 }, null, 2),
  );
  if (describe) {
    const p = spawnSync(process.execPath, [RELAY, "plan", describe], { cwd: repo, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] });
    fs.writeFileSync(path.join(outDir, `${path.basename(repo)}.plan.log`), p.stdout);
    if (p.status !== 0) console.error(`plan session failed (exit ${p.status}); continuing with whatever was written`);
    console.log(p.stdout.trim().split("\n").filter((l) => /^\s+\[/.test(l)).join("\n"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "plan: written by relay plan session"]);
  }
  const r = spawnSync(process.execPath, [RELAY, "run"], { cwd: repo, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] });
  fs.writeFileSync(path.join(outDir, `${path.basename(repo)}.runner.log`), r.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".relay", "state.json"), "utf8"));
  const u = { sessions: 0, costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 };
  for (const x of state.runs) {
    if (x.costUsd == null && !x.tokens) continue;
    u.sessions++;
    u.costUsd += x.costUsd || 0;
    u.turns += x.turns || 0;
    for (const k of ["input", "cacheRead", "cacheWrite", "output"]) u[k] += x.tokens?.[k] || 0;
  }
  u.byKind = state.runs.map((x) => ({ kind: x.kind, outcome: x.outcome, model: x.model, effort: x.effort, costUsd: x.costUsd, output: x.tokens?.output, turns: x.turns, durationMs: x.durationMs }));
  return u;
}

function runSingle(repo) {
  const prompt = `You are implementing a plan in one session. Read \`.relay/PLAN.md\` (goal, constraints, verify command, task list).
Work through the tasks IN ORDER. For each task: implement it, run \`${verify}\` and fix failures, commit with a message starting with the task id, then tick the task in .relay/PLAN.md (\`- [ ]\` → \`- [x]\`) and include that edit in the commit. Never amend or push. When every task is ticked and \`${verify}\` passes, stop.`;
  const res = claude(repo, prompt, model, ["--permission-mode", "acceptEdits", "--allowedTools", allowedTools()], timeoutMin);
  fs.writeFileSync(path.join(outDir, `${path.basename(repo)}.single.json`), JSON.stringify(res.parsed, null, 2));
  const p = res.parsed || {};
  const uu = p.usage || {};
  return {
    sessions: 1,
    costUsd: p.total_cost_usd || 0,
    input: uu.input_tokens || 0,
    cacheRead: uu.cache_read_input_tokens || 0,
    cacheWrite: uu.cache_creation_input_tokens || 0,
    output: uu.output_tokens || 0,
    turns: p.num_turns || 0,
    isError: !!p.is_error || res.code !== 0,
    denials: (p.permission_denials || []).length,
  };
}

function runJudge(repo, base) {
  const schema = JSON.stringify({
    type: "object",
    properties: {
      score: { type: "integer", minimum: 1, maximum: 10 },
      goal_met: { type: "boolean" },
      defects: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, file: { type: "string" }, issue: { type: "string" } }, required: ["severity", "issue"] } },
      scope_creep: { type: "boolean" },
      notes: { type: "string" },
    },
    required: ["score", "goal_met", "defects", "scope_creep", "notes"],
  });
  const prompt = `You are grading the output of an autonomous coding agent. Read \`.relay/PLAN.md\` for the goal, constraints and acceptance criteria, then inspect the code (\`git diff ${base}..HEAD\`, run \`${verify}\`, read the tests). Do NOT modify anything. Grade strictly as a senior reviewer: score 1-10 for how well the goal and every Accept line are actually met, list concrete defects with severity high/medium/low, flag scope creep or constraint violations.`;
  const res = claude(repo, prompt, judgeModel, ["--permission-mode", "plan", "--allowedTools", `Bash(git:*) Bash(${verify}) Bash(${verify}:*) Read Grep Glob`, "--json-schema", schema], 15);
  const p = res.parsed || {};
  let verdict = p.structured_output ?? null;
  if (!verdict && typeof p.result === "string") {
    try {
      verdict = JSON.parse(p.result);
    } catch {}
  }
  return { verdict, costUsd: p.total_cost_usd || 0, raw: verdict ? undefined : p.result };
}

function claude(cwd, prompt, mdl, extra, minutes) {
  const r = spawnSync("claude", ["-p", "--output-format", "json", "--model", mdl, ...extra], {
    cwd,
    input: prompt,
    encoding: "utf8",
    env: cleanEnv(),
    timeout: minutes * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  try {
    const i = (r.stdout || "").indexOf("{");
    parsed = i >= 0 ? JSON.parse(r.stdout.slice(i)) : null;
  } catch {}
  if (!parsed) console.error(`(claude returned no JSON; exit ${r.status}) ${(r.stderr || "").slice(0, 300)}`);
  return { code: r.status, parsed, stderr: r.stderr };
}

function allowedTools() {
  return ["Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(mkdir:*)", `Bash(${verify})`, `Bash(${verify}:*)`].join(" ");
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

function git(cwd, a) {
  return execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
}

function summary(rows) {
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
  const lines = [
    `# relay benchmark — ${describe ? `"${describe}"` : path.basename(planFile)}, model ${model}${Object.keys(roleModels).length ? ` (${Object.entries(roleModels).map(([a, b]) => `${a}=${b}`).join(" ")})` : ""}${Object.keys(roleEfforts).length ? ` efforts ${Object.entries(roleEfforts).map(([a, b]) => `${a}=${b}`).join(" ")}` : ""}, judge ${judgeModel}`,
    "",
    "| run | arm | verify | ticked | commits | sessions | turns | cost | out tokens | cache read | cache write | wall | judge score | defects (h/m/l) | scope creep |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const v = r.judge?.verdict;
    const d = v?.defects || [];
    const cnt = (s) => d.filter((x) => (x.severity || "").toLowerCase().startsWith(s)).length;
    lines.push(
      `| ${r.run} | ${r.arm} | ${r.verifyPass ? "PASS" : "FAIL"} | ${r.ticked}/${r.totalTasks} | ${r.commits} | ${r.usage.sessions} | ${r.usage.turns} | $${r.usage.costUsd.toFixed(2)} | ${k(r.usage.output)} | ${k(r.usage.cacheRead)} | ${k(r.usage.cacheWrite)} | ${(r.wallMs / 60000).toFixed(1)}m | ${v ? v.score : "?"} | ${cnt("h")}/${cnt("m")}/${cnt("l")} | ${v ? (v.scope_creep ? "yes" : "no") : "?"} |`,
    );
  }
  const byArm = {};
  for (const r of rows) (byArm[r.arm] ||= []).push(r);
  lines.push("", "## Averages per arm", "");
  for (const [arm, rs] of Object.entries(byArm)) {
    const avg = (f) => rs.reduce((s, r) => s + (f(r) || 0), 0) / rs.length;
    lines.push(
      `- **${arm}**: verify pass ${rs.filter((r) => r.verifyPass).length}/${rs.length}, cost $${avg((r) => r.usage.costUsd).toFixed(2)}, out tokens ${k(avg((r) => r.usage.output))}, judge ${avg((r) => r.judge?.verdict?.score).toFixed(1)}, high defects ${avg((r) => (r.judge?.verdict?.defects || []).filter((d) => /^h/i.test(d.severity)).length).toFixed(1)}`,
    );
  }
  for (const r of rows) {
    if (!r.usage.byKind) continue;
    lines.push("", `## ${r.label} sessions`, "", "| session | model/effort | outcome | turns | out tokens | cost | wall |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const x of r.usage.byKind)
      lines.push(`| ${x.kind} | ${x.model || "default"}${x.effort ? "/" + x.effort : ""} | ${x.outcome} | ${x.turns ?? ""} | ${x.output != null ? k(x.output) : ""} | ${x.costUsd != null ? "$" + x.costUsd.toFixed(2) : ""} | ${x.durationMs ? (x.durationMs / 60000).toFixed(1) + "m" : ""} |`);
  }
  lines.push("", "Judge notes:", "");
  for (const r of rows) if (r.judge?.verdict) lines.push(`- ${r.label}: ${r.judge.verdict.notes}`);
  return lines.join("\n") + "\n";
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) (o[k] = n), i++;
    else o[k] = true;
  }
  return o;
}
function die(m) {
  console.error(m);
  process.exit(2);
}
