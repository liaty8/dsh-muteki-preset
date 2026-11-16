# muteki-orchestrator

给 DSH agent 提供「程序化派单」能力：主控 agent 不再靠自然语言让子代理干活，而是调用工具把任务派给全新上下文的子代理，并等结果、回收任务、记账。

## 提供的工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `muteki_dispatch` | 手动派一个 Step | `prompt`（必填）、`name`、`lane`、`lane_ttl`、`provider`、`model`、`reasoning_effort`、`cwd` |
| `muteki_tick` | 从黑板任务队列取 1–3 条，批量派一轮 | `limit`（1–3）、`cwd`、`provider`、`model` |
| `muteki_run` | 自动循环：切题 → 回收卡住任务 → 取队列 → 派单 → 等结果 → 查 flag → 直到空/flag/超时/额度 | `limit`、`max_rounds`、`max_minutes`、`challenge`、`cwd`、`provider`、`model` |
| `muteki_review` | 起一个只读 Reviewer 审黑板，意见写回 review 表 | `cwd`、`focus` |
| `muteki_cli` | 把 Step 交给本地 Claude Code CLI（独立进程、异步、不占子代理席位） | `prompt`、`cwd`、`timeout_minutes`（1–30）、`model` |

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
| `storageDir` | `~/.dsh-muteki/artifacts` | 证据与 `runs.json` / `costs.json` / `totals.json` / `subagents.jsonl` / `cli.jsonl` |
| `mode` | `attended` | `attended`=人主导（额度宽）；`unattended`=无人值守/定时任务（额度紧） |
| `maxRunsPerHour` | 按 mode | **每题**每小时派单上限；attended 40 / unattended 12 |
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
| 每小时派单 | `runs.json`（滚动 1h，保留 24h） | 等窗口滚动 |
| 每小时成本 | `costs.json`（滚动 1h，保留 24h） | 等窗口滚动 |
| 整题累计派单 | `totals.json`（**不清理**） | 换一道新题，或调高配置 |
| 整题累计成本 | `totals.json`（**不清理**） | 换一道新题，或调高配置 |

为什么要有整题总闸：每小时上限防的是「短时间失控」，但一道硬题连打八小时照样能烧穿预算——以前没有任何东西拦得住。`totals.json` 按题累计、跨小时不清零，切回旧题继续累计，换新题从 0 开始。

`muteki_run` 的返回值带 `quota` 明细（mode、四个 used/cap、`limitHit`），`stoppedReason: "budget"` 时能直接看出命中的是哪一条。

成本口径提醒：`costs.json` 里的美元来自 Claude Code 按 **Anthropic 标价**的估算，接 DeepSeek 后端时实际账单低一个数量级；DSH 子代理的花费目前尚未计入（见路线图）。

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
