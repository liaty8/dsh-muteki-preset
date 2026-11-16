---
name: muteki-board
description: Muteki 黑板协议：读写工作区级作战事实图（fact / dead-end / flag / observation）与资源认领，让同一题目的多个会话与子代理共享已证实结论、避免重复踩坑。CTF、授权渗透、长链排查时使用。
whenToUse: 开始一个需要多步探测的 CTF/攻防任务前；派子代理前；任务收束前；发现又想去试一个之前试过的方向时。
---

# Muteki 黑板

黑板是一个工作区级的 append-only 事实图（SQLite）。它只记四类东西：

- **fact** —— 被真实工具输出支持、可被后续步骤直接引用的结论（必须挂 `--artifact`）；
- **observation** —— 还没被工具证实的推测/观察（`fact` 不带 `--artifact` 时自动落这里，禁止当结论传给下一步）；
- **deadend** —— 被实测排除的方向（测了什么、实际看到什么）；
- **flag** —— 从真实回显里拿到的候选 flag。

推算、经验、猜测**不进事实区**。这是这套流程唯一真正重要的纪律：假事实一旦被下一个 worker 当成已知条件，整条链会连锁跑偏。

数据库位置：当前工作目录的 `.muteki-board/board.db`（可用环境变量 `MUTEKI_BOARD_DB` 覆盖）。同一个题目目录下的所有会话、所有子代理共享同一个库。

## 证据门（muteki-core 插件）

DSH 里的 `muteki-core` 插件会监听每一次真实工具调用，把「工具名 + 参数 + 输出」落盘成证据，并给一个 id（形如 `a1x2y3z4-8f2a`）。`fact` / `deadend` 用 `--artifact <id>` 引用它：

- id 不存在或对应文件丢了 → board.py 直接拒写（退出码 2）；
- 不带 `--artifact` → 记为 observation，`context` 会把它单独列在「未证实观察」，提醒不要当结论；
- 一个结论可以挂多个 `--artifact`（重复传参或空格/逗号分隔）。

证据库默认在 `{{STORAGE}}\index.jsonl`（可用 `MUTEKI_ARTIFACT_DIR` 覆盖，必须与插件配置一致）。

## 资源认领

同一个目标同时只允许一个执行者。开工前先认领一个 lane（名字自取，如 `web-login`、`pwn-heap`、`target-10.0.0.5`）：

- 认领成功 → 独占该 lane，到期自动释放；
- 已被别人占用 → board.py 拒绝并显示持有者与剩余时间，换 lane 或等过期；
- 只有持有者能释放（或等它过期）。

## 按题隔离（题名 challenge）

黑板按题名隔离：fact / deadend / flag / task / review / claim 都带一个 `challenge` 字段，默认只读写「当前题」。上一题留下的 flag、事实、死路、任务不会出现在新题里，也不会被误当成本轮首解。

- 开工先切题：`board.py use web-8080`（题名自取，如 `web-8080`、`pwn-heap-1`）；
- 查看当前题：`board.py current`；
- 跨题回看：`context --all` / `task list --all` / `review list --all` / `stats --all`；
- `muteki_run` 开工前会自动 `use` 到本轮题名（`challenge` 参数可指定，省略则生成 `run-<时间戳>`），并且只把「开工之后新出现的 flag」当作首解。

环境变量 `MUTEKI_CHALLENGE` 可覆盖当前题名（优先级高于数据库里的 meta）。

## 任务队列（意图）

`task` 是主控与子代理之间的待办队列：主控用 `task add` 建任务，`muteki_tick` 或子代理用 `task claim` 原子认领，完成后 `task done`。

```powershell
{{PYTHON}} {{BOARD}} task add "复现登录注入" --detail "背景 + 预期证据 + 停止边界" --priority 3
{{PYTHON}} {{BOARD}} task list --status open
{{PYTHON}} {{BOARD}} task claim 1 --owner worker-a
{{PYTHON}} {{BOARD}} task done 1
```

priority：1 低 / 2 中 / 3 高。`task claim` 只在 open 状态成功，抢不到直接报错，不要重试同一任务。

