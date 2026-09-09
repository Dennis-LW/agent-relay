#!/usr/bin/env node
// agent-relay — run long tasks as a relay of short, fresh agent sessions (Claude Code, Codex, Gemini or any CLI agent).
// Zero dependencies. Node >= 18. Works on macOS, Linux and Windows.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  plan: ".relay/PLAN.md",
  handoff: ".relay/HANDOFF.md",
  verify: "",
  agent: "claude", // claude | codex | gemini | custom
  command: [], // custom agent: argv, "{prompt}" is replaced by the prompt (or omit it to feed stdin)
  claude: "claude", // executable override for the selected preset
  model: "", // default model for every session kind (empty = the CLI's default)
  // Per-role overrides so planning, implementation and review can use different
  // models (e.g. a stronger model for plan/review, a cheaper one for workers).
  // Empty string = fall back to `model`, then to the CLI default.
  models: { plan: "", worker: "", review: "", accept: "" },
  // Reasoning effort, same fallback rules as models. Claude Code: --effort
  // (low|medium|high); Codex: -c model_reasoning_effort=<level>; custom: {effort};
  // Gemini has no equivalent and ignores it.
  effort: "",
  efforts: { plan: "", worker: "", review: "", accept: "" },
  permissionMode: "acceptEdits", // claude only
  // claude only: extra --allowedTools rules. Headless `-p` sessions cannot ask for
  // permission, so git and the verify command are always allowed (see claudeAllowedTools).
  allowedTools: [],
  extraArgs: [],
  sessionTimeoutMinutes: 45,
  reviewEvery: 3,
  acceptance: true,
  maxAcceptanceRounds: 2,
  maxConsecutiveFailures: 5,
  retryBaseMinutes: 5,
  retryMaxMinutes: 60,
  commitRequired: true,
  notes: "",
};

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

const log = (...a) => console.log(`[relay ${ts()}]`, ...a);
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
let seq = 0;
const fileTs = () => `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${String(++seq).padStart(2, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const exists = (p) => fs.existsSync(p);
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const readJson = (p, fallback) => {
  try {
    return JSON.parse(readText(p));
  } catch {
    return fallback;
  }
};
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project / config
// ---------------------------------------------------------------------------

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, ".relay", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadProject(cwd) {
  const root = findRoot(cwd);
  if (!root) {
    console.error("No .relay/config.json found. Run `relay init` in your project first.");
    process.exit(2);
  }
  const relayDir = path.join(root, ".relay");
  const cfg = { ...DEFAULT_CONFIG, ...readJson(path.join(relayDir, "config.json"), {}) };
  return {
    root,
    relayDir,
    cfg,
    planPath: path.resolve(root, cfg.plan),
    handoffPath: path.resolve(root, cfg.handoff),
    statePath: path.join(relayDir, "state.json"),
    pidPath: path.join(relayDir, "runner.pid"),
    logsDir: path.join(relayDir, "logs"),
  };
}

function loadState(p) {
  return readJson(p, {
    completedSinceReview: 0,
    consecutiveFailures: 0,
    acceptanceRounds: 0,
    lastReviewHead: "",
    runs: [],
    stopped: false,
  });
}

// ---------------------------------------------------------------------------
// PLAN.md parsing
// ---------------------------------------------------------------------------

const TASK_RE = /^- \[( |x|X|-)\] (.+)$/;

function parsePlan(planPath) {
  const text = readText(planPath);
  const lines = text.split("\n");
  const tasks = [];
  let cur = null;
  let inTasks = false;
  let tasksLevel = 0; // heading level of the "Tasks" section; deeper headings stay inside it
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (/\btasks?\b/i.test(h[2])) {
        inTasks = true;
        tasksLevel = level;
      } else if (!inTasks || level <= tasksLevel) {
        inTasks = false;
      }
      cur = null;
      continue;
    }
    const m = line.match(TASK_RE);
    if (m && inTasks) {
      const mark = m[1];
      const title = m[2].trim();
      const idm = title.match(/^([A-Za-z]+-?\d+)\s*[:.]\s*(.*)$/);
      cur = {
        index: tasks.length,
        line: i,
        status: mark === "-" ? "skipped" : mark === " " ? "open" : "done",
        id: idm ? idm[1] : `#${tasks.length + 1}`,
        title: idm ? idm[2] : title,
        raw: title,
        body: [],
      };
      tasks.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      cur.body.push(line.trim());
    } else if (line.trim() === "") {
      // keep body going across blank lines only if next line is indented
    } else {
      cur = null;
    }
  }
  const verifyMatch = text.match(/^#{1,6}\s+verify\s*\n+\s*`?([^`\n]+)`?/im);
  return { text, tasks, verify: verifyMatch ? verifyMatch[1].trim() : "" };
}

