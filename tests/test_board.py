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


class TestContextBudgetAndOrder(BoardCase):
    """B2：context 段落优先级、新→旧排序、字符预算截断。"""

    def _seed(self, deadends: int = 3, facts: int = 3) -> None:
        aid = self.make_artifact()
        for i in range(facts):
            self.board("fact", f"事实{i}", f"结论{i}", "--artifact", aid)
        for i in range(deadends):
            self.board("deadend", f"方向{i}", "--tested", "范围" * 20, "--observed", "结果" * 20)
        self.board("task", "add", "待办任务")
        self.board("fact", "推测", "尚未证实")

    def test_deadends_come_before_facts(self) -> None:
        self._seed()
        out = self.board("context").stdout
        self.assertLess(out.index("## 已排除的方向"), out.index("## 已证实的事实"))

    def test_facts_newest_first(self) -> None:
        self._seed()
        out = self.board("context").stdout
        self.assertLess(out.index("事实2"), out.index("事实0"))

    def test_deadends_newest_first(self) -> None:
        self._seed()
        out = self.board("context").stdout
        self.assertLess(out.index("方向2"), out.index("方向0"))

    def test_budget_truncates_and_marks(self) -> None:
        self._seed(deadends=30, facts=5)
        out = self.board("context", "--budget", "800").stdout
        self.assertIn("## 已排除的方向", out)
        self.assertIn("预算 800", out)
        self.assertIn("截断", out)
        # 低优先级段落不应出现
        self.assertNotIn("## 未证实观察", out)
        self.assertNotIn("## 任务队列", out)

    def test_budget_keeps_high_priority_flags(self) -> None:
        self._seed(deadends=30)
        self.board("flag", "flag{test}", "--source", "响应")
        out = self.board("context", "--budget", "1200").stdout
        self.assertIn("flag{test}", out)

    def test_no_budget_no_truncation_marker(self) -> None:
        self._seed(deadends=30)
        out = self.board("context").stdout
        self.assertNotIn("预算", out)
        self.assertIn("## 未证实观察", out)
        self.assertIn("## 任务队列", out)

    def test_section_custom_order(self) -> None:
        self._seed()
        out = self.board("context", "--section", "tasks,deadends").stdout
        self.assertIn("## 任务队列", out)
        self.assertIn("## 已排除的方向", out)
        self.assertNotIn("## 已证实的事实", out)
        self.assertLess(out.index("## 任务队列"), out.index("## 已排除的方向"))

    def test_unknown_section_returns_2(self) -> None:
        self.board("context", "--section", "bogus", expect=2)

    def test_json_output_unchanged(self) -> None:
        import json

        self._seed()
        data = json.loads(self.board("context", "--json").stdout)
        for key in ("flags", "facts", "observations", "deadends", "tasks", "reviews", "claims", "superseded"):
            self.assertIn(key, data)
        self.assertEqual(len(data["deadends"]), 3)

    # --- v1.5.2：截断提示行必须计入预算，输出不得超限 ---

    def test_budget_output_never_exceeds_budget(self) -> None:
        self._seed(deadends=30, facts=5)
        for budget in (200, 250, 400, 800, 1200, 3000):
            out = self.board("context", "--budget", str(budget)).stdout
            self.assertLessEqual(
                len(out), budget, msg=f"--budget {budget} 实际输出 {len(out)} 字符"
            )

    def test_budget_note_present_and_counted(self) -> None:
        self._seed(deadends=30, facts=5)
        out = self.board("context", "--budget", "250").stdout
        self.assertIn("预算 250", out)
        self.assertIn("截断", out)
        self.assertLessEqual(len(out), 250)

    def test_budget_note_matches_actual_output(self) -> None:
        import re

        headers = {
            "flags": "## 已获得的 flag",
            "deadends": "## 已排除的方向",
            "facts": "## 已证实的事实",
            "tasks": "## 任务队列",
            "reviews": "## 待处理复核意见",
            "observations": "## 未证实观察",
            "claims": "## 进行中的认领",
            "superseded": "## 已被推翻的旧结论",
        }
        self._seed(deadends=30, facts=5)
        for budget in (250, 400, 800):
            out = self.board("context", "--budget", str(budget)).stdout
            named = re.search(r"「([a-z]+)」段被截断", out) or re.search(
                r"预算 \d+ 用尽：([a-z]+) 截断", out
            )
            self.assertIsNotNone(named, msg=f"budget={budget} 没有截断提示：{out}")
            omitted = re.search(r"未显示：([^；]+)", out) or re.search(r"未显示 ([^；]+)", out)
            if omitted:
                for name in [x.strip() for x in omitted.group(1).split(",")]:
                    self.assertIn(name, headers)
                    self.assertNotIn(
                        headers[name], out,
                        msg=f"budget={budget} 提示说 {name} 未显示，输出里却有",
                    )

    def test_tight_budget_degrades_header_not_silently(self) -> None:
        # 测试工作区的临时路径很长，头部本身就吃掉大半预算：
        # 这时必须显式压缩头部/提示，而不是悄悄超限或悄悄丢内容。
        self._seed(deadends=30, facts=5)
        out = self.board("context", "--budget", "250").stdout
        self.assertLessEqual(len(out), 250)
        self.assertTrue("头部已压缩" in out or "用尽：" in out, msg=out)

    def test_tiny_budget_still_bounded(self) -> None:
        self._seed(deadends=5, facts=2)
        for budget in (1, 2, 40, 120):
            out = self.board("context", "--budget", str(budget)).stdout
            self.assertLessEqual(len(out), budget, msg=f"--budget {budget} 输出 {len(out)}")

    def test_budget_fitting_content_has_no_note(self) -> None:
        self._seed(deadends=1, facts=1)
        out = self.board("context", "--budget", "6000").stdout
        self.assertNotIn("预算", out)
        self.assertLessEqual(len(out), 6000)


