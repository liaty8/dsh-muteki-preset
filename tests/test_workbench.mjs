/**
 * muteki-workbench 服务端回归测试（node:test）。
 * 运行：DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_workbench.mjs
 * 找不到 DSH 依赖时全部 skip。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createHarness, findNodeModules, SKIP_REASON, writeJson } from "./orchestrator_harness.mjs";

const NODE_MODULES = findNodeModules();
const SERVER_SRC = process.env.MUTEKI_TEST_SERVER
  ? process.env.MUTEKI_TEST_SERVER
  : fileURLToPath(new URL("../plugins/muteki-workbench/server.mjs", import.meta.url));

async function withServer(options, fn) {
  const root = join(tmpdir(), `muteki-wb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const storageDir = join(root, "storage");
  mkdirSync(storageDir, { recursive: true });
  // server.mjs  import @deepseek-ai/schemastery：临时目录挂 junction 解析
  const { symlinkSync } = await import("node:fs");
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "junction");
  copyFileSync(SERVER_SRC, join(root, "server.mjs"));
  const mod = await import(pathToFileURL(join(root, "server.mjs")).href);
  const routes = new Map();
  const ctx = options?.noWeb ? {} : { webServer: { register: (r) => routes.set(r.path, r) } };
  if (options?.connection) ctx.connection = options.connection;
  let pendingInject = null;
  ctx.inject = (_deps, fn) => {
    if (options?.lateWeb) pendingInject = fn;
    else fn(ctx);
  };
  mod.apply(ctx, { enabled: true, storageDir, ...(options?.config || {}) });
  if (options?.lateWeb) {
    // 模拟 web 平面服务晚于插件 apply 才就绪
    ctx.webServer = { register: (r) => routes.set(r.path, r) };
    pendingInject(ctx);
  }
  const call = async (path, method = "GET", body) => {
    const route = routes.get(path);
    assert.ok(route, `路由未注册：${path}`);
    const req = body === undefined ? Object.assign(Readable.from([]), { method }) : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method });
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s; } };
    await route.handler(req, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  try {
    await fn({ call, storageDir, routes, mod });
  } finally {
    try { unlinkSync(join(root, "node_modules")); } catch { /* junction */ }
    rmSync(root, { recursive: true, force: true });
  }
}

test("workbench: settings 读写走白名单，空串与未知键被丢弃", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    const post = await s.call("/api/muteki/settings", "POST", {
      mode: "bulk", tier: "lite", poolSize: 6, evil: "x", maxCostUsdPerHour: "",
    });
    assert.equal(post.status, 200);
    assert.deepEqual(post.json.data.settings, { mode: "bulk", tier: "lite", poolSize: 6 });
    const get = await s.call("/api/muteki/settings");
    assert.deepEqual(get.json.data.settings, { mode: "bulk", tier: "lite", poolSize: 6 });
    const onDisk = JSON.parse(readFileSync(join(s.storageDir, "settings.json"), "utf8"));
    assert.equal(onDisk.poolSize, 6);
    assert.ok(!("evil" in onDisk));
  });
});

test("workbench: 坏 JSON body 返回 400", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    const route = s.routes.get("/api/muteki/settings");
    const req = Object.assign(Readable.from([Buffer.from("{not json")]), { method: "POST" });
    const res = { statusCode: 0, setHeader() {}, end(x) { this.body = x; } };
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  });
});

test("workbench: ledger 快照读账本计数", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    writeJson(join(s.storageDir, "totals.json"), { "web-1": { runs: 3, usdEstimate: 0.5 } });
    writeJson(join(s.storageDir, "runs.json"), [{}, {}, {}]);
    writeJson(join(s.storageDir, "costs.json"), [{}, {}]);
    const get = await s.call("/api/muteki/ledger");
    assert.equal(get.json.data.runsCount, 3);
    assert.equal(get.json.data.costsCount, 2);
    assert.equal(get.json.data.totals["web-1"].runs, 3);
  });
});

test("workbench: flags 路由读 flags.jsonl 尾部并倒序（首解即报横幅数据源）", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    writeFileSync(
      join(s.storageDir, "flags.jsonl"),
      JSON.stringify({ ts: 1, challenge: "a", value: "flag{1}" }) + "\n" +
      JSON.stringify({ ts: 2, challenge: "b", value: "flag{2}" }) + "\n",
      "utf8",
    );
    const get = await s.call("/api/muteki/flags");
    assert.equal(get.status, 200);
    assert.deepEqual(get.json.data.flags.map((f) => f.value), ["flag{2}", "flag{1}"]);
  });
});

test("workbench: enabled=false 或无 webServer 时不注册不炸", { skip: SKIP_REASON }, async () => {
  await withServer({ config: { enabled: false } }, async (s) => {
    assert.equal(s.routes.size, 0);
  });
  await withServer({ noWeb: true }, async (s) => {
    assert.equal(s.routes.size, 0);
  });
});

test("workbench: webServer 晚到也能注册（inject 等就绪，不静默丢路由）", { skip: SKIP_REASON }, async () => {
  await withServer({ lateWeb: true }, async (s) => {
    assert.ok(s.routes.has("/api/muteki/settings"));
    const get = await s.call("/api/muteki/settings");
    assert.equal(get.status, 200);
  });
});

