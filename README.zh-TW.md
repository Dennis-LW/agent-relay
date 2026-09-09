# agent-relay

把長時間、多步驟的開發任務，拆成一連串**短而乾淨的 agent session 接力**完成：規劃 → 實作 → 審查 → 驗收，所有狀態都放在 git 裡。品質不會因為 context 變長而衰退，打到用量上限也只是暫停，不是中斷。

支援 **Claude Code**（預設）、**OpenAI Codex CLI**、**Gemini CLI**，或任何能無人值守執行的 CLI agent。skill 本身採用開放的 [Agent Skills](https://agentskills.io) `SKILL.md` 格式。

[English](README.md)

## 為什麼需要

單一長 agent session 會慢慢變差：context 塞滿過時的推理、早期的錯誤變成「事實」、一次 usage limit 就讓整個作業停擺。自動壓縮只能延後這件事，不能解決。

解法是結構性的：**讓每個 session 都很短，把狀態放到 session 之外。**

```
PLAN.md ──► runner ──► 新 session：做 T1，驗證，commit，打勾，寫交接
                 └───► 新 session：做 T2 ...
                 └───► 新 session：審查最近 3 個 commit，補上修正任務
                 └───► 新 session：做 T3 ...
                 └───► 新 session：驗收，逐項檢查整體目標，補上後續任務
```

- `PLAN.md` 是任務清單，勾選狀態就是進度。
- `HANDOFF.md` 是每個 session 留給下一個的交接便條。
- 每個任務結束都有一個 git commit。runner 只信 commit 與勾選，不信 session 自己說的。
- 被限流時 runner 會退避重試，什麼都不會丟。

## 需求

- 至少一個 agent CLI 在 PATH 上：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`）、[Codex CLI](https://github.com/openai/codex)（`codex`）或 [Gemini CLI](https://github.com/google-gemini/gemini-cli)（`gemini`）
- Node.js 18 以上（三者都是 npm 安裝，環境一定有）
- git

支援 macOS、Linux、Windows，零依賴。

## 安裝

### 以 Claude Code plugin 安裝（建議）

```
claude plugin marketplace add Dennis-LW/agent-relay
claude plugin install relay@agent-relay
```

之後每個專案都有 `/relay` 這個 skill 可用。

### Codex CLI

Codex 從 `~/.codex/skills` 讀取 skill。clone 此 repo 後把 `skills/relay` 複製或 symlink 過去：

```
git clone https://github.com/Dennis-LW/agent-relay
ln -s "$PWD/agent-relay/skills/relay" ~/.codex/skills/relay     # Windows 用 mklink /D
```

在專案裡執行 `relay init --agent codex`（或在 `.relay/config.json` 設 `"agent": "codex"`），session 會以 `codex exec --full-auto` 執行。

### Gemini CLI 或其他 agent

規劃用該 CLI 本身，執行交給 runner：`relay init --agent gemini` 會以 `gemini --yolo -p <prompt>` 跑 session。其他工具設 `"agent": "custom"` 加 `"command": ["my-agent", "--auto", "{prompt}"]`（省略 `{prompt}` 則改由 stdin 餵入）。runner 只要求 agent 能改檔、跑指令、commit；成功與否看勾選與新 commit，不看 agent 的輸出文字。

### 手動（Claude Code）

clone 此 repo，把 `skills/relay` 複製或 symlink 到 `~/.claude/skills/relay`。

### 只裝 CLI

```
npm install -g github:Dennis-LW/agent-relay
relay help
```

## 快速開始

在 Claude Code 裡，切到要開發的專案：

```
/relay plan  做一個發票 REST API：CRUD、PDF 匯出、測試，用 FastAPI。
```

Claude 會探索專案並寫出 `.relay/PLAN.md`：按依賴順序排列的小任務，每項都有 `Accept:` 驗收條件，然後請你確認。commit 之後：

```
/relay run
```

runner 會在背景啟動。之後回來看：

```
/relay status
```

或在終端機：

```
node ~/.claude/skills/relay/scripts/relay.mjs status   # 若用 npm 安裝，直接 relay status
```

## 計畫檔的格式

```markdown
# Plan: Invoice API

## Goal
使用者可以建立、列出、更新、刪除發票，並下載 PDF。

## Constraints
- 在 feat/invoices 分支作業。Python 3.12、FastAPI、pytest。
- 不要動 auth 模組。

## Verify
`pytest -q`

## Tasks
- [ ] T1: 新增 Invoice model 與 migration
  - Accept: `pytest tests/test_models.py` 通過；migration 可套用在全新 db
- [ ] T2: /invoices 的 CRUD endpoint
  - Accept: 四個動詞的測試通過；OpenAPI 看得到路由
- [ ] T3: PDF 匯出 endpoint
  - Accept: GET /invoices/{id}/pdf 對 seed 資料回傳 application/pdf
```

讓接力成功的規則：

- **一個任務等於一個新 session。** 幾句話描述不完的 diff 就該再拆。
- **順序就是依賴順序。** runner 永遠取第一個未完成的任務。
- **每個任務都有可觀察的 Accept 條件。**
- **Constraints 寫下新 session 不可能知道的事。**

任何 markdown 檔，只要在含有「Tasks」的標題下有 `- [ ]` 項目就能用，所以可以把 `plan` 指到既有的任務檔（例如 OpenSpec 的 `tasks.md`）。

## 各種 session 做什麼

| session | 時機 | 契約 |
| --- | --- | --- |
| worker | 每個未完成任務 | 只做這一項 → 跑 verify → commit → 打勾 `[x]` → 覆寫 HANDOFF |
| review | 每完成 `reviewEvery` 項 | 用乾淨 context 讀 diff，寫 `.relay/reviews/*.md`，高/中嚴重度的發現補成 `R<n>` 任務；不改程式碼 |
| acceptance | 沒有未完成任務時 | 真的逐項重跑 Accept 條件並對照 Goal，寫 `.relay/ACCEPTANCE.md`，補上 `A<n>` 後續任務；不改程式碼 |

任務要同時滿足「勾選變了」**且**「HEAD 前進了」才算完成。做不完的 worker 會讓任務保持未勾選（或標成 `[-]` 表示卡住），並在 HANDOFF 說明原因。

## CLI

```
relay init [--plan <path>] [--verify "<cmd>"] [--agent <name>]   在目前專案建立 .relay/
relay status                                    進度、下一個任務、runner 狀態、交接內容
relay next                                      印出下一個未完成任務
relay run [--once] [--dry-run] [--detach]       跑接力迴圈（預設前景）
relay stop                                      停止背景 runner
```

## 設定（`.relay/config.json`）

| 鍵 | 預設 | 意義 |
| --- | --- | --- |
| `plan` | `.relay/PLAN.md` | 任務檔 |
| `handoff` | `.relay/HANDOFF.md` | 交接檔 |
| `verify` | `""` | 打勾前必須通過的指令 |
| `agent` | `claude` | `claude` \| `codex` \| `gemini` \| `custom` |
| `command` | `[]` | `custom` 用：argv，`{prompt}` 會被代換，沒有則由 stdin 餵入 |
| `claude` | `claude` | 所選 preset 的執行檔覆寫（例如完整路徑） |
| `model` | `""` | session 的模型參數 |
| `permissionMode` | `acceptEdits` | Claude Code 的 `--permission-mode` |
| `extraArgs` | `[]` | 附加到每個 session 的額外 CLI 參數 |
| `sessionTimeoutMinutes` | `45` | 每個 session 的強制逾時 |
| `reviewEvery` | `3` | 每完成幾項就審查一次（0 = 不審） |
| `acceptance` | `true` | 最後是否跑驗收 session |
| `maxAcceptanceRounds` | `2` | 驗收 → 補任務的迴圈上限 |
| `maxConsecutiveFailures` | `5` | 連續失敗幾次就放棄 |
| `retryBaseMinutes` / `retryMaxMinutes` | `5` / `60` | 限流退避時間 |
| `commitRequired` | `true` | 每個任務都要有新 commit |
| `notes` | `""` | 附加到每個 prompt 的自由文字 |

## 權限與安全

session 無人值守執行。Claude Code 用 `--permission-mode acceptEdits`（編輯自動核准，Bash 仍遵守 allow/deny 規則；`"permissionMode": "bypassPermissions"` 只建議在信任的沙箱裡用）。Codex 用 `exec --full-auto`、Gemini 用 `--yolo`，都是各自的無人值守模式。worker 被明確要求不 push、不改寫歷史。

每個 session 的 prompt 與結果都會寫到 `.relay/logs/`。

## 限制

- 用量上限是帳號層級，不是 session 層級。relay 不會給你更多額度，它只是讓「等 reset」變成自動且不丟進度。
- 背景 runner 是本機 process，睡眠或關機就停；再 `relay run` 就從計畫接續。要脫離本機，可用任何排程器定期執行 `relay run --once`。
- 品質仍取決於任務拆得夠不夠小。大而模糊的任務會得到大而模糊的結果。

## 授權

MIT