class TestAdopt(BoardCase):
    """B4：归属迁移 + 空题提示（解决 legacy / 旧题数据孤儿）。"""

    def _seed_legacy(self) -> None:
        aid = self.make_artifact()
        self.board("use", "legacy")
        self.board("fact", "旧事实", "旧结论", "--artifact", aid)
        self.board("deadend", "旧死路", "--tested", "范围", "--observed", "结果")
        self.board("flag", "flag{test}", "--source", "旧响应")
        self.board("task", "add", "旧任务")
        self.board("review", "add", "--kind", "gap", "--note", "旧意见")
        self.board("use", "web-new")

    def test_adopt_moves_all_record_types(self) -> None:
        self._seed_legacy()
        proc = self.board("adopt", "f1", "d1", "g1", "t1", "r1")
        self.assertIn("成功 5 条", proc.stdout)
        for table in ("facts", "deadends", "flags", "tasks", "reviews"):
            self.assertEqual(
                self.query(f"SELECT challenge FROM {table} WHERE id=1")[0][0], "web-new"
            )
        self.assertIn("adopted", self.event_kinds())

    def test_adopt_comma_separated(self) -> None:
        self._seed_legacy()
        self.board("adopt", "f1,d1,g1")
        self.assertEqual(self.query("SELECT challenge FROM facts WHERE id=1")[0][0], "web-new")
        self.assertEqual(self.query("SELECT challenge FROM flags WHERE id=1")[0][0], "web-new")

    def test_adopt_explicit_target(self) -> None:
        self._seed_legacy()
        self.board("adopt", "f1", "--challenge", "web-other")
        self.assertEqual(self.query("SELECT challenge FROM facts WHERE id=1")[0][0], "web-other")

    def test_adopt_already_in_target_skipped(self) -> None:
        self._seed_legacy()
        self.board("adopt", "f1")
        proc = self.board("adopt", "f1", expect=1)
        self.assertIn("已在题", proc.stdout)

    def test_adopt_missing_id_returns_1(self) -> None:
        self.board("adopt", "f999", expect=1)

    def test_adopt_bad_prefix_returns_1(self) -> None:
        self.board("adopt", "z1", expect=1)

    def test_adopt_flag_value_clash_skipped(self) -> None:
        self._seed_legacy()
        self.execute(
            "INSERT INTO flags (challenge, value, source, created_at) VALUES ('web-new', 'flag{test}', 'x', '2026-01-01 00:00:00')"
        )
        proc = self.board("adopt", "g1", expect=1)
        self.assertIn("同值 flag", proc.stdout)
        self.assertEqual(self.query("SELECT challenge FROM flags WHERE id=1")[0][0], "legacy")

    def test_context_hints_when_current_empty(self) -> None:
        self._seed_legacy()
        out = self.board("context").stdout
        self.assertIn("当前题还没有记录", out)
        self.assertIn("adopt", out)
        self.assertIn("legacy", out)

    def test_context_no_hint_when_current_has_data(self) -> None:
        self._seed_legacy()
        self.board("fact", "新事实", "新结论")
        out = self.board("context").stdout
        self.assertNotIn("当前题还没有记录", out)

    def test_context_all_no_hint(self) -> None:
        self._seed_legacy()
        out = self.board("context", "--all").stdout
        self.assertNotIn("当前题还没有记录", out)

    def test_adopted_records_visible_in_context(self) -> None:
        self._seed_legacy()
        self.board("adopt", "f1,g1,d1")
        out = self.board("context").stdout
        self.assertIn("旧事实", out)
        self.assertIn("flag{test}", out)
        self.assertIn("旧死路", out)

    # --- v1.5.1：adopted 事件必须带 challenge，否则按题复盘永远看不到它 ---

    def test_adopted_event_carries_target_challenge(self) -> None:
        import json

        self._seed_legacy()
        self.board("adopt", "f1,d1")
        rows = self.query("SELECT payload FROM events WHERE kind='adopted'")
        self.assertEqual(len(rows), 1)
        payload = json.loads(rows[0][0])
        self.assertEqual(payload.get("challenge"), "web-new")
        self.assertEqual(payload.get("target"), "web-new")

    def test_adopted_event_visible_in_report_timeline(self) -> None:
        import json

        self._seed_legacy()
        self.board("adopt", "f1,d1,g1")
        data = json.loads(self.board("report", "--json").stdout)
        kinds = [item["kind"] for item in data["timeline"]]
        self.assertIn("adopted", kinds)
        self.assertEqual(data["counts"]["events"], len(kinds))
        md = self.board("report").stdout
        self.assertIn("adopted", md)
        self.assertIn("迁移 3 条", md)

    def test_adopted_event_challenge_is_explicit_target(self) -> None:
        import json

        self._seed_legacy()
        self.board("adopt", "f1", "--challenge", "web-other")
        there = json.loads(self.board("report", "--challenge", "web-other", "--json").stdout)
        self.assertIn("adopted", [item["kind"] for item in there["timeline"]])
        here = json.loads(self.board("report", "--json").stdout)
        self.assertNotIn("adopted", [item["kind"] for item in here["timeline"]])

    def test_report_events_count_matches_challenge_events(self) -> None:
        import json

        self._seed_legacy()
        self.board("adopt", "f1")
        self.board("task", "add", "新任务")
        data = json.loads(self.board("report", "--json").stdout)
        expected = sum(
            1
            for (payload,) in self.query("SELECT payload FROM events")
            if json.loads(payload).get("challenge") == "web-new"
        )
        self.assertGreater(expected, 0)
        self.assertEqual(data["counts"]["events"], expected)


