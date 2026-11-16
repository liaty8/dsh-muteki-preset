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
import { readFileSync } from "node:fs";

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
      burstRuns: 60,
      onQuota: "wait",
      maxWaitMinutes: 10,
      stagnationLimit: 5,
    });
    assert.deepEqual(resolveLimits({ mode: "unattended" }), {
      mode: "unattended",
      runsPerHour: 12,
      costPerHour: 5,
      runsPerChallenge: 100,
      costPerChallenge: 15,
      burstRuns: 12,
      onQuota: "stop",
      maxWaitMinutes: 0,
      stagnationLimit: 3,
    });
    assert.equal(PRESETS.attended.burstRuns > PRESETS.attended.runsPerHour, true);
    assert.equal(PRESETS.unattended.burstRuns, PRESETS.unattended.runsPerHour);
  });
});

test("resolveLimits: 缺省/非法 mode 回落 attended，显式数值优先", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const { resolveLimits } = h.mod;
    assert.equal(resolveLimits({}).mode, "attended");
    assert.equal(resolveLimits({ mode: "bogus" }).mode, "attended");
    assert.equal(resolveLimits({ mode: "unattended", maxRunsPerHour: 3 }).runsPerHour, 3);
    assert.equal(resolveLimits({ maxCostUsdPerChallenge: 7.5 }).costPerChallenge, 7.5);
    assert.equal(resolveLimits({ burstRuns: 5 }).burstRuns, 5);
    assert.equal(resolveLimits({ onQuota: "stop" }).onQuota, "stop");
    assert.equal(resolveLimits({ onQuota: "bogus" }).onQuota, "wait");
    assert.equal(resolveLimits({ maxWaitMinutes: 0 }).maxWaitMinutes, 0);
    assert.equal(resolveLimits({ maxWaitMinutes: -3 }).maxWaitMinutes, 10);
    for (const bad of [0, -1, NaN, "12", null]) {
      assert.equal(resolveLimits({ maxRunsPerHour: bad }).runsPerHour, 40, `非法值 ${bad}`);
      assert.equal(resolveLimits({ burstRuns: bad }).burstRuns, 60, `非法值 ${bad}`);
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

test("dispatch: 令牌耗尽后拒派，报错点名令牌与回填", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 2, maxRunsPerHour: 1, maxRunsPerChallenge: 100 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await h.call("muteki_dispatch", { prompt: "第二步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第三步" }),
      /派单令牌 0\/2/,
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

test("tick: 令牌只够一个时本轮只派一个", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 1, maxRunsPerHour: 1 } }, async (h) => {
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

// ── 令牌桶：突发 + 回填（v1.7.0）──────────────────────────────────────────

test("bucket: 开局可一次性派满突发额度，哪怕远超每小时速率", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { burstRuns: 5, maxRunsPerHour: 1, maxRunsPerChallenge: 100 } },
    async (h) => {
      for (let i = 0; i < 5; i += 1) {
        await h.call("muteki_dispatch", { prompt: `突发第 ${i + 1} 步` });
      }
      assert.equal(h.activations.length, 5);
      await assert.rejects(() => h.call("muteki_dispatch", { prompt: "第六步" }), /派单令牌/);
    },
  );
});

test("bucket: 时间过去后按速率回填，不用等满一小时", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 2, maxRunsPerHour: 60 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await h.call("muteki_dispatch", { prompt: "第二步" });
    await assert.rejects(() => h.call("muteki_dispatch", { prompt: "第三步" }));
    // 60 次/小时 = 1 个/分钟；把桶的时间戳往回拨 60 秒，等价于等了一分钟
    const buckets = readJson(h.ledger("buckets.json"), {});
    buckets.default.updated -= 60_000;
    writeJson(h.ledger("buckets.json"), buckets);
    await h.call("muteki_dispatch", { prompt: "第三步" });
    assert.equal(h.activations.length, 3);
  });
});

