"""install.ps1 的安装冒烟测试（A5：占位符统一与替换完整性）。

需要 PowerShell 7（pwsh）；找不到时自动 skip，不影响其余测试。

运行：
    python -m unittest discover -s tests -v

验证点：
- 安装后 SKILL.md 与 cordis.patch.yml 里**不残留任何 {{占位符}}**；
- 自定义 -StorageDir 时，preset 的 storageDir 与 muteki-core 的 artifactDir 一致；
- board.py / 两个插件 / SKILL.md 都被复制到正确位置；
- 重复安装检测生效（不加 -Force 时第二次应失败）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_PS1 = REPO_ROOT / "install.ps1"
PWSH = shutil.which("pwsh")


@unittest.skipUnless(PWSH, "需要 PowerShell 7（pwsh）")
class TestInstallSmoke(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="muteki-install-")
        self.home = Path(self._tmp.name)
        (self.home / "profiles" / "desktop").mkdir(parents=True)
        (self.home / "profiles" / "desktop" / "cordis.patch.yml").write_text("[]\n", encoding="utf-8")
        self.storage = self.home / "artifacts"
        self.generated = REPO_ROOT / "preset-muteki.generated.yml"

    def tearDown(self) -> None:
        # install.ps1 会在仓库根生成片段文件（已 gitignore），测试后清掉
        if self.generated.exists():
            self.generated.unlink()
        self._tmp.cleanup()

    def install(self, *extra: str, expect: int = 0) -> subprocess.CompletedProcess:
        cmd = [
            PWSH, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(INSTALL_PS1),
            "-DshHome", str(self.home), "-Profile", "desktop",
            "-Python", "python", "-StorageDir", str(self.storage),
            "-ConfigDir", str(self.home / "cfg"),  # 不写真实用户目录
            "-Apply", *extra,
        ]
        proc = subprocess.run(
            cmd, cwd=str(REPO_ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if expect is not None:
            self.assertEqual(
                proc.returncode, expect,
                msg=f"install.ps1 rc={proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}",
            )
        return proc

    def test_no_placeholder_left_and_paths_consistent(self) -> None:
        self.install()
        skill = (self.home / "skills" / "muteki-board" / "SKILL.md").read_text(encoding="utf-8")
        patch = (self.home / "profiles" / "desktop" / "cordis.patch.yml").read_text(encoding="utf-8")
        self.assertNotIn("{{", skill)
        self.assertNotIn("{{", patch)
        self.assertIn(str(self.storage), skill)
        self.assertIn(f"storageDir: '{self.storage}'", patch)
        self.assertIn(f"artifactDir: '{self.storage}'", patch)
        self.assertIn("id: preset-muteki", patch)
        self.assertIn("id: muteki-core", patch)

    def test_files_copied(self) -> None:
        self.install()
        for rel in (
            "skills/muteki-board/board.py",
            "skills/muteki-board/SKILL.md",
            "profiles/desktop/muteki-orchestrator.mjs",
            "profiles/desktop/muteki-core.mjs",
        ):
            self.assertTrue((self.home / rel).is_file(), msg=rel)

    def test_second_install_without_force_fails(self) -> None:
        self.install()
        proc = self.install(expect=None)
        self.assertNotEqual(proc.returncode, 0)
        combined = proc.stdout + proc.stderr
        self.assertTrue("preset-muteki" in combined or "Force" in combined)

    def test_backup_created_on_apply(self) -> None:
        self.install()
        backups = list((self.home / "profiles" / "desktop").glob("cordis.patch.yml.bak-*"))
        self.assertEqual(len(backups), 1)

    def test_market_preset_blocks_manual_install(self) -> None:
        """market 已装 muteki-preset 时手动安装应拒绝（insert id 会重复）。"""
        pkg_path = self.home / "profiles" / "desktop" / "package.json"
        pkg_path.write_text(json.dumps({
            "dependencies": {"muteki-preset": "github:liaty8/dsh-muteki-preset#path:/plugins/muteki-preset"},
            "dsh": {"profile": {"bundles": ["muteki-preset"]}},
        }), encoding="utf-8")
        proc = self.install(expect=None)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("muteki-preset", proc.stdout + proc.stderr)
        # 拒绝时不应落任何文件
        self.assertFalse((self.home / "skills" / "muteki-board" / "board.py").exists())

    def test_market_workbench_skips_local_copy(self) -> None:
        """market 已装工作台（非 file: 依赖）时跳过 [2b/4]，不覆盖成本地拷贝。"""
        profile = self.home / "profiles" / "desktop"
        pkg_path = profile / "package.json"
        original = {
            "dependencies": {"muteki-workbench": "github:liaty8/dsh-muteki-preset#path:/plugins/muteki-workbench"},
            "dsh": {"profile": {"bundles": ["muteki-workbench"]}},
        }
        pkg_path.write_text(json.dumps(original), encoding="utf-8")
        proc = self.install()
        self.assertIn("market", proc.stdout)
        self.assertFalse((profile / "muteki-workbench-pkg").exists(), "不应落本地工作台拷贝")
        self.assertEqual(json.loads(pkg_path.read_text(encoding="utf-8")), original, "market 的依赖声明不应被改写")

    def test_config_written_and_installed_board_resolves_custom_storage(self) -> None:
        """A3 端到端：自定义 -StorageDir 安装后，装好的 board.py 不靠环境变量也能找到证据。"""
        cfgdir = self.home / "cfg"
        self.install()
        cfg_path = cfgdir / "config.json"
        self.assertTrue(cfg_path.is_file())
        self.assertFalse(cfg_path.read_bytes().startswith(b"\xef\xbb\xbf"), msg="config.json 不应带 BOM")
        cfg = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(cfg["storage_dir"], str(self.storage))
        pkg = json.loads(
            (REPO_ROOT / "plugins" / "dsh-muteki-orchestrator" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(cfg["version"], pkg["version"])

        # 在自定义证据目录里放一条合成证据
        aid = "acfg00001-abcdef"
        art_dir = self.storage / "artifacts"
        art_dir.mkdir(parents=True, exist_ok=True)
        art_file = art_dir / f"{aid}.json"
        art_file.write_text(
            json.dumps({"id": aid, "tool": "pwsh", "ok": True, "content": "synthetic"}), encoding="utf-8"
        )
        (self.storage / "index.jsonl").write_text(
            json.dumps({"id": aid, "tool": "pwsh", "ok": True, "file": str(art_file)}) + "\n", encoding="utf-8"
        )

        work = self.home / "work"
        work.mkdir()
        env = {
            **os.environ,
            "MUTEKI_CONFIG": str(cfg_path),
            "MUTEKI_BOARD_DB": str(work / "board.db"),
            "PYTHONIOENCODING": "utf-8",
        }
        env.pop("MUTEKI_ARTIFACT_DIR", None)  # 关键：不靠环境变量
        installed = self.home / "skills" / "muteki-board" / "board.py"
        proc = subprocess.run(
            [sys.executable, str(installed), "fact", "入口", "可复用入口", "--artifact", aid],
            cwd=str(work), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        self.assertIn("已记录", proc.stdout)
        self.assertNotIn("观察", proc.stdout)  # 必须是 fact，而不是退化成 observation


if __name__ == "__main__":
    unittest.main()