class TestEventChallengeGuard(BoardCase):
    """record() 兜底：事件缺 challenge 会「写进库但永远不上按题时间线」。

    v1.5.0 的 adopted 就是这个缺陷。这里直接驱动 record()，确保以后任何
    新事件类型忘了写 challenge 也会被自动补上，而显式给出的值不被覆盖。
    """

    def _module(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("board_under_test", BOARD_PY)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _write_event(self, payload: dict) -> None:
        from unittest import mock

        mod = self._module()
        with mock.patch.dict(os.environ, {"MUTEKI_BOARD_DB": str(self.db)}):
            conn = mod.connect()
            try:
                mod.record(conn, "custom_probe", payload)
                conn.commit()
            finally:
                conn.close()

    def test_record_fills_missing_challenge(self) -> None:
        import json

        self.board("use", "web-guard")
        self._write_event({"id": 1})
        rows = self.query("SELECT payload FROM events WHERE kind='custom_probe'")
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0][0])["challenge"], "web-guard")
        data = json.loads(self.board("report", "--json").stdout)
        self.assertIn("custom_probe", [item["kind"] for item in data["timeline"]])

    def test_record_keeps_explicit_challenge(self) -> None:
        import json

        self.board("use", "web-guard")
        self._write_event({"challenge": "web-explicit", "id": 2})
        rows = self.query("SELECT payload FROM events WHERE kind='custom_probe'")
        self.assertEqual(json.loads(rows[0][0])["challenge"], "web-explicit")
        data = json.loads(self.board("report", "--json").stdout)
        self.assertNotIn("custom_probe", [item["kind"] for item in data["timeline"]])

    def test_record_does_not_mutate_caller_payload(self) -> None:
        self.board("use", "web-guard")
        payload = {"id": 3}
        self._write_event(payload)
        self.assertEqual(payload, {"id": 3})


