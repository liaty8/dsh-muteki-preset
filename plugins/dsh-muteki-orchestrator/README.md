# muteki-orchestrator

给 DSH agent 提供「程序化派单」能力：主控 agent 不再靠自然语言让子代理干活，而是调用工具把任务派给全新上下文的子代理，并等结果、回收任务、记账。

## 提供的工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `muteki_dispatch` | 手动派一个 Step | `prompt`（必填）、`name`、`lane`、`lane_ttl`、`provider`、`model`、`reasoning_effort`、`cwd`、`override_quota`、`override_reason` |
| `muteki_tick` | 从黑板任务队列取 1–3 条，批量派一轮 | `limit`（1–3）、`cwd`、`provider`、`model`、`override_quota` |
| `muteki_run` | 自动循环：切题 → 回收卡住任务 → 取队列 → 派单 → 等结果 → 查 flag → 直到空/flag/超时/额度 | `limit`、`max_rounds`、`max_minutes`、`challenge`、`cwd`、`provider`、`model`、`override_quota`、`override_reason` |
| `muteki_review` | 起一个只读 Reviewer 审黑板，意见写回 review 表 | `cwd`、`focus` |
| `muteki_cli` | 把 Step 交给本地 Claude Code CLI（独立进程、异步、不占子代理席位） | `prompt`、`cwd`、`timeout_minutes`（1–30）、`model`、`override_quota` |

## 安装

插件必须放在 preset 的 `plugins` 列表内（agent scope），这样 `subagents.startActivation` 的 exact-live-parent 校验才能通过。

```powershell
# 1) 复制到 profile 根目录（不进 node_modules：pnpm 不会移走，插件页也不会误报「未生效」）
$p = "$env:DSH_HOME\profiles\desktop"
Copy-Item .\plugin-v13.mjs "$p\muteki-orchestrator.mjs" -Force

# 2) 在 preset 的 plugins 里加一行（用相对路径）
- id: muteki-orchestrator
  name: ./muteki-orchestrator.mjs
  config:
    python: 'python'
    boardPy: '%USERPROFILE%\\.dsh-muteki\\board.py'
    storageDir: '%USERPROFILE%\\.dsh-muteki\\artifacts'
    mode: attended          # 人主导；无人值守 / 定时任务改 unattended
    hardCancelOnFlag: true
    claudeBin: 'claude'
    claudeConfigDir: ''
    enabled: true
```

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `python` | `python` | 调 board.py 的解释器 |
| `boardPy` | `~/.dsh-muteki/board.py` | 黑板脚本路径 |
| `storageDir` | `~/.dsh-muteki/artifacts` | 证据与账本：`runs.json`、`costs.json`、`totals.json`、`buckets.json`、`overrides.jsonl`、`subagents.jsonl`、`cli.jsonl` |
| `mode` | `attended` | `attended`=人主导（额度宽、给突发、可等待）；`unattended`=无人值守/定时任务（额度紧、不等待） |
| `maxRunsPerHour` | 按 mode | 派单令牌的**每小时回填速率**；attended 40 / unattended 12 |
| `burstRuns` | 按 mode | **令牌桶容量**=开局可一次性派多少单；attended 60 / unattended 12 |
| `onQuota` | 按 mode | `muteki_run` 令牌不足时 `wait`（等回填）/ `stop`（立即停）；attended wait / unattended stop |
| `maxWaitMinutes` | 按 mode | `onQuota=wait` 时单次最长等待分钟数；attended 10 / unattended 0 |
| `stagnationLimit` | 按 mode | 连续多少轮无新增带证据 fact/flag 就停并写 review gap；attended 5 / unattended 3；**0=关闭** |
| `workerUsdPerMinute` | `0.1` | DSH 子代理每分钟估算成本（Anthropic 标价口径）；**0=不估 worker 成本** |
| `estimateToActual` | `0.1` | 估算口径 → 真实账单口径的换算系数（接 DeepSeek 约 1/10） |
| `costBasis` | `estimate` | 成本闸门比哪个口径：`estimate`（默认）/ `actual`（选 actual 时上限应调低约 10 倍） |
| `maxCostUsdPerHour` | 按 mode | **每题**每小时成本上限（美元，估算口径）；attended 15 / unattended 5 |
| `maxRunsPerChallenge` | 按 mode | **整题累计**派单总闸，不随小时重置；attended 300 / unattended 100 |
| `maxCostUsdPerChallenge` | 按 mode | **整题累计**成本总闸（美元）；attended 50 / unattended 15 |
| `hardCancelOnFlag` | `true` | 出现本轮新 flag 后中断同批子代理 |
| `claudeBin` | `claude` | Claude Code CLI 路径 |
| `claudeConfigDir` | 空 | 干净配置目录（建议单独一份，无插件无记忆） |
| `enabled` | `true` | 总开关 |