test("workbench: 数字键字符串写入被 coerce 成 number（滑杆覆盖才生效）", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    const post = await s.call("/api/muteki/settings", "POST", { poolSize: "6", maxCostUsdPerHour: "12.5", mode: "bulk" });
    assert.equal(post.json.data.settings.poolSize, 6);
    assert.equal(post.json.data.settings.maxCostUsdPerHour, 12.5);
    assert.equal(typeof post.json.data.settings.poolSize, "number");
  });
  // orchestrator 读侧也容错字符串（旧文件/其它写入方）
  const h = await createHarness({});
  try {
    h.board(["use", "t-coerce"]);
    h.seedTask("题一");
    writeJson(h.ledger("settings.json"), { mode: "bulk", poolSize: "6" });
    const out = await h.call("muteki_run", { challenge: "t-coerce" });
    assert.equal(out.bulk.poolSize, 6, "字符串 poolSize 应被 coerce 生效");
  } finally {
    h.cleanup();
  }
});

test("orchestrator: attended 的 limit 被 clamp 到 1-3，返回体报生效值而非请求值", { skip: SKIP_REASON }, async () => {
  const h = await createHarness({});
  try {
    h.board(["use", "t-clamp"]);
    for (let i = 1; i <= 8; i++) h.seedTask(`靶题${i}`);
    const out = await h.call("muteki_run", { challenge: "t-clamp", limit: 8, max_rounds: 6 });
    assert.equal(out.bulk, undefined, "attended 不应走 bulk 路径");
    assert.equal(out.limit, 3, "limit=8 应被 clamp 到 3");
    assert.equal(out.dispatched.length, 8, "8 条任务分 3 轮派完（3+3+2），不是同时 8 并行");
    assert.equal(out.rounds, 3);
  } finally {
    h.cleanup();
  }
});

test("orchestrator: settings.json 覆盖运行时生效，删除即收回", { skip: SKIP_REASON }, async () => {
  const h = await createHarness({});
  try {
    h.board(["use", "t-override"]);
    h.seedTask("题一");
    writeJson(h.ledger("settings.json"), { mode: "bulk", tier: "lite" });
    const out = await h.call("muteki_run", { challenge: "t-override" });
    assert.ok(out.bulk, "settings.json 应把 run 切到 bulk 路径");
    assert.equal(out.bulk.poolSize, 4);
    writeJson(h.ledger("settings.json"), { mode: "attended", maxCostUsdPerHour: 0.0001 });
    const out2 = await h.call("muteki_run", { challenge: "t-override2" });
    assert.equal(out2.quota.costPerHour, 0.0001);
    assert.equal(out2.bulk, undefined);
    unlinkSync(h.ledger("settings.json"));
    const out3 = await h.call("muteki_run", { challenge: "t-override3" });
    assert.equal(out3.quota.costPerHour, 15);
  } finally {
    h.cleanup();
  }
});

// 安全围栏：挡跨站网页（必带跨域 Origin），放行工作台自身 UI / 本机工具
// （同源 / dsh-app / 无 Origin）。desktop webview 无浏览器登录态，一律走
// requestRejection 会把自家 UI 也 401 掉（实机「保存不了」根因）。
function rawCall(s, path, method, body, headers) {
  const route = s.routes.get(path);
  assert.ok(route, `路由未注册：${path}`);
  const base = { method, headers: headers || {} };
  const req = body === undefined
    ? Object.assign(Readable.from([]), base)
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), base);
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x; } };
  return route.handler(req, res).then(() => res);
}
const CROSS = { origin: "https://evil.example", host: "127.0.0.1:41537" };

test("workbench: 跨域请求被拒 403 且不写 settings（connection 给出拒绝码）", { skip: SKIP_REASON }, async () => {
  await withServer({ connection: { requestRejection: () => 403 } }, async (s) => {
    const post = await rawCall(s, "/api/muteki/settings", "POST", { mode: "bulk", poolSize: 4 }, CROSS);
    assert.equal(post.statusCode, 403);
    assert.ok(!existsSync(join(s.storageDir, "settings.json")), "被拒请求不应写盘");
    const get = await rawCall(s, "/api/muteki/ledger", "GET", undefined, CROSS);
    assert.equal(get.statusCode, 403);
  });
});

test("workbench: 跨域且无 connection 服务时直接 403", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    const get = await rawCall(s, "/api/muteki/flags", "GET", undefined, CROSS);
    assert.equal(get.statusCode, 403);
  });
});

test("workbench: 自身 UI（无 Origin/同源/dsh-app）不被登录态围栏误伤", { skip: SKIP_REASON }, async () => {
  await withServer({ connection: { requestRejection: () => 401 } }, async (s) => {
    for (const headers of [undefined, { origin: "http://127.0.0.1:41537", host: "127.0.0.1:41537" }, { origin: "dsh-app://desktop", host: "127.0.0.1:41537" }]) {
      const post = await rawCall(s, "/api/muteki/settings", "POST", { flagAlert: true }, headers);
      assert.equal(post.statusCode, 200, "自家 UI 不应被 401/403");
    }
  });
});

test("workbench: flagAlert 可保存可收回（首解即报开关回归）", { skip: SKIP_REASON }, async () => {
  await withServer({}, async (s) => {
    const on = await s.call("/api/muteki/settings", "POST", { mode: "bulk", flagAlert: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.data.settings.flagAlert, true);
    const off = await s.call("/api/muteki/settings", "POST", { mode: "bulk" });
    assert.equal(off.json.data.settings.flagAlert, undefined, "全量替换：省略即收回");
  });
});