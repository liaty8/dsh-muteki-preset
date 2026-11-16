#!/usr/bin/env python3
"""发布前敏感信息门禁（stdlib only）。

用途：在 commit / push / 发 release 之前，扫描仓库内容里是否混入了敏感信息。

**分级策略**（按「他人能否利用 / 是否个人信息 / 是否涉及金钱」判定）：

- `block`（阻断发布，rc=1）：可被他人直接利用的凭据与身份数据 ——
  token / API key / 密码 / cookie 字面值、私钥、JWT、webhook 回连地址（可读写他人数据）、
  长 base64 密钥串、个人邮箱。
- `warn`（只提示，rc=0）：不可利用的技术痕迹 ——
  本机目录路径、题名与端口、证据 id、会话 UUID、已解题目的 flag 值、公开靶机 IP、
  sha256 摘要、通用机器用户名。这些泄露后他人无法据此访问任何系统，也不涉及个人身份与金钱。

加 `--strict` 可把 warn 也当作阻断（需要最高卫生标准时用）。

用法：
    python scripts/check_sensitive.py              # 扫描全部 git 已跟踪文件
    python scripts/check_sensitive.py --staged     # 只扫描已 staged 的文件（取索引内容）
    python scripts/check_sensitive.py --strict     # warn 也阻断
    python scripts/check_sensitive.py --json       # 机器可读输出（CI 用）
    python scripts/check_sensitive.py --paths a.md b.py

本地补充黑名单（**不会被提交**，已在 .gitignore 中）：
    scripts/sensitive.local.txt
    每行一个字面量；行首加 `!` 表示 block，否则为 warn。
    例如：`!abc123xy`（某回连 token 前缀，可利用 → 阻断）
          `web-99999`（题名，不可利用 → 提示）

退出码：0 = 无 block（可能有 warn）；1 = 发现 block；2 = 用法/环境错误。

设计原则：对**可利用**的东西 fail closed；对不可利用的技术痕迹只提示，
避免门禁因为噪声太大而被关掉。误报可用 ALLOWLIST 精确豁免（只豁免合成示例）。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_DENYLIST = REPO_ROOT / "scripts" / "sensitive.local.txt"

# 只豁免「明显是合成示例」的值，真实凭据一律不豁免。
ALLOWLIST = {
    "ipv4": {"127.0.0.1", "0.0.0.0", "255.255.255.255", "1.2.3.4", "10.0.0.5"},
    "flag-value": {"flag{test}", "flag{example}", "flag{...}", "flag{REDACTED}"},
    # 文档里的合成证据 id 示例（真实 id 属 warn，不阻断）
    "artifact-id": {"a1x2y3z4-8f2a", "atest0001-000000"},
    "email": {
        "example.com",
        "example.org",
        "users.noreply.github.com",
    },
}

BLOCK = "block"
WARN = "warn"

RULES: list[tuple[str, str, str, str]] = [
    # (规则名, 正则, 说明, 分级)
    ("drive-path", r"\b[A-Za-z]:[\\/][^\s'\"`)\],;]*", "本机绝对路径（盘符）", WARN),
    ("unix-home", r"/(?:[cC]/Users|Users|home)/[A-Za-z0-9_.-]+", "本机用户目录路径", WARN),
    ("ipv4", r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "IPv4 地址（公开靶机不可利用；内网/凭据另判）", WARN),
    ("flag-value", r"\b[A-Za-z0-9_]{2,20}\{[^}\s]{4,}\}", "flag / 类似凭据的值", WARN),
    ("uuid", r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "UUID（本地会话 id，不可远程利用）", WARN),
    ("artifact-id", r"\ba[a-z0-9]{7,9}-[0-9a-f]{4,8}\b", "muteki-core 证据 id（本地标识）", WARN),
    ("hex-secret", r"\b[0-9a-fA-F]{32,}\b", "长 hex（多为 sha256 摘要）", WARN),
    ("machine-user", r"\bAdministrator\b", "通用机器用户名", WARN),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "JWT（可直接用于鉴权）", BLOCK),
    ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "私钥", BLOCK),
    ("webhook", r"webhook\.site/[0-9a-fA-F-]{8,}", "webhook 回连地址（他人可读写其中数据）", BLOCK),
    ("base64-secret", r"\b[A-Za-z0-9+/]{40,}={0,2}\b", "长 base64 串（可能是密钥）", BLOCK),
    ("token-prefix", r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|xoxb|xoxp|AKIA|AIza)[A-Za-z0-9_-]{16,}", "已知 token 前缀（涉及账号与金钱）", BLOCK),
    ("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "个人邮箱", BLOCK),
    (
        "credential-assign",
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|authorization|set-cookie|cookie)\b\s*[:=]\s*['\"]?([A-Za-z0-9_./+=-]{8,})",
        "凭据字段的字面值",
        BLOCK,
    ),
]

COMPILED = [(name, re.compile(pattern), desc, sev) for name, pattern, desc, sev in RULES]

# 这些形态是占位符 / 环境变量名，不是真实凭据
PLACEHOLDER = re.compile(r"^(?:\{\{.*\}\}|<.*>|\$\{?\w+\}?|[A-Z][A-Z0-9_]{3,}|None|null|true|false)$")

BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".tgz", ".exe", ".dll", ".woff", ".woff2"}


def git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=str(REPO_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{proc.stderr.strip()}")
    return proc.stdout


def tracked_files() -> list[str]:
    return [p for p in git("ls-files", "-z").split("\0") if p]


def staged_files() -> list[str]:
    return [p for p in git("diff", "--cached", "--name-only", "-z").split("\0") if p]


def read_text(rel: str, staged: bool) -> str | None:
    path = REPO_ROOT / rel
    if Path(rel).suffix.lower() in BINARY_SUFFIXES:
        return None
    if staged:
        proc = subprocess.run(["git", "show", f":{rel}"], cwd=str(REPO_ROOT), capture_output=True)
        if proc.returncode != 0:
            return None
        raw = proc.stdout
    else:
        if not path.is_file():
            return None
        raw = path.read_bytes()
    if b"\0" in raw[:8192]:
        return None
    return raw.decode("utf-8", errors="replace")


def load_local_denylist() -> list[tuple[str, str]]:
    """返回 [(字面量, 分级)]；行首 `!` 表示 block，否则 warn。"""
    if not LOCAL_DENYLIST.is_file():
        return []
    items: list[tuple[str, str]] = []
    for line in LOCAL_DENYLIST.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!"):
            items.append((line[1:].strip(), BLOCK))
        else:
            items.append((line, WARN))
    return items


def mask(value: str) -> str:
    """输出到终端/CI 日志时不回显完整敏感值。"""
    if len(value) <= 6:
        return value[:2] + "***"
    return value[:3] + "***" + value[-2:] + f"(len={len(value)})"


def allowed(rule: str, value: str) -> bool:
    if rule == "email":
        return value.split("@")[-1].lower() in ALLOWLIST["email"]
    if rule in ALLOWLIST and value in ALLOWLIST[rule]:
        return True
    if rule in {"credential-assign", "hex-secret", "base64-secret", "token-prefix"} and PLACEHOLDER.match(value):
        return True
    return False


def looks_like_flag(value: str) -> bool:
    """区分真实 flag 与代码里的 f-string 占位符（如 NULL{cond} / task_{status}）。"""
    start, end = value.find("{"), value.rfind("}")
    if start < 0 or end <= start:
        return False
    inner = value[start + 1 : end]
    return bool(re.search(r"[_0-9@!$%]", inner)) or len(inner) >= 12


def scan_text(rel: str, text: str, denylist: list | None = None) -> list[dict]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule, regex, desc, sev in COMPILED:
            for match in regex.finditer(line):
                value = match.group(1) if rule == "credential-assign" else match.group(0)
                if allowed(rule, value):
                    continue
                if rule == "flag-value" and not looks_like_flag(value):
                    continue
                findings.append(
                    {"file": rel, "line": lineno, "rule": rule, "desc": desc,
                     "severity": sev, "value": mask(value)}
                )
        for item in denylist or []:
            literal, sev = item if isinstance(item, tuple) else (item, WARN)
            if literal and literal in line:
                findings.append(
                    {"file": rel, "line": lineno, "rule": "local-denylist",
                     "desc": "本地黑名单字面量", "severity": sev, "value": mask(literal)}
                )
    return findings


def has_block(findings: list[dict], strict: bool = False) -> bool:
    return any(f["severity"] == BLOCK or (strict and f["severity"] == WARN) for f in findings)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="发布前敏感信息门禁（block/warn 分级）")
    parser.add_argument("--staged", action="store_true", help="只扫描已 staged 的文件（取索引内容）")
    parser.add_argument("--paths", nargs="*", help="只扫描指定文件（相对仓库根）")
    parser.add_argument("--strict", action="store_true", help="warn 也阻断")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args()

    try:
        if args.paths:
            files = list(args.paths)
        elif args.staged:
            files = staged_files()
        else:
            files = tracked_files()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    denylist = load_local_denylist()
    findings: list[dict] = []
    scanned = 0
    for rel in files:
        text = read_text(rel, staged=args.staged and not args.paths)
        if text is None:
            continue
        scanned += 1
        findings.extend(scan_text(rel, text, denylist))

    blocks = [f for f in findings if f["severity"] == BLOCK]
    warns = [f for f in findings if f["severity"] == WARN]
    failed = has_block(findings, strict=args.strict)

    if args.json:
        print(json.dumps(
            {"scanned": scanned, "strict": args.strict, "blocked": failed,
             "block_count": len(blocks), "warn_count": len(warns), "findings": findings},
            ensure_ascii=False, indent=2))
    else:
        mode = "staged" if args.staged else "tracked"
        print(f"扫描 {scanned} 个文件（{mode}），本地黑名单 {len(denylist)} 条，strict={args.strict}")
        if blocks:
            print(f"\n[BLOCK] {len(blocks)} 处可利用凭据 / 个人信息，必须处理：")
            for item in blocks:
                print(f"  {item['file']}:{item['line']}  [{item['rule']}] {item['desc']}  → {item['value']}")
        if warns:
            print(f"\n[WARN] {len(warns)} 处不可利用的技术痕迹（不阻断，建议改占位符）：")
            for item in warns:
                print(f"  {item['file']}:{item['line']}  [{item['rule']}] {item['desc']}  → {item['value']}")
        if not findings:
            print("干净：未发现敏感信息。")
        elif not failed:
            print("\n结论：只有 warn，无 block → 允许发布（rc=0）。")
        else:
            print("\n结论：存在 block → 阻止发布（rc=1）。改成占位符或合成示例后重跑。")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())