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

    def make_artifact(self, aid: str = "atest0001-000000", content: str = "hello", value=None) -> str:
        """伪造一条 muteki-core 证据（索引 + 文件），用于证据门测试。"""
        import json

        file = self.artifacts / "artifacts" / f"{aid}.json"
        file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"id": aid, "tool": "pwsh", "ok": True, "content": content}
        if value is not None:
            payload["value"] = value
        file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
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


class TestReadAndSearch(BoardCase):
    """A2：read 支持任务 id；search 覆盖 tasks / reviews。"""

    def test_read_task_by_id(self) -> None:
        self.board("task", "add", "复现登录注入", "--detail", "预期证据 + 停止边界", "--priority", "3")
        proc = self.board("read", "t1")
        self.assertIn("复现登录注入", proc.stdout)
        self.assertIn("status: open", proc.stdout)
        self.assertIn("priority: 3", proc.stdout)
        self.assertIn("预期证据", proc.stdout)

    def test_read_missing_task_returns_1(self) -> None:
        self.board("read", "t999", expect=1)

    def test_read_unknown_prefix_still_returns_2(self) -> None:
        self.board("read", "z1", expect=2)

    def test_read_other_prefixes_not_regressed(self) -> None:
        aid = self.make_artifact()
        self.board("fact", "入口", "可复用入口", "--artifact", aid)
        self.board("deadend", "排除", "--tested", "范围", "--observed", "结果")
        self.board("flag", "flag{test}", "--source", "响应")
        self.board("review", "add", "--kind", "gap", "--note", "缺验证")
        for rid, needle in (("f1", "入口"), ("d1", "排除"), ("g1", "flag{test}"), ("r1", "缺验证")):
            proc = self.board("read", rid)
            self.assertIn(needle, proc.stdout)

    def test_search_hits_task_title_and_detail(self) -> None:
        self.board("task", "add", "同主机端口侦察", "--detail", "用 bot 当 SSRF 代理")
        proc = self.board("search", "SSRF")
        self.assertIn("t1", proc.stdout)
        proc2 = self.board("search", "端口侦察")
        self.assertIn("t1", proc2.stdout)

    def test_search_hits_review_note(self) -> None:
        self.board("review", "add", "--kind", "challenge", "--target", "f1", "--note", "证据与结论对不上")
        proc = self.board("search", "对不上")
        self.assertIn("r1", proc.stdout)

    def test_search_existing_tables_not_regressed(self) -> None:
        aid = self.make_artifact()
        self.board("fact", "反序列化入口", "node-serialize 可控", "--artifact", aid)
        self.board("deadend", "原型污染无效", "--tested", "三种 payload", "--observed", "无差异")
        self.board("flag", "flag{test}", "--source", "响应")
        self.assertIn("f1", self.board("search", "反序列化").stdout)
        self.assertIn("d1", self.board("search", "原型污染").stdout)
        self.assertIn("g1", self.board("search", "flag{test}").stdout)

    def test_search_respects_challenge_isolation(self) -> None:
        self.board("use", "web-a")
        self.board("task", "add", "甲题任务")
        self.board("use", "web-b")
        self.board("task", "add", "乙题任务")
        # 当前题 web-b：只应命中乙题
        proc = self.board("search", "题任务")
        self.assertIn("乙题任务", proc.stdout)
        self.assertNotIn("甲题任务", proc.stdout)
        # --all 才跨题
        proc_all = self.board("search", "题任务", "--all")
        self.assertIn("甲题任务", proc_all.stdout)
        self.assertIn("乙题任务", proc_all.stdout)


