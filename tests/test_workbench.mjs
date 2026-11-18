/**
 * muteki-workbench 服务端回归测试（node:test）。
 * 运行：DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_workbench.mjs
 * 找不到 DSH 依赖时全部 skip。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
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