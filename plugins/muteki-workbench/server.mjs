/**
 * muteki-workbench 服务端：给右侧栏工作台提供 HTTP 路由。
 *
 *   GET  /api/muteki/settings  → 当前 settings.json 覆盖层（raw）
 *   POST /api/muteki/settings  → 写覆盖层（白名单过滤；orchestrator 下一次额度判定即生效）
 *   GET  /api/muteki/ledger    → 账本快照（totals/buckets/runs/costs 计数），供工作台显示
 *
 * 覆盖层文件与 orchestrator 共用 storageDir：优先 config.storageDir，
 * 其次 ~/.dsh-muteki/config.json 的 storage_dir，最后默认 artifacts 目录。
 *
 * 安全：每个路由 handler 先走 connection.requestRejection(req)（Host/Origin
 * 围栏 + 浏览器登录态），被拒返回 401/403 且不触达读写；inject 声明 connection。
 */
import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "muteki-workbench";

// cordis 服务必须声明 inject 才能访问；webServer 由 web 平面异步提供，
// 直接读 ctx.webServer 会拿不到（helmd 同款坑：它用 ctx.inject 等就绪）。
// connection 不进 inject 依赖：desktop 宿主不一定把它作为可 inject 服务暴露，
// 写进依赖会让整组路由永不注册；改为请求时懒读（见 route handler）。
export const inject = ["webServer"];

export const Config = z.object({
  enabled: z.boolean().default(true),
  storageDir: z.string().default("").comment("省略则读 ~/.dsh-muteki/config.json 的 storage_dir"),
});

const SETTINGS_KEYS = [
  "mode", "tier", "poolSize", "maxRunsPerHour", "burstRuns", "onQuota",
  "maxWaitMinutes", "stagnationLimit", "maxCostUsdPerHour", "maxRunsPerChallenge",
  "maxCostUsdPerChallenge", "workerUsdPerMinute", "estimateToActual", "costBasis",
  "hardCancelOnFlag", "autoOpenPane", "currency", "usdToCny", "flagAlert",
];

// 数字键：UI 的 <input> 给的是字符串，resolveLimits 只认 number，写入前 coerce。
const NUMERIC_KEYS = new Set([
  "poolSize", "maxRunsPerHour", "burstRuns", "maxWaitMinutes", "stagnationLimit",
  "maxCostUsdPerHour", "maxRunsPerChallenge", "maxCostUsdPerChallenge",
  "workerUsdPerMinute", "estimateToActual", "usdToCny",
]);

function coerce(key, value) {
  if (NUMERIC_KEYS.has(key) && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

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
          // 安全围栏：挡的是「浏览器里别的网页」跨站调用（它们必带跨域 Origin）。
          // 工作台自身 UI 与本机工具（同源 / dsh-app / 无 Origin）放行——desktop webview
          // 没有浏览器登录态 cookie，若一律走 requestRejection 会把自家 UI 也 401 掉
          // （实机「保存不了」的根因）。跨域请求才问 connection，问不到就直接 403。
          const origin = req.headers?.origin || "";
          const host = req.headers?.host || "";
          const local =
            !origin || origin.startsWith("dsh-app:") || origin.endsWith("://" + host);
          if (!local) {
            const connection = Reflect.get(ctx, "connection");
            const rejection = connection?.requestRejection?.(req);
            res.statusCode = rejection !== undefined ? rejection : 403;
            res.end();
            return;
          }
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
          if (body[key] !== undefined && body[key] !== null && body[key] !== "") next[key] = coerce(key, body[key]);
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

    // 首解即报：orchestrator 检测到新 flag 即追加 flags.jsonl；这里读尾部供工作台横幅
    // 即时显示 flag 值（不用等主会话收束、不用人工点子代理）。
    route("/api/muteki/flags", () => {
      let lines = [];
      try {
        lines = readFileSync(join(storageDir, "flags.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        /* 还没有 flag 留痕 */
      }
      const flags = [];
      for (const line of lines.slice(-20)) {
        try {
          flags.push(JSON.parse(line));
        } catch {
          /* 坏行跳过 */
        }
      }
      return { flags: flags.reverse() };
    });

    // 删除单条旗标留痕（仅 flags.jsonl，不碰黑板 flag）。按 ts+challenge+value 精确匹配。
    route("/api/muteki/flags/delete", async (req) => {
      if (req.method !== "POST") throw Object.assign(new Error("method not allowed"), { status: 405 });
      const body = await readJsonBody(req);
      const file = join(storageDir, "flags.jsonl");
      let lines = [];
      try {
        lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return { removed: 0 };
      }
      const kept = [];
      let removed = 0;
      for (const line of lines) {
        let row = null;
        try { row = JSON.parse(line); } catch { /* 坏行保留原样 */ }
        const hit = row && row.ts === body.ts && row.value === body.value && (row.challenge || "") === (body.challenge || "");
        if (hit) removed += 1;
        else kept.push(line);
      }
      writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
      return { removed };
    });

    // 清空全部旗标留痕（仅 flags.jsonl，不碰黑板 flag）。
    route("/api/muteki/flags/clear", async (req) => {
      if (req.method !== "POST") throw Object.assign(new Error("method not allowed"), { status: 405 });
      await readJsonBody(req);
      writeFileSync(join(storageDir, "flags.jsonl"), "", "utf8");
      return { cleared: true };
    });
  });
}

export default { name, Config, apply };