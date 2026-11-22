"""muteki-preset bundle 与 canonical 源的一致性测试（unittest）。

bundle 的 orchestrator/core/assets/patch 全部由 scripts/sync_bundle.py 生成，
这里守住「不许手改 bundle 造成两条安装路径漂移」的纪律。
"""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "plugins" / "muteki-preset"

spec = importlib.util.spec_from_file_location("sync_bundle", ROOT / "scripts" / "sync_bundle.py")
sync_bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync_bundle)


class TestBundleSync(unittest.TestCase):
    def test_no_drift(self):
        self.assertEqual(sync_bundle.main(check=True), 0, "bundle 与 canonical 源漂移，运行 python scripts/sync_bundle.py")

    def test_exports_exist(self):
        pkg = json.loads((PKG / "package.json").read_text(encoding="utf-8"))
        for sub, rel in pkg["exports"].items():
            self.assertTrue((PKG / rel).is_file(), f"exports[{sub}] 指向的文件不存在：{rel}")
        self.assertEqual(pkg["dsh"]["bundle"]["patch"], ["./cordis.patch.yml"])

    def test_patch_shape(self):
        patch = (PKG / "cordis.patch.yml").read_text(encoding="utf-8")
        self.assertIn("name: muteki-preset/orchestrator", patch)
        self.assertIn("name: muteki-preset/core", patch)
        self.assertIn("id: muteki-bootstrap", patch)
        self.assertIn("id: preset-muteki", patch)
        self.assertNotIn("./muteki-orchestrator.mjs", patch)
        self.assertNotIn("./muteki-core.mjs", patch)
        for placeholder in ("{{PYTHON}}", "{{BOARD_PY}}", "{{STORAGE_DIR}}", "{{CLAUDE_BIN}}", "{{CLAUDE_CONFIG_DIR}}"):
            self.assertNotIn(placeholder, patch, f"bundle patch 不应含安装期占位符 {placeholder}")

    def test_persona_has_no_install_placeholders(self):
        # persona 命令行走技能引用（两条安装路径统一），不再依赖安装期路径替换
        template = (ROOT / "preset" / "preset-muteki.patch.yml").read_text(encoding="utf-8")
        persona = template.split("prefix: |", 1)[1].split("complete: false", 1)[0]
        self.assertNotIn("{{PYTHON}}", persona)
        self.assertNotIn("{{BOARD_PY}}", persona)
        self.assertIn("muteki-board", persona)


if __name__ == "__main__":
    unittest.main()