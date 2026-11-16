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
# 1) 复制到 profile 的 node_modules
$p = "$env:DSH_HOME\profiles\desktop"
New-Item -ItemType Directory -Force "$p\node_modules\@local\dsh-muteki-orchestrator" | Out-Null
Copy-Item .\* "$p\node_modules\@local\dsh-muteki-orchestrator\" -Force

# 2) 在 preset 的 plugins 里加一行（用包名，不要用相对路径）
- id: muteki-orchestrator
  name: '@local/dsh-muteki-orchestrator'
  config:
    python: 'python'
    boardPy: 'C:\Users\you\.dsh-muteki\board.py'
    storageDir: 'C:\Users\you\.dsh-muteki\artifacts'
    maxRunsPerHour: 12
    hardCancelOnFlag: true
    claudeBin: 'claude'
    claudeConfigDir: ''
    maxCostUsdPerHour: 3
    enabled: true
```

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `python` | `python` | 调 board.py 的解释器 |
| `boardPy` | `~/.dsh-muteki/board.py` | 黑板脚本路径 |
| `storageDir` | `~/.dsh-muteki/artifacts` | 证据与 `runs.json` / `costs.json` / `subagents.jsonl` / `cli.jsonl` |
| `maxRunsPerHour` | `12` | **每题**每小时派单上限 |
| `hardCancelOnFlag` | `true` | 出现本轮新 flag 后中断同批子代理 |
| `claudeBin` | `claude` | Claude Code CLI 路径 |
| `claudeConfigDir` | 空 | 干净配置目录（建议单独一份，无插件无记忆） |
| `maxCostUsdPerHour` | `3` | **每题**每小时 CLI 成本上限 |
| `enabled` | `true` | 总开关 |

## 依赖

- `board/board.py`（黑板）：`muteki_tick` / `muteki_run` 要靠它读写任务与 flag；
- 可选 `muteki-core`：没有它也能派单，但 `fact --artifact` 会拿不到证据 id。

## 注意

1. **不要用 `install_bundle`**：它会跑一次完整 pnpm install，可能替换原生模块导致宿主崩溃；直接改 profile 的 `cordis.patch.yml` 即可。
2. **插件放 preset 内**：放 profile 全局 insert 会报 `UNAUTHORIZED`（插件工具不在 agent scope，拿不到 exact live parent）。
3. **改代码要换文件名**：ESM 有模块缓存，热加载按 URL 判断；改完把入口改成新文件名并在 `package.json` 里同步。
4. `muteki_cli` 用异步 `execFile`；不要改回 `spawnSync`，否则会卡死 DSH 桌面端。
