/**
 * muteki-bootstrap 回归测试（node:test）。
 * 运行：DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_bootstrap.mjs
 *
 * bootstrap 读 homedir() 与 $DSH_HOME，测试用子进程重定向 USERPROFILE/HOME/DSH_HOME
 * 到临时目录，绝不触碰真实用户目录。找不到 DSH 依赖时全部 skip。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import { findNodeModules, SKIP_REASON } from "./orchestrator_harness.mjs";

const NODE_MODULES = findNodeModules();
const PKG = fileURLToPath(new URL("../plugins/muteki-preset/", import.meta.url));

/** 搭一个临时 profile：package 副本 + node_modules junction + 假 HOME/DSH_HOME。 */
function setup() {
  const root = join(tmpdir(), `muteki-boot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pkgDir = join(root, "pkg");
  const home = join(root, "home");
  const dsh = join(root, "dsh");
  mkdirSync(join(pkgDir, "assets"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const f of ["bootstrap.mjs", "package.json"]) copyFileSync(join(PKG, f), join(pkgDir, f));
  for (const f of ["board.py", "SKILL.md"]) copyFileSync(join(PKG, "assets", f), join(pkgDir, "assets", f));
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "junction");
  return { root, pkgDir, home, dsh };
}

function runApply(s, config = { enabled: true }) {
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(join(s.pkgDir, "bootstrap.mjs")).href)});
    const logs = [];
    mod.apply({ logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(["WARN", ...a]) } }, ${JSON.stringify(config)});
    console.log(JSON.stringify(logs));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, USERPROFILE: s.home, HOME: s.home, DSH_HOME: s.dsh },
  });
  assert.equal(run.status, 0, `bootstrap 子进程失败：${run.stderr}`);
  return JSON.parse(run.stdout.trim());
}

function cleanup(s) {
  try { unlinkSync(join(s.root, "node_modules")); } catch { /* junction */ }
  rmSync(s.root, { recursive: true, force: true });
}

const skillDir = (s) => join(s.dsh, "skills", "muteki-board");
const configFile = (s) => join(s.home, ".dsh-muteki", "config.json");

test("bootstrap: 全新环境铺设技能 + config.json（占位符回填默认路径）", { skip: SKIP_REASON }, () => {
  const s = setup();
  try {
    runApply(s);
    const boardPy = join(skillDir(s), "board.py");
    const skillMd = join(skillDir(s), "SKILL.md");
    assert.ok(existsSync(boardPy), "board.py 应被铺设");
    assert.equal(readFileSync(boardPy, "utf8"), readFileSync(join(PKG, "assets", "board.py"), "utf8"));
    const text = readFileSync(skillMd, "utf8");
    assert.ok(!text.includes("{{PYTHON}}") && !text.includes("{{BOARD_PY}}") && !text.includes("{{STORAGE_DIR}}"), "占位符应全部回填");
    assert.ok(text.includes(boardPy), "SKILL.md 应含本机 board.py 路径");
    assert.ok(text.includes(join(s.home, ".dsh-muteki", "artifacts")), "SKILL.md 应含默认证据目录");
    const cfg = JSON.parse(readFileSync(configFile(s), "utf8"));
    assert.equal(cfg.python, "python");
    assert.equal(cfg.board_py, boardPy);
    assert.equal(cfg.storage_dir, join(s.home, ".dsh-muteki", "artifacts"));
    assert.ok(cfg.version, "config.json 应带版本");
    assert.ok(existsSync(join(skillDir(s), ".muteki-preset-version")), "版本戳应存在");
  } finally {
    cleanup(s);
  }
});

test("bootstrap: 同版本重复启动不重写（用户改过的 SKILL.md 保留）", { skip: SKIP_REASON }, () => {
  const s = setup();
  try {
    runApply(s);
    const skillMd = join(skillDir(s), "SKILL.md");
    writeFileSync(skillMd, readFileSync(skillMd, "utf8") + "\n<!-- 用户手工备注 -->\n", "utf8");
    runApply(s);
    assert.ok(readFileSync(skillMd, "utf8").includes("用户手工备注"), "同版本内手工修改不应被冲掉");
  } finally {
    cleanup(s);
  }
});

test("bootstrap: 已有 config.json 不覆盖，SKILL.md 按其路径回填", { skip: SKIP_REASON }, () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, ".dsh-muteki"), { recursive: true });
    const custom = { python: "py3", board_py: join(s.home, "custom", "board.py"), storage_dir: join(s.home, "custom-storage") };
    writeFileSync(configFile(s), JSON.stringify(custom), "utf8");
    runApply(s);
    assert.deepEqual(JSON.parse(readFileSync(configFile(s), "utf8")), custom, "已有配置一律不覆盖");
    const text = readFileSync(join(skillDir(s), "SKILL.md"), "utf8");
    assert.ok(text.includes("py3 "), "SKILL.md 应用 config 的 python");
    assert.ok(text.includes(custom.board_py), "SKILL.md 应用 config 的 board_py");
    assert.ok(text.includes(custom.storage_dir), "SKILL.md 应用 config 的 storage_dir");
  } finally {
    cleanup(s);
  }
});

test("bootstrap: 包版本升级后重新生成技能文件", { skip: SKIP_REASON }, () => {
  const s = setup();
  try {
    runApply(s);
    const stamp = join(skillDir(s), ".muteki-preset-version");
    writeFileSync(stamp, JSON.stringify({ version: "0.0.1" }), "utf8");
    const skillMd = join(skillDir(s), "SKILL.md");
    writeFileSync(skillMd, "旧版残留", "utf8");
    runApply(s);
    assert.ok(readFileSync(skillMd, "utf8").includes("Muteki 黑板"), "版本不一致应重新生成");
    assert.equal(JSON.parse(readFileSync(stamp, "utf8")).version, JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version);
  } finally {
    cleanup(s);
  }
});

test("bootstrap: enabled=false 不铺任何文件", { skip: SKIP_REASON }, () => {
  const s = setup();
  try {
    runApply(s, { enabled: false });
    assert.ok(!existsSync(skillDir(s)));
    assert.ok(!existsSync(configFile(s)));
  } finally {
    cleanup(s);
  }
});