class TestReport(BoardCase):
    """B5：复盘报告（Markdown / JSON / 按题过滤 / 账本整合）。"""

    def _seed(self) -> None:
        aid = self.make_artifact()
        self.board("use", "web-r")
        self.board("fact", "入口", "可复用入口", "--artifact", aid)
        self.board("deadend", "排除", "--tested", "范围", "--observed", "结果")
        self.board("flag", "flag{test}", "--source", "响应", "--artifact", aid)
        self.board("flagstatus", "1", "--set", "accepted", "--verified-by", "平台回显")
        self.board("task", "add", "步骤一")
        self.board("task", "done", "1")
        self.board("review", "add", "--kind", "gap", "--note", "缺验证")

    def test_markdown_report_sections(self) -> None:
        self._seed()
        out = self.board("report").stdout
        for needle in ("# Muteki 复盘报告", "## 概览", "## flag", "## 已证实事实",
                       "## 已排除方向", "## 任务", "## 复核意见", "## 时间线"):
            self.assertIn(needle, out)
        self.assertIn("入口", out)
        self.assertIn("flag{test}", out)
        self.assertIn("[accepted]", out)
        self.assertIn("task_done", out)

    def test_json_report_structure(self) -> None:
        import json

        self._seed()
        data = json.loads(self.board("report", "--json").stdout)
        self.assertEqual(data["challenge"], "web-r")
        self.assertEqual(data["counts"]["facts"], 1)
        self.assertEqual(data["counts"]["deadends"], 1)
        self.assertEqual(data["counts"]["flags"], 1)
        self.assertEqual(data["flag_status"], {"accepted": 1})
        self.assertEqual(data["task_status"], {"done": 1})
        self.assertTrue(data["span"])
        kinds = {e["kind"] for e in data["timeline"]}
        self.assertIn("task_added", kinds)
        self.assertIn("flag_status", kinds)

    def test_report_challenge_filter(self) -> None:
        import json

        self._seed()
        self.board("use", "web-other")
        self.board("fact", "别题事实", "别题结论")
        data = json.loads(self.board("report", "--challenge", "web-r", "--json").stdout)
        self.assertEqual(data["counts"]["facts"], 1)
        self.assertEqual(data["challenge"], "web-r")

    def test_report_all_includes_other_challenges(self) -> None:
        import json

        self._seed()
        aid = self.make_artifact(aid="atest0002-abcdef")
        self.board("use", "web-other")
        self.board("fact", "别题事实", "别题结论", "--artifact", aid)
        data = json.loads(self.board("report", "--all", "--json").stdout)
        self.assertEqual(data["counts"]["facts"], 2)

    def test_report_integrates_ledgers(self) -> None:
        import json
        import time as _time

        self._seed()
        now_ms = int(_time.time() * 1000)
        (self.artifacts / "runs.json").write_text(
            json.dumps([{"ts": now_ms, "challenge": "web-r"}, {"ts": now_ms, "challenge": "other"}]),
            encoding="utf-8",
        )
        (self.artifacts / "costs.json").write_text(
            json.dumps([{"ts": now_ms, "usd": 0.5, "engine": "claude-cli", "challenge": "web-r"}]),
            encoding="utf-8",
        )
        data = json.loads(self.board("report", "--json").stdout)
        self.assertEqual(data["dispatches"], 1)
        self.assertEqual(data["cli_cost_usd"], 0.5)
        self.assertIn("$0.5000", self.board("report").stdout)

    def test_report_empty_board_does_not_crash(self) -> None:
        out = self.board("report").stdout
        self.assertIn("## 概览", out)
        self.assertIn("（无）", out)

    def test_report_md_flag_is_default(self) -> None:
        self._seed()
        a = [ln for ln in self.board("report", "--md").stdout.splitlines() if "生成时间" not in ln]
        b = [ln for ln in self.board("report").stdout.splitlines() if "生成时间" not in ln]
        self.assertEqual(a, b)


