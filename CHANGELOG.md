# Changelog

本项目的所有显著变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布节奏：**3–5 个问题一个 release**（自 1.10.0 起）。每个 release 合并处理一批相关问题，附带回归测试与迁移说明；
正文与 CHANGELOG 都**不写「接下来 / 下一步 / 后续」这类展望段落**。
1.10.0 之前是一个问题一发，往届 21 个碎 release 已按阶段合并为 4 个（tag 与 commit 全部保留）。

---

## [1.12.0] - 2026-11-20

比赛抢速度：首解即报可选开关 + 旗标即时横幅（含复制/删除/全部删除与工作台内确认模态）；并修掉两个实机验证抓出的回归（访问检查误伤自家 UI、run 返回 schema 拒收）。

### Added

- **`flagAlert` 首解即报（默认关，工作台行为区开关）**：新 flag 一写回就落账 `storageDir/flags.jsonl`；工作台顶部横幅 2s 轮询 `/api/muteki/flags` 直接显示 flag 值 + 题名 + 时间，**不用等主会话收束、不用手动点子代理**。
  - attended：flag 探测加密到 1s；run 返回 `solved` + `advice`（提示主会话跳过 review、立即报 flag / 提交）。
  - bulk：run 级 baseline + 1s 旗标守望，worker 写回瞬间落账、**不等该 worker 跑完**；bulk 仍不全局停（别的题还要打），`advice` 提示先报已解出的 flag、剩余 open 任务如需继续再 run。
- 工作台新增 `/api/muteki/flags` 路由（读 `flags.jsonl` 尾部倒序）。
- **旗标横幅逐条操作**：每条 flag 右列固定复制 ⧉ / 删除 🗑 按钮（`flex:none`），长 flag 左列 `min-width:0` 自动换行，窄侧栏不挤掉按钮与时间；复制**只写 flag 值**进剪贴板（async clipboard + execCommand 回退），成功闪 ✓。
- **删除确认改工作台内居中模态**（替换系统白框）：琥珀 ⚠ 警告标 + 品红描边卡片 + flag 值虚线框 + 范围说明（仅删 `flags.jsonl` 留痕、不动黑板 flag）；取消=暗色描边、删除=红→品红渐变白字；点遮罩/取消关闭不删。确认后播 280ms 滑出收起动画。「全部删除」同款模态带条数。
- 新增 `/api/muteki/flags/delete`（ts+challenge+value 精确匹配删单条）与 `/api/muteki/flags/clear`（清空）路由，沿用同源放行/跨域拒绝围栏。
- **宿主版本要求机器可读声明**：工作台 `package.json` 按市场规范以 `peerDependencies` 声明四个宿主包 `>=0.2.2-rc.3 <0.2.3-0`（比较符带预发布标签，rc 构建不被 node-semver 静默排除；已用 semver 实测 rc.3/rc.5/0.2.2 放行）。

### Fixed

- **访问检查误伤自家 UI 导致「保存不了」**：上一版一律走 `connection.requestRejection`，desktop webview 无浏览器登录态 cookie，自家保存请求也被 401。改为只拦**跨域 Origin**（浏览器里别的网页，即市场指出的暴露面），同源 / dsh-app / 无 Origin（工作台自身、本机工具）放行；`connection` 改请求时懒读、不进 inject 依赖（避免宿主不暴露时整组路由不注册）。
- **`muteki_run` 返回被 schema 拒收**：output schema `additionalProperties:false` 未声明新增顶层 `solved`/`advice`（及 attended 的 `limit`），整个返回值被拒、主会话收不到 stoppedReason/advice。补三个可选键；render 单独一行输出 advice；新增防漂移回归（返回体顶层键与 bulk 子键必须都在 schema 声明，并硬断言 attended 带 limit、bulk 不带）。

### Tests

- workbench node:test 14（跨域 403 不写盘 / 跨域无 connection 403 / 自家 UI 不误伤 / flagAlert 可保存可收回 / flags 路由倒序 / delete 精确删单条 / clear 清空 / 跨域删除不写盘）+ orchestrator node:test 58（含 bulk+flagAlert 守望+advice、schema 防漂移）+ Python unittest 147 全绿。
- 实机隔离验证：横幅亮旗早于解旗 worker 结束 20.4s / 8.7s 两轮；settings.flagAlert 跑前跑后不丢；修复后返回完整带出「跳过 review」。
- 浏览器 harness 验证横幅操作：320px 窄栏长 flag 换行 4 行、按钮列固定 61px；复制只含 flag 值；模态居中且限定工作台内、取消不删、确认删除播滑出动画、全部删除清空横幅（截图 `assets/workbench-modal.png`）。

---

## [1.11.1] - 2026-11-19

市场维护者复核指出的本机路由暴露面修复（awesome-dsh-plugin#16667 合并后反馈）。

### Fixed

- **工作台 HTTP 路由缺 DSH 访问检查**：`/api/muteki/settings` 与 `/api/muteki/ledger` 原先任何浏览器打开的网页都能请求。现在每个 handler 先走 `connection.requestRejection(req)`（Host/Origin 围栏防 DNS rebinding / 跨站调用 + 浏览器登录态），被拒返回 401/403 且不触达任何读写；`inject` 声明 `["webServer","connection"]`（与 dsh-host-open-in-app / dsh-experimental-inspector 同款）。无 connection 的旧宿主 / headless 优雅降级。

### Tests

- 新增三条安全回归：connection 拒绝→403 且不写 settings；connection 放行→照常读写；无 connection→不炸。workbench node:test 11 全绿。

---

## [1.11.0] - 2026-11-18

靶场批量模式 + 独立工作台小包 + 运行时覆盖层，一批合并带出；附工作台界面截图（`assets/workbench.png`、`assets/workbench-dsh.png`）。

### Added

- **`mode: bulk`（靶场批量）**：完成驱动并发池，一次打几十上百道独立题。tier `lite/standard/max` = 池 4/8/16，令牌回填与成本墙随档放宽；任一 worker 结束立刻补位（不等整批）；flag 按题归属、不做全局首解 cancel、无停滞熔断；没标 done 的任务重试一次后 drop。整批共用一个 challenge、一题一条 task。返回 `bulk{poolSize,peakPool,solved,dropped}`。
- **`muteki-workbench` 工作台小包**（独立 bundle，进 `dsh.profile.bundles` 白名单）：会话头部「工作台」胶囊 + 右侧栏页签。档位按钮式 UI（稳妥/推荐/全力）、模式卡片、人民币默认与 $ 切换、DeepSeek 实际口径标定、估算免责声明、白字悬浮提示、渐变保存按钮、账本快照、派单自动开子代理实时 pane（最多 8 个）。
- **运行时覆盖层**：工作台保存写 `storageDir/settings.json`，orchestrator 每次额度判定读取（mtime 缓存、优先级高于 patch、数字字符串容错 coerce）；**保存即生效、不用重启**，删文件即收回。服务端 `/api/muteki/settings`（白名单 + coerce）与 `/api/muteki/ledger` 走 `ctx.inject(["webServer"])` 注册。
- **attended 返回体新增生效 `limit`**（clamp 1-3），避免把「多轮累计派发数」误读成「同时并行数」。

### Fixed

- **工作台「选档位却仍跑 attended」的静默错位**：旧版档位按钮只写数字、不写 mode/tier，保存推荐档后 mode 仍是 attended，bulk 路径根本不触发；首开默认也预填推荐数字 + mode 跟随，踩同一个坑。现在**点档位即写入 `mode=bulk` + `tier`（safe/rec/full → lite/standard/max）+ 推荐数字**；切回人主导/无人值守自动清 tier；首开默认人主导 + 跟随预设（推荐仅 badge 标示）；非批量却带数字覆盖时显示琥珀提示「并发池不启用、数字仅作额度覆盖」。
- **bulk worker 误试 `board.py observation` 子命令**（验证轮发现，argparse invalid choice 浪费一轮）：bulk 提示词补明「黑板没有 observation 子命令，记观察用不带 --artifact 的 fact」。

### Changed

- 工作台计价默认 **CNY**（汇率 7.2 可调），推荐档成本墙按 DeepSeek 实际口径（usdActual ≈ 估算×0.1）标定，量级真实；旁常驻「价格预算仅为估算，不代表实际使用」。其它模型消耗不做逐模型计价，保持原样。
- 保存栏改底部固定 + 内容区独立滚动（不再遮挡账本）；窄侧栏 320/360/400 宽 auto-fit 网格 + 行内换行，无横向溢出。

### Tests

- 新增 bulk 回归（tier 额度、完成驱动补池时序、flag 按题归属不全局停摆、重试一次后 drop、提示词隔离共享 flag）与工作台回归（白名单/coerce/400/ledger/enabled/无 web/晚到 web inject、settings 覆盖运行时生效删除即收回、attended limit=8→3/轮×3 轮=8 派发）。
- 全量：Python unittest 147 + orchestrator node:test 55 + workbench node:test 8 全绿。

---

## [1.10.1] - 2026-11-17

