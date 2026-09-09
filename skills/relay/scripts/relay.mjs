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
  model: "",
  permissionMode: "acceptEdits", // claude only
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      inTasks = /^#{1,6}\s+tasks?\b/i.test(line);
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

const RATE_LIMIT_RE = /rate.?limit|usage.?limit|limit reached|too many requests|\b429\b|overloaded|resets? (at|in)|quota|capacity/i;

function runClaude(proj, prompt, kind) {
  const { cfg, root, logsDir } = proj;
  ensureDir(logsDir);
  const stamp = fileTs();
  const logBase = path.join(logsDir, `${stamp}-${kind}`);
  fs.writeFileSync(`${logBase}.prompt.md`, prompt);

  const { exe, args, viaStdin } = agentCommand(cfg, prompt);

  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: root,
      shell: IS_WIN, // resolves .cmd shims on Windows
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...childEnv(), CLAUDE_RELAY: "1", CLAUDE_RELAY_KIND: kind, RELAY_KIND: kind },
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
      const rateLimited = RATE_LIMIT_RE.test(stderr) || (isError && RATE_LIMIT_RE.test(resultText));
      fs.writeFileSync(
        `${logBase}.result.md`,
        `# ${kind} — ${stamp}\n\nexit: ${code}  timedOut: ${timedOut}  rateLimited: ${rateLimited}\n\n## stdout\n\n${resultText}\n\n## stderr\n\n${stderr}\n`,
      );
      resolve({ code, timedOut, isError, rateLimited, resultText, stderr, costUsd: parsed?.total_cost_usd, logBase });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.writeFileSync(`${logBase}.result.md`, `# ${kind} — spawn error\n\n${e.stack || e}\n`);
      resolve({ code: -1, timedOut: false, isError: true, rateLimited: false, resultText: "", stderr: String(e), logBase });
    });
  });
}

// Build the argv for the configured agent CLI. Success is judged by side
// effects (tick + commit), so any CLI that can edit files and run commands
// unattended works here.
function agentCommand(cfg, prompt) {
  const extra = cfg.extraArgs || [];
  const model = cfg.model ? ["--model", cfg.model] : [];
  switch (cfg.agent) {
    case "claude":
      return {
        exe: cfg.claude || "claude",
        args: ["-p", "--output-format", "json", "--permission-mode", cfg.permissionMode, ...model, ...extra],
        viaStdin: true,
      };
    case "codex":
      // OpenAI Codex CLI: `codex exec` runs non-interactively; "-" reads the prompt from stdin.
      return {
        exe: cfg.claude === "claude" ? "codex" : cfg.claude,
        args: ["exec", "--full-auto", ...model, ...extra, "-"],
        viaStdin: true,
      };
    case "gemini":
      // Google Gemini CLI: -p prompt, --yolo auto-approves tool calls.
      return {
        exe: cfg.claude === "claude" ? "gemini" : cfg.claude,
        args: ["--yolo", ...(cfg.model ? ["-m", cfg.model] : []), ...extra, "-p", prompt],
        viaStdin: false,
      };
    case "custom": {
      if (!cfg.command?.length) throw new Error('agent "custom" needs "command": [exe, ...args] in .relay/config.json');
      const hasPlaceholder = cfg.command.some((a) => a.includes("{prompt}"));
      const args = cfg.command.slice(1).map((a) => a.replace("{prompt}", prompt));
      return { exe: cfg.command[0], args, viaStdin: !hasPlaceholder };
    }
    default:
      throw new Error(`unknown agent "${cfg.agent}" (claude | codex | gemini | custom)`);
  }
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
  return runClaude(proj, render(loadPrompt("worker"), vars), `worker-${task.id}`);
}

async function reviewSession(proj, plan, state) {
  const head = gitHead(proj.root);
  const since = state.lastReviewHead || "";
  const range = since ? `${since}..${head}` : `HEAD~${Math.max(1, state.completedSinceReview)}..HEAD`;
  const vars = { ...baseVars(proj, plan), COMMIT_RANGE: range };
  const res = await runClaude(proj, render(loadPrompt("review"), vars), "review");
  return { res, head };
}

async function acceptanceSession(proj, plan) {
  return runClaude(proj, render(loadPrompt("accept"), baseVars(proj, plan)), "accept");
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
  log("Next: fill in the plan (or run /relay plan inside Claude Code), then `relay run`.");
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
  console.log(`Failures: ${state.consecutiveFailures} consecutive; ${state.completedSinceReview} done since last review`);
  if (state.runs.length) {
    console.log("Recent runs:");
    for (const r of state.runs.slice(-5)) console.log(`  ${r.at}  ${r.kind.padEnd(14)} ${r.outcome}${r.note ? "  " + r.note : ""}`);
  }
  if (exists(proj.handoffPath)) {
    console.log("\n--- HANDOFF ---");
    console.log(readText(proj.handoffPath).trim());
  }
}

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
      const vars = { ...baseVars(proj, plan), TASK_ID: task.id, TASK_TITLE: task.title, TASK_RAW: task.raw, TASK_BODY: task.body.join("\n") };
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
      if (await handleFailure(proj, st, res, why)) break;
    }
    if (once) break;
  }
  cleanup();
}

function record(state, kind, outcome, res, note) {
  state.runs.push({ at: ts(), kind, outcome, note: note || "", log: res?.logBase ? path.basename(res.logBase) : "" });
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
                                                  create .relay/ in the current project
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
