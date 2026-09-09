#!/usr/bin/env node
// Does the relay skill trigger on the right requests and stay quiet on the wrong ones?
// Runs one headless Claude Code turn per phrase with this plugin loaded and checks
// whether the model invoked the Skill tool for relay. Spends tokens (small: one
// turn each). Usage:
//   node bench/trigger-eval.mjs [--model claude-haiku-4-5] [--claude <path>] [--only positive|negative] [--turns 4]
// The model may read files first; it counts as triggered if it invokes the relay skill within --turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((x) => x.length));
const model = args.model || "claude-haiku-4-5-20251001";
const claudeExe = args.claude || "claude";

const POSITIVE = [
  "把這個功能拆成小任務在背景一個一個做，我要離開一陣子，做完再叫我",
  "用接力的方式做這個重構，一個任務開一個新 session",
  "讓它跑一整晚，被限流就等額度回來自己繼續",
  "我不想一個對話越做越長，幫我把這個大功能拆開跑",
  "把 docs/spec.md 整個實作完，無人值守，做完幫我驗收",
  "Hand this whole feature off to run unattended: plan it, implement it task by task, review, accept.",
  "Run this migration as a relay of fresh sessions so quality doesn't decay.",
  "Keep working through rate limits without me; resume automatically when the limit resets.",
  "This is a big job (new billing module end to end). Set it up so I can leave and come back to a finished branch.",
  "幫我用 relay 做：新增 invoice 的 PDF 匯出，含測試，我晚點回來看",
];
const NEGATIVE = [
  "幫我做一個 todo CLI，用 node，要有測試",
  "重構 src/store.mjs，把同步 fs 改成 async",
  "這個測試為什麼會失敗？",
  "幫我寫一個 README",
  "把這個函式的變數名稱改好一點",
  "Add a --verbose flag to the CLI and update the help text.",
  "Explain what this regex does.",
  "Run the tests and fix the one that fails.",
  "Set up a cron job that runs backups every night.",
  "Review this diff for bugs.",
];

function seedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-trigger-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }, null, 2));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "store.mjs"), "export function load(p) { return JSON.parse(require('fs').readFileSync(p)); }\n");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "spec.md"), "# Spec\n\nInvoices: CRUD + PDF export.\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  return dir;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

function probe(dir, phrase) {
  const r = spawnSync(
    claudeExe,
    ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", String(args.turns || 4), "--plugin-dir", ROOT, "--allowedTools", "Skill Read Glob Grep", "--permission-mode", "default"],
    { cwd: dir, input: phrase, encoding: "utf8", env: cleanEnv(), timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  let invoked = false;
  let other = [];
  let text = "";
  let cost = 0;
  for (const line of (r.stdout || "").split("\n")) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "assistant")
      for (const b of m.message?.content || []) {
        if (b.type === "tool_use") {
          const s = JSON.stringify(b.input);
          if (b.name === "Skill" && /relay/i.test(s)) invoked = true;
          else other.push(`${b.name}(${s.slice(0, 40)})`);
        } else if (b.type === "text") text += b.text;
      }
    if (m.type === "result") cost = m.total_cost_usd || 0;
  }
  return { invoked, other, text: text.slice(0, 120).replace(/\n/g, " "), cost };
}

const only = args.only;
const sets = [
  ["positive", POSITIVE, true],
  ["negative", NEGATIVE, false],
].filter(([n]) => !only || n === only);
let cost = 0;
const rows = [];
for (const [name, phrases, want] of sets) {
  for (const phrase of phrases) {
    const dir = seedRepo();
    const res = probe(dir, phrase);
    fs.rmSync(dir, { recursive: true, force: true });
    cost += res.cost;
    const ok = res.invoked === want;
    rows.push({ set: name, ok, phrase, ...res });
    console.log(`${ok ? "✔" : "✖"} [${name}] ${res.invoked ? "TRIGGERED" : "not triggered"}  ${phrase.slice(0, 70)}${res.invoked ? "" : res.other.length ? `  → ${res.other.join(", ")}` : `  → "${res.text.slice(0, 60)}"`}`);
  }
}
const pos = rows.filter((r) => r.set === "positive");
const neg = rows.filter((r) => r.set === "negative");
console.log(`\nmodel ${model}: positive ${pos.filter((r) => r.ok).length}/${pos.length} triggered, negative ${neg.filter((r) => r.ok).length}/${neg.length} stayed quiet, cost $${cost.toFixed(2)}`);
const out = path.join(ROOT, "bench", "results", `trigger-${model}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ model, rows }, null, 2));
