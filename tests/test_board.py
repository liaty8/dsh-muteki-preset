"""board.py 回归测试（标准库 unittest，无需第三方依赖）。

运行：
    python -m unittest discover -s tests -v

设计要点：所有命令都以**子进程**方式执行，因为 A1 类缺陷（写操作后未提交事件）
只在进程退出时才暴露；在同一进程内持有连接测试会漏掉它。
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BOARD_PY = REPO_ROOT / "board" / "board.py"


class BoardCase(unittest.TestCase):
    """每个用例一个独立工作区与独立黑板库。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="muteki-test-")
        self.root = Path(self._tmp.name)
        self.db = self.root / ".muteki-board" / "board.db"
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.env = {
            **os.environ,
            "MUTEKI_BOARD_DB": str(self.db),
            "MUTEKI_ARTIFACT_DIR": str(self.artifacts),
            "PYTHONIOENCODING": "utf-8",
        }

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def board(self, *args: str, expect: int | None = 0) -> subprocess.CompletedProcess:
        proc = subprocess.run(
            [sys.executable, str(BOARD_PY), *args],
            cwd=str(self.root),
            env=self.env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if expect is not None:
            self.assertEqual(
                proc.returncode,
                expect,
                msg=(
                    f"board.py {' '.join(args)} → rc={proc.returncode}（期望 {expect}）\n"
                    f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
                ),
            )
        return proc

    def query(self, sql: str, params: tuple = ()) -> list[tuple]:
        con = sqlite3.connect(str(self.db))
        try:
            return con.execute(sql, params).fetchall()
        finally:
            con.close()

    def execute(self, sql: str, params: tuple = ()) -> None:
        con = sqlite3.connect(str(self.db))
        try:
            con.execute(sql, params)
            con.commit()
        finally:
            con.close()

    def event_kinds(self) -> list[str]:
        return [row[0] for row in self.query("SELECT kind FROM events ORDER BY id")]

    def make_artifact(self, aid: str = "atest0001-000000", content: str = "hello") -> str:
        """伪造一条 muteki-core 证据（索引 + 文件），用于证据门测试。"""
        import json

        file = self.artifacts / "artifacts" / f"{aid}.json"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(
            json.dumps({"id": aid, "tool": "pwsh", "ok": True, "content": content}, ensure_ascii=False),
            encoding="utf-8",
        )
        index = self.artifacts / "index.jsonl"
        with index.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps({"id": aid, "tool": "pwsh", "ok": True, "file": str(file)}, ensure_ascii=False)
                + "\n"
            )
        return aid


class TestEventPersistence(BoardCase):
    """A1：每一种写操作都必须留下对应事件（此前 task/review 事件全部丢失）。"""

    def test_task_add_writes_event(self) -> None:
        self.board("task", "add", "步骤一", "--detail", "预期证据 + 停止边界")
        self.assertIn("task_added", self.event_kinds())

    def test_task_claim_writes_event(self) -> None:
        self.board("task", "add", "步骤一")
        self.board("task", "claim", "1", "--owner", "worker-a")
        self.assertIn("task_claimed", self.event_kinds())

    def test_task_done_writes_event(self) -> None:
        self.board("task", "add", "步骤一")
        self.board("task", "done", "1")
        self.assertIn("task_done", self.event_kinds())

    def test_task_drop_writes_event(self) -> None:
        self.board("task", "add", "步骤一")
        self.board("task", "drop", "1")
        self.assertIn("task_dropped", self.event_kinds())

    def test_task_reopen_writes_event(self) -> None:
        self.board("task", "add", "步骤一")
        self.board("task", "claim", "1", "--owner", "worker-a")
        self.board("task", "reopen", "1")
        self.assertIn("task_reopened", self.event_kinds())

    def test_task_reclaim_writes_event(self) -> None:
        self.board("task", "add", "步骤一")
        self.board("task", "claim", "1", "--owner", "worker-a")
        # 把 updated_at 推早，模拟「中断后卡在 claimed」
        self.execute("UPDATE tasks SET updated_at='2000-01-01 00:00:00' WHERE id=1")
        self.board("task", "reclaim", "--minutes", "30")
        self.assertIn("task_reclaimed", self.event_kinds())
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "open")

    def test_review_add_writes_event(self) -> None:
        self.board("review", "add", "--kind", "gap", "--note", "缺基线对照")
        self.assertIn("review_added", self.event_kinds())

    def test_review_resolve_writes_event(self) -> None:
        self.board("review", "add", "--kind", "gap", "--note", "缺基线对照")
        self.board("review", "resolve", "1")
        self.assertIn("review_resolved", self.event_kinds())

    def test_fact_deadend_flag_events_not_regressed(self) -> None:
        aid = self.make_artifact()
        self.board("fact", "入口", "可复用入口", "--artifact", aid)
        self.board("deadend", "排除", "--tested", "范围", "--observed", "结果", "--artifact", aid)
        self.board("flag", "flag{test}", "--source", "响应")
        kinds = self.event_kinds()
        for expected in ("fact", "deadend", "flag"):
            self.assertIn(expected, kinds)

    def test_observation_event_not_regressed(self) -> None:
        self.board("fact", "推测", "尚未证实")
        self.assertIn("observation", self.event_kinds())

    def test_challenge_switch_event_not_regressed(self) -> None:
        self.board("use", "web-1")
        self.assertIn("challenge_switched", self.event_kinds())

    def test_every_record_has_an_event(self) -> None:
        """不变量：五类记录总数 ≤ 事件总数（每条记录至少一个事件）。"""
        aid = self.make_artifact()
        self.board("use", "web-1")
        self.board("task", "add", "步骤一")
        self.board("task", "claim", "1", "--owner", "worker-a")
        self.board("task", "done", "1")
        self.board("task", "add", "步骤二")
        self.board("task", "drop", "2")
        self.board("fact", "入口", "可复用入口", "--artifact", aid)
        self.board("fact", "推测", "尚未证实")
        self.board("deadend", "排除", "--tested", "范围", "--observed", "结果")
        self.board("flag", "flag{test}", "--source", "响应")
        self.board("review", "add", "--kind", "merge", "--target", "f1", "--note", "重复")
        self.board("review", "resolve", "1")

        records = sum(
            self.query(f"SELECT COUNT(*) FROM {table}")[0][0]
            for table in ("facts", "deadends", "flags", "tasks", "reviews")
        )
        events = self.query("SELECT COUNT(*) FROM events")[0][0]
        self.assertGreaterEqual(
            events,
            records,
            msg=f"事件 {events} 条 < 记录 {records} 条，说明有写操作没留下事件",
        )

    def test_failed_claim_writes_no_event(self) -> None:
        """认领失败不应产生事件（避免把失败当成功记账）。"""
        self.board("task", "add", "步骤一")
        self.board("task", "claim", "1", "--owner", "worker-a")
        before = len(self.event_kinds())
        self.board("task", "claim", "1", "--owner", "worker-b", expect=1)
        self.assertEqual(len(self.event_kinds()), before)


if __name__ == "__main__":
    unittest.main()