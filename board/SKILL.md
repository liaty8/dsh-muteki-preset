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
- **flag** —— 从真实回显里拿到的 flag，带证据 id 与验证状态（candidate / submitted / accepted / rejected）。

推算、经验、猜测**不进事实区**。这是这套流程唯一真正重要的纪律：假事实一旦被下一个 worker 当成已知条件，整条链会连锁跑偏。

数据库位置：当前工作目录的 `.muteki-board/board.db`（可用环境变量 `MUTEKI_BOARD_DB` 覆盖）。同一个题目目录下的所有会话、所有子代理共享同一个库。

## 证据门（muteki-core 插件）

DSH 里的 `muteki-core` 插件会监听每一次真实工具调用，把「工具名 + 参数 + 输出」落盘成证据，并给一个 id（形如 `a1x2y3z4-8f2a`）。`fact` / `deadend` 用 `--artifact <id>` 引用它（`flag` 也支持，可选但强烈建议）：

- id 不存在或对应文件丢了 → board.py 直接拒写（退出码 2）；
- 不带 `--artifact` → 记为 observation，`context` 会把它单独列在「未证实观察」，提醒不要当结论；
- 一个结论可以挂多个 `--artifact`（重复传参或空格/逗号分隔）。
- **可选相关性校验 `--quote "<原文片段>"`**（可重复）：要求该片段真实出现在所引证据的内容里。
  `fact` 未命中 → **降级为 observation** 并说明原因；`deadend` 未命中 → **拒写（exit 2）**，因为死路必须是实测排除。
  不带 `--quote` 时行为与旧版完全一致（只校验 id 存在）。注意：证据被截断时（超大输出），
  落在截断部分的片段会校验不到——这时改用更靠前的片段，或等完整输出落盘能力（路线图 C3）。

证据库目录优先级：`MUTEKI_ARTIFACT_DIR` 环境变量 > 安装配置 `~/.dsh-muteki/config.json` 的 `storage_dir` > 内置默认 `~/.dsh-muteki/artifacts`。索引文件为该目录下的 `index.jsonl`，**必须与 muteki-core 插件的 `artifactDir` 一致**，否则证据门找不到 id。配置文件由 `install.ps1` 生成，可用 `MUTEKI_CONFIG` 指向别处。

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
- **归属迁移**：旧题或 `legacy` 里属于本题的记录用 `adopt` 迁过来（默认迁到当前题，`--challenge` 指定目标）。
  当前题为空而其他题有数据时，`context` 顶部会给出提示与迁移命令，避免已解出的成果「看起来消失了」。
- `muteki_run` 开工前会自动 `use` 到本轮题名（`challenge` 参数可指定，省略则生成 `run-<时间戳>`），并且只把「开工之后新出现的 flag」当作首解。

环境变量 `MUTEKI_CHALLENGE` 可覆盖当前题名（优先级高于数据库里的 meta）。

## 任务队列（意图）

`task` 是主控与子代理之间的待办队列：主控用 `task add` 建任务，`muteki_tick` 或子代理用 `task claim` 原子认领，完成后 `task done`。

```powershell
{{PYTHON}} {{BOARD_PY}} task add "复现登录注入" --detail "背景 + 预期证据 + 停止边界" --priority 3
{{PYTHON}} {{BOARD_PY}} task list --status open
{{PYTHON}} {{BOARD_PY}} task claim 1 --owner worker-a
{{PYTHON}} {{BOARD_PY}} task done 1
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

默认每小时最多派 **12** 次（orchestrator 的 `maxRunsPerHour`，**按题独立**），防止无人值守时烧预算。子代理的启动/结束会记到 `{{STORAGE_DIR}}\subagents.jsonl`。

成本上限按题独立：`muteki_cli` 每次调用会把 Claude Code 上报的 `total_cost_usd` 记进 `costs.json`；**本题**最近一小时累计超过 `maxCostUsdPerHour`（默认 3 美元）后，`muteki_cli` 与 `muteki_run` 都以 `budget` 停止派单。换新题不继承旧题成本，新题从 $0 开始；某题花超就先放下（`task drop`），把预算留给别的题。注意这是 Claude Code 按 Anthropic 标价估算的金额，接 DeepSeek 时实际账单更低。

## 命令

脚本路径固定：`{{BOARD_PY}}`

```powershell
# 开工先读：flag、已证实事实、未证实观察、进行中的认领、已排除方向、任务队列、待处理复核
{{PYTHON}} {{BOARD_PY}} context

# 给子代理或上游消费时限定字符预算（超出按段落优先级截断并标注，不会静默丢内容）
{{PYTHON}} {{BOARD_PY}} context --budget 6000

# 只看指定段落、自定义顺序（默认 flags,deadends,facts,tasks,reviews,observations,claims,superseded）
{{PYTHON}} {{BOARD_PY}} context --section deadends,facts,tasks

# 切题 / 看当前题（按题隔离：上一题的记录默认不可见；--all 才跨题）
{{PYTHON}} {{BOARD_PY}} use web-8080
{{PYTHON}} {{BOARD_PY}} current
{{PYTHON}} {{BOARD_PY}} context --all

# 把旧题/legacy 里属于本题的记录迁到当前题（可逗号分隔；--challenge 指定目标题）
{{PYTHON}} {{BOARD_PY}} adopt f1,d3,g1
{{PYTHON}} {{BOARD_PY}} adopt f9 --challenge web-8080

# 认领资源（手动 claim 默认 600 秒；muteki_dispatch 的 lane_ttl 默认 900 秒；--ttl 调时长）
{{PYTHON}} {{BOARD_PY}} claim web-login --ttl 900 --note "SQL 注入验证"
{{PYTHON}} {{BOARD_PY}} release web-login
{{PYTHON}} {{BOARD_PY}} lanes