四个额度字段**省略即用 mode 预设**，显式写出的值优先（老配置里写死的 `12` / `3` 仍然被尊重，不会被预设悄悄改掉）。

## 额度闸门

`muteki_dispatch` / `muteki_tick` / `muteki_run` / `muteki_cli` 四个入口共用同一套判定（`quotaState`），不会再出现「dispatch 拦、run 不拦」的口径分叉。命中任一上限即拒派 / 停止：

| 上限 | 账本 | 恢复方式 |
|---|---|---|
| 派单令牌（桶容量 `burstRuns`，回填 `maxRunsPerHour`/h） | `buckets.json` | 时间过去就持续回填；`onQuota=wait` 时 run 会自动等 |
| 每小时成本 | `costs.json`（滚动 1h，保留 24h） | 等窗口滚动 |
| 整题累计派单 | `totals.json`（**不清理**） | 换一道新题，或调高配置 |
| 整题累计成本 | `totals.json`（**不清理**） | 换一道新题，或调高配置 |

**为什么是令牌桶而不是滚动小时窗口**：滚动窗口是悬崖——打满 12 次后最坏要干等 60 分钟才腾出 1 个额度，而 `muteki_run` 直接返回，人不在就干等。令牌桶把速率限制变成「容量 + 回填」：开局能一口气派 `burstRuns` 个把 recon 与第一轮 exp 全铺出去，之后按 `maxRunsPerHour` 持续供给。硬题的派单本来就是前密后疏。

**等待与越过**：

- `onQuota: wait` **只作用于 `muteki_run` 的循环**（最多 `maxWaitMinutes`，等不到就停并给 `resumeAt`）。`dispatch` / `tick` / `cli` 立即返回错误，不阻塞界面。
- `override_quota=true` + `override_reason="..."`：**仅 `mode: attended`**，显式越过本轮**速率**限制，往黑板写一条 observation（无证据，不算事实）并记 `overrides.jsonl`。
- **成本上限与整题总闸越不过去**，`override_quota` 对它们无效；撞上时 run 会优雅收束（`stoppedReason: "budget"` + `overrideNote` 说明原因），而不是整个工具报错。
- 批次内也照常判定：override 只放宽令牌，一轮里派到整题总闸就停。

为什么要有整题总闸：每小时上限防的是「短时间失控」，但一道硬题连打八小时照样能烧穿预算——以前没有任何东西拦得住。`totals.json` 按题累计、跨小时不清零，切回旧题继续累计，换新题从 0 开始。

`muteki_run` 的返回值带 `quota` 明细（mode、四个 used/cap、`limitHit`），`stoppedReason: "budget"` 时能直接看出命中的是哪一条。

## 成本口径

账本里每条成本都带 `basis`，两种引擎都记：

| 来源 | basis | 怎么算 |
|---|---|---|
| `muteki_cli` | `estimate-anthropic` | Claude Code 上报的 `total_cost_usd`（按 Anthropic 标价估算） |
| DSH 子代理 | `estimate-time` | 墙钟分钟数 × `workerUsdPerMinute`（默认 0.1） |
| DSH 子代理（将来带 usage 时） | `actual` | 事件里直接给出 `costUsd` / `total_cost_usd` 时采用真实值 |