test("run: onQuota=wait 会等令牌回填并继续派下一轮", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { burstRuns: 1, maxRunsPerHour: 3600, maxWaitMinutes: 1, maxRunsPerChallenge: 100 } },
    async (h) => {
      h.board(["use", "t-wait"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-wait", limit: 1, max_rounds: 5 });
      assert.equal(out.dispatched.length, 2);
      assert.equal(out.rounds, 2);
      assert.ok(out.waitedMs > 0, `应当等过令牌，实际 waitedMs=${out.waitedMs}`);
      assert.equal(out.quota.onQuota, "wait");
      assert.equal(out.stoppedReason, "empty");
    },
  );
});

test("run: unattended 默认 stop，绝不自作主张等待", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { mode: "unattended", burstRuns: 1, maxRunsPerHour: 60, maxRunsPerChallenge: 100 } },
    async (h) => {
      h.board(["use", "t-nowait"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-nowait", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "budget");
      assert.equal(out.waitedMs, 0);
      assert.equal(out.dispatched.length, 1);
      assert.equal(out.quota.onQuota, "stop");
      assert.equal(out.quota.limitHit, "tokens");
      assert.ok(out.resumeAt > Date.now(), "应当给出下一个令牌的回填时刻");
    },
  );
});

test("run: 等待被 maxWaitMinutes 封顶，等不到就停并给 resumeAt", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { burstRuns: 1, maxRunsPerHour: 1, maxWaitMinutes: 0.03, maxRunsPerChallenge: 100 } },
    async (h) => {
      h.board(["use", "t-cap"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-cap", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "budget");
      assert.ok(out.waitedMs >= 1000 && out.waitedMs <= 6000, `waitedMs=${out.waitedMs}`);
      assert.ok(out.resumeAt > Date.now());
    },
  );
});

// ── 显式越过额度（只越过速率，钱的闸不动）─────────────────────────────────

test("override_quota: attended 下越过令牌并留痕", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 1, maxRunsPerHour: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await assert.rejects(() => h.call("muteki_dispatch", { prompt: "第二步" }));
    await h.call("muteki_dispatch", { prompt: "第二步", override_quota: true, override_reason: "人在看着，硬题要连打" });
    assert.equal(h.activations.length, 2);
    assert.match(h.board(["search", "额度越过"]).stdout, /额度越过/);
    const raw = readFileSync(h.ledger("overrides.jsonl"), "utf8");
    assert.match(raw, /人在看着，硬题要连打/);
    assert.equal(raw.trim().split("\n").length, 1);
  });
});

test("override_quota: unattended 下直接拒绝", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { mode: "unattended", burstRuns: 1, maxRunsPerHour: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第二步", override_quota: true }),
      /只在 mode=attended/,
    );
  });
});

test("override_quota: 不能越过整题派单总闸", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 100, maxRunsPerChallenge: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第二步", override_quota: true }),
      /不能越过成本\/整题总闸/,
    );
  });
});

test("override_quota: 不能越过成本总闸", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 100, maxCostUsdPerChallenge: 1 } }, async (h) => {
    writeJson(h.ledger("totals.json"), { default: { runs: 0, usd: 1 } });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第一步", override_quota: true }),
      /不能越过成本\/整题总闸/,
    );
    assert.equal(h.activations.length, 0);
  });
});

test("run: override 放宽令牌，但整题总闸在批次内照常拦", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { burstRuns: 100, maxRunsPerHour: 1, maxRunsPerChallenge: 2 } },
    async (h) => {
      h.board(["use", "t-midcap"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      h.seedTask("任务三");
      const out = await h.call("muteki_run", {
        challenge: "t-midcap",
        limit: 3,
        max_rounds: 5,
        override_quota: true,
      });
      assert.equal(out.dispatched.length, 2);
      assert.equal(out.stoppedReason, "budget");
      assert.equal(out.quota.limitHit, "runsPerChallenge");
      assert.match(out.overrideNote, /不能越过成本\/整题总闸/);
    },
  );
});

test("run: unattended 下带 override_quota 不会炸，优雅停并说明原因", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { mode: "unattended", burstRuns: 1, maxRunsPerHour: 1, maxRunsPerChallenge: 100 } },
    async (h) => {
      h.board(["use", "t-unattended-override"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", {
        challenge: "t-unattended-override",
        limit: 1,
        max_rounds: 5,
        override_quota: true,
      });
      assert.equal(out.stoppedReason, "budget");
      assert.equal(out.overridden, false);
      assert.match(out.overrideNote, /只在 mode=attended/);
    },
  );
});