function nextOpenTask(plan) {
  return plan.tasks.find((t) => t.status === "open") || null;
}

function countTasks(plan) {
  const c = { open: 0, done: 0, skipped: 0 };
  for (const t of plan.tasks) c[t.status]++;
  return c;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const gitHead = (root) => git(root, ["rev-parse", "HEAD"]).out || "";

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? "").toString());
}

function loadPrompt(name) {
  return readText(path.join(SKILL_DIR, "prompts", `${name}.md`));
}

function baseVars(proj, plan) {
  const { cfg, root } = proj;
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  return {
    PLAN_PATH: rel(proj.planPath),
    HANDOFF_PATH: rel(proj.handoffPath),
    HANDOFF: exists(proj.handoffPath) ? readText(proj.handoffPath) : "(no handoff yet — this is the first session)",
    VERIFY: cfg.verify || plan.verify || "(no verify command configured — use the project's own test/build command)",
    NOTES: cfg.notes || "",
    PLATFORM: process.platform,
  };
}

// ---------------------------------------------------------------------------
// Running one Claude session
// ---------------------------------------------------------------------------

// Deliberately narrow: a worker whose *task* is about quotas or rate limits must not
// trigger the long exponential backoff. Matches the actual CLI/API error strings.
const RATE_LIMIT_RE = /usage limit reached|rate_limit_error|rate.?limit(?:ed)?\s+(?:reached|exceeded|hit)|too many requests|\b429\b|overloaded_error/i;

const ROLES = ["plan", "worker", "review", "accept"];
const roleOf = (kind) => (kind.startsWith("worker-") ? "worker" : kind);
function modelFor(cfg, role) {
  return (cfg.models && cfg.models[role]) || cfg.model || "";
}
function effortFor(cfg, role) {
  return (cfg.efforts && cfg.efforts[role]) || cfg.effort || "";
}

function runClaude(proj, prompt, kind, verify = "") {
  const { cfg, root, logsDir } = proj;
  const model = modelFor(cfg, roleOf(kind));
  const effort = effortFor(cfg, roleOf(kind));
  ensureDir(logsDir);
  const stamp = fileTs();
  const logBase = path.join(logsDir, `${stamp}-${kind}`);
  fs.writeFileSync(`${logBase}.prompt.md`, prompt);

  const { exe, args, viaStdin } = agentCommand(cfg, prompt, verify, model, effort);

  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: root,
      shell: IS_WIN, // resolves .cmd shims on Windows
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...childEnv(), CLAUDE_RELAY: "1", CLAUDE_RELAY_KIND: kind, RELAY_KIND: kind, RELAY_ROLE: roleOf(kind), RELAY_MODEL: model, RELAY_EFFORT: effort },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (viaStdin) child.stdin.end(prompt);
    else child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, cfg.sessionTimeoutMinutes * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        // json output is a single object; tolerate leading noise
        const start = stdout.indexOf("{");
        parsed = start >= 0 ? JSON.parse(stdout.slice(start)) : null;
      } catch {
        parsed = null;
      }
      const resultText = parsed?.result ?? stdout;
      const isError = code !== 0 || timedOut || parsed?.is_error === true;
      const rateLimited = RATE_LIMIT_RE.test(stderr) || (isError && RATE_LIMIT_RE.test(resultText.slice(0, 300)));
      const denials = (parsed?.permission_denials || []).map((d) => `${d.tool_name}(${d.tool_input?.command || JSON.stringify(d.tool_input || {})})`);
      const usage = summariseUsage(parsed);
      fs.writeFileSync(
        `${logBase}.result.md`,
        `# ${kind} — ${stamp}\n\nmodel: ${model || "(cli default)"}  effort: ${effort || "(cli default)"}  exit: ${code}  timedOut: ${timedOut}  rateLimited: ${rateLimited}\n` +
          `usage: ${usage ? JSON.stringify(usage) : "(not reported)"}\n` +
          (denials.length ? `permission denials: ${denials.join(", ")}\n` : "") +
          `\n## stdout\n\n${resultText}\n\n## stderr\n\n${stderr}\n`,
      );
      resolve({ code, timedOut, isError, rateLimited, resultText, stderr, costUsd: parsed?.total_cost_usd, usage, denials, logBase, model, effort });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.writeFileSync(`${logBase}.result.md`, `# ${kind} — spawn error\n\n${e.stack || e}\n`);
      resolve({ code: -1, timedOut: false, isError: true, rateLimited: false, resultText: "", stderr: String(e), usage: null, denials: [], logBase, model, effort });
    });
  });
}