**为什么 worker 只能按时间估**：已核对 DSH 0.2.2-rc.3 的类型定义——`subagent/end` 的 payload 是
`runInfo`（runId / provider / parentSessionId / id / local）+ `stopReason` + `lastAssistantMessage`（`ContentBlock[]`），
**不带 token usage**；`ContentBlock` 的七种类型里也没有 usage 字段。所以拿不到真实 token，只能估，并如实标注。
若事件里出现 `usage.inputTokens/outputTokens`，会一并记进 `tokens` 字段供将来按 token 计价；出现 `costUsd` 则直接改用 `actual`。

每条成本同时存两个口径：

- `usdEstimate`：Anthropic 标价口径（`usd` 字段保留同值，兼容老账本）；
- `usdActual`：`usdEstimate × estimateToActual`（默认 0.1，接 DeepSeek 时约 1/10）。

`costBasis` 决定**闸门比哪一个**，默认 `estimate`。老账本只有 `usd` 字段也能读：estimate 口径直接用，actual 口径按系数换算。

归因原则：`subagent/end` 只带 childId、不带题名，所以派单时先按 FIFO 挂一个待归属的题，`start` 事件认领、拿到 childId 后权威覆盖；**归因不了就不记账**——宁可少记，也不把花费算到别的题头上。

## 停滞熔断

硬题真正的风险不是派单多，是**同一条死路换个说法反复试**。次数上限只能间接拦，代价是把有效工作一起拦了。所以 `muteki_run` 每轮结束后直接测进展：

- 进展 = 「最新**带证据** fact 的 id 前进」或「flag 条数增加」；
- **observation 与 deadend 不算进展**（排除方向有价值，但连续几轮只在排除方向，说明该换入口了）；
- 连续 `stagnationLimit` 轮无进展 → `stoppedReason: "stagnation"`，并写一条 `review --kind gap`，
  提示人工核对 deadend 覆盖面、是否缺入口/凭据/原语、或换 `muteki_cli` 异构打一遍；
- `stagnationLimit: 0` 关闭熔断；返回值里的 `stagnantRounds` 始终如实计数。

首解优先：flag 一出现就按 `flag` 收束，不会被误判成停滞。

## 依赖

- `board/board.py`（黑板）：`muteki_tick` / `muteki_run` 要靠它读写任务与 flag；
- 可选 `muteki-core`：没有它也能派单，但 `fact --artifact` 会拿不到证据 id。

## 本地测试（不需要进 DSH）

`tests/test_orchestrator.mjs` 用 mock ctx + mock subagents 驱动**真实插件代码**，黑板侧调**真实 board.py**（子进程），
所以额度闸门、停止条件、首解硬 cancel、任务回收这些逻辑都能在本地回归：

```bash
DSH_NODE_MODULES=<你的 DSH home>/profiles/desktop/node_modules \
  node --test tests/test_orchestrator.mjs
```

- 依赖 DSH profile 的 `node_modules`（插件 import 了 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools`）；找不到就全部 **skip**，不算失败。
- 脚手架用 junction 把依赖接进临时目录，清理时先 unlink，**不会递归删到 DSH 的依赖**。
- 负向对照：`MUTEKI_TEST_PLUGIN=<旧版插件路径>` 可以用同一套用例证明缺陷确实存在。
- 用例必须**串行**（脚手架会临时改进程环境变量），不要加 `--test-concurrency`。
- 解释器默认 `python`，可用 `MUTEKI_TEST_PYTHON` 指定。

## 注意

1. **不要用 `install_bundle`**：它会跑一次完整 pnpm install，可能替换原生模块导致宿主崩溃；直接改 profile 的 `cordis.patch.yml` 即可。
2. **插件放 preset 内**：放 profile 全局 insert 会报 `UNAUTHORIZED`（插件工具不在 agent scope，拿不到 exact live parent）。
3. **改代码要换文件名**：ESM 有模块缓存，热加载按 URL 判断；改完把入口改成新文件名并在 `package.json` 里同步。
4. `muteki_cli` 用异步 `execFile`；不要改回 `spawnSync`，否则会卡死 DSH 桌面端。
