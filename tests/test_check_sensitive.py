"""scripts/check_sensitive.py 的门禁回归测试（stdlib unittest）。

运行：
    python -m unittest discover -s tests -v

覆盖两类要求：
1. 真实敏感信息必须被拦下（本机路径 / 靶机 IP / flag / 证据 id / 会话 UUID / token / 邮箱）；
2. 合成示例与代码占位符不得误报（否则门禁会被绕过或被迫关掉）。

注意：本文件里的「敏感样本」全部是**合成值**，并且用字符串拼接构造，
使源码中不出现完整的敏感字面量——否则门禁扫描仓库时会把测试文件自己拦下，
也避免把任何真实作战数据写进公开仓库。
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_sensitive.py"

_spec = importlib.util.spec_from_file_location("check_sensitive", SCRIPT)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def rules_hit(text: str, denylist: list[str] | None = None) -> set[str]:
    findings = gate.scan_text("sample.md", text, denylist or [])
    return {item["rule"] for item in findings}


class TestMustCatch(unittest.TestCase):
    def test_windows_drive_path(self) -> None:
        self.assertIn("drive-path", rules_hit("把库放在 D:" + "\\some\\where\\board.db"))

    def test_unix_home_path(self) -> None:
        self.assertIn("unix-home", rules_hit("path: /c/Users/" + "someone/project"))

    def test_real_target_ip(self) -> None:
        # TEST-NET-3 文档地址段，非任何真实资产
        self.assertIn("ipv4", rules_hit("目标 203.0.113" + ".77:8080"))

    def test_real_flag_value(self) -> None:
        self.assertIn("flag-value", rules_hit("拿到 ctf{th1s_1s_" + "4_synt3tic_t3st}"))

    def test_real_artifact_id(self) -> None:
        self.assertIn("artifact-id", rules_hit("证据 atest9999" + "-abcdef 支持该结论"))

    def test_session_uuid(self) -> None:
        self.assertIn(
            "uuid",
            rules_hit("owner=session-00000000-0000-" + "0000-0000-000000000000"),
        )

    def test_github_token_prefix(self) -> None:
        self.assertIn("token-prefix", rules_hit("ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"))

    def test_long_hex_digest(self) -> None:
        self.assertIn("hex-secret", rules_hit("digest=" + "ab12cd34" * 8))

    def test_real_email(self) -> None:
        self.assertIn("email", rules_hit("联系 someone.somebody" + "@mailprovider.com"))

    def test_webhook_url(self) -> None:
        self.assertIn(
            "webhook",
            rules_hit("回连 webhook.site/" + "00000000-0000-0000-" + "0000-000000000000"),
        )

    def test_credential_literal(self) -> None:
        # 用变量拼装，避免源码里出现「关键字: 字面值」的完整形态而被门禁自己拦下
        key = "api" + "Key"
        literal = "abcdefgh" + "ijkl1234567890"
        self.assertIn("credential-assign", rules_hit(f'{key}: "{literal}"'))

    def test_local_denylist_literal(self) -> None:
        self.assertIn("local-denylist", rules_hit("题名 web-99999", denylist=["web-99999"]))

    def test_machine_username(self) -> None:
        self.assertIn("machine-user", rules_hit("运行用户 Admin" + "istrator"))


class TestMustNotFalsePositive(unittest.TestCase):
    def test_doc_loopback_and_example_ip(self) -> None:
        self.assertEqual(rules_hit("本机 127.0.0.1，示例 1.2.3.4:8080"), set())

    def test_synthetic_flag_examples(self) -> None:
        self.assertEqual(rules_hit("flag{test} / flag{...} / flag{example}"), set())

    def test_fstring_placeholders(self) -> None:
        self.assertEqual(rules_hit("WHERE superseded_by IS NULL{cond}"), set())
        self.assertEqual(rules_hit('commit_with_event(conn, f"task_{status}", ...)'), set())

    def test_synthetic_artifact_id(self) -> None:
        self.assertEqual(rules_hit("例如 a1x2y3z4-8f2a（合成示例）"), set())

    def test_package_names_and_urls(self) -> None:
        text = (
            "@deepseek-ai/dsh-compaction-tool-result-pruner 与 "
            "https://github.com/liaty8/dsh-muteki-preset/releases/tag/v1.0.13"
        )
        self.assertEqual(rules_hit(text), set())

    def test_long_python_identifiers(self) -> None:
        self.assertEqual(rules_hit("def test_every_record_has_an_event(self):"), set())

    def test_placeholder_credentials(self) -> None:
        self.assertEqual(rules_hit("apiKeyEnv: DEEPSEEK_API_KEY"), set())
        self.assertEqual(rules_hit("token: {{STORAGE_DIR}}"), set())

    def test_noreply_email(self) -> None:
        self.assertEqual(rules_hit("user@users.noreply.github.com"), set())

    def test_clean_prose(self) -> None:
        self.assertEqual(rules_hit("黑板按题隔离，事实必须带证据，死路必须记账。"), set())


class TestMasking(unittest.TestCase):
    def test_mask_does_not_echo_full_value(self) -> None:
        secret = "ctf{th1s_1s_" + "4_synt3tic_t3st}"
        masked = gate.mask(secret)
        self.assertNotIn(secret, masked)
        self.assertIn("***", masked)


class TestSeverity(unittest.TestCase):
    """S2：分级策略——可利用凭据/个人信息/金钱相关 → block；不可利用技术痕迹 → warn。"""

    def test_rule_severity_mapping(self) -> None:
        sev = {name: s for name, _, _, s in gate.RULES}
        for rule in ("credential-assign", "token-prefix", "private-key", "jwt", "webhook", "base64-secret", "email"):
            self.assertEqual(sev[rule], gate.BLOCK, msg=rule)
        for rule in ("drive-path", "unix-home", "ipv4", "flag-value", "uuid", "artifact-id", "hex-secret", "machine-user"):
            self.assertEqual(sev[rule], gate.WARN, msg=rule)

    def test_warn_only_does_not_block(self) -> None:
        findings = gate.scan_text("x.md", "路径 D:" + "\\some\\where 与目标 203.0.113" + ".77", [])
        self.assertTrue(findings)
        self.assertFalse(gate.has_block(findings))
        self.assertTrue(gate.has_block(findings, strict=True))

    def test_credential_blocks(self) -> None:
        key = "api" + "Key"
        literal = "abcdefgh" + "ijkl1234567890"
        findings = gate.scan_text("x.md", f'{key}: "{literal}"', [])
        self.assertTrue(gate.has_block(findings))

    def test_email_blocks_but_noreply_allowed(self) -> None:
        findings = gate.scan_text("x.md", "联系 someone.somebody" + "@mailprovider.com", [])
        self.assertTrue(gate.has_block(findings))
        self.assertEqual(gate.scan_text("x.md", "user@users.noreply.github.com", []), [])

    def test_denylist_bang_prefix_is_block(self) -> None:
        blocked = gate.scan_text("x.md", "前缀 abc123xy 出现", [("abc123xy", gate.BLOCK)])
        self.assertTrue(gate.has_block(blocked))
        warned = gate.scan_text("x.md", "题名 web-99999", [("web-99999", gate.WARN)])
        self.assertFalse(gate.has_block(warned))

    def test_plain_string_denylist_defaults_to_warn(self) -> None:
        findings = gate.scan_text("x.md", "题名 web-99999", ["web-99999"])
        self.assertEqual(findings[0]["severity"], gate.WARN)

    def test_clean_text_has_no_findings(self) -> None:
        self.assertEqual(gate.scan_text("x.md", "黑板按题隔离，事实必须带证据。", []), [])


if __name__ == "__main__":
    unittest.main()