DSH 只读审查反馈的一批问题合并处理，并带出上一轮未发版的用法小修（commit `daf371f`）。

### Fixed

- **worker 提示词里的裸 `board.py` 命令**（审查第 1 条，实际比报告的更多）：
  `workerPrompt` 硬要求里 `context` / `task done` / `artifact list` / `deadend` / `flag` 共 5 行 7 处
  写的是裸 `board.py ...`，子代理 cwd 是工作区、PATH 里没有 `board.py`，照字面执行会 command not found。
  全部改为 `{{PYTHON}} {{BOARD}}` 模板（fillCmd 渲染成本机绝对路径）；
  `muteki_dispatch` 的工具描述同步改为「命令绝对路径见 muteki-board 技能」。
- **`muteki_tick` 不回收卡住的任务**（审查第 3 条）：上一轮 run 被中断留下 claimed 任务时，
  手动 tick 会看到空队列。现在 tick 开工先跑 `task reclaim --minutes 30`，与 run 一致。
- **等令牌期间被用户中断被误报成 `budget`**（审查第 3 条）：`ensureQuota` 等待被 `exec.signal`
  打断后额度仍不足，run 原来一律按 `budget` 收束。现在如实返回 `stoppedReason: "interrupted"`，
  render 附「被用户中断而停止（不是额度用尽）」说明；未做完的任务照常由 finally 释放回队列。

### Changed

- **persona「四个入口共用额度闸门」表述不准**（审查第 2 条）：同句列了 5 个工具，且
  `muteki_review` 实际不过闸门也不记账。改为「四个派单入口（run/tick/dispatch/cli）共用额度闸门；
  muteki_review 只读审图，不派单也不计额度」，SKILL / 插件 README / 主 README 同步写明豁免。
- 带出 `daf371f` 的用法小修：`fact list` 列出已有事实与观察、`task claim --as` 别名、
  `--all` 跨题语义与空列表提示、令牌充足时授权留痕的渲染文案。

### Added

- 插件测试 +3（46 → **49**）：worker 提示词命令全带绝对路径且无裸 `board.py`、
  tick 开工回收 40 分钟前卡住的 claimed 任务、等令牌期间中断返回 `interrupted`。
  三条均先对旧插件跑过负向对照（全部失败）再对新代码跑通。

### 审查核对（未采纳项）

- 「tool-agent-team 禁用理由已过时」**不成立**：本机 DSH 0.2.2-rc.3 的 dsh-base（0.1.3-alpha.2）
  patch 里没有 agent-team / tool-agent-team，node_modules 也没有该包与 agentTeams 服务，
  保留 `disabled: true` 与原注释。
- 并发文件锁 / FIFO 归因窗口 / execFile 进程树残留：人主导单会话场景影响很小，
  FIFO 待归属条目会被 start 事件权威覆盖，本版不动。
- 本机 `muteki-core.mjs` 是手工定制版（有意不覆盖）；本机 SKILL 实路径版是安装渲染产物，均属设计内。

### Migration

- 无黑板 schema 变更、无配置字段变更。插件覆盖后需重启 DSH。
- 行为变化：tick 开工多一次 reclaim（只释放 claimed 超过 30 分钟的任务）；
  run 被中断时 `stoppedReason` 从 `budget` 变为 `interrupted`（监控/复盘脚本如有硬编码需同步）。

---

## [1.10.0] - 2026-11-16

DSH 实机验证（v1.9.1）反馈的一批问题合并处理。**发布节奏从本版起改为「3–5 个问题一个 release」**，
不再一个问题一发；往届 21 个碎 release 已按阶段合并为 4 个（tag 与 commit 全部保留）。

### Fixed

- **`override_quota` 在令牌充足时是静默 no-op**（实机 D 组不符的根因）。
  旧实现先 `if (state.ok) return`，授权分支根本走不到，于是黑板没有 observation、`overrides.jsonl` 也不生成。
  改为：**只要人显式表了态就留痕**，不论令牌是否真的不足、授权是否被拒。
  - `logOverride` 增加 `allowed` / `needed` / `blockedBy` 三个维度，标题区分「额度越过（人工授权）」与「额度越过被拒（人工授权尝试）」；
  - 令牌充足时 `overridden=false`、`overrideNote` 说明「未实际放宽，仅记录授权」，但痕迹照样留下；
  - unattended 下被拒、撞上成本/整题总闸被拒，**同样留痕**（`allowed:false` + `blockedBy`），便于审计「谁在什么时候试图越过什么」。
- **`quota.costBasis` 有字段但不在返回文本里渲染**（实机 C 组 ⚠️）：run 的 render 现在显示「成本口径 estimate/actual」。
- **worker 写 `task done t1` 被拒**：`workerPrompt` 的硬要求里明确「id 写数字或带前缀都行」，
  配合 1.9.2 的黑板侧放宽，子代理不必再绕弯。

### Changed

- `ensureQuota` 返回值区分 **`rateBypassed`**（本轮授权是否放宽了速率闸，供批次内判定用）与
  **`overridden`**（是否真的需要放宽）；run 输出新增 **`overrideRequested`**。
  批次内判定改用 `rateBypassed`，所以「令牌充足时授权」也能覆盖整轮，而不是只覆盖第一次派单。
- 文档补上**停滞熔断的前提**：每轮只取 `limit` 条，**队列先空会先以 `empty` 停止**；
  只放 3 条任务时永远走不到 5 轮停滞，要实测至少放 `stagnationLimit × limit` 条。
  （实机 C 组第一次「不符」正是这个原因，不是缺陷。）
- `README.md` / `board/SKILL.md` / 插件 README：override 留痕语义、`overrideRequested`、`costBasis` 渲染、停滞前提。
- 本 CHANGELOG 删掉 1.6.0 的「后续」节；**此后 release 正文与 CHANGELOG 不再写「接下来 / 下一步 / 后续」这类展望段落**。

### Added

- 插件测试 +4（41 → **45**）：令牌充足时授权也留痕（`allowed:true, needed:false`）、
  unattended 授权被拒仍留痕（`blockedBy:"mode"`）、撞整题总闸被拒仍留痕（`blockedBy:"runsPerChallenge"`）、
  run 区分 `overrideRequested` 与 `overridden`。

### Migration

- 无黑板 schema 变更。`overrides.jsonl` 旧条目没有 `allowed`/`needed`/`blockedBy` 字段，读时按缺省处理即可。
- 行为变化：显式带 `override_quota=true` 时**总会**在黑板多一条 observation。这是有意的——人工授权必须可见。
- 插件覆盖后需重启 DSH。

### 验证

```bash
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs   # 45 pass
python -m unittest discover -s tests                                             # Ran 136 tests ... OK
```

实机已验证通过的部分（v1.9.1，本轮未改动）：预设加载与五个工具、`mode: attended` 生效、
真实 DSH `subagent/start|end` 事件被捕获并按墙钟归因到正确题名（`basis=estimate-time`、
`usdActual=usdEstimate×0.1`）、totals/runs/buckets 三处同步、停滞熔断在 5 轮触发并写 gap review。