// Build the argv for the configured agent CLI. Success is judged by side
// effects (tick + commit), so any CLI that can edit files and run commands
// unattended works here.
function agentCommand(cfg, prompt, verify = "", modelName = "", effort = "") {
  const extra = cfg.extraArgs || [];
  const model = modelName ? ["--model", modelName] : [];
  const claudeEffort = effort ? ["--effort", effort] : [];
  const codexEffort = effort ? ["-c", `model_reasoning_effort=${effort}`] : [];
  switch (cfg.agent) {
    case "claude": {
      const allowed = claudeAllowedTools(cfg, verify);
      return {
        exe: cfg.claude || "claude",
        args: [
          "-p",
          "--output-format",
          "json",
          "--permission-mode",
          cfg.permissionMode,
          ...(allowed.length ? ["--allowedTools", allowed.join(" ")] : []),
          ...model,
          ...claudeEffort,
          ...extra,
        ],
        viaStdin: true,
      };
    }
    case "codex":
      // OpenAI Codex CLI: `codex exec` runs non-interactively; "-" reads the prompt from stdin.
      return {
        exe: cfg.claude === "claude" ? "codex" : cfg.claude,
        args: ["exec", "--full-auto", ...model, ...codexEffort, ...extra, "-"],
        viaStdin: true,
      };
    case "gemini":
      // Google Gemini CLI: -p prompt, --yolo auto-approves tool calls.
      return {
        exe: cfg.claude === "claude" ? "gemini" : cfg.claude,
        args: ["--yolo", ...(modelName ? ["-m", modelName] : []), ...extra, "-p", prompt],
        viaStdin: false,
      };
    case "custom": {
      if (!cfg.command?.length) throw new Error('agent "custom" needs "command": [exe, ...args] in .relay/config.json');
      const hasPlaceholder = cfg.command.some((a) => a.includes("{prompt}"));
      // {model} / {effort} are substituted with the role's values. When a value is
      // not configured, an argument that is exactly the placeholder is dropped
      // together with the flag right before it (["--model", "{model}"] disappears).
      const subs = { "{model}": modelName, "{effort}": effort };
      const src = cfg.command.slice(1);
      const args = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        if (a in subs && !subs[a]) {
          if (args.length && args[args.length - 1].startsWith("-")) args.pop();
          continue;
        }
        let out = a.replace("{prompt}", prompt);
        for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
        args.push(out);
      }
      return { exe: cfg.command[0], args, viaStdin: !hasPlaceholder };
    }
    default:
      throw new Error(`unknown agent "${cfg.agent}" (claude | codex | gemini | custom)`);
  }
}

