"""同步 muteki-preset bundle：从 canonical 源复制文件 + 生成 cordis.patch.yml。

bundle 里的 orchestrator.mjs / core.mjs / assets 与手动安装路径共用同一份源文件，
preset patch 从 preset/preset-muteki.patch.yml 变换生成（插件名改包导出、去掉
安装期占位符路径行——market 路径由插件运行时读 ~/.dsh-muteki/config.json 解析）。

用法：
  python scripts/sync_bundle.py          # 重新生成
  python scripts/sync_bundle.py --check  # 只校验漂移（CI/测试用），不写盘
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "plugins" / "muteki-preset"

COPIES = [
    (ROOT / "plugins" / "dsh-muteki-orchestrator" / "plugin-v13.mjs", PKG / "orchestrator.mjs"),
    (ROOT / "plugins" / "muteki-core" / "muteki-core.mjs", PKG / "core.mjs"),
    (ROOT / "board" / "board.py", PKG / "assets" / "board.py"),
    (ROOT / "board" / "SKILL.md", PKG / "assets" / "SKILL.md"),
]

# 安装期占位符路径行：market 路径改由 resolvePaths()/configuredStorageDir() 运行时解析
DROP_PREFIXES = (
    "python: '{{PYTHON}}'",
    "boardPy: '{{BOARD_PY}}'",
    "storageDir: '{{STORAGE_DIR}}'",
    "claudeBin: '{{CLAUDE_BIN}}'",
    "claudeConfigDir: '{{CLAUDE_CONFIG_DIR}}'",
)

HEADER = """\
# 由 scripts/sync_bundle.py 从 preset/preset-muteki.patch.yml 生成 —— 勿手改。
# market 安装路径：与 install.ps1 -Apply 追加的 patch 段等效；
# python/boardPy/storageDir 不在此写死，由插件运行时读 ~/.dsh-muteki/config.json 解析。
- insert:
    - id: muteki-bootstrap
      name: muteki-preset
      config:
        enabled: true
"""

CORE_TAIL = """\
    - id: muteki-core
      name: muteki-preset/core
      config:
        maxPayloadBytes: 2097152
        enabled: true
"""


def render_patch(template: str) -> str:
    lines = template.splitlines()
    if lines[0].strip() != "- insert:":
        raise ValueError("preset 模板必须以 '- insert:' 开头")
    body = []
    for line in lines[1:]:
        stripped = line.strip()
        if stripped.startswith(DROP_PREFIXES):
            continue
        if stripped == "name: ./muteki-orchestrator.mjs":
            line = line.replace("name: ./muteki-orchestrator.mjs", "name: muteki-preset/orchestrator")
        body.append(line)
    while body and body[-1].strip() == "":
        body.pop()
    return HEADER + "\n".join(body) + "\n" + CORE_TAIL


def main(check: bool) -> int:
    drift = []
    for src, dst in COPIES:
        want = src.read_bytes()
        have = dst.read_bytes() if dst.exists() else None
        if have != want:
            drift.append(str(dst.relative_to(ROOT)))
            if not check:
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(want)
    patch_dst = PKG / "cordis.patch.yml"
    want_patch = render_patch((ROOT / "preset" / "preset-muteki.patch.yml").read_text(encoding="utf-8"))
    have_patch = patch_dst.read_text(encoding="utf-8") if patch_dst.exists() else None
    if have_patch != want_patch:
        drift.append(str(patch_dst.relative_to(ROOT)))
        if not check:
            patch_dst.write_text(want_patch, encoding="utf-8", newline="\n")
    if check:
        if drift:
            print("bundle 与 canonical 源漂移：" + ", ".join(drift))
            print("运行 python scripts/sync_bundle.py 重新生成")
            return 1
        print("bundle 同步校验通过")
        return 0
    print("已同步：" + (", ".join(drift) if drift else "无变化"))
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))