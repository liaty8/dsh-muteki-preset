"""Muteki 安装自检：一条命令定位「预设没出现 / 加载失败 / 黑板不可用」的落盘原因。

market 与手动两条安装路径都查。只读不写（不创建目录、不改配置）。
退出码：0 = 全部通过（允许 WARN）；1 = 有 FAIL。

用法：
  python scripts/selfcheck.py
  python scripts/selfcheck.py --profile desktop --dsh-home D:\\dsh\\home --python python
"""
import argparse
import json
import os
import subprocess
import sys

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
from pathlib import Path

RESULTS = []


def report(level, msg):
    RESULTS.append(level)
    print(f"[{level}] {msg}")


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profile", default="desktop")
    ap.add_argument("--dsh-home", default=None)
    ap.add_argument("--python", default=None)
    args = ap.parse_args()

    home = args.dsh_home or os.environ.get("DSH_HOME")
    if not home:
        for cand in (Path.home() / "dsh" / "home", Path.home() / ".dsh"):
            if cand.is_dir():
                home = str(cand)
                break
    if not home:
        report("FAIL", "找不到 DSH home（用 --dsh-home 指定，或设 DSH_HOME 环境变量）")
        return 1
    profile = Path(home) / "profiles" / args.profile
    report("PASS" if profile.is_dir() else "FAIL", f"profile 目录：{profile}")
    if not profile.is_dir():
        return 1

    pkg = read_json(profile / "package.json") or {}
    bundles = (pkg.get("dsh") or {}).get("profile", {}).get("bundles") or []
    patch_path = profile / "cordis.patch.yml"
    patch = patch_path.read_text(encoding="utf-8-sig") if patch_path.exists() else ""
    market_preset = "muteki-preset" in bundles
    manual_preset = "id: preset-muteki" in patch

    # ── 预设本体（二选一）──────────────────────────────────────────────
    if market_preset:
        report("PASS", "安装路径：market（bundles 含 muteki-preset）")
        pkg_dir = profile / "node_modules" / "muteki-preset"
        for f in ("package.json", "bootstrap.mjs", "orchestrator.mjs", "core.mjs", "cordis.patch.yml"):
            ok = (pkg_dir / f).is_file()
            report("PASS" if ok else "FAIL", f"bundle 文件 node_modules/muteki-preset/{f}")
        if manual_preset:
            report("FAIL", "cordis.patch.yml 里还有手动追加的 preset-muteki 段 → insert id 重复，删掉手动段")
    elif manual_preset:
        report("PASS", "安装路径：手动（cordis.patch.yml 含 preset-muteki）")
        if "id: muteki-core" not in patch:
            report("FAIL", "patch 缺 muteki-core insert（证据捕获没挂载，fact 会全退化成 observation）")
        for f in ("muteki-orchestrator.mjs", "muteki-core.mjs"):
            ok = (profile / f).is_file()
            report("PASS" if ok else "FAIL", f"profile 根插件 {f}")
    else:
        report("FAIL", "预设本体未安装：market 装 muteki-preset，或跑 install.ps1 -Apply")

    # ── 工作台（可选）─────────────────────────────────────────────────
    if "muteki-workbench" in bundles:
        report("PASS", "工作台：bundles 含 muteki-workbench")
    else:
        report("WARN", "工作台未安装（可选）：market 装 muteki-workbench，或 install.ps1 [2b/4]")

    # ── 黑板技能 ──────────────────────────────────────────────────────
    skill_dir = Path(home) / "skills" / "muteki-board"
    for f in ("board.py", "SKILL.md"):
        ok = (skill_dir / f).is_file()
        report("PASS" if ok else "FAIL", f"黑板技能 {skill_dir / f}")
    skill_md = skill_dir / "SKILL.md"
    if skill_md.is_file():
        text = skill_md.read_text(encoding="utf-8-sig")
        if "{{" in text:
            report("FAIL", "SKILL.md 仍含 {{...}} 占位符（安装未完成路径回填）")
        else:
            report("PASS", "SKILL.md 占位符已回填")

    # ── 安装配置 ──────────────────────────────────────────────────────
    cfg_path = Path.home() / ".dsh-muteki" / "config.json"
    cfg = read_json(cfg_path)
    if cfg is None:
        report("FAIL", f"config.json 缺失或损坏：{cfg_path}（market 路径首启自动创建；手动跑 install.ps1）")
        cfg = {}
    else:
        report("PASS", f"config.json 可解析：{cfg_path}")
    board_py = cfg.get("board_py") or str(skill_dir / "board.py")
    report("PASS" if Path(board_py).is_file() else "FAIL", f"config.board_py 指向的脚本存在：{board_py}")
    storage = cfg.get("storage_dir")
    if storage:
        report("PASS" if Path(storage).is_dir() else "WARN", f"证据目录：{storage}" + ("" if Path(storage).is_dir() else "（尚不存在，首次派单/捕获时创建）"))

    # ── Python 与 board.py 实跑 ───────────────────────────────────────
    python = args.python or cfg.get("python") or "python"
    try:
        ver = subprocess.run([python, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, creationflags=CREATE_NO_WINDOW)
        ok = ver.returncode == 0
        report("PASS" if ok else "FAIL", f"python 可用：{python} → {(ver.stdout or ver.stderr).strip()}")
    except Exception as e:
        report("FAIL", f"python 不可用：{python}（{e}）；改 config.json 的 python 字段")
        ok = False
    if ok and Path(board_py).is_file():
        try:
            run = subprocess.run([python, board_py, "--help"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=CREATE_NO_WINDOW)
            report("PASS" if run.returncode == 0 else "FAIL", f"board.py --help 退出码={run.returncode}")
        except Exception as e:
            report("FAIL", f"board.py 跑不起来：{e}")

    print()
    fails = RESULTS.count("FAIL")
    warns = RESULTS.count("WARN")
    print(f"自检完成：FAIL={fails} WARN={warns}。" + ("落盘全部就位；预设不出现时完整重启 DSH Desktop（只新开会话不够）。" if fails == 0 else "先修上面的 FAIL 再重启 DSH。"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())