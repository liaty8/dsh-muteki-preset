/**
 * muteki-orchestrator 回归测试（node:test，无需第三方测试框架）。
 *
 * 运行：
 *   DSH_NODE_MODULES=<你的 DSH home>/profiles/desktop/node_modules \
 *     node --test tests/test_orchestrator.mjs
 *
 * 找不到 DSH 依赖时全部 skip（不算失败），这样没有 DSH 的机器也能跑 Python 那套测试。
 * 注意：脚手架会临时改进程环境变量，用例必须**串行**跑（node --test 顶层默认串行，
 * 不要加 --test-concurrency）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createHarness,
  readJson,
  writeJson,
  SKIP_REASON,
} from "./orchestrator_harness.mjs";

const withHarness = async (options, fn) => {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    harness.cleanup();
  }
};

// ── 额度预设与显式覆盖（v1.6.0）──────────────────────────────────────────

test("resolveLimits: attended / unattended 两套预设", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const { resolveLimits, PRESETS } = h.mod;
    assert.deepEqual(resolveLimits({ mode: "attended" }), {
      mode: "attended",
      runsPerHour: 40,
      costPerHour: 15,
      runsPerChallenge: 300,
      costPerChallenge: 50,
    });
    assert.deepEqual(resolveLimits({ mode: "unattended" }), {
      mode: "unattended",
      runsPerHour: 12,
      costPerHour: 5,
      runsPerChallenge: 100,
      costPerChallenge: 15,
    });
    assert.equal(PRESETS.attended.runsPerHour > PRESETS.unattended.runsPerHour, true);
  });
});

test("resolveLimits: 缺省/非法 mode 回落 attended，显式数值优先", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const { resolveLimits } = h.mod;
    assert.equal(resolveLimits({}).mode, "attended");
    assert.equal(resolveLimits({ mode: "bogus" }).mode, "attended");
    assert.equal(resolveLimits({ mode: "unattended", maxRunsPerHour: 3 }).runsPerHour, 3);
    assert.equal(resolveLimits({ maxCostUsdPerChallenge: 7.5 }).costPerChallenge, 7.5);
    for (const bad of [0, -1, NaN, "12", null]) {
      assert.equal(resolveLimits({ maxRunsPerHour: bad }).runsPerHour, 40, `非法值 ${bad}`);
    }
  });
});

test("Config: mode 有默认值，四个额度字段可省略", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const resolved = h.mod.Config({});
    assert.equal(resolved.mode, "attended");
    assert.equal(resolved.maxRunsPerHour, undefined);
    assert.equal(resolved.maxCostUsdPerHour, undefined);
    assert.equal(resolved.maxRunsPerChallenge, undefined);
    assert.equal(resolved.maxCostUsdPerChallenge, undefined);
    assert.equal(h.mod.Config({ mode: "unattended" }).mode, "unattended");
    assert.throws(() => h.mod.Config({ mode: "bogus" }));
    // 老配置（写死 12 / 3）仍然被尊重，不会被预设悄悄改掉
    const legacy = h.mod.Config({ maxRunsPerHour: 12, maxCostUsdPerHour: 3 });
    assert.equal(h.mod.resolveLimits(legacy).runsPerHour, 12);
    assert.equal(h.mod.resolveLimits(legacy).costPerHour, 3);
  });
});

// ── 四个闸门都走同一套判定 ────────────────────────────────────────────────

test("dispatch: 每小时上限命中后拒派，报错点名上限", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 2, maxRunsPerChallenge: 100 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await h.call("muteki_dispatch", { prompt: "第二步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第三步" }),
      /每小时派单 2\/2/,
    );
    assert.equal(h.activations.length, 2);
  });
});

test("dispatch: 整题总闸命中后拒派（小时额度还很宽）", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 100, maxRunsPerChallenge: 2 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await h.call("muteki_dispatch", { prompt: "第二步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第三步" }),
      /整题累计派单 2\/2/,
    );
  });
});

test("totals: 小时窗口滚过去后整题总闸仍然生效", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 100, maxRunsPerChallenge: 2 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await h.call("muteki_dispatch", { prompt: "第二步" });
    h.ageLedger(h.ledger("runs.json"), 2 * 3600_000);
    const totals = readJson(h.ledger("totals.json"), {});
    assert.equal(totals.default.runs, 2);
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第三步" }),
      /整题累计派单/,
    );
  });
});

test("totals: 按题独立，换题不继承旧题总闸", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 100, maxRunsPerChallenge: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "旧题第一步" });
    await assert.rejects(() => h.call("muteki_dispatch", { prompt: "旧题第二步" }));
    h.board(["use", "web-new"]);
    await h.call("muteki_dispatch", { prompt: "新题第一步" });
    const totals = readJson(h.ledger("totals.json"), {});
    assert.equal(totals.default.runs, 1);
    assert.equal(totals["web-new"].runs, 1);
  });
});

test("tick: 额度只够一个时本轮只派一个", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 1 } }, async (h) => {
    h.seedTask("任务一");
    h.seedTask("任务二");
    const out = await h.call("muteki_tick", { limit: 3 });
    assert.equal(out.dispatched.length, 1);
  });
});

test("cli: 整题成本总闸命中后拒跑（小时成本为 0）", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxCostUsdPerHour: 100, maxCostUsdPerChallenge: 5 } }, async (h) => {
    writeJson(h.ledger("costs.json"), [
      { ts: Date.now() - 3 * 3600_000, usd: 5, engine: "claude-cli", challenge: "default" },
    ]);
    writeJson(h.ledger("totals.json"), { default: { runs: 0, usd: 5 } });
    await assert.rejects(
      () => h.call("muteki_cli", { prompt: "异构一步" }),
      /整题累计成本\(\$\) 5\/5/,
    );
  });
});

// ── muteki_run：停止原因与额度明细 ────────────────────────────────────────

test("run: 额度用尽 → stoppedReason=budget，并带 quota 明细", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerHour: 100, maxRunsPerChallenge: 1 } }, async (h) => {
    h.board(["use", "t-budget"]);
    h.seedTask("任务一");
    h.seedTask("任务二");
    const out = await h.call("muteki_run", { challenge: "t-budget", limit: 1, max_rounds: 5 });
    assert.equal(out.stoppedReason, "budget");
    assert.equal(out.dispatched.length, 1);
    assert.equal(out.quota.mode, "attended");
    assert.equal(out.quota.runsTotal, 1);
    assert.equal(out.quota.runsPerChallenge, 1);
    assert.equal(out.quota.limitHit, "runsPerChallenge");
  });
});

test("run: unattended 模式预设更紧，quota 里能看出来", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { mode: "unattended", maxRunsPerChallenge: 1 } }, async (h) => {
    h.board(["use", "t-unattended"]);
    h.seedTask("任务一");
    const out = await h.call("muteki_run", { challenge: "t-unattended", limit: 1 });
    assert.equal(out.quota.mode, "unattended");
    assert.equal(out.quota.runsPerHour, 12);
    assert.equal(out.quota.costPerHour, 5);
    assert.equal(out.quota.costPerChallenge, 15);
  });
});

test("run: 队列空 → empty（回归，额度改造没破坏正常停止）", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const out = await h.call("muteki_run", { challenge: "t-empty", limit: 2 });
    assert.equal(out.stoppedReason, "empty");
    assert.equal(out.dispatched.length, 0);
    assert.equal(out.quota.limitHit, "");
  });
});

test("run: worker 写回 flag → 首解即停（回归）", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      worker: async ({ board }) => {
        board(["flag", "flag{test}", "--source", "mock-worker"]);
      },
    },
    async (h) => {
      h.board(["use", "t-flag"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-flag", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "flag");
      assert.deepEqual(out.flags, ["flag{test}"]);
    },
  );
});

test("run: 中断后 claimed 任务被释放回 open（回归）", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { maxRunsPerChallenge: 1 } }, async (h) => {
    h.board(["use", "t-reopen"]);
    h.seedTask("任务一");
    h.seedTask("任务二");
    await h.call("muteki_run", { challenge: "t-reopen", limit: 1 });
    const open = JSON.parse(h.board(["task", "list", "--status", "open", "--json"]).stdout);
    assert.equal(open.length, 2);
  });
});