# 任务队列：建待办 / 认领 / 完成
{{PYTHON}} {{BOARD_PY}} task add "复现登录注入" --detail "预期证据 + 停止边界" --priority 3
{{PYTHON}} {{BOARD_PY}} task list --status open
{{PYTHON}} {{BOARD_PY}} task claim 1 --owner worker-a
{{PYTHON}} {{BOARD_PY}} task done 1

# 查最近捕获的工具证据（拿 --artifact 要用的 id）
{{PYTHON}} {{BOARD_PY}} artifact list --limit 20
{{PYTHON}} {{BOARD_PY}} artifact show a1x2y3z4-8f2a

# 复核意见（Reviewer 写回；查看 / 关闭）
{{PYTHON}} {{BOARD_PY}} review add --kind gap --note "缺什么验证" --target f3
{{PYTHON}} {{BOARD_PY}} review list --status open
{{PYTHON}} {{BOARD_PY}} review resolve 1

# 记一条带证据的事实（只写本步增量，不复述已知内容）
{{PYTHON}} {{BOARD_PY}} fact "标题一句话" "增量结论 + 适用范围" --artifact a1x2y3z4-8f2a --evidence "补充说明（可选）"

# 加强版：要求结论的关键原文真的出现在证据里（未命中会自动降级为观察）
{{PYTHON}} {{BOARD_PY}} fact "延时注入成立" "sleep 6 实测 6.13s" --artifact a1x2y3z4-8f2a --quote "time=6.127874"

# 还没证实的推测：不带 --artifact，会记为 observation
{{PYTHON}} {{BOARD_PY}} fact "待验证" "目前只看到 X，不能确认 Y"

# 推翻旧事实时
{{PYTHON}} {{BOARD_PY}} fact "标题" "新结论与修正依据" --artifact aXXXX --supersedes 3

# 记死路：被测方向 + 范围 + 实际观察（三者缺一不可）
{{PYTHON}} {{BOARD_PY}} deadend "为什么排除" --tested "测了什么、什么范围" --observed "实际看到什么" --artifact aXXXX

# 拿到 flag 立刻记，保留原始值，并绑定真实回显的证据 id
{{PYTHON}} {{BOARD_PY}} flag "flag{...}" --source "从哪个响应/文件来的" --artifact aXXXX

# flag 验证状态机：candidate（候选）→ submitted（已提交）→ accepted / rejected（平台判定）
{{PYTHON}} {{BOARD_PY}} flagstatus 1 --set submitted
{{PYTHON}} {{BOARD_PY}} flagstatus 1 --set accepted --verified-by "平台回显 correct"
{{PYTHON}} {{BOARD_PY}} flagstatus 1 --set rejected --note "平台判错，回到证据复核"

# 检索 / 细读 / 统计
{{PYTHON}} {{BOARD_PY}} search "关键词"
{{PYTHON}} {{BOARD_PY}} read f3
{{PYTHON}} {{BOARD_PY}} stats

# 复盘报告：默认 Markdown（可直接贴 writeup），--json 供插件消费；--challenge / --all 指定范围
{{PYTHON}} {{BOARD_PY}} report
{{PYTHON}} {{BOARD_PY}} report --json
```

`search` 覆盖 fact / deadend / flag / **task / review**（按题隔离，`--all` 跨题）。
`read` 支持 `f3` / `d2` / `g1` / `r1` / **`t2`** / `a<证据id>`，输出该条记录的全部字段。

id 前缀：`f`=fact/observation、`d`=deadend、`g`=flag、`t`=task、`r`=review、`a`=artifact。

## 什么时候写

- 拿到一个**可复用的**入口、凭据、原语、可读数据的通道 → 先跑 `artifact list` 找到刚才那次工具调用的证据 id，再 `fact --artifact`，写清怎么接着用、怎么确认它还活着。
- 只成功过一次的路径，不要写成默认入口。
- 有限实验排除了一个明确假设 → `deadend --artifact`，写清测试范围与实际观察；「没跑通」不是死路，「测了 X 得到 Y」才是。
- 超时、取消、没跑完 → 不写 fact、不写 deadend，如实说明这一步没有结论。
- 提交 flag 前优先确认它来自真实回显，并用 `--artifact` 把那次回显绑上；`flag` 不带证据仍能记录（向后兼容），但会提示「未绑定证据」，且无法与证据库核对。
- flag 有状态：`candidate`（候选）→ `submitted`（已提交平台）→ `accepted` / `rejected`（平台判定）。用 `flagstatus <id> --set <状态>` 推进，`--verified-by` 写判定依据、`--note` 写判定链（例如「与公开 writeup 同值，但已由目标回连实时取证」）。平台判错时标 `rejected`，回到黑板记录里找原始输出复核，不要直接删条目。

## 与子代理配合

派子代理时：

1. 先 `context` 读黑板，把当前事实、observation、死路整理成一小段交给子代理（只给它那一步需要的，不要塞整段对话）；
2. 给每个子代理分配不同的 lane 并在派发前 claim；同一时间不要有两个子代理做同一个探测；
3. 子代理回报后，带证据的部分用 `fact --artifact` 写进黑板，其余标注为观察；谁先拿到可验证结果就保留谁。

## 收束

任务结束时先跑 `report` 拿到结构化复盘（概览计数、flag 与验证状态、已证实事实、已排除方向、任务完成情况、复核意见、时间线、本题派单次数与 CLI 成本），再在此基础上用一段话总结：已证实的事实（引用 f 编号）、已排除的方向（d 编号）、还缺什么、下一步最值得做什么。不要为了填满黑板而制造条目。