被用户中断、子代理已经不在了，任务却还卡在 `claimed` 时，用 `task reopen <id>` 或 `task reclaim --minutes 30` 把它们释放回 `open`；否则 `muteki_run` 会看到空队列直接停。`muteki_run` 正常/异常结束时会自动释放本轮没做完的任务。

## 派子代理（muteki_run / muteki_tick / muteki_dispatch / muteki_review / muteki_cli）

**开局门槛**：拿到新题先 `board.py use <题名>` 切到干净题，再 `task add` 拆成至少 2 条有界 Step，然后 `muteki_run`；不要绕过队列自己单干到结束（只有队列空、收尾核对时可以自己做）。`muteki_run` 会自动切题并只认「开工后新出现的 flag」，所以上一题残留的 flag 不会让它一开工就误停。

在 Muteki 蜂群预设下，`muteki_run` 是最省事的一个：给它轮数或分钟上限，它自动反复「取 open 任务 → 原子认领 → 派子代理 → 等这批完成 → 查黑板」，队列空、出现 flag、超时或达到本题每小时派单上限就停，返回 `stoppedReason`。出现 flag 时会立即中断同批其余子代理（首解硬 cancel，不陪跑）。派单额度按题独立：某一题打满 12 次/小时后，换一道新题仍从满额度开始，旧题不会拖累新题；遇到特别难的题超限，就 `task drop` 放弃它、`use` 切到新题，把预算留给新题。

`muteki_tick` 只驱动一轮调度：从任务队列取最高优先级的 open 任务（limit 1-3），原子认领后各派一个全新上下文的子代理，立即返回。

`muteki_review` 起一个**只读 Reviewer 子代理**审图：质疑没有证据的结论、指出重复、找验证缺口，意见写回黑板（`review list` 能看到）。它不碰目标、不执行攻击命令，适合在一个阶段结束或准备交 flag 前跑一次。

`muteki_cli` 把同一个 Step 交给**本地 Claude Code CLI**（独立 `config-worker` 配置：空插件、无记忆、bypassPermissions、DeepSeek 后端）跑，返回它的最终输出与本次花费。它是独立进程，不占 DSH 的子代理席位，适合做真正的跨引擎异构竞速：同一道题让 DSH 子代理与 CC 各打一遍，结论都写回同一块黑板。注意 CLI 是异步调用（默认 5 分钟超时，不阻塞界面，但工具会一直等到它结束），prompt 里要写清「先读黑板、只做这一条、用 board.py 写回、结束 task done」。

也可以手动 `muteki_dispatch` 派单个 Step。子代理是全新上下文，**看不到当前会话**，所以 prompt 必须自包含：

- 背景：题面/目标/已知条件；
- 要回答的问题：这一步只取哪一条信息；
- 预期证据：看到什么算成功；
- 停止边界：试到什么程度就停（次数、耗时、范围）。

参数：`prompt`（必填）、`name`、`lane`（先认领资源，认领失败就不派单）、`lane_ttl`、`provider`/`model`/`reasoning_effort`（指定不同模型做异构竞速）、`cwd`（决定用哪个工作区黑板）。

默认每小时最多派 6 次，防止无人值守时烧预算。子代理的启动/结束会记到 `{{STORAGE}}\subagents.jsonl`。

成本上限按题独立：`muteki_cli` 每次调用会把 Claude Code 上报的 `total_cost_usd` 记进 `costs.json`；**本题**最近一小时累计超过 `maxCostUsdPerHour`（默认 3 美元）后，`muteki_cli` 与 `muteki_run` 都以 `budget` 停止派单。换新题不继承旧题成本，新题从 $0 开始；某题花超就先放下（`task drop`），把预算留给别的题。注意这是 Claude Code 按 Anthropic 标价估算的金额，接 DeepSeek 时实际账单更低。

## 命令

脚本路径固定：`{{BOARD}}`