class TestFlagEvidenceAndStatus(BoardCase):
    """A4：flag 绑定证据 + 验证状态机 + 旧库迁移。"""

    def test_flag_with_artifact_is_stored(self) -> None:
        aid = self.make_artifact(content="flag{test} in response")
        self.board("flag", "flag{test}", "--source", "响应", "--artifact", aid)
        row = self.query("SELECT artifacts, status FROM flags WHERE id=1")[0]
        self.assertIn(aid, row[0])
        self.assertEqual(row[1], "candidate")

    def test_flag_with_bad_artifact_rejected(self) -> None:
        self.board("flag", "flag{test}", "--artifact", "anothere-000000", expect=2)
        self.assertEqual(self.query("SELECT COUNT(*) FROM flags")[0][0], 0)

    def test_flag_without_artifact_still_works(self) -> None:
        proc = self.board("flag", "flag{test}", "--source", "响应")
        self.assertIn("未绑定证据", proc.stdout)
        self.assertEqual(self.query("SELECT status FROM flags WHERE id=1")[0][0], "candidate")

    def test_flag_initial_status_can_be_set(self) -> None:
        self.board("flag", "flag{test}", "--status", "submitted")
        self.assertEqual(self.query("SELECT status FROM flags WHERE id=1")[0][0], "submitted")

    def test_flagstatus_transitions_and_event(self) -> None:
        self.board("flag", "flag{test}")
        self.board("flagstatus", "1", "--set", "submitted")
        self.board("flagstatus", "1", "--set", "accepted", "--verified-by", "平台回显 correct")
        row = self.query("SELECT status, verified_by FROM flags WHERE id=1")[0]
        self.assertEqual(row[0], "accepted")
        self.assertEqual(row[1], "平台回显 correct")
        self.assertEqual(
            self.query("SELECT COUNT(*) FROM events WHERE kind='flag_status'")[0][0], 2
        )

    def test_flagstatus_rejected_keeps_note(self) -> None:
        self.board("flag", "flag{test}")
        self.board("flagstatus", "1", "--set", "rejected", "--note", "平台判错")
        row = self.query("SELECT status, note FROM flags WHERE id=1")[0]
        self.assertEqual(row[0], "rejected")
        self.assertEqual(row[1], "平台判错")

    def test_flagstatus_missing_id_returns_1(self) -> None:
        self.board("flagstatus", "99", "--set", "accepted", expect=1)

    def test_flagstatus_invalid_status_returns_2(self) -> None:
        self.board("flag", "flag{test}")
        self.board("flagstatus", "1", "--set", "bogus", expect=2)

    def test_flagstatus_respects_challenge(self) -> None:
        self.board("use", "web-a")
        self.board("flag", "flag{test}")
        self.board("use", "web-b")
        self.board("flagstatus", "1", "--set", "accepted", expect=1)

    def test_context_shows_status_and_evidence(self) -> None:
        aid = self.make_artifact()
        self.board("flag", "flag{test}", "--artifact", aid)
        self.board("flagstatus", "1", "--set", "accepted")
        out = self.board("context").stdout
        self.assertIn("[accepted]", out)
        self.assertIn(aid, out)

    def test_read_flag_shows_new_fields(self) -> None:
        self.board("flag", "flag{test}")
        out = self.board("read", "g1").stdout
        self.assertIn("status: candidate", out)
        self.assertIn("artifacts:", out)

    def _make_old_flags_db(self, with_challenge: bool) -> None:
        self.db.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(self.db))
        try:
            if with_challenge:
                con.execute(
                    "CREATE TABLE flags (id INTEGER PRIMARY KEY, challenge TEXT NOT NULL DEFAULT 'default', "
                    "value TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL, UNIQUE(challenge, value))"
                )
                con.execute(
                    "INSERT INTO flags (id, challenge, value, source, created_at) "
                    "VALUES (1, 'legacy', 'flag{test}', '旧来源', '2026-01-01 00:00:00')"
                )
            else:
                con.execute(
                    "CREATE TABLE flags (id INTEGER PRIMARY KEY, value TEXT NOT NULL, "
                    "source TEXT, created_at TEXT NOT NULL)"
                )
                con.execute(
                    "INSERT INTO flags (id, value, source, created_at) "
                    "VALUES (1, 'flag{test}', '旧来源', '2026-01-01 00:00:00')"
                )
            con.commit()
        finally:
            con.close()

    def test_migration_adds_columns_to_existing_flags(self) -> None:
        self._make_old_flags_db(with_challenge=True)
        self.board("stats", "--all")
        cols = {r[1] for r in self.query("PRAGMA table_info(flags)")}
        self.assertTrue({"artifacts", "status", "verified_by", "note"} <= cols)
        row = self.query("SELECT value, status, artifacts FROM flags WHERE id=1")[0]
        self.assertEqual(row[0], "flag{test}")
        self.assertEqual(row[1], "candidate")
        self.assertEqual(row[2], "[]")

    def test_migration_rebuilds_pre_challenge_flags(self) -> None:
        self._make_old_flags_db(with_challenge=False)
        self.board("stats", "--all")
        cols = {r[1] for r in self.query("PRAGMA table_info(flags)")}
        self.assertTrue({"challenge", "artifacts", "status"} <= cols)
        row = self.query("SELECT challenge, value, status FROM flags WHERE id=1")[0]
        self.assertEqual(row[0], "legacy")
        self.assertEqual(row[1], "flag{test}")
        self.assertEqual(row[2], "candidate")


