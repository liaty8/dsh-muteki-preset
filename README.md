<p align="center">
  <img src="assets/icon.png" alt="Muteki 蜂群" width="140" style="border-radius:20px">
</p>

<h1 align="center">Muteki 蜂群 · DSH Agent 预设</h1>

<p align="center">
  把「多 agent 蜂群解 CTF / 授权渗透」的作战流程，做成 DeepSeek Harness 里一个可直接选用的预设。
</p>

<p align="center">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.3-blue">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.10%2B-3776AB">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## 这是什么

**Muteki 蜂群**是一个运行在 [DeepSeek Harness](https://github.com/deepseek-ai) 里的 Agent 预设（agent preset）。
选中它之后，你会得到一个「主控 + 子代理」的作战模式：

- 所有结论写进一块**工作区级黑板**（SQLite 事实图），不是散落在聊天里；
- 每条事实必须带**真实工具输出的证据 id**，没有证据只能记为 observation；
- 主控先把题目拆成**有界任务**，再用程序化工具派给全新上下文的子代理；
- 自动循环派单、首解即停、其余子代理立刻中断；
- 支持用**本地 Claude Code CLI** 跑跨引擎异构；
- 派单次数与成本都**按题独立限额**，一道题烧超了不会拖累下一道题。

> 思想来自开源项目 [FishCodeTech/muteki](https://github.com/FishCodeTech/muteki)（無敵 · Project Muteki）。
> 本仓库没有复制它的源码，而是用 DSH 原生的子代理、任务、工具与插件能力重新实现了一套轻量版。

---

## 用来打 CTF

这个预设不是通用聊天增强，它是按「一场 CTF 怎么打」设计的：主控只负责读题、拆任务、调度与复核，真正的分析/利用交给一个又一个**全新上下文**的子代理，所有结论都落在黑板上。

| 题型 | 怎么用 |
|---|---|
| **Web**（SQLi / XSS / SSRF / 文件上传 / 反序列化） | 拆「入口探测 → 认证绕过 → 注入验证 → 利用链」等 Step，子代理各自 curl/发包验证；fact 必须带真实响应 artifact，猜的不许升级成结论 |
| **Pwn**（栈 / 堆 / 格式化字符串） | 先派 recon 子代理跑 checksec/strings/IDA 导出，再派 exp 子代理写 pwntools；offset 与 leak 分开记，失败方向记 deadend |
| **Reverse** | 多子代理并行静态分析 / 动态调试 / 算法还原；每步结论带反汇编或运行输出 artifact |
| **Crypto / Misc / 取证** | 大附件拆成多个有界 Step（文件识别 → 解包 → 提取 → 验证），避免单会话被大文件拖爆上下文 |
| **AWDP / 授权渗透** | 用 lane 锁串行化共享容器（只读优先、写操作持锁），`muteki_run` 的 `limit` 设为 1 |

### 一场比赛的典型流程

1. **读题**：你贴题面 / 附件 / 靶机，主控先 `board.py use web-8080` 切到这道题；
2. **拆任务**：把题拆成至少 2 条有界 Step，每条写清「预期证据」和「停止边界」，进 `task` 队列；
3. **自动派单**：`muteki_run limit 2 max_minutes 15`，子代理各自新上下文，只拿到本题黑板摘要；
4. **写回**：子代理用 `fact --artifact` / `deadend` / `flag` 写回，不必等整批跑完；
5. **复核**：`muteki_review` 起只读 Reviewer，质疑无证据结论、找验证缺口；
6. **交 flag**：你手动复制到平台提交（刻意保留的人工确认）。

### 三个可直接抄的提示

```text
# Web
目标 http://1.2.3.4:8080，flag{wctf{...}}。先 board.py use web-8080，
把它拆成入口探测 / 认证绕过 / 注入验证三条有界 Step，再 muteki_run limit 2 max_minutes 15。

# Pwn
附件 pwn1，远程 nc 1.2.3.4 9999。先派 recon（checksec/strings/IDA），
再派 exp 写 pwntools 脚本；offset 和 leak 分开记 fact，失败方向记 deadend。

# 大杂项
附件 2GB 镜像。先拆「文件识别 / 挂载 / 找关键文件」三步，单步 10 分钟上限，
超时就把范围记 deadend，不要反复重扫。
```

### 不适合

- 需要人机验证 / 真人交互的题（验证码、支付、短信登录）；
- 不可信的恶意 challenge：本预设**不做沙箱隔离**，Worker 会真实执行命令、访问目标；
- 多 flag 平台的自动提交：没有平台提交闭环，flag 仍需人工确认。

---

## 解决什么问题

长会话里让一个 agent 从头打到尾，几乎一定会遇到四个坑：

| 坑 | 表现 | 本预设的对策 |
|---|---|---|
| 上下文腐化 | 越聊越慢、越聊越忘、关键结论被淹没 | 每步一个**全新子会话**，只注入当前题的黑板摘要 |
| 幻觉级联 | A 猜的结论被 B 当成前提，整群跑偏 | **证据门**：fact 必须引用真实存在的 artifact id，否则 exit 2 |
| 重复踩坑 | 换个说法反复试同一条死路 | **dead-end 记账** + 按题隔离，重开需引用新证据 |
| 多 agent 撞车 | 两个子代理同时改同一个目标、互相干扰 | **任务原子认领** + 资源 lane 锁 + 按题隔离 |

---

## 核心机制

```
你（题目/靶机）
      │
      ▼
┌─────────────────────────────────────────────┐
│  主控 Agent（Muteki 预设）                    │
│  persona：七条铁律（一步一交付 / 证据 / 增量…）│
│                                             │
│  board.py task add  ──► 任务队列（有界 Step） │
│  muteki_run  ─────────► 自动循环派单          │
│        │                     │               │
│        │              ┌──────┴──────┐        │
│        │              ▼             ▼        │
│        │         Worker 子代理   Worker 子代理 │
│        │         （全新上下文）  （全新上下文）   │
│        │              │             │        │
│        └──────────────┴──────┬──────┘        │
│                              ▼               │
│                    board.py（事实图）          │
│        fact / deadend / flag / observation    │
│        + 证据 id（muteki-core 捕获）           │
│                              │               │
│              muteki_review ──► 只读 Reviewer   │
│              muteki_cli   ──► Claude Code CLI  │
└─────────────────────────────────────────────┘
```

### 1. 黑板：工作区级事实图

`board/board.py`，纯标准库、零依赖，数据落在 `<工作区>/.muteki-board/board.db`（WAL）。

| 记录 | 用途 |
|---|---|
| `fact` | 已被真实工具输出证明、可供下一步复用的结论 |
| `observation` | 只是看到、还不能当结论用的观察 |
| `deadend` | 被有界实验排除的方向（测了什么范围、看到什么） |
| `flag` | 候选 flag（按题隔离） |
| `task` | 有界 Step 队列（open / claimed / done / dropped） |
| `review` | Reviewer 的质疑 / 合并 / 缺口意见 |
| `claim` | 独占资源 lane 锁（带 TTL 与持有者） |

### 2. 证据门

`muteki-core` 插件监听 `tools/result`，把每次工具调用的结果落盘到证据库并写索引：

```
<storageDir>/artifacts/<id>.json
<storageDir>/index.jsonl
```

`board.py fact ... --artifact <id>` 会同时校验索引条目与 payload 文件；伪造 id 直接 `exit 2` 拒写。没有 `--artifact` 的结论自动降级为 `observation`。

### 3. 按题隔离

`board.py use <题名>` 切换当前题；所有读写命令默认只作用于当前题：

```bash
board.py use web-19542     # 切到这道题
board.py current           # 看当前题
board.py context --all     # 跨题审计
```

`muteki_run` 开工前会自动 `use` 到本轮题名；它只有在本轮**新出现**的 flag 才算首解，上一题的旧 flag 不会误停。

### 4. 程序化派单

| 工具 | 作用 |
|---|---|
| `muteki_dispatch` | 手动派一个 Step（可先 claim 资源 lane） |
| `muteki_tick` | 从任务队列取 1–3 条，批量派一轮 |
| `muteki_run` | 自动循环：切题 → 回收卡住任务 → 取队列 → 派单 → 等结果 → 检查 flag → 直到队列空 / 出现 flag / 超时 / 达额度 |
| `muteki_review` | 起一个**只读** Reviewer 审图，意见写回 `review` |
| `muteki_cli` | 把同类 Step 交给本地 Claude Code CLI（独立进程、异步、不占 DSH 子代理席位） |

`muteki_run` 结束（含异常/中断）时会用 `finally` 把本轮没做完的任务释放回 `open`，不会留下假 `claimed`。

### 5. 首解硬 cancel

`muteki_run` 每 2 秒轮询 flag；一旦出现**本轮新增**的 flag，立即对同批其余子代理调用 `subagents.interrupt`（`kind: "ancestor"`），不再陪跑。可用 `hardCancelOnFlag: false` 关闭。

### 6. 额度按题独立

- 派单次数：每题每小时 `maxRunsPerHour`（默认 12）次；
- CLI 成本：每题每小时 `maxCostUsdPerHour`（默认 $3）；
- 切到新题不继承旧题额度；切回旧题时额度继续累计；
- 超限就用 `board.py task drop <id>` 放弃该题，或换题。

---

## 安装

### 前置条件

- DeepSeek Harness **≥ 0.2.2-rc.3**（使用 `@deepseek-ai/dsh-agent-preset` 与 `@deepseek-ai/dsh-tools`）；
- Python **3.10+**（`board.py` 只用标准库）；
- 可选：[Claude Code CLI](https://code.claude.com/docs)（只有想用 `muteki_cli` 跨引擎异构时才需要）；
- 可选：`git`（从本仓库克隆）。

### 方式一：一键脚本（Windows PowerShell）

```powershell
git clone https://github.com/liaty8/dsh-muteki-preset.git
cd dsh-muteki-preset
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：

1. 把 `board.py` + `SKILL.md`（替换成你的真实路径）装到 `$DSH_HOME\skills\muteki-board\`；
2. 把插件装到 `<profile>\node_modules\@local\dsh-muteki-orchestrator\`；
3. 把 `muteki-core.mjs` 放到 `<profile>\`；
4. 生成 `preset-muteki.patch.yml`（已替换路径），**默认只输出文件**，并提示你把它追加到 profile 的 `cordis.patch.yml`。

想让它自动追加：

```powershell
.\install.ps1 -Apply     # 会先备份 cordis.patch.yml
```

> 安装脚本不会碰你的 `node_modules` 依赖、不会跑 `pnpm install`。改完 patch 后**新开一个会话**才会加载新预设。

### 方式二：手动安装

```powershell
# 1) 黑板技能
New-Item -ItemType Directory -Force "$env:DSH_HOME\skills\muteki-board" | Out-Null
Copy-Item .\board\board.py       "$env:DSH_HOME\skills\muteki-board\"
Get-Content .\board\SKILL.md -Raw |
  ForEach-Object { $_ -replace '\{\{PYTHON\}\}', 'python' -replace '\{\{BOARD\}\}', "$env:DSH_HOME\skills\muteki-board\board.py" -replace '\{\{STORAGE\}\}', "$env:USERPROFILE\.dsh-muteki\artifacts" } |
  Set-Content "$env:DSH_HOME\skills\muteki-board\SKILL.md" -Encoding UTF8

# 2) 插件
$p = "$env:DSH_HOME\profiles\desktop"
New-Item -ItemType Directory -Force "$p\node_modules\@local\dsh-muteki-orchestrator" | Out-Null
Copy-Item .\plugins\dsh-muteki-orchestrator\* "$p\node_modules\@local\dsh-muteki-orchestrator\" -Force
Copy-Item .\plugins\muteki-core\muteki-core.mjs "$p\muteki-core.mjs" -Force

# 3) 把 preset\preset-muteki.patch.yml 里的 {{...}} 换成你的真实路径，
#    然后追加到 $p\cordis.patch.yml 末尾；同时把 muteki-core 的 insert 也加上。
```

`preset\preset-muteki.patch.yml` 里的占位符：

| 占位符 | 填什么 |
|---|---|
| `{{PYTHON}}` | 你的 python 可执行文件，例如 `python` 或 `C:\Python312\python.exe` |
| `{{BOARD_PY}}` | `board.py` 的绝对路径 |
| `{{STORAGE_DIR}}` | 证据库目录，例如 `C:\Users\you\.dsh-muteki\artifacts` |
| `{{CLAUDE_BIN}}` | `claude` 可执行文件（用不上 `muteki_cli` 可随便填） |
| `{{CLAUDE_CONFIG_DIR}}` | Claude Code 的独立配置目录（同上） |

---

## 使用

1. 新开一个会话，在输入框下方把预设切到 **Muteki 蜂群**；
2. 发题目 / 靶机 / 目标，让它先拆任务：

```
目标：http://1.2.3.4:8080 格式 flag{...}
先 board.py use web-8080，把这道题拆成至少 2 条有界 Step，
再用 muteki_run 跑，limit 2，max_minutes 15。
```

3. 想手动看单步：`muteki_tick`（一轮）或 `muteki_dispatch`（单个 Step）；
4. 想审图：`muteki_review`；
5. 想跨引擎对照：`muteki_cli`（需要本机已装并登录 Claude Code CLI）。

### 黑板常用命令

```bash
board.py context                 # 当前题全图
board.py context --all           # 跨题审计
board.py task add "验证 SQL 注入" --detail "..." --priority 3
board.py task list --status open
board.py task reopen 3           # 中断后释放卡住的任务
board.py task reclaim --minutes 30
board.py claim web-login --ttl 900 --note "登录接口"
board.py fact "登录处存在注入" "..." --artifact aXXXX --evidence "..."
board.py deadend "排除 XSS" --tested "..." --observed "..."
board.py flag "flag{...}" --source "响应体 /debug"
board.py review list --status open
board.py stats
```

---

## 目录结构

```
dsh-muteki-preset/
├─ install.ps1                     # Windows 一键安装
├─ preset/
│  └─ preset-muteki.patch.yml      # 预设定义（含占位符）
├─ plugins/
│  ├─ dsh-muteki-orchestrator/     # 派单 / 自动循环 / 记账 / 额度
│  │  ├─ README.md                 # 插件独立安装说明
│  │  ├─ package.json
│  │  └─ plugin-v13.mjs
│  └─ muteki-core/                 # 证据捕获（tools/result → artifacts）
│     ├─ README.md                 # 插件独立安装说明
│     └─ muteki-core.mjs
├─ board/
│  ├─ board.py                     # 黑板（SQLite，标准库）
│  └─ SKILL.md                     # 给 agent 用的黑板操作手册
└─ assets/icon.png
```

---

## 插件独立使用

两个插件都不依赖 Muteki 预设的 persona，可以单独挂到其他预设或 profile 全局：

| 插件 | 单独用能做什么 | 依赖 |
|---|---|---|
| `muteki-core` | 任意会话里捕获工具结果、生成证据 id，配合 board.py 做证据门 | 无（只要 DSH） |
| `muteki-orchestrator` | 任意预设里获得 `muteki_dispatch/tick/run/review/cli` 五个工具 | board.py（任务队列与 flag 检查） |

挂载时注意两条硬约束：**必须放在 preset 的 `plugins` 内**（agent scope，否则 `UNAUTHORIZED`），**用包名 `@local/...` 引用**（不要相对路径）。各插件的详细安装步骤见它们目录下的 `README.md`。

---

## 配置项（`muteki-orchestrator`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `python` | `python` | 调 `board.py` 用的解释器 |
| `boardPy` | `~/.dsh-muteki/board.py` | `board.py` 路径 |
| `storageDir` | `~/.dsh-muteki/artifacts` | 证据与 `runs/costs/subagents/cli.jsonl` 存放 |
| `maxRunsPerHour` | `12` | 每题每小时派单上限 |
| `hardCancelOnFlag` | `true` | 出现本轮 flag 后中断同批子代理 |
| `claudeBin` | `claude` | Claude Code CLI 路径 |
| `claudeConfigDir` | 空 | 独立配置目录（建议指向一个干净、无插件的 config） |
| `maxCostUsdPerHour` | `3` | 每题每小时 CLI 成本上限 |
| `enabled` | `true` | 总开关 |

---

## 边界与安全

- **不提供隔离**：Worker 会执行真实命令、访问目标服务。只在你拥有或明确获授权的题目与靶机上使用；不要跑不可信的恶意 challenge。
- **Reviewer 只读**：`muteki_review` 只读黑板、不碰目标。
- **没有平台提交闭环**：flag 仍需要你手动复制到 CTF 平台；这是刻意留给人确认的一步。
- **额度不是硬沙箱**：`$3/h` 是估算上限（Claude Code 按 Anthropic 价估算，接 DeepSeek 后端时实际更低），不是账单保证。
- **Windows 优先**：脚本与路径以 Windows 为主，Linux/macOS 需把 `install.ps1` 的路径替换成对应 shell 写法。

---

## 致谢

- 机制灵感：[FishCodeTech/muteki](https://github.com/FishCodeTech/muteki)（AGPL-3.0，本项目未复制其源码）；
- 运行平台：DeepSeek Harness；
- 图标：仓库作者提供。

## License

[MIT](LICENSE)
