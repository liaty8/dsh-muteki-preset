/**
 * muteki-bootstrap —— market 安装路径的首启铺设（root scope，随 bundle 挂载）。
 *
 * market 安装 bundle 只做「加依赖 + 进 bundles 白名单」，不会跑 install.ps1，
 * 所以预设依赖的外置文件由本插件在 DSH 启动时自动补齐：
 *
 *   1. $DSH_HOME/skills/muteki-board/{board.py,SKILL.md}
 *      —— 黑板脚本 + 技能文档（SKILL.md 里的 {{PYTHON}}/{{BOARD_PY}}/{{STORAGE_DIR}}
 *         按本机 config.json 回填；宿主 skill-filesystem 正好发现 $DSH_HOME/skills）。
 *   2. ~/.dsh-muteki/config.json —— 仅在缺失时创建（python/board_py/storage_dir），
 *      已存在一律不覆盖：手动安装或用户改过的配置优先。
 *
 * 幂等与克制：
 *   - skillDir 里放 .muteki-preset-version 戳；版本一致且文件齐全就跳过重写，
 *     用户在同一版本内对 SKILL.md 的手工修改不会被每次启动冲掉；包升级才重新生成。
 *   - 绝不触碰 board.db、artifacts/、settings.json、flags.jsonl 等运行时数据。
 *   - 任何失败只 warn 不抛错——铺设失败不应拖垮整个 profile 启动。
 *
 * 手动安装（install.ps1）不经过本插件；两条路径铺出的文件布局一致。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

export const name = "muteki-bootstrap";

export const Config = z.object({
  enabled: z.boolean().default(true),
});

/** 与宿主 resolveDshHome 同序：$DSH_HOME（非空白）> ~/.dsh。 */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "") return resolve(env.trim());
  return join(homedir(), ".dsh");
}

function readJsonSafe(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v : "");

export function apply(ctx, config) {
  if (!config.enabled) return;
  try {
    const pkg = readJsonSafe(fileURLToPath(new URL("./package.json", import.meta.url)));
    const version = str(pkg.version) || "0.0.0";
    const skillDir = join(dshHome(), "skills", "muteki-board");
    const configDir = join(homedir(), ".dsh-muteki");
    const configFile = join(configDir, "config.json");
    const cfg = readJsonSafe(configFile);

    const python = str(cfg.python) || "python";
    const storageDir = str(cfg.storage_dir) || join(configDir, "artifacts");
    const boardPy = str(cfg.board_py) || join(skillDir, "board.py");

    // 版本戳一致且文件齐全 → 不重写（尊重同版本内的手工修改）
    const stampFile = join(skillDir, ".muteki-preset-version");
    const stampOk = existsSync(stampFile) && str(readJsonSafe(stampFile).version) === version
      && existsSync(join(skillDir, "board.py")) && existsSync(join(skillDir, "SKILL.md"));
    if (!stampOk) {
      mkdirSync(skillDir, { recursive: true });
      copyFileSync(fileURLToPath(new URL("./assets/board.py", import.meta.url)), join(skillDir, "board.py"));
      const skill = readFileSync(fileURLToPath(new URL("./assets/SKILL.md", import.meta.url)), "utf8")
        .replaceAll("{{PYTHON}}", python)
        .replaceAll("{{BOARD_PY}}", boardPy)
        .replaceAll("{{STORAGE_DIR}}", storageDir);
      writeFileSync(join(skillDir, "SKILL.md"), skill, "utf8");
      writeFileSync(stampFile, JSON.stringify({ version }, null, 2) + "\n", "utf8");
      ctx.logger?.info?.("muteki-bootstrap: 黑板技能已铺设到 %s（version=%s）", skillDir, version);
    }

    if (!existsSync(configFile)) {
      mkdirSync(configDir, { recursive: true });
      const fresh = {
        python,
        board_py: join(skillDir, "board.py"),
        storage_dir: storageDir,
        config_dir: configDir,
        version,
      };
      writeFileSync(configFile, JSON.stringify(fresh, null, 2) + "\n", "utf8");
      ctx.logger?.info?.("muteki-bootstrap: 安装配置已写入 %s", configFile);
    }
  } catch (err) {
    try { ctx.logger?.warn?.("muteki-bootstrap: 铺设失败（不影响启动）：%s", String(err)); } catch { /* 日志也不许抛 */ }
  }
}

export default { name, Config, apply };