[1.10.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.10.0

---

## [1.9.2] - 2026-11-16

来自 DSH 实机验证反馈：**worker 写 `task done t1` 被拒**。缺陷修复（可用性），升 patch。

### 问题

`read` / `search` / `task list` / `context` 全都用**带前缀**的 id 展示（`t1` / `g1` / `r1`），
但写操作 `task claim/done/drop/reopen`、`review resolve`、`flagstatus` 的 argparse 是 `type=int`，
只收纯数字。子代理照着黑板显示的样子抄，就会撞上：

```text
argument id: invalid int value: 't1'   (exit 1)
```

实机验证里 worker 因此绕了一次弯。这是展示口径与输入口径不一致，不是子代理的问题。

### Fixed

- 新增 `record_id_type(prefix)`：argparse 类型工厂，**同时接受 `1` 与 `t1`**（大小写不敏感）。
- 六个命令换用它：`task claim/done/drop/reopen`（`t`）、`review resolve`（`r`）、`flagstatus`（`g`）。
- **前缀必须与命令匹配**：给 `task done` 传 `g1` 仍然 exit 2，不会静默当成另一条记录；
  非数字（`abc` / `t` / `t1x`）同样 exit 2。报错信息说明期望格式。
- 事件 payload 里的 `id` 仍是整数，与纯数字写法完全一致（有用例核对）。

### Changed

- `board/SKILL.md`：id 前缀段落补「写操作也接受带前缀 id」，并说明前缀必须匹配。

### Added

- `tests/test_board.py` 新增 `TestPrefixedIds`（11 个用例，总数 125 → **136**）：
  六个命令各自接受前缀、大写前缀、纯数字回归、错前缀拒写且状态不变、非数字拒写、
  前缀写法与数字写法写出同一条事件。

### Migration

无需迁移，纯输入放宽，旧写法（纯数字）行为不变。

### 验证

```bash
python -m unittest discover -s tests   # Ran 136 tests ... OK
```

**负向对照**：用 v1.9.1 的 `board.py` 跑新用例 → **9 failures**；
通过的 2 个正是「纯数字仍可用」「非数字拒写」这两条既有行为。

[1.9.2]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.9.2

---

## [1.9.1] - 2026-11-16

文档与实现一致性核对（额度改造四连发之后）。纯文档，升 patch。

### Fixed

- `README.md`
  - 程序化派单表里 `muteki_run` 的停止条件还写着「队列空 / flag / 超时 / 达额度」，**漏了停滞熔断**；补全并列出 `stoppedReason` 六种取值与新增返回字段。
  - `config.json` 示例里 `"version": "1.1.2"` 是几个版本前的死值（实际由 `install.ps1` 从 `package.json` 读取）→ 改成占位符并说明来源，避免再次腐化。
  - `storageDir` 说明漏了 `buckets.json` / `overrides.jsonl`，且斜杠串写法会被敏感信息门禁误判成长 base64 串 → 改为逐个文件名。
  - 「黑板常用命令」补齐 `context --budget/--section`、`flagstatus`、`adopt`、`artifact list`、`read`、`search`、`report`（`report` 是收束出口，之前只在 SKILL.md 里出现）。
  - 顶部特性列表补「连续多轮无进展也会停下来找人」；使用步骤补第 6 条「离开电脑 / 挂定时任务改 `mode: unattended`」。
  - 插件独立使用的依赖描述补上进展快照与 review 写回。
- `plugins/dsh-muteki-orchestrator/README.md`
  - 工具表里 run 的停止条件同样漏了停滞；
  - `quota` 明细还写着「四个 used/cap」，与实际字段（tokens/burstRuns/onQuota/costBasis/…）不符 → 按实际返回列全。
- `board/SKILL.md`
  - `muteki_run` 那段在四个 release 里被反复追加，已经长成一大坨难读的长句 → 拆成「返回字段 / 额度规则 / 停滞熔断」三块；
  - `muteki_dispatch` 参数列表补 `override_quota` / `override_reason`，并说明另外三个工具也支持。

### 核对方式

把 README 配置表与插件 `Config` schema 逐字段对照：**19 个字段完全一致**，无遗漏无多余。
另全仓 grep 陈旧措辞（`12 次` / `$3` / `1.1.2` / `达额度` / `每小时派单上限`），确认剩下的命中都是**有意保留的历史描述**
（CHANGELOG 旧条目、插件 README 里解释「为什么不用滚动窗口」的对比句）。

### Migration

无代码变更，无需迁移。`board.py` 与插件逻辑均与 1.9.0 相同。

[1.9.1]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.9.1

---

## [1.9.0] - 2026-11-16

额度机制改造第 4 步（收尾）：**成本账本只记了一半，口径也没标**。新能力，升 minor。

### 问题

- `recordCost` 只在 `muteki_cli` 里调用，**主力用的 DSH 子代理花多少完全没进账本**——
  所谓「成本上限」其实只拦得住 CLI 那一小部分。
- 账本里的美元是 Claude Code 按 **Anthropic 标价**的估算，接 DeepSeek 后端实际低一个数量级，
  但条目上没有任何口径标注，看账的人无法判断这是估算还是账单。

### 核对过的事实（不是猜的）

DSH 0.2.2-rc.3 的 `subagent/end` payload = `runInfo`（`runId` / `provider` / `parentSessionId` / `id` / `local`）
+ `stopReason` + `lastAssistantMessage`（`ContentBlock[]`）。查过 `dsh-subagent` 与 `dsh-llm` 的类型定义：
**不带 token usage**，`ContentBlock` 的七种类型（text / reasoning / image / file / tool-call / tool-addition / tool-removal）里也没有 usage 字段。
所以 worker 成本**只能按墙钟时间估**，并如实标 `basis`；将来版本带上 usage / costUsd 时会自动改用真实值。

### Added

- **DSH 子代理花费记账**：`subagent/start` 记起始时刻，`subagent/end` 结算
  `墙钟分钟 × workerUsdPerMinute`（默认 **0.1**，Anthropic 标价口径），`basis: estimate-time`，engine `dsh-subagent`。
  `workerUsdPerMinute: 0` 可关闭。
- **两种口径并存**：每条成本同时存 `usdEstimate` 与 `usdActual`（= 估算 × `estimateToActual`，默认 **0.1**）；
  `usd` 字段保留同值兼容老账本。新增 **`costBasis`**（`estimate` 默认 / `actual`）决定闸门比哪一个。
- **basis 标注**：`estimate-anthropic`（CLI 上报值）、`estimate-time`（worker 墙钟估）、`actual`（事件直接给 costUsd）。
  事件若带 `usage.inputTokens/outputTokens`，一并记进 `tokens` 字段，供将来按 token 计价。
- **归因机制**：`subagent/end` 只带 childId、不带题名，所以派单前按 FIFO 挂待归属题，
  `start` 事件认领、拿到 childId 后权威覆盖；**归因不了就不记账**（宁可少记，不算到别的题头上）。
  待归属队列有界（16），派单失败不会留下无限增长的陈旧条目。
- `muteki_run` 的 `quota` 明细补 `costBasis`。
- 插件测试 +9（32 → **41**）：worker 入账与题名归因、墙钟耗时记录、`estimateToActual` 换算、
  `workerUsdPerMinute=0` 不估、事件带 `costUsd` → `actual`、带 usage → 保留 tokens、
  归因不了不入账、`costBasis` 两种口径分别判定、**老账本只有 `usd` 也能读且 actual 口径按系数换算**、
  worker 花费计入整题成本总闸、run 输出带 costBasis。
- 测试脚手架补 `emit()` 与生命周期模拟：mock subagents 现在会发 `subagent/start` / `subagent/end`，
  `endInfo` 可注入 usage 字段测「未来版本带 usage」的分支。

### Fixed

- **极短命子代理的归因竞态**：`end` 可能比 `startActivation` 返回更早到（那时还没拿到 childId），
  导致成本被丢弃。改为派单前先挂 FIFO 待归属题，`start` 事件即可认领。
  这个缺陷是测试脚手架模拟「零耗时 worker」时抓出来的，真实 DSH 里 worker 至少跑几秒，但失败即退的场景同样会踩。

### Migration

- 无黑板 schema 变更。老 `costs.json` / `totals.json`（只有 `usd`）继续可读：
  estimate 口径直接用，actual 口径按 `estimateToActual` 换算。
- **默认行为变化**：worker 现在也计成本了，所以成本闸会比以前更早命中。
  嫌紧就调高 `maxCostUsdPerHour` / `maxCostUsdPerChallenge`，或设 `workerUsdPerMinute: 0` 关掉 worker 估算。
- 想按真实账单口径管钱：设 `costBasis: actual`，同时把上限调低约 10 倍（例如 $1.5/h、整题 $5）。
- 插件覆盖后需重启 DSH。

### 验证

```bash
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs   # 41 pass
python -m unittest discover -s tests                                             # Ran 125 tests ... OK
```

[1.9.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.9.0

---

## [1.8.0] - 2026-11-16

额度机制改造第 3 步：**硬题该被「没进展」拦，不该被「次数」拦**。新能力，升 minor。

### 问题

棘手题真正的风险不是派单多，是**同一条死路换个说法反复试**。以前只能靠次数上限间接拦，
代价是把有效工作一起拦了；而额度放宽之后（1.6.0 / 1.7.0），这种空转可以持续更久、烧更多钱。

### Added

- **停滞熔断**：`muteki_run` 每轮结束后比较进展快照——
  - 进展 = 「最新**带证据** fact 的 id 前进」或「flag 条数增加」；
  - **observation 与 deadend 不算进展**（排除方向有价值，但连续几轮只在排除方向说明该换入口了）；
  - 连续 `stagnationLimit` 轮无进展 → `stoppedReason: "stagnation"`，并写一条
    `review --kind gap`，提示核对 deadend 覆盖面、是否缺入口/凭据/原语、或换 `muteki_cli` 异构打一遍。
- **`stagnationLimit` 配置**：attended **5** / unattended **3**，**0 = 关闭**；显式值优先于预设。
- **`muteki_run` 返回 `stagnantRounds`**（始终如实计数，即使熔断关闭）；render 文本显示
  「连续 N 轮无新增 fact/flag」，并在 stagnation 时提示「先看 review list，不要原样重跑」。
- 新增 `progressSnapshot(cwd)`：复用 `context --json`（facts 按 id DESC，`max(id)` 即全题最新 fact id），
  不额外增加黑板命令种类。
- 插件测试 +6（26 → **32**）：触发熔断并写 review gap、每轮有新 fact 则不熔断、
  只写 observation 不算进展、只写 deadend 不算进展、`limit=0` 关闭、**首解优先于停滞判定**。

### Changed

- `muteki_run` 的停止条件从「空 / flag / 超时 / 额度」扩展为「空 / flag / 超时 / 额度 / **停滞**」。
- `preset-muteki.patch.yml` 的 config 注释与 **persona** 同步：撞上停滞先读 review 意见再决定下一步。
- `README.md`、`board/SKILL.md`、插件 README（新增「停滞熔断」一节）。

### Migration

无黑板 schema 变更（复用既有 `review` 表）。默认即生效；不想要就设 `stagnationLimit: 0`。
插件覆盖后需重启 DSH。

### 验证

```bash
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs   # 32 pass
python -m unittest discover -s tests                                             # Ran 125 tests ... OK
```

另修掉一个**测试自身的竞态**：unattended「立即停并给 resumeAt」用例原先把回填速率设成 3600 次/小时
（1 个/秒），闸门判定与退出取值之间几毫秒就可能回填满桶，导致 `resumeAt` 偶发为 0。
改成 60 次/小时后判定稳定——产品行为没问题（桶满了自然不需要等），是用例设计不当。

[1.8.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.8.0

---

## [1.7.0] - 2026-11-16

额度机制改造第 2 步：**消除「打满额度后干等 60 分钟」的悬崖**。新能力，升 minor。

### 问题

`recentRuns` 是滚动小时窗口：打满上限后，最坏要等 **60 分钟**才腾出 1 个额度，
而 `muteki_run` 直接返回 `budget`，人不在就干等。硬题的派单本来是「前密后疏」
（开局 recon + 第一轮 exp 要一口气铺出去），滚动窗口恰好在最需要突发的时候卡死。

### Added

- **派单令牌桶**（新账本 `buckets.json`，按题独立）：
  - 容量 `burstRuns`：attended **60** / unattended **12**（开局可一次性派这么多）；
  - 回填速率 `maxRunsPerHour`：attended 40 / unattended 12（次/小时，连续回填，不是整点重置）；
  - 每次派单消耗 1 个令牌；`runs.json` 保留为流水（供复盘），不再当硬闸。
- **`onQuota` / `maxWaitMinutes`**：`muteki_run` 令牌不足时 `wait`（等回填，attended 默认最多 10 分钟）
  或 `stop`（unattended 默认，绝不自作主张等待）。等待可被 `exec.signal` 中断。
  **只作用于 run 的循环**；`dispatch` / `tick` / `cli` 立即返回，不阻塞界面。
- **`override_quota` / `override_reason` 参数**（dispatch / tick / run / cli 四个工具都有）：
  仅 `mode: attended` 有效，人显式越过本轮**速率**限制；往黑板写一条 observation（无证据、不算事实）
  并记 `overrides.jsonl` 留痕。**成本上限与整题总闸越不过去**，批次内也照常判定。
- **`muteki_run` 新返回字段**：`resumeAt`（下一个令牌回填时刻，epoch ms）、`waitedMs`（本轮累计等待）、
  `overridden`、`overrideNote`（override 为什么没生效）；`quota` 明细补 `tokens` / `burstRuns` / `onQuota` / `maxWaitMinutes`。
  render 文本同步显示等待秒数、越过留痕与「约几点几分回填出下一个令牌」。

### Changed

- `maxRunsPerHour` 语义从「每小时硬上限」变为「**令牌回填速率**」；硬闸由桶容量承担。
  显式配置仍然优先，老配置写死的数值不会被预设改掉。
- 额度判定不再抛异常式处理 override 误用：撞上钱的闸时 run **优雅收束**
  （`stoppedReason: "budget"` + `overrideNote`），而不是整个工具报错。
- 移除 run 批次结束后的那一次额度判定——否则刚派完一批就 `budget` 退出，等待机制永远没机会生效；
  统一回到循环顶部由 `ensureQuota` 处理。
- `preset-muteki.patch.yml` 的 config 注释与 **persona 额度描述**同步为令牌桶语义。
- `README.md`、`board/SKILL.md`、插件 README：额度表格、等待/越过规则、工具参数表。

### Migration

- 无黑板 schema 变更。`buckets.json` 首次判定时自动创建，**新题从满桶开始**。
- 行为变化：同样配置下开局能派更多（突发），随后按速率持续供给；
  `attended` 的 run 在令牌不足时会**等一会儿**而不是立刻停（不想等就设 `onQuota: stop`）。
- 插件覆盖后需重启 DSH。

### 验证

```bash
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs   # 26 pass
python -m unittest discover -s tests                                             # Ran 125 tests ... OK
```

新增 12 个用例（14 → **26**）：突发额度可超过每小时速率、时间过去按速率回填（不用等满一小时）、
`onQuota=wait` 真的等并继续派下一轮、unattended 默认 stop 且给 `resumeAt`、等待被 `maxWaitMinutes` 封顶、
override 在 attended 生效并留痕（黑板 observation + `overrides.jsonl`）、unattended 下拒绝、
**override 不能越过整题派单总闸 / 成本总闸**、批次内总闸照常拦、unattended 带 override 时 run 优雅停并说明原因。

过程中抓到一个自己引入的缺陷：override 在循环顶部生效后，**批次内仍用未放宽的 `quotaState` 判定**，
导致第二轮一个都派不出去（`dispatched=1`）。改为 `roundQuotaOk()`：override 只放宽令牌，钱的闸照常拦。

[1.7.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.7.0

---

## [1.6.0] - 2026-11-16

对应额度机制改造第 1 步：**硬题很容易打满每小时上限，然后干等**。新能力，升 minor。

### 问题

- `maxRunsPerHour: 12` / `maxCostUsdPerHour: 3` 是「无人值守防烧钱」的值，却被当成所有场景的默认。
  人坐在屏幕前打一道硬题（几十上百个 Step）时，12 次/小时意味着大部分时间在等窗口滚动。
- 每小时上限**防不住总花费**：12 次/h × 8 小时 = 96 次，没有任何东西拦得住一道题烧穿预算。
- 四个入口的判定各写各的：`dispatch` 只查次数、`cli` 只查成本、`run` 查两者，口径容易分叉。
- 美元口径失真：`costs.json` 记的是 Claude Code 按 **Anthropic 标价**的估算，接 DeepSeek 实际低一个数量级，
  $3/h 估算 ≈ 实际 $0.3/h，紧得没有意义。

### Added

- **`mode` 配置**：`attended`（人主导，默认）/ `unattended`（无人值守、定时任务）。两套预设：

  | 上限 | attended | unattended |
  |---|---|---|
  | 每小时派单 | 40 | 12 |
  | 每小时成本 | $15 | $5 |
  | 整题累计派单 | 300 | 100 |
  | 整题累计成本 | $50 | $15 |

- **整题累计总闸**：新账本 `totals.json`（按题累计、**不做 24h 清理**），新增
  `maxRunsPerChallenge` / `maxCostUsdPerChallenge`。每小时上限防短时间失控，整题总闸防长时间烧穿。
- **统一判定 `quotaState()`**：`muteki_dispatch` / `muteki_tick` / `muteki_run` / `muteki_cli`
  四个闸门共用，命中任一上限即拒派/停止，报错点名「哪条上限、用了多少/上限多少、怎么恢复」。
- **`muteki_run` 返回 `quota` 明细**：mode、四个 used/cap、`limitHit`；render 文本同步显示，
  `stoppedReason: "budget"` 时不再需要猜是哪条闸拦的。
- 导出 `PRESETS` 与 `resolveLimits(config)`（纯函数，便于测试与文档核对）。
- **插件侧本地测试脚手架** `tests/orchestrator_harness.mjs` + `tests/test_orchestrator.mjs`（`node:test`）：
  mock ctx + mock subagents 驱动**真实插件代码**，黑板侧调**真实 board.py** 子进程。
  额度、停止条件、首解硬 cancel、任务回收从此不必进 DSH 就能回归。
  依赖 DSH profile 的 `node_modules`（`DSH_NODE_MODULES` 指定），找不到则全部 skip；
  用 junction 接依赖、清理前先 unlink，不会递归删到 DSH 的依赖；
  `MUTEKI_TEST_PLUGIN` 可指向旧版插件做负向对照。

### Changed

- 四个额度字段改为**可省略**：省略即用 `mode` 预设，**显式写出的值优先**。
  老配置里写死的 `maxRunsPerHour: 12` / `maxCostUsdPerHour: 3` 仍然被尊重，不会被预设悄悄改掉。
- `preset/preset-muteki.patch.yml`：去掉写死的 `12` / `3`，改为 `mode: attended` + 预设说明注释；
  **persona 里的额度描述同步更新**（否则 agent 以为还是 12 次/$3）。
- `README.md`、`board/SKILL.md`、`plugins/dsh-muteki-orchestrator/README.md`：
  额度表格、恢复方式、成本口径提醒、本地测试说明、目录结构。
- 移除 `costBudgetLeft()`（被 `quotaState()` 取代）。

### Migration

- 无 schema 变更（黑板侧 untouched）。`totals.json` 首次派单时自动创建；
  **历史派单不回填**，所以升级后整题累计从 0 开始计。
- 已有安装若显式写着 `maxRunsPerHour: 12` / `maxCostUsdPerHour: 3`，行为不变；
  要吃到新预设，把这两行删掉并加 `mode: attended`（或直接跑新版 `install.ps1` 生成的 patch）。
- 插件文件覆盖后**需要重启 DSH**（ESM 按 URL 缓存模块）。

### 验证

```bash
python -m unittest discover -s tests                                    # Ran 125 tests ... OK
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs   # 14 pass
```

- **负向对照**：同一套 14 个用例指向 v1.5.2 的插件 → **11 fail / 3 pass**；
  通过的 3 个正是「tick 小时上限」「首解即停」「中断后任务回收」这些既有行为（回归护栏两边都该绿）。
- 覆盖点：两套预设与非法值回落、显式覆盖优先、老配置不被改、每小时/整题两类闸门、
  小时窗口滚过去后总闸仍生效、按题独立、tick 部分派单、cli 成本总闸、
  run 的 budget 停止与 quota 明细、unattended 预设、empty/flag 停止与任务回收回归。

[1.6.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.6.0

---

## [1.5.2] - 2026-11-16

来自 DSH 实机验证反馈：**`context --budget N` 的输出会超过 N**。缺陷修复，升 patch。

### 问题

截断提示行是在预算核算**之外**追加的：装填循环只保证「内容 ≤ 预算」，随后无条件
`out.append(提示行)`，于是 `--budget 250` 实际输出 337 字符（提示行约 90 字符白送）。
对「把 context 塞进子代理 prompt 并限定字符数」这个用途来说，承诺没兑现——上游按 N 预留空间就会溢出。

同时确认一个**不是缺陷**的现象：内容本身不足预算时不出现提示行（实机验证库里只有 387 字符，
`--budget 800` 自然不截断）。这是预期行为，本次不改。

### Fixed

- `cmd_context` 重写装填逻辑为 `fill(limit, head)` + **提示行预留收敛**：
  1. 先按全额预算装填，找到第一个被截断的段；
  2. 为该段的提示行预留 `len(note)+1` 字符后重装；
  3. 预留可能让截断点前移、提示变长（未显示段更多），迭代到「截断点 + 提示长度」收敛
     （单调收敛，上限 `len(order)+2` 轮，纯内存操作无额外 I/O）。
- **优雅降级**而不是静默超限：预算连「头部 + 提示」都放不下时，先把提示换成短式
  （`预算 N 用尽：deadends 截断，未显示 facts, tasks；--json 取全量`），
  再压缩头部（去掉 db / 证据库路径，显式标注「头部已压缩，路径见 --json」）。
- **最终硬保证**：`len(stdout) ≤ N`（含 `print` 末尾换行）。极小预算（如 `--budget 1`）
  只能硬截留「…」，但绝不超限。
- 修正一处命名遮蔽：新加的标志位原名 `short`，与模块级 `short()` 函数同名，
  会让整个 `cmd_context` 里的 `short(...)` 调用抛 `UnboundLocalError`；改名 `short_note`。

### Changed

- `--budget` 的 help 与 `board/SKILL.md` 明确「输出总长含提示行与末尾换行，保证 ≤ N」，
  并说明小预算下的降级顺序。

### Added

- `tests/test_board.py` `TestContextBudgetAndOrder` 增 6 个用例（总数 119 → **125**）：
  多档预算（200/250/400/800/1200/3000）输出均 ≤ 预算；提示行存在且被计入；
  提示点名的段与「未显示」列表和实际输出一致；极小预算（1/2/40/120）仍有界；
  长路径工作区下紧预算必须显式降级；内容放得下时不出现提示行。

### Migration

无需迁移，不涉及 schema 变更。行为变化只有一处：**同样预算下内容会比以前略少**
（因为提示行现在占额度），这是兑现承诺的必然代价。要全量始终用 `--json`。

### 验证

```bash
python -m unittest discover -s tests   # Ran 125 tests ... OK
```

- **负向对照**：用 v1.5.1 的 `board.py` 跑新用例 → 4 failures
  （`323 not <= 250`、`297 not <= 200`、`295 not <= 1`）。
- **真实库只读复验**（短路径工作区）：`--budget 250 → 231`、`400 → 400`、`800 → 617`、
  `2000 → 1946` 字符，全部 ≤ 预算，提示行正确点名被截断的段与未显示段。

[1.5.2]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.5.2

---

## [1.5.1] - 2026-11-16

来自 DSH 实机验证反馈：**`adopt` 的事件写进了库，却永远不出现在按题复盘里**。缺陷修复，升 patch。

### 问题

`cmd_adopt` 写 `adopted` 事件时 payload 只有 `target / moved / skipped`，没有 `challenge`；
而 `report` 的时间线按 `payload["challenge"] == 当前题` 过滤，于是：

- `report` / `report --json` 的时间线**永远看不到 adopted**（Markdown 里早已写好「迁移 N 条」的渲染分支，却收不到事件）；
- `counts.events` 少计（实机验证：当前题实际 10 条相关事件，JSON 只报 9 条）；
- `adopt --challenge 别的题` 时，这次迁移在目标题的复盘里同样消失。

事件本身没丢（events 表里查得到，`challenge` 为 `None`），丢的是**按题可见性**。
这是 A1 之后同一类缺陷的第二个变种：A1 是事件没提交，本次是事件提交了但没有归属维度。

### Fixed

- `cmd_adopt` 的 `adopted` payload 补 `challenge = target`（**目标题**，不是当前题；`--challenge` 指定时以它为准）。
- `record()` 增加兜底：payload 缺 `challenge` 时自动补当前题；**显式给出的值不被覆盖**，且不修改调用方传入的 dict。
  以后任何新事件类型忘了写归属，也不会再变成「写进库但按题复盘看不见」的黑洞。

### Added

- `tests/test_board.py`：`TestAdopt` 增 4 个用例（事件带目标题、出现在 report 时间线与 Markdown、
  `--challenge` 时归属目标题而非当前题、`counts.events` 与库内同题事件数一致）；
  新增 `TestEventChallengeGuard`（3 个用例，直接驱动 `record()`：缺字段自动补、显式值不覆盖、不污染调用方 payload）。

### Migration

无需迁移，不涉及 schema 变更。**历史 `adopted` 事件不回填**（append-only 纪律）：
旧事件仍缺 challenge，按题复盘依旧看不到它们；要审计就用 `report --all` 或直接查 events 表。
本版本之后发生的迁移正常可见。

### 验证

```bash
python -m unittest discover -s tests   # Ran 119 tests ... OK
python board/board.py --version        # muteki-board 1.5.1
```

- **负向对照**（证明新用例真能抓住缺陷）：用 v1.5.0 的 `board.py` 跑本次新用例 →
  `TestAdopt` 3 failures + `TestEventChallengeGuard` 1 error（`KeyError: 'challenge'`）。
- **本地复验**：独立库 `use old-case` → `fact` → `use verify-151` → `adopt f1` →
  `report --json` 的 timeline 为 `['challenge_switched', 'adopted']`、`counts.events = 2`；
  Markdown 时间线显示 `adopted  迁移 1 条 → verify-151`。

[1.5.1]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.5.1

---

## [1.5.0] - 2026-11-16

对应路线图条目 **B5：缺「复盘 / 下一步」出口**。新能力，升 minor。

### Added

- **新命令 `report`**：一屏复盘报告，默认 **Markdown**（可直接贴 writeup / release notes），
  `--json` 输出结构化数据供插件与 CI 消费，`--md` 为显式别名。
  范围：默认当前题，`--challenge <题名>` 指定，`--all` 跨全部题。
- 报告内容：
  - 元信息：生成时间、黑板路径、证据库路径、**作战跨度**（首末事件时间）；
  - 概览计数：事实 / 观察 / 死路 / flag（按状态分布）/ 任务（按状态分布）/ 复核（含待处理数）；
  - flag 明细：状态、来源、证据 id、判定依据、备注；
  - 已证实事实、已排除方向（含测了什么 / 实际看到）、任务、复核意见、未证实观察；
  - **时间线**：逐条事件（依赖 A1 修好的事件持久化），flag 状态变更显示 from→to，adopt 显示迁移条数；
  - **账本整合**：读取证据目录下的 `runs.json` / `costs.json`，按题过滤出本题派单次数与 CLI 成本；
    `subagents.jsonl` 条数（全机累计，明确标注）。
- 新增 `_read_jsonl()` / `_read_json_list()` 两个容错读取辅助（坏行跳过、文件缺失返回空）。
- `tests/test_board.py` 新增 `TestReport`（7 个用例）：Markdown 段落齐全、JSON 结构与计数、
  按题过滤、`--all` 跨题、账本整合（派单次数与成本）、空库不崩、`--md` 与默认输出一致。

### Changed

- `board/SKILL.md`：命令块补 `report`；「收束」改为先跑 report 再写总结。
- `board.py` 文档字符串补 report 用法。
- 版本号同步到 `1.5.0`。

### Migration

无需迁移，不涉及 schema 变更。账本文件缺失时报告照常生成（对应计数为 0）。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 112 tests ... OK
python board/board.py report
python board/board.py report --json
python board/board.py --version           # muteki-board 1.5.0
```

[1.5.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.5.0

---

## [1.4.0] - 2026-11-16

对应路线图条目 **B4：按题隔离把历史成果变成孤儿**。新能力，升 minor。

### 问题

按题隔离上线后，旧记录统一归入 `legacy`，默认不可见。实测一个真实作战库：
当前题 `context` 显示 **flag 0**，而两个已解出的 flag 与 9 条 fact 全在 `legacy`——
用户「已经解出的题」在黑板上看起来消失了，换题后也无路复用旧结论。

### Added

- **新命令 `adopt <ids...> [--challenge <题名>]`**：把 facts / deadends / flags / tasks / reviews
  的归属迁移到目标题（**默认当前题**）。支持逗号分隔与重复传参；写 `adopted` 事件（含 from/to 明细）。
  - 已在目标题、id 不存在、前缀无法解析 → 跳过并说明；全部跳过时 rc=1。
  - flag 迁移遇到目标题已有同值 flag（`UNIQUE(challenge, value)`）→ 跳过并指出冲突的 g 编号，不破坏唯一约束。
- **`context` 空题提示**：当前题没有任何 facts / deadends / flags / observations，
  而其他题（含 legacy）有数据时，顶部输出统计与题名，并给出 `adopt` / `context --all` 两条出路。
- `tests/test_board.py` 新增 `TestAdopt`（11 个用例）：五类记录迁移、逗号分隔、显式目标题、
  重复迁移跳过、不存在 id、非法前缀、flag 同值冲突、空题提示出现/不出现/`--all` 不提示、
  迁移后记录在 context 可见。

### Changed

- `board/SKILL.md`：按题隔离小节补「归属迁移」说明；命令块补 `adopt` 示例。
- `board.py` 文档字符串补 `adopt` 用法。
- 版本号同步到 `1.4.0`。

### Migration

- 无需迁移，不涉及 schema 变更。
- **旧库里的 `legacy` 记录不会被自动搬动**：是否属于当前题由人判断，用 `adopt` 显式迁移，
  每次迁移都留审计事件。这样不会把上一题的结论误当成本题首解。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 105 tests ... OK
python board/board.py adopt f1,d3,g1
python board/board.py --version           # muteki-board 1.4.0
```

[1.4.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.4.0

---

## [1.3.0] - 2026-11-16

对应路线图条目 **B2（黑板侧）：context 截断会先丢掉死路**。新能力，升 minor。

### 问题

`cmd_context` 的打印顺序是 flags → claims → tasks → reviews → facts（**旧→新**）→ observations
→ superseded → **deadends（最后）**，而上游 orchestrator 是盲目 `slice(0, 6000)` / `slice(0, 8000)`。
题一复杂，被切掉的恰好是「避免重复踩坑」的死路与最新事实——黑板最核心的价值被静默丢弃。

### Added

- **`context --budget N`**：字符预算（0=不限）。超出时**按段落优先级逐行截断**，
  并在末尾明确标注「哪一段被截断、哪些段未显示」，不再静默丢内容。
- **`context --section a,b,c`**：自定义段落与顺序；未知段落名 exit 2 并列出可选值。
- 可选段落：`flags` / `deadends` / `facts` / `tasks` / `reviews` / `observations` / `claims` / `superseded`。
- `tests/test_board.py` 新增 `TestContextBudgetAndOrder`（9 个用例）：死路先于事实、
  事实与死路均新→旧、预算截断并标注、高优先级 flag 在极小预算下仍保留、
  无预算时不出现截断标记、自定义段落顺序、未知段落 rc=2、`--json` 输出结构不变。

### Changed

- **默认段落顺序改为**：`flags → deadends → facts → tasks → reviews → observations → claims → superseded`。
  死路从最后提到第二位，事实从「旧→新」改为「新→旧」（标题文案原本就写「新→旧」，此前与实现不符）。
- `context` 渲染重构为「先构建段落、再按顺序与预算装配」，`--json` 分支完全不变。
- `board/SKILL.md` 补 `--budget` / `--section` 用法与默认顺序说明。
- 版本号同步到 `1.3.0`。

### 兼容性

- `--json` 输出结构与字段**完全不变**（上游插件可继续消费）。
- 不带新参数时仍输出全部段落，只是**顺序变化**；依赖固定文本顺序的脚本需改用 `--json` 或 `--section`。
- 不涉及 schema 变更，无需迁移。
- orchestrator 侧改用 `context --json` 自行渲染（不再切字符串）属 DSH 运行时改动，
  留待需要 DSH 验证的批次处理；本 release 只动黑板。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 94 tests ... OK
python board/board.py context --budget 6000
python board/board.py context --section deadends,facts,tasks
python board/board.py --version           # muteki-board 1.3.0
```

[1.3.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.3.0

---

## [1.2.0] - 2026-11-16

对应路线图条目 **A6：证据门只验「存在」，不验「相关」**。新能力，升 minor。

### 背景

`verify_artifacts()` 只检查 id 在索引中且文件存在，**不检查证据内容是否支持该结论**。
真实作战中 Reviewer 已指出：某条 fact 挂的两条 artifact 根本不含所声称的延时与堆栈证据。
证据门能挡「凭空捏造 id」，挡不住「挂一个不相干的真实 id」——这是假事实进入事实区的第二条通道。

### Added

- **`fact --quote "<原文片段>"` / `deadend --quote "<原文片段>"`**（均可重复传参）：
  要求片段真实出现在所引证据的 `content` 或 `value` 里。
  - `fact` 未命中 → **降级为 observation**，stdout 明确写出未命中的片段与原因（rc=0，不中断流程）。
  - `fact --quote` 但没有 `--artifact` → 记为 observation 并提示需配合证据。
  - `deadend` 未命中或缺证据 → **拒写 exit 2**（死路必须是实测排除，不能靠推测）。
- 新增 `parse_quotes()` / `artifact_texts()` / `missing_quotes()` 三个辅助函数。
- `fact` / `deadend` 的事件 payload 增加 `quotes` 与 `quote_missing` 字段，便于复盘与 Reviewer 核对。
- `tests/test_board.py` 新增 `TestQuoteRelevance`（10 个用例）：命中保持 fact、未命中降级、
  多片段其一未命中、无证据时的提示、**不带 --quote 行为完全不变**、匹配 `value` 字段、
  deadend 命中/未命中/缺证据、事件 payload 记录。
- `BoardCase.make_artifact()` 支持 `value=` 参数，便于构造结构化输出证据。

### Changed

- `board/SKILL.md`：证据门小节补 `--quote` 语义与截断注意事项；命令示例补一条加强版 fact。
- `board.py` 文档字符串补 `--quote` 用法。
- 版本号同步到 `1.2.0`。

### 兼容性（重要）

- **默认强度不变**：不带 `--quote` 时，行为与 1.1.x 逐字一致（只校验 id 存在）。
  这是刻意选择——相关性校验会增加写入摩擦，因此做成**可选增强**，而不是默认强制。
- 不涉及 schema 变更，无需迁移。
- 已知限制：证据超大被截断时（`muteki-core` 只保留前 4000 字符），落在截断部分的片段会校验不到。
  完整输出落盘（sidecar）属路线图 C3，后续 release 处理。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 85 tests ... OK
python scripts/check_sensitive.py         # rc=0
python board/board.py --version           # muteki-board 1.2.0
```

[1.2.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.2.0

---

## [1.1.2] - 2026-11-16

对应路线图条目 **A3：安装时自定义证据目录会与 `board.py` 默认值分叉（release 阻塞级）**。

### 问题

`install.ps1` 原样复制 `board.py`，而 `board.py` 的默认证据目录是 `~/.dsh-muteki/artifacts`。
用户一旦传 `-StorageDir` 指到别处，插件把证据写到自定义目录，`board.py` 却仍去内置默认找索引：

- `fact --artifact <id>` → 证据校验失败，exit 2；
- 不带 `--artifact` → 全部退化成 observation。

证据门是这套预设的核心纪律，新装用户第一步就会踩坑，且现象隐蔽、难以自查。

### Added

- **安装配置 `config.json`**：`install.ps1` 新增 `-ConfigDir` 参数（默认 `%USERPROFILE%\.dsh-muteki`），
  安装时写入 `python` / `board_py` / `storage_dir` / `config_dir` / `version` 五个字段。
  用 .NET `UTF8Encoding($false)` 写入，**无 BOM**，兼容 PowerShell 5.1 与 7。
- **`board.py` 配置读取**：新增 `config_file()` 与 `load_config()`；
  证据目录优先级改为 **`MUTEKI_ARTIFACT_DIR` > `config.json` 的 `storage_dir`（兼容 `artifact_dir` 别名）> 内置默认**。
  配置文件位置可用 `MUTEKI_CONFIG` 覆盖；读取用 `utf-8-sig` 容忍 BOM；
  配置缺失/损坏静默回退，绝不让黑板命令崩掉。
- `tests/test_board.py` 新增 `TestArtifactDirConfig`（6 个用例）：配置目录生效、环境变量优先于配置、
  BOM 容忍、配置缺失回退、配置损坏回退、`artifact_dir` 别名。
- `tests/test_install.py` 新增**端到端用例**：自定义 `-StorageDir` + `-ConfigDir` 安装后，
  断言 config.json 无 BOM、`storage_dir` 与传入一致、`version` 与 package.json 一致；
  随后在自定义证据目录放一条合成证据，**不设 `MUTEKI_ARTIFACT_DIR`**，
  直接跑装好的 `board.py fact --artifact` → 必须成功且落为 fact（不是 observation）。
- 安装冒烟测试统一传 `-ConfigDir` 到临时目录，**不再写真实用户目录**。

### Changed

- `board/SKILL.md` 证据库说明改为完整优先级链，并指出必须与插件 `artifactDir` 一致。
- `board.py` 文档字符串同步。
- `README.md` 新增「安装配置（`config.json`）」小节：字段示例、优先级、BOM 处理、`MUTEKI_CONFIG` 用法。
- 版本号同步到 `1.1.2`。

### Migration

- **旧安装需要重跑一次 `install.ps1`** 才会生成 `config.json`；
  在此之前行为与旧版一致（仍可用 `MUTEKI_ARTIFACT_DIR` 环境变量临时指定）。
- 不涉及 schema 变更，黑板库无需迁移。
- 已经手工把 `board.py` 默认路径改成硬编码绝对路径的用户：重跑安装会覆盖该文件，
  之后请改用 `-StorageDir` / `config.json`，不要再手改脚本（避免仓库与运行副本分叉）。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 75 tests ... OK
python scripts/check_sensitive.py         # rc=0
```

[1.1.2]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.1.2

---

## [1.1.1] - 2026-11-16

对应路线图条目 **A5：文档与配置默认值不一致 + 安装占位符两套命名**。

### Fixed

- **`board/SKILL.md` 派单上限写错**：原文「默认每小时最多派 **6** 次」，
  而 orchestrator `maxRunsPerHour` 默认是 **12**、preset 也设 12。改为 12 并注明按题独立。
  用户按旧文档预期会在第 7 次派单时被意外熔断。
- **lane TTL 双默认值未说明**：手动 `board.py claim` 默认 **600s**，
  而 `muteki_dispatch` 的 `lane_ttl` 默认 **900s**。两者都保留（不改行为），
  在 SKILL.md 命令注释里写清区别，避免误以为同一个默认值。

### Changed

- **安装占位符统一为一套命名**：`{{PYTHON}}` / `{{BOARD_PY}}` / `{{STORAGE_DIR}}` /
  `{{CLAUDE_BIN}}` / `{{CLAUDE_CONFIG_DIR}}`。
  `board/SKILL.md` 原用的 `{{BOARD}}`（32 处）与 `{{STORAGE}}`（2 处）全部改名，
  `install.ps1` 的替换逻辑同步更新。此前两套命名容易漏替换。
- `README.md` 占位符表补充说明：**安装时占位符**（由 `install.ps1` 替换）与
  **插件运行时占位符**（orchestrator 内部 worker/reviewer prompt 里的 `{{PYTHON}}/{{BOARD}}/{{STORAGE}}`，
  由 `fillCmd()` 从配置填充）是两套独立机制，后者不需要手工替换。
- 版本号同步到 `1.1.1`。

### Added

- **`tests/test_install.py`：4 个安装冒烟用例**（需要 pwsh，找不到自动 skip）：
  - 安装后 SKILL.md 与 cordis.patch.yml **零残留占位符**，且自定义 `-StorageDir` 时
    preset 的 `storageDir` 与 muteki-core 的 `artifactDir` 一致；
  - board.py / SKILL.md / 两个插件都复制到正确位置；
  - 不加 `-Force` 重复安装会失败（已安装检测生效）；
  - `-Apply` 会生成 `cordis.patch.yml.bak-*` 备份。
  测试在临时假 DSH_HOME 上跑，不触碰真实安装；结束后清理仓库根的生成片段。

### Migration

- 无需迁移，不涉及 schema 与运行时行为。
- **重新安装即可**：`install.ps1` 会用新占位符生成 SKILL.md。
  已安装且 SKILL.md 早已替换成绝对路径的用户不受影响。
- 若你手工维护 SKILL.md 模板，请把 `{{BOARD}}` → `{{BOARD_PY}}`、`{{STORAGE}}` → `{{STORAGE_DIR}}`。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 68 tests ... OK（含 4 个安装冒烟）
python scripts/check_sensitive.py         # rc=0
```

[1.1.1]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.1.1

---

## [1.1.0] - 2026-11-16

对应路线图条目 **A4：flag 没有证据字段、没有验证状态**。这是 schema 变更 + 新能力，按语义化版本升 minor。

### 背景

`flags` 表此前只有 `value / source`，`flag` 命令不支持 `--artifact`——
flag 是最终交付物，却是全黑板唯一不需要证据的条目，与「结论必须带证据」的铁律自相矛盾。
真实作战中 Reviewer 已两次指出该缺口（flag 未绑定证据 id 无法核对；flag 与公开 writeup 同值需写明判定链）。

### Added

- **`flags` 表新增四列**：`artifacts`（证据 id 列表，JSON）、`status`（验证状态）、
  `verified_by`（判定依据）、`note`（判定链 / 备注）。
- **`flag --artifact <id>`**：走与 fact / deadend 同一道证据门，id 不存在直接 exit 2 拒写。
  仍可重复传参绑定多条证据。
- **`flag --status <状态>`**：记录时即可指定初始状态（默认 `candidate`）。
- **`flag --note`**：写判定链，例如「与公开 writeup 同值，但已由目标回连实时取证」。
- **新命令 `flagstatus <id> --set <状态> [--verified-by ...] [--note ...]`**：
  状态机 `candidate → submitted → accepted / rejected`；跨题操作被拒（rc=1）；
  非法状态 rc=2；每次变更写 `flag_status` 事件（含 from/to）。
- `context` 的 flag 段现在显示 `[状态]`、证据 id、判定依据与备注；未绑定证据时明确提示。
- `read g<id>` 输出新字段；`context --json` 的 flags 行自动包含新列。
- `tests/test_board.py` 新增 `TestFlagEvidenceAndStatus`（13 个用例）：
  绑定证据、坏证据拒写、无证据仍兼容、初始状态、状态机流转与事件、rejected 备注、
  不存在 id、非法状态、按题隔离、context 展示、read 新字段，
  以及**两种旧库迁移**（有 challenge 列补四列 / 无 challenge 列重建后补列）。

### Changed

- `board/SKILL.md`：flag 定义补证据与状态；证据门说明纳入 flag；命令示例补 `--artifact` 与 `flagstatus`；
  「什么时候写」补状态机与判定链要求。
- `board.py` 文档字符串补 `flag --artifact` 与 `flagstatus` 用法。
- 版本号同步到 `1.1.0`。

### Migration

- **自动迁移，无需手工操作**：`_migrate()` 检测 `flags` 缺列时 `ALTER TABLE ADD COLUMN`；
  极旧库（无 `challenge` 列）先按原逻辑重建再补列。已有 flag 一律落为 `status='candidate'`、`artifacts='[]'`。
- **向后兼容**：`flag "<值>" --source "..."` 的旧用法完全不变（证据为可选），
  orchestrator 的 workerPrompt 与既有会话无需改动即可继续工作。
- 迁移前建议备份 `board.db`（与以往一致）。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 64 tests ... OK
python board/board.py flag "flag{test}" --artifact <真实id>
python board/board.py flagstatus 1 --set accepted --verified-by "平台回显 correct"
python board/board.py --version           # muteki-board 1.1.0
```

[1.1.0]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.1.0

---

## [1.0.17] - 2026-11-16

对应路线图条目 **S2：门禁分级（block / warn）**。按用户策略：只有「他人可利用 / 个人信息 / 涉及金钱」才阻断发布，
不可利用的技术痕迹只提示，避免门禁因噪声过大而被关掉。

### Changed

- **`scripts/check_sensitive.py` 改为分级判定**：
  - `block`（rc=1，阻止发布）：凭据字面值（api key / secret / token / password / cookie / authorization）、
    已知 token 前缀（`ghp_` / `github_pat` / `sk-` / `AKIA` / `AIza` 等）、私钥头、JWT、
    webhook 回连地址（他人可读写其中数据）、长 base64 密钥串、个人邮箱。
  - `warn`（rc=0，只提示）：本机盘符路径与用户目录、IPv4（公开靶机不可利用）、flag 形态值（已解题目）、
    本地会话 UUID、muteki-core 证据 id、长 hex（多为 sha256 摘要）、通用机器用户名。
- 新增 `--strict`：把 warn 也当作阻断，供需要最高卫生标准的场合使用。
- **本地黑名单支持分级**：`scripts/sensitive.local.txt` 行首加 `!` 表示 block，不加表示 warn。
- 输出分 `[BLOCK]` / `[WARN]` 两段，并给出明确结论行；`--json` 增加 `severity`、`block_count`、
  `warn_count`、`blocked`、`strict` 字段。
- 门禁脚本自身输出强制 UTF-8（`sys.stdout.reconfigure`），修掉 Windows 控制台下的中文乱码。
- README「发布前检查」一节改为分级说明表 + `--strict` 用法 + 黑名单 `!` 前缀约定。

### Added

- `tests/test_check_sensitive.py` 新增 `TestSeverity`（7 个用例）：规则分级映射、只有 warn 不阻断、
  `--strict` 下 warn 阻断、凭据与个人邮箱阻断、noreply 邮箱豁免、黑名单 `!` 前缀为 block、
  纯字符串黑名单默认 warn、干净文本无命中。

### Migration

- 无需迁移。**行为变化**：此前任何命中都 rc=1；现在只有 block 才 rc=1。
  若你的 CI 依赖「任何命中即失败」，请改用 `--strict`。
- 本地黑名单文件语义扩展（`!` 前缀），旧格式（无前缀）继续可用，按 warn 处理。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 51 tests ... OK
python scripts/check_sensitive.py         # rc=0
python scripts/check_sensitive.py --strict # rc=0
```

[1.0.17]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.0.17

---

## [1.0.16] - 2026-11-16

对应路线图条目 **A2：`read` 不支持任务 id、`search` 不覆盖任务与复核**。

### Fixed

- **`board.py read t<id>` 不再报「未知前缀：t」**（此前 rc=2）。`cmd_read` 增加 `t` 前缀分支，
  读取 `tasks` 表全部字段。人主导做题时「这条任务当时怎么收的」是高频查询，此前查不到。
- **`board.py search` 现在覆盖 `tasks`（title / detail）与 `reviews`（kind / target / note）**，
  此前只搜 facts / deadends / flags。检索仍按题隔离，`--all` 才跨题。

### Changed

- `board.py` 文档字符串与 `read` / `search` 的 `--help` 文案补上新覆盖范围。
- `board/SKILL.md`：明确 `search` 覆盖五类记录、`read` 支持 `t2`，id 前缀表补 `t`=task、`r`=review。
- 版本号同步到 `1.0.16`。

### Added

- `tests/test_board.py` 新增 `TestReadAndSearch`（8 个用例）：
  读任务字段、读不存在任务 rc=1、未知前缀仍 rc=2、其余前缀不回归、
  搜索命中任务标题与详情、搜索命中复核意见、原有三类记录不回归、搜索按题隔离与 `--all`。

### Migration

无需迁移：不涉及 schema 变更，旧库直接可用。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 44 tests ... OK
python board/board.py read t1             # 输出任务全部字段
python board/board.py --version           # muteki-board 1.0.16
```

[1.0.16]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.0.16

---

## [1.0.15] - 2026-11-16

> **版本号说明**：`v1.0.14` 已被先前的「安装修复 + 默认路径脱敏」release 占用（tag 指向 `9eb7a4a`），
> 因此本条目顺延为 `1.0.15`，不覆盖既有 tag。另：`v1.0.13`（A1 事件修复）发布时间晚于既有的
> `v1.0.14`，号序与时间序不一致属历史遗留；自 `1.0.15` 起恢复正常递增。

对应路线图条目 **S1：发布前敏感信息门禁 + 仓库脱敏**（用户最高优先要求：公开仓库不得暴露任何真实作战数据）。

### Added

- **`scripts/check_sensitive.py`：发布前敏感信息门禁**（标准库，无第三方依赖）。
  - 扫描范围：全部 git 已跟踪文件（默认）、`--staged` 只扫本次提交内容、`--paths` 指定文件、`--json` 供 CI 消费。
  - 规则：盘符绝对路径、用户目录路径、IPv4、flag 形态值、UUID（会话 id / webhook token）、
    muteki-core 证据 id、JWT、私钥头、webhook 回连地址、长 hex / base64、已知 token 前缀
    （`ghp_` / `github_pat` / `sk-` / `AKIA` / `AIza` 等）、邮箱、机器用户名、凭据字段字面值。
  - 输出**掩码**片段（`abc***gh(len=8)`），不把完整敏感值回显到终端或 CI 日志。
  - 退出码：`0` 干净 / `1` 发现疑似敏感信息 / `2` 用法错误。**发现即阻止发布**。
  - 设计原则 fail closed：宁可误报人工确认，也不漏报把真实数据推上公开仓库。
- **本地黑名单 `scripts/sensitive.local.txt`**（已加入 `.gitignore`，不会提交）：
  每行一个字面量，用于禁止自己的真实靶机 IP、题名、证据 id 前缀、机器用户名等出现在仓库里。
- `tests/test_check_sensitive.py`：**23 个门禁回归用例**，同时覆盖「必须拦下」与「不得误报」两侧。
  测试样本全部为合成值，并用字符串拼接构造，使源码中不出现完整敏感字面量
  （否则门禁会把测试文件自己拦下，也避免真实数据进仓库）。
- README 新增「发布前检查（敏感信息门禁）」与「测试」两节；目录结构补 `scripts/`、`tests/`、`CHANGELOG.md`；
  「边界与安全」补充运行期数据含敏感信息的提醒。

### Changed（脱敏，无行为变更）

- 文档与工具描述里的**题名示例**统一改为 `web-8080`，替换掉原先带真实端口号的示例
  （涉及 `README.md`、`board/SKILL.md`、`board/board.py` 文档字符串、
  `plugins/dsh-muteki-orchestrator/plugin-v13.mjs` 的 `challenge` 参数描述、`preset/preset-muteki.patch.yml`）。
- `plugins/muteki-core/README.md` 的证据 id 示例改为合成值 `a1x2y3z4-8f2a`，替换掉一个真实格式的历史 id。
- `README.md` 的 flag 示例改为 `flag{...}`，去掉真实赛事前缀；python 路径示例改为 `<Python 安装目录>\python.exe`，
  去掉盘符绝对路径。
- `board.py` 与 orchestrator `package.json` 版本号同步到 `1.0.15`。

### Migration

- **无需迁移**：不涉及 schema 与配置变更，旧库旧配置直接可用。
- 已有的本机安装若想让门禁生效，把 `scripts/` 目录一并复制过去，并在 `scripts/sensitive.local.txt`
  里填自己的真实字面量（该文件永不提交）。

### 验证

```bash
python -m unittest discover -s tests -v   # Ran 36 tests ... OK
python scripts/check_sensitive.py         # 干净：未发现敏感信息（rc=0）
python board/board.py --version           # muteki-board 1.0.15
```

### 发布流程（从此每个 release 必做）

1. 改代码 → 2. 跑 unittest → 3. 跑 `check_sensitive.py`（含 `--staged`）→ 4. commit →
5. tag → 6. push → 7. 建 GitHub Release（release 正文同样不得含本机路径与真实作战数据）。

[1.0.15]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.0.15

---

## [1.0.13] - 2026-11-16

对应路线图条目 **A1：任务与复核事件全部丢失**。

### Fixed

- **`board.py`：`task` 与 `review` 的写操作不再丢失事件。**
  此前 `cmd_task`（add / claim / reopen / reclaim / done / drop）与 `cmd_review`（add / resolve）
  都是先 `conn.commit()` 再 `record(...)`，事件 INSERT 落在一个从未提交的事务里，
  进程退出即回滚。结果是 `events` 表缺失全部 `task_*` / `review_*` 事件，
  复盘时间线缺半边，也无法从 events 重建投影。

  实测一个真实作战库：facts + deadends + flags + tasks + reviews 共 44 条记录，
  `events` 只有 28 条，种类里完全没有 `task_*` / `review_*`。

  修法：新增 `commit_with_event(conn, kind, payload)`，把「写事件」与「提交」绑在一起；
  上述 8 个动作统一改走它。失败路径（认领失败、任务不存在等）不提交、不写事件。

### Added

- `tests/test_board.py`：13 个标准库 `unittest` 回归用例（无需 pytest）。
  全部以**子进程**方式执行 `board.py`——因为该类缺陷只在进程退出时暴露，
  同进程持有连接的测试会漏掉它。覆盖：
  - task 六个动作各自的事件；
  - review 两个动作各自的事件；
  - fact / deadend / flag / observation / challenge_switched 事件不回归；
  - 不变量「事件总数 ≥ 五类记录总数」；
  - 认领失败不产生事件。
- `board.py --version`：打印黑板脚本版本，便于核对本机装的是哪个 release。
- `board.py` 增加 `__version__` 常量。

### Changed

- `plugins/dsh-muteki-orchestrator/package.json` 版本号同步到 `1.0.13`。

### Migration

- **无需迁移**：本次不涉及 schema 变更，旧库直接可读可写。
- **历史事件不可恢复**：v1.0.13 之前丢失的 `task_*` / `review_*` 事件无法回填，
  也不会伪造补写。旧库的 `events` 计数仍会小于记录计数，这是预期现象；
  从本版本起新的写操作都会留下事件。

### Known issues（后续 release 处理）

- `claim` / `release`（资源 lane）仍不写审计事件 → 路线图 B8。
- `read` 不支持任务 id（`read t11` 报「未知前缀：t」）→ 路线图 A2。
- 安装时自定义 `-StorageDir` 会与 `board.py` 默认证据目录分叉 → 路线图 A3。

### 验证

```bash
python -m unittest discover -s tests -v   # 13 tests, OK
python board/board.py --version           # muteki-board 1.0.13
```

[1.0.13]: https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.0.13