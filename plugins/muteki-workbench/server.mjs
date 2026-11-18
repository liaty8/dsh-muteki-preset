/**
 * muteki-workbench 服务端：给右侧栏工作台提供 HTTP 路由。
 *
 *   GET  /api/muteki/settings  → 当前 settings.json 覆盖层（raw）
 *   POST /api/muteki/settings  → 写覆盖层（白名单过滤；orchestrator 下一次额度判定即生效）
 *   GET  /api/muteki/ledger    → 账本快照（totals/buckets/runs/costs 计数），供工作台显示
 *
 * 覆盖层文件与 orchestrator 共用 storageDir：优先 config.storageDir，
 * 其次 ~/.dsh-muteki/config.json 的 storage_dir，最后默认 artifacts 目录。
 */
import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "muteki-workbench";

// cordis 服务必须声明 inject 才能访问；webServer 由 web 平面异步提供，
// 直接读 ctx.webServer 会拿不到（helmd 同款坑：它用 ctx.inject 等就绪）。
export const inject = ["webServer"];

export const Config = z.object({
  enabled: z.boolean().default(true),
  storageDir: z.string().default("").comment("省略则读 ~/.dsh-muteki/config.json 的 storage_dir"),
});

const SETTINGS_KEYS = [
  "mode", "tier", "poolSize", "maxRunsPerHour", "burstRuns", "onQuota",
  "maxWaitMinutes", "stagnationLimit", "maxCostUsdPerHour", "maxRunsPerChallenge",
  "maxCostUsdPerChallenge", "workerUsdPerMinute", "estimateToActual", "costBasis",
  "hardCancelOnFlag", "autoOpenPane",
];

function defaultStorageDir() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".dsh-muteki", "config.json"), "utf8"));
    if (typeof cfg.storage_dir === "string" && cfg.storage_dir) return cfg.storage_dir;
  } catch {
    /* 没有 config.json 就用默认 */
  }
  return join(homedir(), ".dsh-muteki", "artifacts");
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body exceeds 8192 bytes"), { status: 413 }));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() === "" ? {} : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("body must be a JSON object"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function apply(ctx, config) {
  if (!config.enabled) return;
  const storageDir = config.storageDir || defaultStorageDir();
  mkdirSync(storageDir, { recursive: true });
  const settingsFile = join(storageDir, "settings.json");

  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    if (!webServer?.register) return; // 无 web 平面（headless）时静默不注册
    const seen = new Set();
    function route(path, handler) {
      if (seen.has(path)) return;
      seen.add(path);
      webServer.register({
        kind: "exact",
        path,
        handler: async (req, res) => {
          res.setHeader("content-type", "application/json");
          try {
            const data = await handler(req);
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, data }));
          } catch (err) {
            res.statusCode = err?.status || 500;
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
        },
      });
    }

    route("/api/muteki/settings", async (req) => {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw Object.assign(new Error("settings must be a JSON object"), { status: 400 });
        }
        const next = {};
        for (const key of SETTINGS_KEYS) {
          if (body[key] !== undefined && body[key] !== null && body[key] !== "") next[key] = body[key];
        }
        writeFileSync(settingsFile, JSON.stringify(next, null, 2) + "\n", "utf8");
        return { settings: next, file: settingsFile };
      }
      return { settings: readJsonSafe(settingsFile) || {}, file: settingsFile };
    });

    route("/api/muteki/ledger", () => {
      const totals = readJsonSafe(join(storageDir, "totals.json")) || {};
      const buckets = readJsonSafe(join(storageDir, "buckets.json")) || {};
      const runs = readJsonSafe(join(storageDir, "runs.json"));
      const costs = readJsonSafe(join(storageDir, "costs.json"));
      return {
        storageDir,
        totals,
        buckets,
        runsCount: Array.isArray(runs) ? runs.length : 0,
        costsCount: Array.isArray(costs) ? costs.length : 0,
      };
    });
  });
}

export default { name, Config, apply };