class TestPrefixedIds(BoardCase):
    """v1.9.2：task / review / flagstatus 也接受带前缀的 id（t1 / r1 / g1）。

    read / search / task list 都用带前缀的 id 展示，子代理照着抄就会写
    `task done t1`；以前只收纯数字，报 invalid int value 让它绕一次弯。
    """

    def _seed(self) -> None:
        self.board("task", "add", "任务一")
        self.board("review", "add", "--kind", "gap", "--note", "缺验证")
        self.board("flag", "flag{test}", "--source", "响应")

    def test_task_done_accepts_prefix(self) -> None:
        self._seed()
        proc = self.board("task", "done", "t1")
        self.assertIn("t1 → done", proc.stdout)
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "done")

    def test_task_claim_accepts_prefix(self) -> None:
        self._seed()
        self.board("task", "claim", "t1", "--owner", "worker-a")
        self.assertEqual(self.query("SELECT owner FROM tasks WHERE id=1")[0][0], "worker-a")

    def test_task_reopen_accepts_prefix(self) -> None:
        self._seed()
        self.board("task", "claim", "1", "--owner", "worker-a")
        self.board("task", "reopen", "t1")
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "open")

    def test_task_drop_accepts_prefix(self) -> None:
        self._seed()
        self.board("task", "drop", "t1")
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "dropped")

    def test_review_resolve_accepts_prefix(self) -> None:
        self._seed()
        self.board("review", "resolve", "r1")
        self.assertEqual(self.query("SELECT status FROM reviews WHERE id=1")[0][0], "resolved")

    def test_flagstatus_accepts_prefix(self) -> None:
        self._seed()
        self.board("flagstatus", "g1", "--set", "accepted", "--verified-by", "平台回显")
        self.assertEqual(self.query("SELECT status FROM flags WHERE id=1")[0][0], "accepted")

    def test_uppercase_prefix_accepted(self) -> None:
        self._seed()
        self.board("task", "done", "T1")
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "done")

    def test_numeric_id_still_works(self) -> None:
        self._seed()
        self.board("task", "done", "1")
        self.board("review", "resolve", "1")
        self.board("flagstatus", "1", "--set", "submitted")
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "done")
        self.assertEqual(self.query("SELECT status FROM reviews WHERE id=1")[0][0], "resolved")
        self.assertEqual(self.query("SELECT status FROM flags WHERE id=1")[0][0], "submitted")

    def test_wrong_prefix_rejected(self) -> None:
        self._seed()
        proc = self.board("task", "done", "g1", expect=2)
        self.assertIn("id 应为 t", proc.stderr)
        self.board("flagstatus", "t1", "--set", "accepted", expect=2)
        self.board("review", "resolve", "f1", expect=2)
        # 拒写之后状态不能变
        self.assertEqual(self.query("SELECT status FROM tasks WHERE id=1")[0][0], "open")

    def test_non_numeric_rejected(self) -> None:
        self._seed()
        self.board("task", "done", "abc", expect=2)
        self.board("task", "done", "t", expect=2)
        self.board("task", "done", "t1x", expect=2)

    def test_prefix_id_writes_same_event_as_numeric(self) -> None:
        self._seed()
        self.board("task", "done", "t1")
        kinds = self.event_kinds()
        self.assertIn("task_done", kinds)
        rows = self.query("SELECT payload FROM events WHERE kind='task_done'")
        import json

        self.assertEqual(json.loads(rows[0][0])["id"], 1)


