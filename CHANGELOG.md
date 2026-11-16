# Changelog

本项目的所有显著变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布节奏：**一个问题一个 release**。每个 release 只解决路线图中的一条问题，附带回归测试与迁移说明。

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