class TestArtifactDirConfig(BoardCase):
    """A3：证据目录优先级 环境变量 > config.json > 内置默认。"""

    def setUp(self) -> None:
        super().setUp()
        self.env.pop("MUTEKI_ARTIFACT_DIR", None)
        self.cfg = self.root / "cfg" / "config.json"
        self.cfg.parent.mkdir(parents=True, exist_ok=True)
        self.custom = self.root / "custom-artifacts"
        (self.custom / "artifacts").mkdir(parents=True, exist_ok=True)

    def write_config(self, storage: Path, bom: bool = False) -> None:
        import json

        payload = json.dumps({"storage_dir": str(storage)}).encode("utf-8")
        self.cfg.write_bytes((b"\xef\xbb\xbf" if bom else b"") + payload)
        self.env["MUTEKI_CONFIG"] = str(self.cfg)

    def put_artifact(self, directory: Path, aid: str = "acfg00001-abcdef") -> str:
        import json

        file = directory / "artifacts" / f"{aid}.json"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({"id": aid, "tool": "pwsh", "ok": True, "content": "x"}), encoding="utf-8")
        with (directory / "index.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": aid, "tool": "pwsh", "ok": True, "file": str(file)}) + "\n")
        return aid

    def test_config_storage_dir_is_used(self) -> None:
        self.write_config(self.custom)
        aid = self.put_artifact(self.custom)
        self.board("fact", "入口", "可复用入口", "--artifact", aid)
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")

    def test_env_overrides_config(self) -> None:
        self.write_config(self.custom)
        self.env["MUTEKI_ARTIFACT_DIR"] = str(self.artifacts)
        aid = self.put_artifact(self.artifacts)
        self.board("fact", "入口", "内容", "--artifact", aid)
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")
        # 配置目录里的同名证据不应被用到
        self.assertNotIn(str(self.custom), self.board("artifact", "list").stdout)

    def test_bom_config_tolerated(self) -> None:
        self.write_config(self.custom, bom=True)
        aid = self.put_artifact(self.custom)
        self.board("fact", "入口", "内容", "--artifact", aid)
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")

    def test_missing_config_falls_back_without_crash(self) -> None:
        self.env["MUTEKI_CONFIG"] = str(self.root / "nope.json")
        self.board("artifact", "list")

    def test_corrupt_config_falls_back_without_crash(self) -> None:
        self.cfg.write_text("{ not json", encoding="utf-8")
        self.env["MUTEKI_CONFIG"] = str(self.cfg)
        self.board("artifact", "list")

    def test_config_artifact_dir_alias(self) -> None:
        import json

        self.cfg.write_text(json.dumps({"artifact_dir": str(self.custom)}), encoding="utf-8")
        self.env["MUTEKI_CONFIG"] = str(self.cfg)
        aid = self.put_artifact(self.custom)
        self.board("fact", "入口", "内容", "--artifact", aid)
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")