```powershell
# 开工先读：flag、已证实事实、未证实观察、进行中的认领、已排除方向、任务队列、待处理复核
{{PYTHON}} {{BOARD}} context

# 切题 / 看当前题（按题隔离：上一题的记录默认不可见；--all 才跨题）
{{PYTHON}} {{BOARD}} use web-8080
{{PYTHON}} {{BOARD}} current
{{PYTHON}} {{BOARD}} context --all

# 认领资源（默认 600 秒；--ttl 调时长）
{{PYTHON}} {{BOARD}} claim web-login --ttl 900 --note "SQL 注入验证"
{{PYTHON}} {{BOARD}} release web-login
{{PYTHON}} {{BOARD}} lanes

# 任务队列：建待办 / 认领 / 完成
{{PYTHON}} {{BOARD}} task add "复现登录注入" --detail "预期证据 + 停止边界" --priority 3
{{PYTHON}} {{BOARD}} task list --status open
{{PYTHON}} {{BOARD}} task claim 1 --owner worker-a
{{PYTHON}} {{BOARD}} task done 1

# 查最近捕获的工具证据（拿 --artifact 要用的 id）
{{PYTHON}} {{BOARD}} artifact list --limit 20
{{PYTHON}} {{BOARD}} artifact show a1x2y3z4-8f2a

# 复核意见（Reviewer 写回；查看 / 关闭）
{{PYTHON}} {{BOARD}} review add --kind gap --note "缺什么验证" --target f3
{{PYTHON}} {{BOARD}} review list --status open
{{PYTHON}} {{BOARD}} review resolve 1

# 记一条带证据的事实（只写本步增量，不复述已知内容）
{{PYTHON}} {{BOARD}} fact "标题一句话" "增量结论 + 适用范围" --artifact a1x2y3z4-8f2a --evidence "补充说明（可选）"

# 还没证实的推测：不带 --artifact，会记为 observation
{{PYTHON}} {{BOARD}} fact "待验证" "目前只看到 X，不能确认 Y"

# 推翻旧事实时
{{PYTHON}} {{BOARD}} fact "标题" "新结论与修正依据" --artifact aXXXX --supersedes 3

# 记死路：被测方向 + 范围 + 实际观察（三者缺一不可）
{{PYTHON}} {{BOARD}} deadend "为什么排除" --tested "测了什么、什么范围" --observed "实际看到什么" --artifact aXXXX

# 拿到候选 flag 立刻记，保留原始值
{{PYTHON}} {{BOARD}} flag "flag{...}" --source "从哪个响应/文件来的"

# 检索 / 细读 / 统计
{{PYTHON}} {{BOARD}} search "关键词"
{{PYTHON}} {{BOARD}} read f3
{{PYTHON}} {{BOARD}} stats
```

id 前缀：`f`=fact/observation、`d`=deadend、`g`=flag、`a`=artifact。

## 什么时候写

- 拿到一个**可复用的**入口、凭据、原语、可读数据的通道 → 先跑 `artifact list` 找到刚才那次工具调用的证据 id，再 `fact --artifact`，写清怎么接着用、怎么确认它还活着。
- 只成功过一次的路径，不要写成默认入口。
- 有限实验排除了一个明确假设 → `deadend --artifact`，写清测试范围与实际观察；「没跑通」不是死路，「测了 X 得到 Y」才是。
- 超时、取消、没跑完 → 不写 fact、不写 deadend，如实说明这一步没有结论。
- 提交 flag 前优先确认它来自真实回显；平台判错时回到黑板记录里找原始输出复核。

## 与子代理配合

派子代理时：

1. 先 `context` 读黑板，把当前事实、observation、死路整理成一小段交给子代理（只给它那一步需要的，不要塞整段对话）；
2. 给每个子代理分配不同的 lane 并在派发前 claim；同一时间不要有两个子代理做同一个探测；
3. 子代理回报后，带证据的部分用 `fact --artifact` 写进黑板，其余标注为观察；谁先拿到可验证结果就保留谁。

## 收束

任务结束时用一段话总结：已证实的事实（引用 f 编号）、已排除的方向（d 编号）、还缺什么、下一步最值得做什么。不要为了填满黑板而制造条目。
