# Changelog

本项目的所有显著变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布节奏：**一个问题一个 release**。每个 release 只解决路线图中的一条问题，附带回归测试与迁移说明。

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