// In `claude -p` nobody can approve a permission prompt, so every Bash call that
// is not pre-allowed is silently denied. acceptEdits only covers file edits; the
// worker would create files but never commit. Allow the git verbs the contract
// requires, the verify command, and whatever the user adds in `allowedTools`.
function claudeAllowedTools(cfg, verify) {
  if (cfg.permissionMode === "bypassPermissions") return [];
  const rules = new Set([
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git checkout -- :*)",
    "Bash(git restore:*)",
    "Bash(mkdir:*)",
  ]);
  const v = (verify || "").trim();
  if (v && !v.startsWith("(")) {
    rules.add(`Bash(${v})`);
    rules.add(`Bash(${v}:*)`);
  }
  for (const r of cfg.allowedTools || []) rules.add(r);
  return [...rules];
}

// Pull the token/cost numbers out of `claude -p --output-format json` (other
// agents that print a similar object get the same treatment; otherwise null).
function summariseUsage(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const u = parsed.usage || {};
  const has = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some((k) => k in u);
  if (!has && parsed.total_cost_usd == null) return null;
  return {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
    turns: parsed.num_turns ?? null,
    durationMs: parsed.duration_ms ?? null,
    costUsd: parsed.total_cost_usd ?? null,
    models: Object.keys(parsed.modelUsage || {}),
  };
}

// Claude Code refuses to start when it thinks it is nested inside another
// Claude Code session (CLAUDECODE env var). The runner is often launched from
// inside a session via /relay run, so strip those markers for children.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Session kinds
// ---------------------------------------------------------------------------

async function workerSession(proj, plan, task) {
  const vars = {
    ...baseVars(proj, plan),
    TASK_ID: task.id,
    TASK_TITLE: task.title,
    TASK_RAW: task.raw,
    TASK_BODY: task.body.length ? task.body.map((l) => `  ${l}`).join("\n") : "  (no details)",
  };
  return runClaude(proj, render(loadPrompt("worker"), vars), `worker-${task.id}`, vars.VERIFY);
}

async function reviewSession(proj, plan, state) {
  const head = gitHead(proj.root);
  const since = state.lastReviewHead || "";
  // Without a recorded review head, count real commits since the runner started
  // (a worker may make more than one commit per task, so task count is not enough).
  const fallback = state.runStartHead && state.runStartHead !== head ? state.runStartHead : `HEAD~${Math.max(1, state.completedSinceReview)}`;
  const range = since ? `${since}..${head}` : `${fallback}..HEAD`;
  const vars = { ...baseVars(proj, plan), COMMIT_RANGE: range };
  const res = await runClaude(proj, render(loadPrompt("review"), vars), "review", vars.VERIFY);
  // The review session commits its own report; the next review must start after it.
  return { res, head: res.isError ? head : gitHead(proj.root) };
}

async function planSession(proj, description) {
  const cfg = proj.cfg;
  const rel = (p) => path.relative(proj.root, p).split(path.sep).join("/");
  const vars = {
    PLAN_PATH: rel(proj.planPath),
    DESCRIPTION: description,
    VERIFY: cfg.verify || "(not configured yet — find the project's test/build command and put it in the Verify section and in .relay/config.json)",
    NOTES: cfg.notes || "",
    PLATFORM: process.platform,
    TEMPLATE: readText(path.join(SKILL_DIR, "templates", "PLAN.md")),
  };
  return runClaude(proj, render(loadPrompt("plan"), vars), "plan");
}