class TestUsabilityFixes(BoardCase):
    """v1.11.0：实机验证里 worker 绕弯的四个用法问题。"""

    def _seed(self) -> None:
        aid = self.make_artifact()
        self.board("fact", "带证据的结论", "可复用", "--artifact", aid)
        self.board("fact", "还没证实的推测", "只是看到")
        self.board("task", "add", "任务一")

    def test_fact_list_marks_level(self) -> None:
        self._seed()
        out = self.board("fact", "list").stdout
        self.assertIn("f1 [事实]", out)
        self.assertIn("f2 [观察]", out)
        self.assertIn("观察不能当结论", out)

    def test_fact_list_level_filter(self) -> None:
        self._seed()
        out = self.board("fact", "list", "--level", "fact").stdout
        self.assertIn("f1 [事实]", out)
        self.assertNotIn("f2", out)
        obs = self.board("fact", "list", "--level", "observation").stdout
        self.assertIn("f2 [观察]", obs)
        self.assertNotIn("f1", obs)

    def test_fact_list_json(self) -> None:
        import json

        self._seed()
        data = json.loads(self.board("fact", "list", "--json").stdout)
        self.assertEqual(len(data), 2)
        self.assertEqual({row["level"] for row in data}, {"fact", "observation"})

    def test_fact_list_respects_challenge(self) -> None:
        self._seed()
        self.board("use", "other")
        self.assertEqual(self.board("fact", "list").stdout.count("- f"), 0)
        self.assertIn("f1", self.board("fact", "list", "--all").stdout)

    def test_fact_missing_args_points_to_list(self) -> None:
        proc = self.board("fact", expect=2)
        self.assertIn("fact list", proc.stderr)
        proc = self.board("fact", "只有标题", expect=2)
        self.assertIn("fact list", proc.stderr)

    def test_fact_titled_list_still_records(self) -> None:
        self.board("fact", "list", "这是一条标题叫 list 的结论")
        # fact list 只显示标题，正文用 read / 直接查库核对
        out = self.board("fact", "list").stdout
        self.assertIn("- f1 [观察] list", out)
        self.assertEqual(
            self.query("SELECT content FROM facts WHERE id=1")[0][0],
            "这是一条标题叫 list 的结论",
        )

    def test_task_claim_as_alias(self) -> None:
        self._seed()
        self.board("task", "claim", "t1", "--as", "worker-a")
        self.assertEqual(self.query("SELECT owner FROM tasks WHERE id=1")[0][0], "worker-a")

    def test_task_list_empty_hints_status_all(self) -> None:
        self._seed()
        self.board("task", "done", "1")
        out = self.board("task", "list").stdout
        self.assertIn("--status all", out)
        self.assertIn("t1", self.board("task", "list", "--status", "all").stdout)

    def test_all_challenges_alias(self) -> None:
        self._seed()
        self.board("use", "other")
        self.board("task", "add", "别题任务")
        out = self.board("task", "list", "--status", "all", "--all-challenges").stdout
        self.assertIn("任务一", out)
        self.assertIn("别题任务", out)

    def test_review_list_empty_hint(self) -> None:
        out = self.board("review", "list").stdout
        self.assertIn("--status all", out)

    def test_search_marks_observation(self) -> None:
        self._seed()
        out = self.board("search", "结论").stdout
        self.assertIn("[事实]", out)
        obs = self.board("search", "推测").stdout
        self.assertIn("[观察]", obs)


