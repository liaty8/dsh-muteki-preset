#!/usr/bin/env python3
"""Muteki 黑板：工作区级、append-only 的作战事实图（按题隔离）。

参考 Project Muteki 的 Shared Graph：events 是唯一真相，facts / deadends /
flags 是折叠出来的视图；只有真实工具输出支持的结论才应该被写进来。

阶段 3 增强（按题隔离，防旧题污染）：
  - 每条记录带 challenge 维度，默认只读写 meta.current_challenge 指向的题。
  - `board.py use <题名>` 切题；`board.py current` 查看当前题。
  - `--all` 让 context / task list / review list / stats / search 跨题查看。
  - 新开一题前先 use 一个干净的名字（如 web-8080），旧题的 fact / deadend /
    task / flag / lane 就不会再被 muteki_run 当成当前题的证据或首解。
  - 旧库自动迁移：老记录统一归入 challenge='legacy'，不影响新题。

阶段 1 能力：
  - 证据门：fact / deadend 可挂 --artifact（muteki-core 插件捕获的工具执行
    证据 id）。校验不过直接拒写；没挂证据的结论记为 observation（观察），
    与带证据的 fact 分开显示，避免"猜的"被下一步当结论用。
  - 认领锁：claim / release / lanes，防止多个会话或子代理同时打同一目标。

用法：
    python board.py use web-8080
    python board.py current
    python board.py context [--all]
    python board.py fact "<标题>" "<增量结论>" --artifact a1x2y3-8f2a [--quote "原文片段"]
    python board.py fact "<标题>" "<尚未证实的观察>"
    python board.py deadend "<原因>" --tested "<范围>" --observed "<结果>" [--artifact ID] [--quote "原文片段"]
    python board.py flag "<flag>" [--source "..."] [--artifact ID] [--status candidate]
    python board.py flagstatus 1 --set accepted --verified-by "平台回显 correct"
    python board.py task add "<标题>" --detail "..." --priority 3
    python board.py task list [--status open|claimed|done|dropped|all] [--all]
    python board.py task claim 3 / task done 3 / task drop 3
    python board.py claim web-login --ttl 900 --note "SQL 注入验证"
    python board.py release web-login
    python board.py lanes
    python board.py review add --kind gap --note "缺少对 X 的验证" --target f3
    python board.py review list [--status open|resolved|all] [--all]
    python board.py review resolve 1
    python board.py artifact list [--limit N] / artifact show <id>
    python board.py search "<关键词>" [--all]
    python board.py read f3 / d2 / g1 / r1 / t2 / a1x2y3-8f2a
    python board.py stats [--all]

数据库默认在工作目录的 .muteki-board/board.db，可用 MUTEKI_BOARD_DB 覆盖；
当前题可用 MUTEKI_CHALLENGE 覆盖（优先于 meta 里的值）。
证据目录优先级：MUTEKI_ARTIFACT_DIR > 安装配置 ~/.dsh-muteki/config.json 的 storage_dir
> 内置默认 ~/.dsh-muteki/artifacts。配置文件由 install.ps1 生成（可用 MUTEKI_CONFIG 指向别处），
必须与 muteki-core 插件的 artifactDir 一致，否则证据门找不到索引。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

__version__ = "1.2.0"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    kind    TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
    id            INTEGER PRIMARY KEY,
    challenge     TEXT NOT NULL DEFAULT 'default',
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    evidence      TEXT,
    artifacts     TEXT NOT NULL DEFAULT '[]',
    level         TEXT NOT NULL DEFAULT 'fact',
    superseded_by INTEGER,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deadends (
    id         INTEGER PRIMARY KEY,
    challenge  TEXT NOT NULL DEFAULT 'default',
    reason     TEXT NOT NULL,
    tested     TEXT,
    observed   TEXT,
    artifacts  TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flags (
    id         INTEGER PRIMARY KEY,
    challenge  TEXT NOT NULL DEFAULT 'default',
    value      TEXT NOT NULL,
    source     TEXT,
    created_at TEXT NOT NULL,
    artifacts  TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'candidate',
    verified_by TEXT,
    note       TEXT,
    UNIQUE(challenge, value)
);
CREATE TABLE IF NOT EXISTS claims (
    challenge   TEXT NOT NULL DEFAULT 'default',
    lane        TEXT NOT NULL,
    owner       TEXT NOT NULL,
    note        TEXT,
    ttl_seconds INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    PRIMARY KEY (challenge, lane)
);
CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY,
    challenge  TEXT NOT NULL DEFAULT 'default',
    title      TEXT NOT NULL,
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    owner      TEXT,
    priority   INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY,
    challenge  TEXT NOT NULL DEFAULT 'default',
    kind       TEXT NOT NULL,
    target     TEXT,
    note       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")


def db_path() -> Path:
    override = os.environ.get("MUTEKI_BOARD_DB")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.cwd() / ".muteki-board" / "board.db").resolve()


def config_file() -> Path:
    """安装时生成的配置文件（install.ps1 写入）。可用 MUTEKI_CONFIG 覆盖。"""
    override = os.environ.get("MUTEKI_CONFIG")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".dsh-muteki" / "config.json").resolve()


def load_config() -> dict:
    """读配置；缺失/损坏都静默回退到内置默认（utf-8-sig 容忍 BOM）。"""
    try:
        data = json.loads(config_file().read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def artifact_dir() -> Path:
    """证据目录优先级：MUTEKI_ARTIFACT_DIR > config.json 的 storage_dir > 内置默认。

    A3：此前只有「环境变量 > 内置默认」，install.ps1 自定义 -StorageDir 时
    插件写到自定义目录、board.py 却去内置默认找索引，证据门必然失败。
    """
    override = os.environ.get("MUTEKI_ARTIFACT_DIR")
    if override:
        return Path(override).expanduser().resolve()
    cfg = load_config()
    value = cfg.get("storage_dir") or cfg.get("artifact_dir")
    if value:
        return Path(str(value)).expanduser().resolve()
    return (Path.home() / ".dsh-muteki" / "artifacts").resolve()


def artifact_index_path() -> Path:
    return artifact_dir() / "index.jsonl"


def load_artifact_index() -> dict[str, dict]:
    """读取 muteki-core 插件写的索引（一行一个 JSON，坏行跳过）。"""
    path = artifact_index_path()
    out: dict[str, dict] = {}
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                aid = str(item.get("id") or "")
                if aid:
                    out[aid] = item
    except FileNotFoundError:
        pass
    return out


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {str(row["name"]) for row in rows}


def _migrate(conn: sqlite3.Connection) -> None:
    """旧库迁移：补 challenge 维度和历史列；旧记录归入 legacy。"""
    # 1) facts 的历史列（artifacts / level）
    fact_cols = _columns(conn, "facts")
    if fact_cols and "artifacts" not in fact_cols:
        conn.execute("ALTER TABLE facts ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'")
    if fact_cols and "level" not in fact_cols:
        conn.execute("ALTER TABLE facts ADD COLUMN level TEXT NOT NULL DEFAULT 'fact'")
        conn.execute(
            "UPDATE facts SET level='observation' "
            "WHERE (artifacts IS NULL OR artifacts='[]') AND (evidence IS NULL OR evidence='')"
        )
    if "artifacts" not in _columns(conn, "deadends"):
        conn.execute("ALTER TABLE deadends ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'")

    # 2) 普通表补 challenge 列；旧数据统一归 legacy
    for table in ("facts", "deadends", "tasks", "reviews"):
        cols = _columns(conn, table)
        if cols and "challenge" not in cols:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN challenge TEXT NOT NULL DEFAULT 'legacy'"
            )

    # 3) flags / claims 需要 (challenge, ...) 复合唯一，旧表重建
    flag_cols = _columns(conn, "flags")
    if flag_cols and "challenge" not in flag_cols:
        conn.execute("ALTER TABLE flags RENAME TO flags_old")
        conn.execute(
            """CREATE TABLE flags (
                id         INTEGER PRIMARY KEY,
                challenge  TEXT NOT NULL DEFAULT 'default',
                value      TEXT NOT NULL,
                source     TEXT,
                created_at TEXT NOT NULL,
                artifacts  TEXT NOT NULL DEFAULT '[]',
                status     TEXT NOT NULL DEFAULT 'candidate',
                verified_by TEXT,
                note       TEXT,
                UNIQUE(challenge, value)
            )"""
        )
        conn.execute(
            "INSERT INTO flags (id, challenge, value, source, created_at) "
            "SELECT id, 'legacy', value, source, created_at FROM flags_old"
        )
        conn.execute("DROP TABLE flags_old")
        flag_cols = _columns(conn, "flags")

    # 3b) flags 的证据与验证状态列（A4）：旧库补列，已有 flag 默认 candidate
    if flag_cols:
        if "artifacts" not in flag_cols:
            conn.execute("ALTER TABLE flags ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'")
        if "status" not in flag_cols:
            conn.execute("ALTER TABLE flags ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate'")
        if "verified_by" not in flag_cols:
            conn.execute("ALTER TABLE flags ADD COLUMN verified_by TEXT")
        if "note" not in flag_cols:
            conn.execute("ALTER TABLE flags ADD COLUMN note TEXT")
    claim_cols = _columns(conn, "claims")
    if claim_cols and "challenge" not in claim_cols:
        conn.execute("ALTER TABLE claims RENAME TO claims_old")
        conn.execute(
            """CREATE TABLE claims (
                challenge   TEXT NOT NULL DEFAULT 'default',
                lane        TEXT NOT NULL,
                owner       TEXT NOT NULL,
                note        TEXT,
                ttl_seconds INTEGER NOT NULL,
                created_at  TEXT NOT NULL,
                expires_at  INTEGER NOT NULL,
                PRIMARY KEY (challenge, lane)
            )"""
        )
        conn.execute(
            "INSERT INTO claims (challenge, lane, owner, note, ttl_seconds, created_at, expires_at) "
            "SELECT 'legacy', lane, owner, note, ttl_seconds, created_at, expires_at FROM claims_old"
        )
        conn.execute("DROP TABLE claims_old")

    # 4) meta 初始化
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('current_challenge', 'default')"
    )


def current_challenge(conn: sqlite3.Connection) -> str:
    env = os.environ.get("MUTEKI_CHALLENGE")
    if env and env.strip():
        return env.strip()
    row = conn.execute(
        "SELECT value FROM meta WHERE key='current_challenge'"
    ).fetchone()
    return str(row["value"]) if row else "default"


def set_challenge(conn: sqlite3.Connection, name: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('current_challenge', ?)",
        (name,),
    )
    record(conn, "challenge_switched", {"challenge": name})


def _scope(conn: sqlite3.Connection, all_flag: bool = False) -> tuple[str, list]:
    """返回 SQL 片段与参数：默认只查当前题；all=True 时跨题。"""
    if all_flag:
        return "", []
    return " AND challenge = ?", [current_challenge(conn)]


def record(conn: sqlite3.Connection, kind: str, payload: dict) -> None:
    conn.execute(
        "INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)",
        (now(), kind, json.dumps(payload, ensure_ascii=False)),
    )


def commit_with_event(conn: sqlite3.Connection, kind: str, payload: dict) -> None:
    """把「写事件」与「提交」绑在一起。

    历史缺陷（v1.0.13 之前）：task / review 的各动作先 conn.commit() 再 record()，
    事件 INSERT 落在一个从未提交的事务里，进程退出即回滚，导致 events 表缺失
    全部 task_* / review_* 事件。所有写操作统一走本函数，杜绝再次写反。
    """
    record(conn, kind, payload)
    conn.commit()


def short(text: str, limit: int = 400) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_artifacts(args: argparse.Namespace) -> list[str]:
    raw = getattr(args, "artifact", None) or []
    out: list[str] = []
    for item in raw:
        for piece in str(item).replace(",", " ").split():
            piece = piece.strip()
            if piece and piece not in out:
                out.append(piece)
    return out


def verify_artifacts(ids: list[str]) -> int:
    """校验证据 id；缺失时打印原因并返回非 0。"""
    if not ids:
        return 0
    index = load_artifact_index()
    missing: list[str] = []
    for aid in ids:
        entry = index.get(aid)
        if entry is None:
            missing.append(aid)
            continue
        file = str(entry.get("file") or "")
        if file and not Path(file).exists():
            missing.append(aid)
    if missing:
        print(
            "证据校验失败：" + ", ".join(missing) + " 不在 muteki-core 证据库里。"
            "先跑一次真实工具，再用 `board.py artifact list` 核对 id。",
            file=sys.stderr,
        )
        return 2
    return 0


def parse_quotes(args: argparse.Namespace) -> list[str]:
    raw = getattr(args, "quote", None) or []
    out: list[str] = []
    for item in raw:
        text = str(item).strip()
        if text and text not in out:
            out.append(text)
    return out


def artifact_texts(ids: list[str]) -> dict[str, str]:
    """读取证据文件里可搜索的文本（content + value 序列化）。读不到则为空串。"""
    index = load_artifact_index()
    texts: dict[str, str] = {}
    for aid in ids:
        entry = index.get(aid) or {}
        file = str(entry.get("file") or "")
        text = ""
        if file:
            try:
                payload = json.loads(Path(file).read_text(encoding="utf-8", errors="replace"))
                parts = []
                content = payload.get("content")
                if isinstance(content, str):
                    parts.append(content)
                value = payload.get("value")
                if value is not None:
                    parts.append(json.dumps(value, ensure_ascii=False))
                text = "\n".join(parts)
            except Exception:
                text = ""
        texts[aid] = text
    return texts


def missing_quotes(ids: list[str], quotes: list[str]) -> list[str]:
    """A6：返回未在任何所引证据里命中的 quote（可选的相关性校验）。"""
    if not quotes:
        return []
    blob = "\n".join(artifact_texts(ids).values())
    return [q for q in quotes if q not in blob]


def cmd_use(args: argparse.Namespace) -> int:
    conn = connect()
    name = str(args.name).strip()
    if not name:
        print("题名不能为空", file=sys.stderr)
        return 2
    set_challenge(conn, name)
    conn.commit()
    print(f"当前题已切换为 {name}（旧题数据仍保留；context --all 可跨题查看）")
    return 0


def cmd_current(args: argparse.Namespace) -> int:
    conn = connect()
    print(current_challenge(conn))
    return 0


def cmd_fact(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    artifacts = parse_artifacts(args)
    code = verify_artifacts(artifacts)
    if code != 0:
        return code
    level = "fact" if artifacts else "observation"
    quotes = parse_quotes(args)
    quote_miss: list[str] = []
    quote_note = ""
    if quotes:
        if not artifacts:
            quote_note = "（--quote 需配合 --artifact；本条按观察记录）"
        else:
            quote_miss = missing_quotes(artifacts, quotes)
            if quote_miss:
                level = "observation"
                quote_note = (
                    "（--quote 未在证据中命中："
                    + " / ".join(short(q, 60) for q in quote_miss)
                    + "；已降级为观察）"
                )
    if args.supersedes:
        old = conn.execute(
            "SELECT id FROM facts WHERE id = ? AND challenge = ?", (args.supersedes, ch)
        ).fetchone()
        if old is None:
            print(
                f"当前题（{ch}）没有 id=f{args.supersedes} 的事实，忽略 --supersedes",
                file=sys.stderr,
            )
    cur = conn.execute(
        "INSERT INTO facts (challenge, title, content, evidence, artifacts, level, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            ch,
            args.title,
            args.content,
            args.evidence,
            json.dumps(artifacts),
            level,
            now(),
        ),
    )
    new_id = int(cur.lastrowid)
    if args.supersedes:
        conn.execute(
            "UPDATE facts SET superseded_by = ? WHERE id = ? AND id != ? AND challenge = ?",
            (new_id, args.supersedes, new_id, ch),
        )
    record(
        conn,
        level,
        {
            "challenge": ch,
            "id": new_id,
            "title": args.title,
            "content": args.content,
            "evidence": args.evidence,
            "artifacts": artifacts,
            "supersedes": args.supersedes,
            "quotes": quotes,
            "quote_missing": quote_miss,
        },
    )
    conn.commit()
    if level == "fact":
        print(
            f"f{new_id} 已记录（{ch}，证据 {', '.join(artifacts)}）："
            f"{short(args.title, 120)}{quote_note}"
        )
    else:
        reason = "无工具证据" if not artifacts else "证据相关性校验未通过"
        print(
            f"f{new_id} 已记录为观察（{ch}，{reason}，不应当作结论传给下一步）："
            f"{short(args.title, 120)}{quote_note}"
        )
    return 0


def cmd_deadend(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    artifacts = parse_artifacts(args)
    code = verify_artifacts(artifacts)
    if code != 0:
        return code
    quotes = parse_quotes(args)
    if quotes:
        if not artifacts:
            print(
                "deadend --quote 需要配合 --artifact（死路必须是实测排除，不能只凭推测）",
                file=sys.stderr,
            )
            return 2
        missed = missing_quotes(artifacts, quotes)
        if missed:
            print(
                "deadend --quote 未在证据中命中："
                + " / ".join(short(q, 60) for q in missed)
                + "；拒写（死路必须有实测证据支持）",
                file=sys.stderr,
            )
            return 2
    cur = conn.execute(
        "INSERT INTO deadends (challenge, reason, tested, observed, artifacts, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (ch, args.reason, args.tested, args.observed, json.dumps(artifacts), now()),
    )
    new_id = int(cur.lastrowid)
    record(
        conn,
        "deadend",
        {
            "challenge": ch,
            "id": new_id,
            "reason": args.reason,
            "tested": args.tested,
            "observed": args.observed,
            "artifacts": artifacts,
            "quotes": quotes,
        },
    )
    conn.commit()
    suffix = f"（证据 {', '.join(artifacts)}）" if artifacts else ""
    print(f"d{new_id} 已记录死路（{ch}）{suffix}：{short(args.reason, 120)}")
    return 0


FLAG_STATUSES = ("candidate", "submitted", "accepted", "rejected")


def cmd_flag(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    artifacts = parse_artifacts(args)
    code = verify_artifacts(artifacts)
    if code != 0:
        return code
    status = getattr(args, "status", None) or "candidate"
    if status not in FLAG_STATUSES:
        print(
            f"未知 flag 状态：{status}（可选 {' / '.join(FLAG_STATUSES)}）",
            file=sys.stderr,
        )
        return 2
    existing = conn.execute(
        "SELECT id, challenge FROM flags WHERE value = ?", (args.value,)
    ).fetchone()
    if existing:
        if str(existing["challenge"]) == ch:
            print(f"g{existing['id']} 已存在，未重复记录")
        else:
            print(
                f"g{existing['id']} 已记录在题 {existing['challenge']}，本题（{ch}）未重复写入"
            )
        return 0
    note = getattr(args, "note", None)
    try:
        cur = conn.execute(
            "INSERT INTO flags (challenge, value, source, created_at, artifacts, status, note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (ch, args.value, args.source, now(), json.dumps(artifacts), status, note),
        )
    except sqlite3.IntegrityError:
        print(f"该 flag 已存在（全局唯一），本题（{ch}）未重复写入")
        return 0
    new_id = int(cur.lastrowid)
    record(
        conn,
        "flag",
        {
            "challenge": ch,
            "id": new_id,
            "value": args.value,
            "source": args.source,
            "artifacts": artifacts,
            "status": status,
            "note": note,
        },
    )
    conn.commit()
    suffix = (
        f"（证据 {', '.join(artifacts)}）"
        if artifacts
        else "（未绑定证据；建议补 --artifact，否则无法与证据库核对）"
    )
    print(f"g{new_id} 已记录 flag（{ch}，{status}）{suffix}：{args.value}")
    return 0


def cmd_flagstatus(args: argparse.Namespace) -> int:
    """flag 验证状态机：candidate → submitted → accepted / rejected。"""
    conn = connect()
    ch = current_challenge(conn)
    status = args.set
    if status not in FLAG_STATUSES:
        print(
            f"未知 flag 状态：{status}（可选 {' / '.join(FLAG_STATUSES)}）",
            file=sys.stderr,
        )
        return 2
    row = conn.execute(
        "SELECT id, challenge, status FROM flags WHERE id = ?", (args.id,)
    ).fetchone()
    if row is None:
        print(f"没有 g{args.id}", file=sys.stderr)
        return 1
    if str(row["challenge"]) != ch:
        print(f"g{args.id} 属于题 {row['challenge']}，不是当前题（{ch}）", file=sys.stderr)
        return 1
    conn.execute(
        "UPDATE flags SET status = ?, verified_by = COALESCE(?, verified_by), "
        "note = COALESCE(?, note) WHERE id = ?",
        (status, args.verified_by, args.note, args.id),
    )
    commit_with_event(
        conn,
        "flag_status",
        {
            "challenge": ch,
            "id": args.id,
            "from": str(row["status"]),
            "to": status,
            "verified_by": args.verified_by,
            "note": args.note,
        },
    )
    print(f"g{args.id} 状态 {row['status']} → {status}（{ch}）")
    return 0


def cmd_claim(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    lane = str(args.lane).strip()
    if not lane:
        print("lane 不能为空", file=sys.stderr)
        return 2
    owner = str(args.owner or os.environ.get("MUTEKI_BOARD_OWNER") or "anon").strip()
    ttl = max(1, int(args.ttl))
    now_ts = int(time.time())
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM claims WHERE lane = ? AND challenge = ?", (lane, ch)
        ).fetchone()
        if row is not None and int(row["expires_at"]) > now_ts and str(row["owner"]) != owner:
            remaining = int(row["expires_at"]) - now_ts
            conn.rollback()
            print(
                f"lane {lane} 已被 {row['owner']} 占用，剩余 {remaining}s"
                f"（note: {row['note'] or '无'}）。等它过期或换一个 lane。",
                file=sys.stderr,
            )
            return 1
        conn.execute(
            "INSERT OR REPLACE INTO claims "
            "(challenge, lane, owner, note, ttl_seconds, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (ch, lane, owner, args.note, ttl, now(), now_ts + ttl),
        )
        conn.commit()
    except sqlite3.Error as exc:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        print(f"认领失败：{exc}", file=sys.stderr)
        return 2
    print(f"lane {lane} 已归 {owner}（{ch}），{ttl}s 后过期（note: {args.note or '无'}）")
    return 0


def cmd_release(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    lane = str(args.lane).strip()
    owner = str(args.owner or os.environ.get("MUTEKI_BOARD_OWNER") or "anon").strip()
    row = conn.execute(
        "SELECT * FROM claims WHERE lane = ? AND challenge = ?", (lane, ch)
    ).fetchone()
    if row is None:
        print(f"当前题（{ch}）没有 lane {lane} 的占用记录")
        return 0
    if str(row["owner"]) != owner and int(row["expires_at"]) > int(time.time()):
        print(
            f"lane {lane} 属于 {row['owner']}，不是 {owner}；未释放",
            file=sys.stderr,
        )
        return 1
    conn.execute("DELETE FROM claims WHERE lane = ? AND challenge = ?", (lane, ch))
    conn.commit()
    print(f"lane {lane} 已释放（{ch}）")
    return 0


def cmd_lanes(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    now_ts = int(time.time())
    rows = conn.execute(
        "SELECT * FROM claims WHERE challenge = ? ORDER BY lane", (ch,)
    ).fetchall()
    print(f"# 资源 lane（{ch}）")
    if not rows:
        print("（空：当前题没有认领）")
        return 0
    for row in rows:
        remaining = int(row["expires_at"]) - now_ts
        state = "已过期" if remaining <= 0 else f"剩余 {remaining}s"
        print(
            f"- {row['lane']}  owner={row['owner']}  {state}  "
            f"note={row['note'] or '无'}"
        )
    return 0


def cmd_artifact(args: argparse.Namespace) -> int:
    action = getattr(args, "artifact_action", "list")
    index = load_artifact_index()
    if action == "show":
        aid = str(args.id).strip()
        entry = index.get(aid)
        if entry is None:
            print(f"没有证据 {aid}（索引：{artifact_index_path()}）", file=sys.stderr)
            return 1
        file = Path(str(entry.get("file") or ""))
        if file.exists():
            print(file.read_text(encoding="utf-8", errors="replace"))
        else:
            print(json.dumps(entry, ensure_ascii=False, indent=2))
        return 0
    items = list(index.values())
    items.sort(key=lambda item: str(item.get("ts") or ""), reverse=True)
    limit = max(1, int(getattr(args, "limit", 20)))
    print(f"# 证据（最近 {min(limit, len(items))} / {len(items)}，索引 {artifact_index_path()}）")
    for item in items[:limit]:
        flag = "OK " if item.get("ok") else "ERR"
        extra = " [truncated]" if item.get("truncated") else ""
        print(
            f"- {item.get('id')}  {flag} {item.get('tool')}  "
            f"{short(item.get('preview'), 160)}{extra}"
        )
    if not items:
        print("（空：muteki-core 插件还没捕获到工具执行）")
    return 0


def cmd_context(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    all_flag = bool(getattr(args, "all", False))
    cond, params = _scope(conn, all_flag)
    flags = conn.execute(f"SELECT * FROM flags WHERE 1=1{cond} ORDER BY id", params).fetchall()
    facts = conn.execute(
        f"SELECT * FROM facts WHERE level='fact' AND superseded_by IS NULL{cond} "
        "ORDER BY id DESC LIMIT ?",
        params + [args.facts],
    ).fetchall()
    observations = conn.execute(
        f"SELECT * FROM facts WHERE level='observation' AND superseded_by IS NULL{cond} "
        "ORDER BY id DESC LIMIT ?",
        params + [args.facts],
    ).fetchall()
    superseded = conn.execute(
        f"SELECT id, superseded_by FROM facts WHERE superseded_by IS NOT NULL{cond} "
        "ORDER BY id DESC LIMIT 5",
        params,
    ).fetchall()
    deadends = conn.execute(
        f"SELECT * FROM deadends WHERE 1=1{cond} ORDER BY id DESC LIMIT ?",
        params + [args.deadends],
    ).fetchall()
    now_ts = int(time.time())
    claims = conn.execute(
        f"SELECT * FROM claims WHERE expires_at > ?{cond} ORDER BY lane",
        [now_ts] + params,
    ).fetchall()
    tasks = conn.execute(
        f"SELECT * FROM tasks WHERE status IN ('open','claimed'){cond} "
        "ORDER BY priority DESC, id ASC",
        params,
    ).fetchall()
    reviews = conn.execute(
        f"SELECT * FROM reviews WHERE status='open'{cond} ORDER BY id", params
    ).fetchall()

    if getattr(args, "json", False):
        print(
            json.dumps(
                {
                    "db": str(db_path()),
                    "challenge": ch,
                    "all_challenges": all_flag,
                    "artifacts": str(artifact_index_path()),
                    "flags": [dict(row) for row in flags],
                    "claims": [dict(row) for row in claims],
                    "facts": [dict(row) for row in facts],
                    "observations": [dict(row) for row in observations],
                    "superseded": [dict(row) for row in superseded],
                    "deadends": [dict(row) for row in deadends],
                    "tasks": [dict(row) for row in tasks],
                    "reviews": [dict(row) for row in reviews],
                },
                ensure_ascii=False,
            )
        )
        return 0

    scope_note = "全部题" if all_flag else f"当前题 {ch}"
    print(f"# Muteki 黑板 · {scope_note} · {db_path()}")
    print()
    print(f"证据库：{artifact_index_path()}")
    print()
    if flags:
        print("## 已获得的 flag / 候选")
        for row in flags:
            data = dict(row)
            arts = json.loads(data.get("artifacts") or "[]")
            status = data.get("status") or "candidate"
            print(
                f"- g{row['id']} [{status}] `{row['value']}`  "
                f"({row['source'] or '未注明来源'}, {row['created_at']}, 题 {row['challenge']})"
            )
            print(f"  证据：{', '.join(arts) if arts else '（未绑定，建议补 --artifact）'}")
            if data.get("verified_by"):
                print(f"  判定依据：{short(data['verified_by'], 200)}")
            if data.get("note"):
                print(f"  备注：{short(data['note'], 200)}")
        print()
    if claims:
        print("## 进行中的认领（别碰别人的 lane）")
        for row in claims:
            print(
                f"- {row['lane']}  归 {row['owner']}，剩余 {int(row['expires_at']) - now_ts}s，"
                f"note: {row['note'] or '无'}"
            )
        print()
    if tasks:
        print("## 任务队列（open/claimed，下一步可派单）")
        for row in tasks:
            owner = f"  归 {row['owner']}" if row["owner"] else ""
            print(
                f"- t{row['id']} [{row['status']}] p{row['priority']} "
                f"{row['title']}{owner}"
            )
            if row["detail"]:
                print(f"  {short(row['detail'], 240)}")
        print()
    if reviews:
        print("## 待处理复核意见（Reviewer）")
        for row in reviews:
            target = f" → {row['target']}" if row["target"] else ""
            print(f"- r{row['id']} [{row['kind']}]{target} {short(row['note'], 240)}")
        print()
    if facts:
        print("## 已证实的事实（带工具证据，新→旧）")
        for row in reversed(facts):
            arts = json.loads(row["artifacts"] or "[]")
            print(f"- f{row['id']} {row['title']}  证据：{', '.join(arts) or '（无）'}")
            print(f"  {short(row['content'])}")
            if row["evidence"]:
                print(f"  依据：{short(row['evidence'], 200)}")
        print()
    else:
        print("## 已证实的事实\n（空：当前题还没有带工具证据的结论）\n")
    if observations:
        print("## 未证实观察（不要当成结论传给下一步）")
        for row in reversed(observations):
            print(f"- f{row['id']} {row['title']}")
            print(f"  {short(row['content'])}")
        print()
    if superseded:
        print("## 已被推翻的旧结论")
        for row in superseded:
            print(f"- f{row['id']} → 被 f{row['superseded_by']} 取代")
        print()
    if deadends:
        print("## 已排除的方向（新→旧）")
        for row in reversed(deadends):
            arts = json.loads(row["artifacts"] or "[]")
            suffix = f"  证据：{', '.join(arts)}" if arts else ""
            print(f"- d{row['id']} {row['reason']}{suffix}")
            if row["tested"]:
                print(f"  测了什么：{short(row['tested'], 200)}")
            if row["observed"]:
                print(f"  实际看到：{short(row['observed'], 200)}")
        print()
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    all_flag = bool(getattr(args, "all", False))
    cond, params = _scope(conn, all_flag)
    like = f"%{args.query}%"
    print(f"# 检索结果（{'全部题' if all_flag else ch}）")
    for table, prefix, fields in (
        ("facts", "f", ("title", "content", "evidence")),
        ("deadends", "d", ("reason", "tested", "observed")),
        ("flags", "g", ("value", "source")),
        ("tasks", "t", ("title", "detail")),
        ("reviews", "r", ("kind", "target", "note")),
    ):
        clause = " OR ".join(f"{field} LIKE ?" for field in fields)
        rows = conn.execute(
            f"SELECT id, {', '.join(fields)} FROM {table} "
            f"WHERE ({clause}){cond} ORDER BY id DESC LIMIT 20",
            [like] * len(fields) + params,
        ).fetchall()
        for row in rows:
            values = [row[field] or "" for field in fields]
            print(f"- {prefix}{row['id']} {short(' | '.join(values), 220)}")
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    conn = connect()
    raw = str(args.id).strip()
    if raw.lower().startswith("a"):
        return cmd_artifact(
            argparse.Namespace(artifact_action="show", id=raw, limit=20)
        )
    prefix = raw[0].lower() if raw[:1].isalpha() else "f"
    number = raw[1:] if raw[:1].isalpha() else raw
    if not number.isdigit():
        print(f"无法解析 id：{args.id}", file=sys.stderr)
        return 2
    if prefix == "f":
        row = conn.execute("SELECT * FROM facts WHERE id = ?", (int(number),)).fetchone()
    elif prefix == "d":
        row = conn.execute("SELECT * FROM deadends WHERE id = ?", (int(number),)).fetchone()
    elif prefix == "g":
        row = conn.execute("SELECT * FROM flags WHERE id = ?", (int(number),)).fetchone()
    elif prefix == "r":
        row = conn.execute("SELECT * FROM reviews WHERE id = ?", (int(number),)).fetchone()
    elif prefix == "t":
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (int(number),)).fetchone()
    else:
        print(f"未知前缀：{prefix}", file=sys.stderr)
        return 2
    if row is None:
        print(f"没有 {args.id}")
        return 1
    for key in row.keys():
        print(f"{key}: {row[key]}")
    return 0


def cmd_task(args: argparse.Namespace) -> int:
    """意图队列：open → claimed → done/dropped。claim 用单条 UPDATE 原子抢占。"""
    conn = connect()
    ch = current_challenge(conn)
    all_flag = bool(getattr(args, "all", False))
    cond, params = _scope(conn, all_flag)
    action = args.task_action
    if action == "add":
        owner = args.owner or os.environ.get("MUTEKI_BOARD_OWNER") or None
        priority = max(1, min(3, args.priority))
        cur = conn.execute(
            "INSERT INTO tasks (challenge, title, detail, status, owner, priority, created_at, updated_at) "
            "VALUES (?, ?, ?, 'open', ?, ?, ?, ?)",
            (ch, args.title, args.detail, owner, priority, now(), now()),
        )
        tid = cur.lastrowid
        commit_with_event(
            conn,
            "task_added",
            {"challenge": ch, "id": tid, "title": args.title, "priority": priority},
        )
        print(f"已加入任务队列（{ch}）：t{tid} {args.title}")
        return 0
    if action == "list":
        if args.status == "all":
            rows = conn.execute(
                f"SELECT * FROM tasks WHERE 1=1{cond} ORDER BY priority DESC, id ASC",
                params,
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM tasks WHERE status=?{cond} ORDER BY priority DESC, id ASC",
                [args.status] + params,
            ).fetchall()
        if args.json:
            print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
            return 0
        if not rows:
            print(f"（没有 {args.status} 任务，题 {ch}）")
            return 0
        for row in rows:
            owner = f"  归 {row['owner']}" if row["owner"] else ""
            print(f"- t{row['id']} [{row['status']}] p{row['priority']} {row['title']}{owner}")
            if row["detail"]:
                print(f"  {short(row['detail'], 240)}")
        return 0
    if action == "claim":
        owner = args.owner or os.environ.get("MUTEKI_BOARD_OWNER") or "anon"
        cur = conn.execute(
            "UPDATE tasks SET status='claimed', owner=?, updated_at=? "
            "WHERE id=? AND status='open' AND challenge=?",
            (owner, now(), args.id, ch),
        )
        if cur.rowcount == 0:
            row = conn.execute(
                "SELECT status, owner, challenge FROM tasks WHERE id=?", (args.id,)
            ).fetchone()
            if row is None:
                print(f"没有任务 t{args.id}", file=sys.stderr)
            elif str(row["challenge"]) != ch:
                print(
                    f"t{args.id} 属于题 {row['challenge']}，不是当前题（{ch}）",
                    file=sys.stderr,
                )
            else:
                print(
                    f"t{args.id} 已被 {row['owner'] or '别人'} 认领（{row['status']}）",
                    file=sys.stderr,
                )
            return 1
        commit_with_event(conn, "task_claimed", {"challenge": ch, "id": args.id, "owner": owner})
        print(f"已认领 t{args.id}（{ch}，{owner}）")
        return 0
    if action == "reopen":
        cur = conn.execute(
            "UPDATE tasks SET status='open', owner=NULL, updated_at=? "
            "WHERE id=? AND status='claimed' AND challenge=?",
            (now(), args.id, ch),
        )
        if cur.rowcount == 0:
            print(f"t{args.id} 不存在、不属于当前题或不是 claimed", file=sys.stderr)
            return 1
        commit_with_event(conn, "task_reopened", {"challenge": ch, "id": args.id})
        print(f"t{args.id} → open（{ch}，已释放认领）")
        return 0
    if action == "reclaim":
        minutes = max(1, int(args.minutes))
        cutoff = (datetime.now().astimezone() - timedelta(minutes=minutes)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        rows = conn.execute(
            "SELECT id, owner FROM tasks WHERE status='claimed' AND challenge=? AND updated_at < ?",
            (ch, cutoff),
        ).fetchall()
        released = []
        for row in rows:
            conn.execute(
                "UPDATE tasks SET status='open', owner=NULL, updated_at=? WHERE id=?",
                (now(), row["id"]),
            )
            released.append(f"t{row['id']}（原 owner={row['owner'] or '?'}）")
        if not released:
            print(f"（没有超过 {minutes} 分钟仍未完成的 claimed 任务，题 {ch}）")
            return 0
        commit_with_event(conn, "task_reclaimed", {"challenge": ch, "ids": [r["id"] for r in rows]})
        print(f"已释放回 open（题 {ch}，{len(released)} 条）：" + "、".join(released))
        return 0
    if action in ("done", "drop"):
        status = "done" if action == "done" else "dropped"
        cur = conn.execute(
            "UPDATE tasks SET status=?, updated_at=? "
            "WHERE id=? AND challenge=? AND status IN ('open','claimed')",
            (status, now(), args.id, ch),
        )
        if cur.rowcount == 0:
            print(f"t{args.id} 不存在、不属于当前题或已收尾", file=sys.stderr)
            return 1
        commit_with_event(conn, f"task_{status}", {"challenge": ch, "id": args.id})
        print(f"t{args.id} → {status}（{ch}）")
        return 0
    print(f"未知 task 操作：{action}", file=sys.stderr)
    return 2


def cmd_review(args: argparse.Namespace) -> int:
    """Reviewer 意见：challenge（质疑无证据）/ merge（重复）/ gap（缺口）。"""
    conn = connect()
    ch = current_challenge(conn)
    all_flag = bool(getattr(args, "all", False))
    cond, params = _scope(conn, all_flag)
    action = args.review_action
    if action == "add":
        cur = conn.execute(
            "INSERT INTO reviews (challenge, kind, target, note, status, created_at) "
            "VALUES (?, ?, ?, ?, 'open', ?)",
            (ch, args.kind, args.target, args.note, now()),
        )
        rid = cur.lastrowid
        commit_with_event(
            conn,
            "review_added",
            {"challenge": ch, "id": rid, "kind": args.kind, "target": args.target},
        )
        target = f" → {args.target}" if args.target else ""
        print(f"r{rid} 已记录复核意见（{ch}，{args.kind}{target}）")
        return 0
    if action == "list":
        if args.status == "all":
            rows = conn.execute(
                f"SELECT * FROM reviews WHERE 1=1{cond} ORDER BY id", params
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM reviews WHERE status=?{cond} ORDER BY id",
                [args.status] + params,
            ).fetchall()
        if args.json:
            print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
            return 0
        if not rows:
            print(f"（没有 {args.status} 复核意见，题 {ch}）")
            return 0
        for row in rows:
            target = f" → {row['target']}" if row["target"] else ""
            print(
                f"- r{row['id']} [{row['kind']}] {row['status']}{target} "
                f"{short(row['note'], 220)}"
            )
        return 0
    if action == "resolve":
        cur = conn.execute(
            "UPDATE reviews SET status='resolved' WHERE id=? AND status='open' AND challenge=?",
            (args.id, ch),
        )
        if cur.rowcount == 0:
            print(f"r{args.id} 不存在、不属于当前题或已关闭", file=sys.stderr)
            return 1
        commit_with_event(conn, "review_resolved", {"challenge": ch, "id": args.id})
        print(f"r{args.id} 已关闭")
        return 0
    print(f"未知 review 操作：{action}", file=sys.stderr)
    return 2


def cmd_stats(args: argparse.Namespace) -> int:
    conn = connect()
    ch = current_challenge(conn)
    all_flag = bool(getattr(args, "all", False))
    cond, params = _scope(conn, all_flag)

    def count(sql: str) -> int:
        return int(conn.execute(sql, params).fetchone()["c"])

    facts = count(f"SELECT COUNT(*) c FROM facts WHERE 1=1{cond}")
    obs = count(f"SELECT COUNT(*) c FROM facts WHERE level='observation'{cond}")
    deadends = count(f"SELECT COUNT(*) c FROM deadends WHERE 1=1{cond}")
    flags = count(f"SELECT COUNT(*) c FROM flags WHERE 1=1{cond}")
    events = int(conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"])
    claims = count(
        f"SELECT COUNT(*) c FROM claims WHERE expires_at > {int(time.time())}{cond}"
    )
    artifacts = len(load_artifact_index())
    tasks = count(f"SELECT COUNT(*) c FROM tasks WHERE 1=1{cond}")
    open_tasks = count(f"SELECT COUNT(*) c FROM tasks WHERE status IN ('open','claimed'){cond}")
    open_reviews = count(f"SELECT COUNT(*) c FROM reviews WHERE status='open'{cond}")
    scope_note = "全部题" if all_flag else f"题 {ch}"
    print(
        f"黑板 {db_path()}（{scope_note}）\n"
        f"事实 {facts}（其中观察 {obs}）· 死路 {deadends} · flag {flags} · "
        f"事件 {events} · 活跃认领 {claims} · 证据 {artifacts} · "
        f"任务 {tasks}（进行中 {open_tasks}）· 复核 {open_reviews}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="board.py", description="Muteki 作战黑板（按题隔离）")
    parser.add_argument(
        "--version",
        action="version",
        version=f"muteki-board {__version__}",
        help="打印黑板脚本版本（用于核对本机装的是哪个 release）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("use", help="切换当前题（旧题数据保留但默认不可见）")
    p.add_argument("name")
    p.set_defaults(func=cmd_use)

    p = sub.add_parser("current", help="打印当前题名")
    p.set_defaults(func=cmd_current)

    p = sub.add_parser("context", help="打印当前黑板摘要")
    p.add_argument("--facts", type=int, default=12)
    p.add_argument("--deadends", type=int, default=12)
    p.add_argument("--json", action="store_true", help="输出结构化 JSON（供插件消费）")
    p.add_argument("--all", action="store_true", help="跨全部题查看")
    p.set_defaults(func=cmd_context)

    p = sub.add_parser("task", help="任务队列（意图）：add/list/claim/done/drop")
    task_sub = p.add_subparsers(dest="task_action", required=True)
    q = task_sub.add_parser("add", help="加入一个待办任务")
    q.add_argument("title")
    q.add_argument("--detail", default=None)
    q.add_argument("--priority", type=int, default=2, help="1 低 / 2 中 / 3 高")
    q.add_argument("--owner", default=None)
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("list", help="列出任务")
    q.add_argument(
        "--status",
        default="open",
        choices=("open", "claimed", "done", "dropped", "all"),
    )
    q.add_argument("--json", action="store_true")
    q.add_argument("--all", action="store_true", help="跨全部题查看")
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("claim", help="原子认领一个 open 任务")
    q.add_argument("id", type=int)
    q.add_argument("--owner", default=None)
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("done", help="把任务标记完成")
    q.add_argument("id", type=int)
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("drop", help="放弃任务")
    q.add_argument("id", type=int)
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("reopen", help="把中断后卡在 claimed 的任务释放回 open")
    q.add_argument("id", type=int)
    q.set_defaults(func=cmd_task)
    q = task_sub.add_parser("reclaim", help="批量释放超时未完成的 claimed 任务")
    q.add_argument("--minutes", type=int, default=30, help="超过多少分钟视为卡住（默认 30）")
    q.set_defaults(func=cmd_task)

    p = sub.add_parser("review", help="复核意见：add/list/resolve")
    review_sub = p.add_subparsers(dest="review_action", required=True)
    q = review_sub.add_parser("add", help="记录一条复核意见")
    q.add_argument(
        "--kind",
        default="challenge",
        choices=("challenge", "merge", "gap"),
        help="challenge=质疑无证据 / merge=重复 / gap=验证缺口",
    )
    q.add_argument("--target", default=None, help="相关记录 id，如 f3 / d2")
    q.add_argument("--note", required=True)
    q.set_defaults(func=cmd_review)
    q = review_sub.add_parser("list", help="列出复核意见")
    q.add_argument("--status", default="open", choices=("open", "resolved", "all"))
    q.add_argument("--json", action="store_true")
    q.add_argument("--all", action="store_true", help="跨全部题查看")
    q.set_defaults(func=cmd_review)
    q = review_sub.add_parser("resolve", help="关闭一条复核意见")
    q.add_argument("id", type=int)
    q.set_defaults(func=cmd_review)

    p = sub.add_parser("fact", help="记录一条事实（无 --artifact 时记为观察）")
    p.add_argument("title")
    p.add_argument("content")
    p.add_argument("--evidence", default=None, help="文字依据（可选）")
    p.add_argument("--artifact", action="append", default=[], help="证据 id，可重复")
    p.add_argument(
        "--quote",
        action="append",
        default=[],
        help="可选相关性校验：必须出现在所引证据里的原文片段，可重复；未命中则降级为观察",
    )
    p.add_argument("--supersedes", type=int, default=None)
    p.set_defaults(func=cmd_fact)

    p = sub.add_parser("deadend", help="记录一条被实测排除的方向")
    p.add_argument("reason")
    p.add_argument("--tested", default=None)
    p.add_argument("--observed", default=None)
    p.add_argument("--artifact", action="append", default=[])
    p.add_argument(
        "--quote",
        action="append",
        default=[],
        help="可选相关性校验：必须出现在所引证据里的原文片段；未命中则拒写（exit 2）",
    )
    p.set_defaults(func=cmd_deadend)

    p = sub.add_parser("flag", help="记录 flag（可绑证据、可设状态）")
    p.add_argument("value")
    p.add_argument("--source", default=None)
    p.add_argument("--artifact", action="append", default=[], help="证据 id，可重复")
    p.add_argument("--status", default="candidate", choices=FLAG_STATUSES)
    p.add_argument("--note", default=None, help="判定链 / 备注（如「与公开 writeup 同值但已实时取证」）")
    p.set_defaults(func=cmd_flag)

    p = sub.add_parser("flagstatus", help="改 flag 验证状态：candidate/submitted/accepted/rejected")
    p.add_argument("id", type=int)
    p.add_argument("--set", required=True, choices=FLAG_STATUSES, dest="set")
    p.add_argument("--verified-by", default=None, dest="verified_by", help="判定依据（平台回显 / 复核人）")
    p.add_argument("--note", default=None)
    p.set_defaults(func=cmd_flagstatus)

    p = sub.add_parser("claim", help="认领一个资源 lane")
    p.add_argument("lane")
    p.add_argument("--ttl", type=int, default=600, help="占用秒数，默认 600")
    p.add_argument("--owner", default=None, help="认领者（默认 MUTEKI_BOARD_OWNER 或 anon）")
    p.add_argument("--note", default=None)
    p.set_defaults(func=cmd_claim)

    p = sub.add_parser("release", help="释放一个资源 lane")
    p.add_argument("lane")
    p.add_argument("--owner", default=None)
    p.set_defaults(func=cmd_release)

    p = sub.add_parser("lanes", help="列出资源认领")
    p.set_defaults(func=cmd_lanes)

    p = sub.add_parser("artifact", help="查看 muteki-core 捕获的工具证据")
    p.add_argument("artifact_action", choices=("list", "show"), nargs="?", default="list")
    p.add_argument("id", nargs="?", default="")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_artifact)

    p = sub.add_parser("search", help="关键词检索黑板（fact/deadend/flag/task/review）")
    p.add_argument("query")
    p.add_argument("--all", action="store_true", help="跨全部题查看")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("read", help="读取一条记录，如 f3 / d2 / g1 / r1 / t2 / a1x2")
    p.add_argument("id")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("stats", help="统计计数")
    p.add_argument("--all", action="store_true", help="跨全部题统计")
    p.set_defaults(func=cmd_stats)
    return parser


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = build_parser().parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