async function acceptanceSession(proj, plan) {
  const vars = baseVars(proj, plan);
  return runClaude(proj, render(loadPrompt("accept"), vars), "accept", vars.VERIFY);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(cwd, flags) {
  const root = path.resolve(cwd);
  const relayDir = path.join(root, ".relay");
  ensureDir(relayDir);
  const cfgPath = path.join(relayDir, "config.json");
  const cfg = readJson(cfgPath, {});
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  if (flags.plan) merged.plan = flags.plan;
  if (flags.verify) merged.verify = flags.verify;
  if (flags.agent) merged.agent = flags.agent;
  if (flags.model) merged.model = flags.model;
  if (flags.effort) merged.effort = flags.effort;
  // --models plan=x,worker=y,...  /  --efforts plan=high,worker=medium,...
  for (const key of ["models", "efforts"]) {
    if (!flags[key]) continue;
    merged[key] = { ...DEFAULT_CONFIG[key], ...(cfg[key] || {}) };
    for (const pair of String(flags[key]).split(",")) {
      const [k, v] = pair.split("=").map((x) => x.trim());
      if (!ROLES.includes(k)) {
        console.error(`--${key}: unknown role "${k}" (plan | worker | review | accept)`);
        process.exit(1);
      }
      merged[key][k] = v || "";
    }
  }
  writeJson(cfgPath, merged);
  const tplDir = path.join(SKILL_DIR, "templates");
  const planPath = path.resolve(root, merged.plan);
  if (!exists(planPath)) {
    ensureDir(path.dirname(planPath));
    fs.copyFileSync(path.join(tplDir, "PLAN.md"), planPath);
  }
  const handoffPath = path.resolve(root, merged.handoff);
  if (!exists(handoffPath)) {
    ensureDir(path.dirname(handoffPath));
    fs.copyFileSync(path.join(tplDir, "HANDOFF.md"), handoffPath);
  }
  const gi = path.join(relayDir, ".gitignore");
  if (!exists(gi)) fs.writeFileSync(gi, "logs/\nstate.json\nrunner.pid\nrunner.out\n");
  log(`initialised ${path.relative(root, relayDir) || ".relay"}`);
  log(`plan:    ${merged.plan}`);
  log(`handoff: ${merged.handoff}`);
  log(`verify:  ${merged.verify || "(not set)"}`);
  log(`agent:   ${merged.agent}`);
  log(`models:  ${describeModels(merged)}`);
  log("Next: fill in the plan (or run /relay plan inside Claude Code), then `relay run`.");
}

function describeModels(cfg) {
  return ROLES.map((r) => {
    const e = effortFor(cfg, r);
    return `${r}=${modelFor(cfg, r) || "(cli default)"}${e ? `/${e}` : ""}`;
  }).join("  ");
}

// `relay plan "<description>"`: one headless session, on the plan role's model,
// writes the plan file. Nothing is committed; the user reviews it first.
async function cmdPlan(proj, args) {
  const description = args.join(" ").trim();
  if (!description) {
    console.error('usage: relay plan "<what to build, or path to a requirements doc>"');
    process.exit(1);
  }
  log(`plan session — agent ${proj.cfg.agent}, model ${modelFor(proj.cfg, "plan") || "(cli default)"}`);
  const res = await planSession(proj, description);
  const plan = exists(proj.planPath) ? parsePlan(proj.planPath) : { tasks: [] };
  if (res.isError || !plan.tasks.length) {
    console.error(`plan session ${res.isError ? "failed" : "wrote no tasks"}; see ${path.relative(proj.root, res.logBase)}.result.md`);
    if (res.denials?.length) console.error(`denied: ${res.denials.join(", ")}`);
    process.exit(1);
  }
  const c = countTasks(plan);
  log(`plan written: ${path.relative(proj.root, proj.planPath)} (${c.open} open tasks)${res.costUsd ? ` ($${res.costUsd.toFixed(2)})` : ""}`);
  for (const t of plan.tasks) console.log(`  [${t.status === "done" ? "x" : " "}] ${t.id}: ${t.title}`);
  log("review the plan, commit it, then `relay run`.");
}

function cmdStatus(proj) {
  const plan = parsePlan(proj.planPath);
  const c = countTasks(plan);
  const state = loadState(proj.statePath);
  const next = nextOpenTask(plan);
  const pid = exists(proj.pidPath) ? Number(readText(proj.pidPath).trim()) : null;
  const alive = pid ? isAlive(pid) : false;
  console.log(`Plan:     ${path.relative(proj.root, proj.planPath)}`);
  console.log(`Tasks:    ${c.done} done / ${c.open} open / ${c.skipped} skipped (total ${plan.tasks.length})`);
  console.log(`Next:     ${next ? `${next.id}: ${next.title}` : "(none — all tasks closed)"}`);
  console.log(`Runner:   ${alive ? `running (pid ${pid})` : "not running"}`);
  console.log(`Agent:    ${proj.cfg.agent}  ${describeModels(proj.cfg)}`);
  console.log(`Failures: ${state.consecutiveFailures} consecutive; ${state.completedSinceReview} done since last review`);
  if (state.runs.length) {
    const tot = usageTotals(state.runs);
    if (tot.sessions) {
      console.log(
        `Usage:    ${tot.sessions} sessions, $${tot.costUsd.toFixed(2)}; tokens in ${fmtK(tot.input)} / cache-read ${fmtK(tot.cacheRead)} / cache-write ${fmtK(tot.cacheWrite)} / out ${fmtK(tot.output)}`,
      );
    }
    console.log("Recent runs:");
    for (const r of state.runs.slice(-5)) {
      const cost = (r.costUsd != null ? `  $${r.costUsd.toFixed(2)}` : "") + (r.model || r.effort ? `  [${r.model || "default"}${r.effort ? "/" + r.effort : ""}]` : "");
      const tok = r.tokens ? `  out ${fmtK(r.tokens.output)}${r.turns != null ? ` / ${r.turns} turns` : ""}` : "";
      console.log(`  ${r.at}  ${r.kind.padEnd(14)} ${r.outcome}${cost}${tok}${r.note ? "  " + r.note : ""}`);
    }
  }
  if (exists(proj.handoffPath)) {
    console.log("\n--- HANDOFF ---");
    console.log(readText(proj.handoffPath).trim());
  }
}

function usageTotals(runs) {
  const t = { sessions: 0, costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of runs) {
    if (r.costUsd == null && !r.tokens) continue;
    t.sessions++;
    t.costUsd += r.costUsd || 0;
    if (r.tokens) for (const k of ["input", "cacheRead", "cacheWrite", "output"]) t[k] += r.tokens[k] || 0;
  }
  return t;
}

const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function cmdNext(proj) {
  const plan = parsePlan(proj.planPath);
  const t = nextOpenTask(plan);
  if (!t) return console.log("(none)");
  console.log(`${t.id}: ${t.title}`);
  for (const l of t.body) console.log(`  ${l}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdStop(proj) {
  if (!exists(proj.pidPath)) return log("runner is not running");
  const pid = Number(readText(proj.pidPath).trim());
  const state = loadState(proj.statePath);
  state.stopped = true; // graceful: runner checks this between sessions
  writeJson(proj.statePath, state);
  if (isAlive(pid)) {
    killTree(pid);
    log(`sent stop to runner pid ${pid}`);
  }
  try {
    fs.unlinkSync(proj.pidPath);
  } catch {}
}

function cmdDetach(proj, argv) {
  const outPath = path.join(proj.relayDir, "runner.out");
  const out = fs.openSync(outPath, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", ...argv.filter((a) => a !== "--detach")], {
    cwd: proj.root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: childEnv(),
  });
  child.unref();
  log(`runner started in background (pid ${child.pid}); output -> ${path.relative(proj.root, outPath)}`);
  log("use `relay status` to follow progress, `relay stop` to stop.");
}

async function cmdRun(proj, flags) {
  const { cfg } = proj;
  if (exists(proj.pidPath) && isAlive(Number(readText(proj.pidPath).trim()))) {
    console.error("runner already running; use `relay stop` first");
    process.exit(1);
  }
  fs.writeFileSync(proj.pidPath, String(process.pid));
  const state = loadState(proj.statePath);
  state.stopped = false;
  state.consecutiveFailures = 0; // a fresh `relay run` is a fresh chance
  if (!state.lastReviewHead) state.runStartHead = gitHead(proj.root);
  writeJson(proj.statePath, state);
  const once = !!flags.once;
  const dry = !!flags["dry-run"];

  const cleanup = () => {
    try {
      fs.unlinkSync(proj.pidPath);
    } catch {}
  };
  process.on("SIGINT", () => (cleanup(), process.exit(130)));
  process.on("SIGTERM", () => (cleanup(), process.exit(143)));

  if (!git(proj.root, ["rev-parse", "--is-inside-work-tree"]).ok) {
    console.error("relay requires a git repository (commits are the durable state).");
    cleanup();
    process.exit(2);
  }

  log(`runner start — agent ${cfg.agent}, plan ${path.relative(proj.root, proj.planPath)}, timeout ${cfg.sessionTimeoutMinutes}m/session`);
  log(`models: ${describeModels(cfg)}`);

  for (;;) {
    const st = loadState(proj.statePath);
    if (st.stopped) {
      log("stop requested; exiting");
      break;
    }
    const plan = parsePlan(proj.planPath);
    const task = nextOpenTask(plan);

    // Review gate
    if (task && cfg.reviewEvery > 0 && st.completedSinceReview >= cfg.reviewEvery) {
      log(`review gate: ${st.completedSinceReview} tasks since last review`);
      if (dry) {
        log("(dry-run) would run review session");
        st.completedSinceReview = 0;
        writeJson(proj.statePath, st);
        continue;
      }
      const { res, head } = await reviewSession(proj, plan, st);
      record(st, "review", res.isError ? "error" : "ok", res);
      if (!res.isError) {
        st.completedSinceReview = 0;
        st.lastReviewHead = head;
      }
      writeJson(proj.statePath, st);
      if (res.isError) {
        if (await handleFailure(proj, st, res)) break;
      }
      if (once) break;
      continue;
    }

    // Acceptance / finish
    if (!task) {
      if (!cfg.acceptance || st.acceptanceRounds >= cfg.maxAcceptanceRounds) {
        log("all tasks closed; done.");
        break;
      }
      log(`acceptance round ${st.acceptanceRounds + 1}/${cfg.maxAcceptanceRounds}`);
      if (dry) {
        log("(dry-run) would run acceptance session");
        break;
      }
      const res = await acceptanceSession(proj, plan);
      st.acceptanceRounds++;
      record(st, "accept", res.isError ? "error" : "ok", res);
      writeJson(proj.statePath, st);
      if (res.isError && (await handleFailure(proj, st, res))) break;
      const after = parsePlan(proj.planPath);
      if (!nextOpenTask(after)) {
        log("acceptance passed with no new tasks; done.");
        break;
      }
      log("acceptance added follow-up tasks; continuing");
      if (once) break;
      continue;
    }

    // Worker
    log(`task ${task.id}: ${task.title}`);
    if (dry) {
      log("(dry-run) would run worker session; prompt preview:");
      const vars = { ...baseVars(proj, plan), TASK_ID: task.id, TASK_TITLE: task.title, TASK_RAW: task.raw, TASK_BODY: task.body.map((l) => `  ${l}`).join("\n") };
      console.log(render(loadPrompt("worker"), vars));
      break;
    }
    const headBefore = gitHead(proj.root);
    const res = await workerSession(proj, plan, task);
    const after = parsePlan(proj.planPath);
    const afterTask = after.tasks.find((t) => t.id === task.id && t.line === task.line) || after.tasks[task.index];
    const ticked = afterTask && afterTask.status === "done";
    const skipped = afterTask && afterTask.status === "skipped";
    const committed = gitHead(proj.root) !== headBefore;
    const success = !res.isError && ticked && (!cfg.commitRequired || committed);

    if (success) {
      record(st, `worker ${task.id}`, "done", res, committed ? "committed" : "no commit");
      st.consecutiveFailures = 0;
      st.completedSinceReview++;
      writeJson(proj.statePath, st);
      log(`task ${task.id} done${res.costUsd ? ` ($${res.costUsd.toFixed(2)})` : ""}`);
    } else if (skipped) {
      record(st, `worker ${task.id}`, "skipped", res, "worker marked task as blocked [-]");
      st.consecutiveFailures = 0;
      writeJson(proj.statePath, st);
      log(`task ${task.id} marked blocked by worker; moving on`);
    } else {
      const why = res.timedOut ? "timeout" : res.rateLimited ? "rate-limited" : res.isError ? `exit ${res.code}` : !ticked ? "task not ticked" : "no commit";
      record(st, `worker ${task.id}`, "failed", res, why);
      if (res.denials?.length) {
        // Retrying cannot help: the same tool call will be denied again. Stop and
        // tell the user what to allow instead of burning sessions.
        log(`task ${task.id} failed (${why}); the session was DENIED permission for: ${res.denials.join(", ")}`);
        log(`add the needed rules to .relay/config.json "allowedTools" (or the project's settings.json), then \`relay run\` again`);
        st.consecutiveFailures++;
        writeJson(proj.statePath, st);
        break;
      }
      if (await handleFailure(proj, st, res, why)) break;
    }
    if (once) break;
  }
  cleanup();
}