class TestQuoteRelevance(BoardCase):
    """A6：可选的证据相关性校验 --quote（默认不启用，行为向后兼容）。"""

    def test_quote_hit_stays_fact(self) -> None:
        aid = self.make_artifact(content="HTTP/1.1 200 OK\r\nX-Trace-Id: trace-9f2a\r\n")
        self.board("fact", "入口", "响应带追踪头", "--artifact", aid, "--quote", "X-Trace-Id: trace-9f2a")
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")

    def test_quote_miss_downgrades_to_observation(self) -> None:
        aid = self.make_artifact(content="HTTP/1.1 200 OK")
        proc = self.board(
            "fact", "RCE 成立", "反序列化可执行命令", "--artifact", aid, "--quote", "node-serialize"
        )
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "observation")
        self.assertIn("未在证据中命中", proc.stdout)
        self.assertIn("降级为观察", proc.stdout)

    def test_multiple_quotes_one_miss_downgrades(self) -> None:
        aid = self.make_artifact(content="sleep 6 → time=6.127874")
        self.board(
            "fact", "延时注入", "可延时", "--artifact", aid,
            "--quote", "time=6.127874", "--quote", "server.js:28",
        )
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "observation")

    def test_quote_without_artifact_is_observation(self) -> None:
        proc = self.board("fact", "推测", "内容", "--quote", "anything")
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "observation")
        self.assertIn("--quote 需配合 --artifact", proc.stdout)

    def test_no_quote_behavior_unchanged(self) -> None:
        aid = self.make_artifact(content="totally unrelated output")
        self.board("fact", "入口", "结论", "--artifact", aid)
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")

    def test_quote_matches_value_field(self) -> None:
        aid = self.make_artifact(content="", value={"stdout": "uid=0(root) gid=0(root)"})
        self.board("fact", "root", "拿到 root", "--artifact", aid, "--quote", "uid=0(root)")
        self.assertEqual(self.query("SELECT level FROM facts WHERE id=1")[0][0], "fact")

    def test_deadend_quote_hit_recorded(self) -> None:
        aid = self.make_artifact(content="3 种 payload 全部 5826B 无差异")
        self.board(
            "deadend", "原型污染无效", "--tested", "三种 payload", "--observed", "无差异",
            "--artifact", aid, "--quote", "无差异",
        )
        self.assertEqual(self.query("SELECT COUNT(*) FROM deadends")[0][0], 1)

    def test_deadend_quote_miss_rejected(self) -> None:
        aid = self.make_artifact(content="200 OK")
        self.board(
            "deadend", "注入无效", "--tested", "x", "--observed", "y",
            "--artifact", aid, "--quote", "SQL syntax error", expect=2,
        )
        self.assertEqual(self.query("SELECT COUNT(*) FROM deadends")[0][0], 0)

    def test_deadend_quote_without_artifact_rejected(self) -> None:
        self.board("deadend", "排除", "--quote", "anything", expect=2)
        self.assertEqual(self.query("SELECT COUNT(*) FROM deadends")[0][0], 0)

    def test_quote_recorded_in_event(self) -> None:
        import json

        aid = self.make_artifact(content="marker-xyz")
        self.board("fact", "入口", "内容", "--artifact", aid, "--quote", "marker-xyz")
        payload = json.loads(self.query("SELECT payload FROM events WHERE kind='fact'")[0][0])
        self.assertEqual(payload["quotes"], ["marker-xyz"])
        self.assertEqual(payload["quote_missing"], [])


if __name__ == "__main__":
    unittest.main()