class TestLineageEdges(BoardCase):
    def _seed_chain(self) -> None:
        self.board("use", "t-edge")
        self.board("fact", "入口", "发现登录口")
        self.board("fact", "绕过", "空 token 绕过")
        self.board("flag", "flag{edge}", "--source", "t")
        self.board("link", "f2", "f1", "--kind", "derived_from")
        self.board("link", "g1", "f2", "--kind", "proves")

    def test_link_writes_edge_and_event(self) -> None:
        self._seed_chain()
        rows = self.query("SELECT src, dst, kind FROM edges")
        self.assertIn(("f2", "f1", "derived_from"), rows)
        self.assertIn(("g1", "f2", "proves"), rows)
        self.assertIn("edge_added", self.event_kinds())

    def test_read_shows_lineage(self) -> None:
        self._seed_chain()
        out = self.board("read", "f2").stdout
        self.assertIn("lineage:", out)
        self.assertIn("f2 -derived_from-> f1", out)
        self.assertIn("g1 -proves-> f2", out)

    def test_chain_transitive(self) -> None:
        self._seed_chain()
        out = self.board("chain", "f1").stdout
        self.assertIn("f2 -derived_from-> f1", out)
        self.assertIn("g1 -proves-> f2", out)
        # 展示去重：同一条边只打印一次（底层 edges 本就只有一条）
        self.assertEqual(out.count("f2 -derived_from-> f1"), 1)
        self.assertEqual(out.count("g1 -proves-> f2"), 1)

    def test_link_rejects_missing_self_and_bad_kind(self) -> None:
        self.board("use", "t-edge")
        self.board("fact", "入口", "x")
        self.board("link", "f1", "f9", expect=1)
        self.board("link", "f1", "f1", expect=2)
        self.board("link", "f1", "f1", "--kind", "bogus", expect=2)

    def test_link_duplicate_idempotent(self) -> None:
        self._seed_chain()
        out = self.board("link", "f2", "f1", "--kind", "derived_from").stdout
        self.assertIn("已存在", out)
        self.assertEqual(len(self.query("SELECT 1 FROM edges")), 2)

    def test_lineage_scoped_to_challenge(self) -> None:
        self._seed_chain()
        self.board("use", "other")
        self.board("fact", "别题", "y")
        self.board("chain", "g1", expect=1)  # g1 只存在于 t-edge
        out = self.board("read", "f1").stdout
        self.assertNotIn("lineage:", out)


class TestLessons(BoardCase):
    def _seed(self) -> None:
        self.board("use", "t-les")
        self.board("fact", "可复用", "空 token 绕过成立")
        self.board("deadend", "爆破不可行", "--tested", "top100", "--observed", "全 401")
        self.board("review", "add", "--kind", "gap", "--note", "缺对 X 验证")
        self.board("flag", "flag{les}", "--source", "t")

    def test_report_writes_lessons_file(self) -> None:
        self._seed()
        self.board("report")
        p = self.db.parent / "lessons-t-les.md"
        self.assertTrue(p.exists())
        text = p.read_text(encoding="utf-8")
        self.assertIn("已排除方向", text)
        self.assertIn("爆破不可行", text)
        self.assertIn("flag{les}", text)
        self.assertIn("缺对 X 验证", text)

    def test_lessons_cmd_prints_and_writes(self) -> None:
        self._seed()
        out = self.board("lessons").stdout
        self.assertIn("lessons-t-les", out)
        self.assertIn("已写", out)
        self.assertTrue((self.db.parent / "lessons-t-les.md").exists())

    def test_lessons_print_only_no_write(self) -> None:
        self._seed()
        out = self.board("lessons", "--print-only").stdout
        self.assertNotIn("已写", out)
        self.assertFalse((self.db.parent / "lessons-t-les.md").exists())


if __name__ == "__main__":
    unittest.main()