#!/usr/bin/env python3
"""发布前敏感信息门禁（stdlib only）。

用途：在 commit / push / 发 release 之前，扫描仓库内容里是否混入了本机路径、
真实目标 IP、flag 值、会话/证据 id、token、cookie、邮箱等敏感信息。

用法：
    python scripts/check_sensitive.py              # 扫描全部 git 已跟踪文件
    python scripts/check_sensitive.py --staged     # 只扫描已 staged 的文件（取索引内容）
    python scripts/check_sensitive.py --json       # 机器可读输出（CI 用）
    python scripts/check_sensitive.py --paths a.md b.py

本地补充黑名单（**不会被提交**，已在 .gitignore 中）：
    scripts/sensitive.local.txt
    每行一个字面量字符串，例如你自己的靶机 IP、题名、机器用户名、webhook token。
    门禁会把这些字面量当作禁止出现的内容扫描。

退出码：0 = 干净；1 = 发现敏感信息；2 = 用法/环境错误。

设计原则：**fail closed**。宁可误报让人工确认，也不要漏报把真实作战数据推上公开仓库。
误报可用 ALLOWLIST 精确豁免（只豁免合成示例，不豁免真实值）。
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

# 只豁免「明显是合成示例」的值，真实值一律不豁免。
ALLOWLIST = {
    "ipv4": {"127.0.0.1", "0.0.0.0", "255.255.255.255", "1.2.3.4", "10.0.0.5"},
    "flag-value": {"flag{test}", "flag{example}", "flag{...}", "flag{REDACTED}"},
    # 文档里的合成证据 id 示例（真实 id 一律不豁免）
    "artifact-id": {"a1x2y3z4-8f2a", "atest0001-000000"},
    "email": {
        "example.com",
        "example.org",
        "users.noreply.github.com",
    },
}

RULES: list[tuple[str, str, str]] = [
    # (规则名, 正则, 说明)
    ("drive-path", r"\b[A-Za-z]:[\\/][^\s'\"`)\],;]*", "本机绝对路径（盘符）"),
    ("unix-home", r"/(?:[cC]/Users|Users|home)/[A-Za-z0-9_.-]+", "本机用户目录路径"),
    ("ipv4", r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "IPv4 地址（可能是真实靶机）"),
    ("flag-value", r"\b[A-Za-z0-9_]{2,20}\{[^}\s]{4,}\}", "flag / 类似凭据的值"),
    ("uuid", r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "UUID（会话 id / webhook token）"),
    ("artifact-id", r"\ba[a-z0-9]{7,9}-[0-9a-f]{4,8}\b", "muteki-core 证据 id"),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "JWT"),
    ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "私钥"),
    ("webhook", r"webhook\.site/[0-9a-fA-F-]{8,}", "webhook.site 回连地址"),
    ("hex-secret", r"\b[0-9a-fA-F]{32,}\b", "长 hex（哈希 / token）"),
    ("base64-secret", r"\b[A-Za-z0-9+/]{40,}={0,2}\b", "长 base64 串"),
    ("token-prefix", r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|xoxb|xoxp|AKIA|AIza)[A-Za-z0-9_-]{16,}", "已知 token 前缀"),
    ("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "邮箱地址"),
    ("machine-user", r"\bAdministrator\b", "本机机器用户名"),
    (
        "credential-assign",
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|authorization|set-cookie|cookie)\b\s*[:=]\s*['\"]?([A-Za-z0-9_./+=-]{8,})",
        "凭据字段的字面值",
    ),
]

COMPILED = [(name, re.compile(pattern), desc) for name, pattern, desc in RULES]

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
    out = git("ls-files", "-z")
    return [p for p in out.split("\0") if p]


def staged_files() -> list[str]:
    out = git("diff", "--cached", "--name-only", "-z")
    return [p for p in out.split("\0") if p]


def read_text(rel: str, staged: bool) -> str | None:
    path = REPO_ROOT / rel
    if Path(rel).suffix.lower() in BINARY_SUFFIXES:
        return None
    if staged:
        proc = subprocess.run(
            ["git", "show", f":{rel}"], cwd=str(REPO_ROOT), capture_output=True
        )
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


def load_local_denylist() -> list[str]:
    if not LOCAL_DENYLIST.is_file():
        return []
    items = []
    for line in LOCAL_DENYLIST.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            items.append(line)
    return items


def mask(value: str) -> str:
    """输出到终端/CI 日志时不回显完整敏感值。"""
    if len(value) <= 6:
        return value[:2] + "***"
    return value[:3] + "***" + value[-2:] + f"(len={len(value)})"


def allowed(rule: str, value: str) -> bool:
    if rule == "email":
        domain = value.split("@")[-1].lower()
        return domain in ALLOWLIST["email"]
    if rule in ALLOWLIST and value in ALLOWLIST[rule]:
        return True
    if rule == "credential-assign" and PLACEHOLDER.match(value):
        return True
    if rule in {"hex-secret", "base64-secret", "token-prefix"} and PLACEHOLDER.match(value):
        return True
    return False


def looks_like_flag(value: str) -> bool:
    """区分真实 flag 与代码里的 f-string 占位符（如 NULL{cond} / task_{status}）。

    真实 flag 的内容几乎总含下划线/数字/符号，或长度较长；
    单个短标识符（cond、status、ch）视为代码占位符，不报。
    """
    start, end = value.find("{"), value.rfind("}")
    if start < 0 or end <= start:
        return False
    inner = value[start + 1 : end]
    return bool(re.search(r"[_0-9@!$%]", inner)) or len(inner) >= 12


def scan_text(rel: str, text: str, denylist: list[str]) -> list[dict]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule, regex, desc in COMPILED:
            for match in regex.finditer(line):
                value = match.group(1) if rule == "credential-assign" else match.group(0)
                if allowed(rule, value):
                    continue
                if rule == "flag-value" and not looks_like_flag(value):
                    continue
                findings.append(
                    {"file": rel, "line": lineno, "rule": rule, "desc": desc, "value": mask(value)}
                )
        for literal in denylist:
            if literal in line:
                findings.append(
                    {
                        "file": rel,
                        "line": lineno,
                        "rule": "local-denylist",
                        "desc": "本地黑名单字面量",
                        "value": mask(literal),
                    }
                )
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="发布前敏感信息门禁")
    parser.add_argument("--staged", action="store_true", help="只扫描已 staged 的文件（取索引内容）")
    parser.add_argument("--paths", nargs="*", help="只扫描指定文件（相对仓库根）")
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

    if args.json:
        print(json.dumps({"scanned": scanned, "findings": findings}, ensure_ascii=False, indent=2))
    else:
        print(f"扫描 {scanned} 个文件（{'staged' if args.staged else 'tracked'}），本地黑名单 {len(denylist)} 条")
        if findings:
            print(f"发现 {len(findings)} 处疑似敏感信息：\n")
            for item in findings:
                print(f"  {item['file']}:{item['line']}  [{item['rule']}] {item['desc']}  → {item['value']}")
            print("\n处理办法：改成占位符（<你的路径> / 合成示例），或确认是误报后加入 ALLOWLIST。")
            print("真实值一律不要豁免；本机专属字面量写进 scripts/sensitive.local.txt（不会被提交）。")
        else:
            print("干净：未发现敏感信息。")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())