function record(state, kind, outcome, res, note) {
  const u = res?.usage;
  state.runs.push({
    at: ts(),
    kind,
    outcome,
    note: note || "",
    log: res?.logBase ? path.basename(res.logBase) : "",
    model: res?.model || "",
    effort: res?.effort || "",
    costUsd: u?.costUsd ?? res?.costUsd ?? null,
    tokens: u ? { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output } : null,
    turns: u?.turns ?? null,
    durationMs: u?.durationMs ?? null,
  });
  if (state.runs.length > 200) state.runs = state.runs.slice(-200);
}

// returns true when the runner should give up
async function handleFailure(proj, state, res, why = "") {
  const { cfg } = proj;
  state.consecutiveFailures++;
  writeJson(proj.statePath, state);
  if (state.consecutiveFailures >= cfg.maxConsecutiveFailures) {
    log(`giving up after ${state.consecutiveFailures} consecutive failures (${why}). Check .relay/logs and HANDOFF, then \`relay run\` again.`);
    return true;
  }
  const n = state.consecutiveFailures;
  let minutes = res.rateLimited ? Math.min(cfg.retryMaxMinutes, cfg.retryBaseMinutes * 2 ** (n - 1)) : Math.min(5, n);
  log(`${why || "failure"} (${n}/${cfg.maxConsecutiveFailures}); waiting ${minutes}m before retry`);
  await sleep(minutes * 60 * 1000);
  return false;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `agent-relay — run long tasks as a relay of short, fresh agent sessions (Claude Code, Codex, Gemini or any CLI agent).

Usage:
  relay init [--plan <path>] [--verify "<cmd>"] [--agent claude|codex|gemini|custom]
             [--model <name>] [--models plan=a,worker=b,review=c,accept=d]
             [--effort <level>] [--efforts plan=a,worker=b,review=c,accept=d]
                                                  create .relay/ in the current project
  relay plan "<description or path to a spec>"    write the plan with one headless session (plan role's model)
  relay status                                    progress, next task, runner state, handoff
  relay next                                      print the next open task
  relay run [--once] [--dry-run] [--detach]       run the relay loop (foreground by default)
  relay stop                                      stop a background runner
  relay help

Files (per project):
  .relay/config.json   settings (plan path, verify command, timeouts, review cadence...)
  .relay/PLAN.md       task list — "- [ ] T1: ..." items under a "## Tasks" heading
  .relay/HANDOFF.md    note left by the last session for the next one
  .relay/logs/         prompt + result of every session
`;

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] || "help";
  const cwd = process.cwd();
  switch (cmd) {
    case "init":
      return cmdInit(cwd, flags);
    case "plan":
      return cmdPlan(loadProject(cwd), _.slice(1));
    case "status":
      return cmdStatus(loadProject(cwd));
    case "next":
      return cmdNext(loadProject(cwd));
    case "stop":
      return cmdStop(loadProject(cwd));
    case "run": {
      const proj = loadProject(cwd);
      if (flags.detach) return cmdDetach(proj, process.argv.slice(3));
      return cmdRun(proj, flags);
    }
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