test("run: override_quota 让本轮继续，并标记 overridden", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { burstRuns: 1, maxRunsPerHour: 1, maxWaitMinutes: 0, maxRunsPerChallenge: 100 } },
    async (h) => {
      h.board(["use", "t-override"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", {
        challenge: "t-override",
        limit: 1,
        max_rounds: 5,
        override_quota: true,
        override_reason: "人工授权连打",
      });
      assert.equal(out.dispatched.length, 2);
      assert.equal(out.overridden, true);
      assert.equal(out.stoppedReason, "empty");
    },
  );
});

// ── 停滞熔断（v1.8.0）─────────────────────────────────────────────────────

test("stagnation: 连续 N 轮无新增 fact/flag → 停并写 review gap", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { stagnationLimit: 2, burstRuns: 100, maxRunsPerHour: 100 } },
    async (h) => {
      h.board(["use", "t-stagnant"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      h.seedTask("任务三");
      const out = await h.call("muteki_run", { challenge: "t-stagnant", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "stagnation");
      assert.equal(out.stagnantRounds, 2);
      assert.equal(out.dispatched.length, 2);
      const reviews = JSON.parse(h.board(["review", "list", "--status", "open", "--json"]).stdout);
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].kind, "gap");
      assert.match(reviews[0].note, /连续 2 轮/);
    },
  );
});

test("stagnation: 每轮都有新 fact 就不熔断，跑到队列空", { skip: SKIP_REASON }, async () => {
  const aid = "atest0001-000000";
  let n = 0;
  await withHarness(
    {
      config: { stagnationLimit: 2, burstRuns: 100, maxRunsPerHour: 100 },
      worker: async ({ board }) => {
        n += 1;
        board(["fact", `进展${n}`, `第 ${n} 步拿到可复用结论`, "--artifact", aid]);
      },
    },
    async (h) => {
      h.makeArtifact(aid, "worker output");
      h.board(["use", "t-progress"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      h.seedTask("任务三");
      const out = await h.call("muteki_run", { challenge: "t-progress", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "empty");
      assert.equal(out.stagnantRounds, 0);
      assert.equal(out.dispatched.length, 3);
    },
  );
});

test("stagnation: 只写 observation 不算进展", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { stagnationLimit: 2, burstRuns: 100, maxRunsPerHour: 100 },
      worker: async ({ board }) => {
        board(["fact", "推测", "还没证实，不能当结论"]);
      },
    },
    async (h) => {
      h.board(["use", "t-obs"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-obs", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "stagnation");
    },
  );
});

test("stagnation: 只写 deadend 不算进展", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { stagnationLimit: 2, burstRuns: 100, maxRunsPerHour: 100 },
      worker: async ({ board }) => {
        board(["deadend", "又排除一个方向", "--tested", "范围", "--observed", "结果"]);
      },
    },
    async (h) => {
      h.board(["use", "t-dead"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-dead", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "stagnation");
    },
  );
});

test("stagnation: limit=0 关闭熔断", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { stagnationLimit: 0, burstRuns: 100, maxRunsPerHour: 100 } },
    async (h) => {
      h.board(["use", "t-off"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      h.seedTask("任务三");
      const out = await h.call("muteki_run", { challenge: "t-off", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "empty");
      assert.equal(out.dispatched.length, 3);
      assert.equal(out.stagnantRounds, 3);
    },
  );
});

test("stagnation: 出现 flag 时首解优先，不误判停滞", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { stagnationLimit: 1, burstRuns: 100, maxRunsPerHour: 100 },
      worker: async ({ board }) => {
        board(["flag", "flag{test}", "--source", "mock-worker"]);
      },
    },
    async (h) => {
      h.board(["use", "t-flagwin"]);
      h.seedTask("任务一");
      const out = await h.call("muteki_run", { challenge: "t-flagwin", limit: 1, max_rounds: 6 });
      assert.equal(out.stoppedReason, "flag");
      assert.deepEqual(out.flags, ["flag{test}"]);
    },
  );
});