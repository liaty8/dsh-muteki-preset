# Changelog

本项目的所有显著变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布节奏：**一个问题一个 release**。每个 release 只解决路线图中的一条问题，附带回归测试与迁移说明。

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