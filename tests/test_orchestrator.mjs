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
import { execFileSync } from "node:child_process";

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
      tier: "standard",
      poolSize: 3,
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
      tier: "standard",
      poolSize: 3,
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

test("flagAlert: 首解即报返回 advice 且 flags.jsonl 留痕；关闭时无 advice 但仍留痕", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      worker: async ({ board }) => {
        board(["flag", "flag{alert}", "--source", "mock-worker"]);
      },
    },
    async (h) => {
      h.board(["use", "t-alert"]);
      h.seedTask("任务一");
      writeJson(h.ledger("settings.json"), { flagAlert: true });
      const out = await h.call("muteki_run", { challenge: "t-alert", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "flag");
      assert.equal(out.solved, true);
      assert.match(out.advice, /跳过 review/);
      const lines = readFileSync(h.ledger("flags.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
      assert.ok(lines.some((r) => r.value === "flag{alert}" && r.challenge === "t-alert"));
    },
  );
  await withHarness(
    {
      worker: async ({ board }) => {
        board(["flag", "flag{off}", "--source", "mock-worker"]);
      },
    },
    async (h) => {
      h.board(["use", "t-alert-off"]);
      h.seedTask("任务一");
      const out = await h.call("muteki_run", { challenge: "t-alert-off", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "flag");
      assert.equal(out.advice, undefined, "flagAlert 默认关时不应给 advice");
      const lines = readFileSync(h.ledger("flags.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
      assert.ok(lines.some((r) => r.value === "flag{off}"), "留痕不依赖开关");
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

// ── 成本口径与 DSH worker 花费记账（v1.9.0）───────────────────────────────

const costsOf = (h) => readJson(h.ledger("costs.json"), []) || [];

// ── 显式授权一律留痕（v1.9.3）─────────────────────────────────────────────

const overrideLines = (h) =>
  readFileSync(h.ledger("overrides.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x));

test("override: 令牌充足时显式授权也留痕，并说明未实际放宽", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 60 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "一步", override_quota: true, override_reason: "人在看着，先表个态" });
    assert.equal(h.activations.length, 1);
    assert.match(h.board(["search", "额度越过"]).stdout, /额度越过（人工授权）/);
    assert.match(h.board(["search", "未实际放宽"]).stdout, /未实际放宽/);
    const rows = overrideLines(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, true);
    assert.equal(rows[0].needed, false);
    assert.equal(rows[0].reason, "人在看着，先表个态");
  });
});

test("override: unattended 下的授权尝试被拒但仍留痕", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { mode: "unattended", burstRuns: 1, maxRunsPerHour: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第二步", override_quota: true, override_reason: "试试" }),
      /只在 mode=attended/,
    );
    const rows = overrideLines(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, false);
    assert.equal(rows[0].blockedBy, "mode");
    assert.match(h.board(["search", "额度越过被拒"]).stdout, /额度越过被拒/);
  });
});

test("override: 撞上整题总闸时授权被拒但仍留痕", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 100, maxRunsPerChallenge: 1 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "第一步" });
    await assert.rejects(
      () => h.call("muteki_dispatch", { prompt: "第二步", override_quota: true }),
      /不能越过成本\/整题总闸/,
    );
    const rows = overrideLines(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allowed, false);
    assert.equal(rows[0].blockedBy, "runsPerChallenge");
  });
});

test("override: run 区分「请求过授权」与「真的放宽了」", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 100, maxRunsPerHour: 100 } }, async (h) => {
    h.board(["use", "t-idle-override"]);
    h.seedTask("任务一");
    const out = await h.call("muteki_run", {
      challenge: "t-idle-override", limit: 1, max_rounds: 3,
      override_quota: true, override_reason: "全程令牌充足",
    });
    assert.equal(out.overrideRequested, true);
    assert.equal(out.overridden, false);
    assert.match(out.overrideNote, /未实际放宽/);
    assert.equal(overrideLines(h)[0].needed, false);
  });
});

test("run: 文本渲染把「请求过授权」与「真的放宽了」都说清楚", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { burstRuns: 100, maxRunsPerHour: 100 } }, async (h) => {
    h.board(["use", "t-render"]);
    h.seedTask("任务一");
    const out = await h.call("muteki_run", {
      challenge: "t-render", limit: 1, max_rounds: 2,
      override_quota: true, override_reason: "渲染验证",
    });
    const tool = h.tools.get("muteki_run");
    const text = tool.output.render({}, out).map((x) => x.text).join("\n");
    assert.match(text, /人工授权已留痕（本轮令牌充足，未实际放宽）/);
    assert.match(text, /成本口径 estimate/);
    assert.equal(out.overrideRequested, true);
    assert.equal(out.overridden, false);
  });
});

test("cost: DSH worker 结束后按墙钟估算入账，并归到正确的题", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { workerUsdPerMinute: 6 }, workerDelayMs: 120 },
    async (h) => {
      h.board(["use", "t-cost"]);
      await h.call("muteki_dispatch", { prompt: "花点时间的一步" });
      await h.activations[0].result;
      const rows = costsOf(h).filter((x) => x.engine === "dsh-subagent");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].challenge, "t-cost");
      assert.equal(rows[0].basis, "estimate-time");
      assert.ok(rows[0].usdEstimate > 0, "应当估出正数成本");
      assert.ok(rows[0].ms >= 100, `应当记录墙钟耗时，实际 ${rows[0].ms}`);
      assert.ok(Math.abs(rows[0].usdActual - rows[0].usdEstimate * 0.1) < 1e-6);
      const totals = readJson(h.ledger("totals.json"), {});
      assert.ok(totals["t-cost"].usdEstimate > 0);
    },
  );
});

test("cost: estimateToActual 可配，actual 跟着换算", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { workerUsdPerMinute: 60, estimateToActual: 0.2 }, workerDelayMs: 80 },
    async (h) => {
      await h.call("muteki_dispatch", { prompt: "一步" });
      await h.activations[0].result;
      const row = costsOf(h).find((x) => x.engine === "dsh-subagent");
      assert.ok(row.usdEstimate > 0);
      assert.ok(Math.abs(row.usdActual - row.usdEstimate * 0.2) < 1e-6);
    },
  );
});

test("cost: workerUsdPerMinute=0 时不估 worker 成本", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { workerUsdPerMinute: 0 }, workerDelayMs: 60 }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "一步" });
    await h.activations[0].result;
    assert.equal(costsOf(h).filter((x) => x.engine === "dsh-subagent").length, 0);
  });
});

test("cost: 事件带 costUsd 时记 actual，带 usage 时保留 tokens", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: {}, endInfo: { costUsd: 0.5 } }, async (h) => {
    await h.call("muteki_dispatch", { prompt: "一步" });
    await h.activations[0].result;
    const row = costsOf(h).find((x) => x.engine === "dsh-subagent");
    assert.equal(row.basis, "actual");
    assert.equal(row.usdEstimate, 0.5);
  });
  await withHarness(
    { config: {}, endInfo: { usage: { inputTokens: 1000, outputTokens: 200 } }, workerDelayMs: 60 },
    async (h) => {
      await h.call("muteki_dispatch", { prompt: "一步" });
      await h.activations[0].result;
      const row = costsOf(h).find((x) => x.engine === "dsh-subagent");
      assert.equal(row.basis, "estimate-time");
      assert.deepEqual(row.tokens, { input: 1000, output: 200 });
    },
  );
});

test("cost: 归因不了的 end 事件不入账（宁可少记，不算到别的题头上）", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    h.emit("subagent/end", { id: "unknown-child", stopReason: "completed" });
    assert.equal(costsOf(h).length, 0);
  });
});

test("cost: costBasis=actual 时闸门按真实口径判定", { skip: SKIP_REASON }, async () => {
  const entry = { ts: Date.now(), usd: 10, usdEstimate: 10, usdActual: 1, engine: "claude-cli", challenge: "default" };
  await withHarness({ config: { costBasis: "actual", maxCostUsdPerHour: 2 } }, async (h) => {
    writeJson(h.ledger("costs.json"), [entry]);
    await h.call("muteki_dispatch", { prompt: "真实口径还没超" });
    assert.equal(h.activations.length, 1);
  });
  await withHarness({ config: { costBasis: "estimate", maxCostUsdPerHour: 2 } }, async (h) => {
    writeJson(h.ledger("costs.json"), [entry]);
    await assert.rejects(() => h.call("muteki_dispatch", { prompt: "估算口径已超" }), /每小时成本/);
  });
});

test("cost: 老账本只有 usd 字段也能读，actual 口径按系数换算", { skip: SKIP_REASON }, async () => {
  const legacy = [{ ts: Date.now(), usd: 5, engine: "claude-cli", challenge: "default" }];
  await withHarness({ config: { maxCostUsdPerHour: 3 } }, async (h) => {
    writeJson(h.ledger("costs.json"), legacy);
    await assert.rejects(() => h.call("muteki_dispatch", { prompt: "一步" }), /每小时成本/);
  });
  await withHarness(
    { config: { costBasis: "actual", estimateToActual: 0.1, maxCostUsdPerHour: 1 } },
    async (h) => {
      writeJson(h.ledger("costs.json"), legacy);
      await h.call("muteki_dispatch", { prompt: "换算后 0.5 < 1，可派" });
      assert.equal(h.activations.length, 1);
    },
  );
});

test("cost: worker 花费计入整题成本总闸", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { workerUsdPerMinute: 6000, maxCostUsdPerChallenge: 0.01, burstRuns: 100, maxRunsPerHour: 100 },
      workerDelayMs: 100,
    },
    async (h) => {
      await h.call("muteki_dispatch", { prompt: "第一步" });
      await h.activations[0].result;
      await assert.rejects(
        () => h.call("muteki_dispatch", { prompt: "第二步" }),
        /整题累计成本/,
      );
    },
  );
});

test("cost: run 的 quota 明细带 costBasis", { skip: SKIP_REASON }, async () => {
  await withHarness({ config: { costBasis: "actual" } }, async (h) => {
    const out = await h.call("muteki_run", { challenge: "t-basis", limit: 1 });
    assert.equal(out.quota.costBasis, "actual");
  });
});

// ── 只读审查修复（v1.10.1）────────────────────────────────────────────────

test("worker 提示词：黑板命令全部带绝对路径，不留裸 board.py", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    h.board(["use", "t-prompt"]);
    h.seedTask("侦察");
    await h.call("muteki_tick", {});
    assert.equal(h.activations.length, 1);
    const prompt = h.activations[0].opts.prompt[0].text;
    const prefix = `${h.config.python} ${h.config.boardPy}`;
    for (const sub of ["context", "artifact list", "deadend", "flag", "task done"]) {
      assert.ok(prompt.includes(`${prefix} ${sub}`), `缺少绝对路径命令：${sub}`);
    }
    assert.ok(!/`board\.py\s/.test(prompt), "提示词里仍有裸 board.py 命令");
    assert.ok(!prompt.includes("{{"), "模板占位符应当已被 fillCmd 替换");
  });
});

test("tick: 开工先回收卡住的 claimed 任务，不再看到空队列", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    h.board(["use", "t-reclaim"]);
    h.seedTask("卡住的任务");
    h.board(["task", "claim", "1", "--owner", "ghost"]);
    // 把认领时间拨回 40 分钟前（reclaim 阈值 30 分钟），模拟上一个会话中断。
    execFileSync(
      h.config.python,
      [
        "-c",
        "import sqlite3; c = sqlite3.connect('.muteki-board/board.db'); " +
          "c.execute(\"UPDATE tasks SET updated_at = datetime('now','localtime','-40 minutes') WHERE id=1\"); " +
          "c.commit()",
      ],
      { cwd: h.ws },
    );
    const out = await h.call("muteki_tick", {});
    assert.equal(out.dispatched.length, 1);
    assert.equal(out.dispatched[0].taskId, 1);
  });
});

test("run: 等令牌期间被用户中断 → interrupted 而不是 budget", { skip: SKIP_REASON }, async () => {
  const signal = { aborted: false };
  await withHarness(
    {
      config: { burstRuns: 1, maxRunsPerHour: 1, maxWaitMinutes: 1, maxRunsPerChallenge: 100 },
      // 第一个 worker 干活时用户按下中断；第二轮撞上令牌不足进入等待。
      worker: async () => {
        signal.aborted = true;
      },
    },
    async (h) => {
      h.exec.signal = signal;
      h.board(["use", "t-int"]);
      h.seedTask("任务一");
      h.seedTask("任务二");
      const out = await h.call("muteki_run", { challenge: "t-int", limit: 1, max_rounds: 5 });
      assert.equal(out.stoppedReason, "interrupted");
      assert.equal(out.dispatched.length, 1);
      const text = h.tools
        .get("muteki_run")
        .output.render({}, out)
        .map((block) => block.text)
        .join("\n");
      assert.match(text, /被用户中断/);
      assert.ok(!/额度用尽/.test(text.split("\n")[0]), "首行不应把中断说成额度问题");
    },
  );
});

// ── bulk 靶场批量模式（完成驱动并发池）─────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const taskIdOf = (name) => name.match(/t(\d+)$/)?.[1];

test("resolveLimits: bulk 三档预设与显式覆盖", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const { resolveLimits, BULK_TIERS } = h.mod;
    const lite = resolveLimits({ mode: "bulk", tier: "lite" });
    assert.equal(lite.poolSize, 4);
    assert.equal(lite.runsPerHour, 60);
    assert.equal(lite.costPerHour, 10);
    assert.equal(lite.stagnationLimit, 0);
    assert.equal(lite.onQuota, "wait");
    const std = resolveLimits({ mode: "bulk" });
    assert.equal(std.tier, "standard");
    assert.equal(std.poolSize, 8);
    assert.equal(std.costPerChallenge, 80);
    const max = resolveLimits({ mode: "bulk", tier: "max" });
    assert.equal(max.poolSize, 16);
    assert.equal(max.runsPerHour, 240);
    assert.equal(resolveLimits({ mode: "bulk", tier: "bogus" }).tier, "standard");
    assert.equal(resolveLimits({ mode: "bulk", poolSize: 6 }).poolSize, 6);
    assert.equal(resolveLimits({ mode: "bulk", poolSize: 99 }).poolSize, 32);
    assert.equal(BULK_TIERS.max.costPerHour, 60);
    // 非 bulk 模式不受 tier 影响
    assert.equal(resolveLimits({ mode: "attended", tier: "max" }).poolSize, 3);
  });
});

test("bulk: 并发池打满 tier 上限，队列抽干后收束", { skip: SKIP_REASON }, async () => {
  let active = 0;
  let peak = 0;
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite" },
      worker: async ({ name, board }) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(120);
        board(["task", "done", taskIdOf(name)]);
        active -= 1;
      },
    },
    async (h) => {
      h.board(["use", "t-bulk"]);
      for (let i = 1; i <= 8; i += 1) h.seedTask(`题${i}`);
      const out = await h.call("muteki_run", { challenge: "t-bulk" });
      assert.equal(out.stoppedReason, "empty");
      assert.equal(out.dispatched.length, 8);
      assert.equal(out.bulk.poolSize, 4);
      assert.equal(out.bulk.peakPool, 4);
      assert.equal(peak, 4);
      assert.equal(out.bulk.dropped, 0);
      const list = h.board(["task", "list", "--status", "all"]).stdout;
      assert.ok(!/\[open\]|\[claimed\]/.test(list), "全部任务应当 done");
    },
  );
});

test("bulk: 完成驱动——快 worker 结束立刻补位，不等慢 worker", { skip: SKIP_REASON }, async () => {
  const starts = {};
  const ends = {};
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite" },
      worker: async ({ name, board }) => {
        const id = taskIdOf(name);
        starts[id] = Date.now();
        await sleep(id === "1" ? 600 : 60);
        board(["task", "done", id]);
        ends[id] = Date.now();
      },
    },
    async (h) => {
      h.board(["use", "t-bulk-pipe"]);
      for (let i = 1; i <= 4; i += 1) h.seedTask(`题${i}`);
      const out = await h.call("muteki_run", { challenge: "t-bulk-pipe", limit: 2 });
      assert.equal(out.stoppedReason, "empty");
      assert.equal(out.dispatched.length, 4);
      assert.ok(starts["3"] < ends["1"], "t3 应当在慢 worker t1 结束前就补位开工");
      assert.ok(out.bulk.peakPool <= 2);
    },
  );
});

test("bulk: flag 按题归属，不触发全局首解停摆", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite" },
      worker: async ({ name, board }) => {
        const id = taskIdOf(name);
        if (id === "1") {
          board(["flag", "flag{bulk-one}", "--source", "测试"]);
        } else {
          await sleep(200);
        }
        board(["task", "done", id]);
      },
    },
    async (h) => {
      h.board(["use", "t-bulk-flag"]);
      h.seedTask("题一");
      h.seedTask("题二");
      const out = await h.call("muteki_run", { challenge: "t-bulk-flag" });
      assert.equal(out.stoppedReason, "empty", "bulk 不应因第一个 flag 全局停");
      assert.equal(out.dispatched.length, 2);
      assert.equal(out.bulk.solved, 1);
      assert.deepEqual(out.flags, ["flag{bulk-one}"]);
    },
  );
});

test("bulk+flagAlert: 旗标守望落账 + 返回 advice 提示先报 flag 跳过 review", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite", flagAlert: true },
      worker: async ({ name, board }) => {
        const id = taskIdOf(name);
        if (id === "1") {
          board(["flag", "flag{bulk-alert}", "--source", "测试"]);
        } else {
          await sleep(200);
        }
        board(["task", "done", id]);
      },
    },
    async (h) => {
      h.board(["use", "t-bulk-alert"]);
      h.seedTask("题一");
      h.seedTask("题二");
      const out = await h.call("muteki_run", { challenge: "t-bulk-alert" });
      assert.equal(out.stoppedReason, "empty", "bulk 不因首解全局停");
      assert.equal(out.bulk.solved, 1);
      assert.equal(out.solved, true);
      assert.match(out.advice, /跳过 review/);
      const lines = readFileSync(h.ledger("flags.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
      assert.ok(lines.some((r) => r.value === "flag{bulk-alert}" && r.challenge === "t-bulk-alert"));
    },
  );
});

test("run: 返回体顶层键与 bulk 子键都在 output schema 声明（防 schema/实现漂移）", { skip: SKIP_REASON }, async () => {
  const checkKeys = (h, out) => {
    const props = h.tools.get("muteki_run").output.schema.properties;
    for (const k of Object.keys(out)) assert.ok(props[k], `未声明的返回键：${k}`);
    if (out.bulk) {
      const bp = props.bulk.properties;
      for (const k of Object.keys(out.bulk)) assert.ok(bp[k], `未声明的 bulk 键：${k}`);
    }
  };
  await withHarness(
    {
      worker: async ({ board }) => {
        board(["flag", "flag{schema-a}", "--source", "t"]);
      },
    },
    async (h) => {
      h.board(["use", "t-schema-a"]);
      h.seedTask("一");
      writeJson(h.ledger("settings.json"), { flagAlert: true });
      const out = await h.call("muteki_run", { challenge: "t-schema-a", limit: 1, max_rounds: 3 });
      checkKeys(h, out);
      assert.equal(out.solved, true);
      assert.ok(out.advice, "flagAlert 首解应带 advice");
      assert.equal(typeof out.limit, "number", "attended 应带生效 limit");
    },
  );
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite", flagAlert: true },
      worker: async ({ name, board }) => {
        board(["flag", "flag{schema-b}", "--source", "t"]);
        board(["task", "done", taskIdOf(name)]);
      },
    },
    async (h) => {
      h.board(["use", "t-schema-b"]);
      h.seedTask("一");
      const out = await h.call("muteki_run", { challenge: "t-schema-b" });
      checkKeys(h, out);
      assert.equal(out.bulk.solved, 1);
      assert.equal(out.limit, undefined, "bulk 返回不应带 limit（limit 仅 attended）");
    },
  );
});

test("bulk: worker 不标 done 的任务最多重试一次，再失败 drop", { skip: SKIP_REASON }, async () => {
  await withHarness(
    { config: { mode: "bulk", tier: "lite" }, worker: async () => {} },
    async (h) => {
      h.board(["use", "t-bulk-retry"]);
      h.seedTask("题一");
      h.seedTask("题二");
      const out = await h.call("muteki_run", { challenge: "t-bulk-retry" });
      assert.equal(out.stoppedReason, "empty");
      assert.equal(out.dispatched.length, 4, "每题派两次");
      assert.equal(out.bulk.dropped, 2);
      const list = h.board(["task", "list", "--status", "all"]).stdout;
      assert.ok(!/\[open\]|\[claimed\]/.test(list), "重试耗尽后应当 drop，不留 open");
    },
  );
});

test("bulk: 提示词屏蔽共享 flag 捷径；attended 的 limit 上限仍是 3", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite" },
      worker: async ({ name, board }) => {
        board(["task", "done", taskIdOf(name)]);
      },
    },
    async (h) => {
      h.board(["use", "t-bulk-prompt"]);
      h.seedTask("题一");
      await h.call("muteki_run", { challenge: "t-bulk-prompt" });
      const prompt = h.activations[0].opts.prompt[0].text;
      assert.match(prompt, /不要因为图中已有 flag 就结束/);
      assert.ok(!prompt.includes("如果图中已有 flag，立刻"), "bulk 不应带单题模式的共享 flag 捷径");
    },
  );
  let active = 0;
  let peak = 0;
  await withHarness(
    {
      worker: async ({ name, board }) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(100);
        board(["task", "done", taskIdOf(name)]);
        active -= 1;
      },
    },
    async (h) => {
      h.board(["use", "t-attended-cap"]);
      for (let i = 1; i <= 6; i += 1) h.seedTask(`题${i}`);
      const out = await h.call("muteki_run", { challenge: "t-attended-cap", limit: 9 });
      assert.equal(peak, 3, "attended 单题路径 limit 仍夹在 3");
      assert.equal(out.bulk, undefined);
    },
  );
});
// ── 路径解析：显式 config > config.json > 内置默认（v1.13.0 market bundle 路径）──

test("resolvePaths: 显式值优先，省略回落 config.json，再回落内置默认", { skip: SKIP_REASON }, async () => {
  await withHarness({}, async (h) => {
    const { resolvePaths, readInstallConfig } = h.mod;
    const cfg = { python: "py-cfg", board_py: "B2", storage_dir: "S2" };
    // 手动安装路径：patch 显式给值，config.json 不参与（行为不变）
    const explicit = resolvePaths({ python: "py-x", boardPy: "B", storageDir: "S" }, cfg);
    assert.equal(explicit.python, "py-x");
    assert.equal(explicit.boardPy, "B");
    assert.equal(explicit.storageDir, "S");
    // market bundle 路径：patch 不带路径，回落 config.json
    const fromCfg = resolvePaths({}, cfg);
    assert.equal(fromCfg.python, "py-cfg");
    assert.equal(fromCfg.boardPy, "B2");
    assert.equal(fromCfg.storageDir, "S2");
    // config.json 也没有 → 内置默认
    const defaults = resolvePaths({}, {});
    assert.equal(defaults.python, "python");
    assert.ok(defaults.boardPy.endsWith("board.py"));
    assert.ok(defaults.storageDir.endsWith("artifacts"));
    // 空串/空白视为省略
    const blank = resolvePaths({ python: "  ", boardPy: "", storageDir: "" }, cfg);
    assert.equal(blank.python, "py-cfg");
    assert.equal(blank.boardPy, "B2");
    assert.equal(blank.storageDir, "S2");
    // 其余字段原样保留
    assert.equal(resolvePaths({ mode: "bulk", enabled: true }, cfg).mode, "bulk");
    // readInstallConfig：文件不存在/坏 JSON 都返回 {}
    assert.deepEqual(readInstallConfig(`${h.root}/definitely-missing.json`), {});
  });
});

// ── 首解硬 cancel 全覆盖（v1.13.0）：tick/dispatch 脱管 worker 也被收束 ──────────

test("hard cancel: tick 脱管 worker 写回 flag，哨兵自动收束（无需 run 在场）", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { flagAlert: true },
      worker: async ({ childId, board, cancelled }) => {
        if (childId !== "child-1") return;
        await sleep(1200);
        board(["flag", "flag{watcher}", "--source", "t"]);
        const guard = Date.now() + 8000;
        while (!cancelled() && Date.now() < guard) await sleep(50);
      },
    },
    async (h) => {
      h.board(["use", "t-watch"]);
      h.seedTask("脱管步骤");
      const tick = await h.call("muteki_tick", { limit: 1 });
      assert.equal(tick.dispatched.length, 1);
      const rec = h.activations[0];
      await Promise.race([
        rec.result,
        sleep(8000).then(() => { throw new Error("哨兵没有在 8s 内收束脱管 worker"); }),
      ]);
      assert.ok(rec.interrupted, "哨兵应 interrupt 脱管 worker");
      assert.ok(rec.disposed, "还应发出 dispose 硬收束");
      const lines = readFileSync(h.ledger("flags.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "flag 只落账一次");
      assert.ok(lines[0].includes("flag{watcher}"));
    },
  );
});

test("hard cancel: run 首解时收束全部活 worker（含 tick 先派出的），hardCancel 报数", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { flagAlert: true },
      worker: async ({ childId, board, cancelled }) => {
        const guard = Date.now() + 8000;
        if (childId === "child-1") {
          await sleep(1500);
          board(["flag", "flag{both}", "--source", "t"]);
        }
        while (!cancelled() && Date.now() < guard) await sleep(50);
      },
    },
    async (h) => {
      h.board(["use", "t-cancel-all"]);
      h.seedTask("脱管步骤");
      h.seedTask("run 批次步骤");
      await h.call("muteki_tick", { limit: 1 }); // child-1 脱管
      const out = await h.call("muteki_run", { challenge: "t-cancel-all", limit: 1 }); // child-2
      assert.equal(out.stoppedReason, "flag");
      assert.equal(out.solved, true);
      assert.ok(out.hardCancel, "run 返回应带 hardCancel 收束明细");
      assert.equal(out.hardCancel.cancelled, 2, "tick 脱管 + run 批次共 2 个都应被收束");
      assert.deepEqual(out.hardCancel.errors, []);
      assert.ok(h.activations[0].interrupted, "tick 脱管 worker 应被中断");
      assert.ok(h.activations[1].interrupted, "run 批次 worker 应被中断");
      const lines = readFileSync(h.ledger("flags.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "run 与哨兵共用去重，flag 不重复落账");
    },
  );
});

test("hard cancel: hardCancelOnFlag=false 尊重配置，哨兵不武装", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { hardCancelOnFlag: false, flagAlert: true },
      worker: async ({ board }) => {
        await sleep(300);
        board(["flag", "flag{nocancel}", "--source", "t"]);
      },
    },
    async (h) => {
      h.board(["use", "t-nocancel"]);
      h.seedTask("步骤");
      await h.call("muteki_tick", { limit: 1 });
      await h.activations[0].result;
      await sleep(2500); // 给哨兵（若错误武装）足够时间动手
      assert.ok(!h.activations[0].interrupted, "关闭开关后不应中断");
      assert.ok(!h.activations[0].disposed, "关闭开关后不应 dispose");
      let recorded = true;
      try { readFileSync(h.ledger("flags.jsonl"), "utf8"); } catch { recorded = false; }
      assert.ok(!recorded, "关闭开关后哨兵不落账");
    },
  );
});

test("hard cancel: interrupt 失败不再静默——errors 留痕 + dispose 兜底收束", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { flagAlert: true },
      interruptError: "UNAUTHORIZED（测试注入）",
      worker: async ({ board, cancelled }) => {
        await sleep(300);
        board(["flag", "flag{err}", "--source", "t"]);
        const guard = Date.now() + 8000;
        while (!cancelled() && Date.now() < guard) await sleep(50);
      },
    },
    async (h) => {
      h.board(["use", "t-cancelerr"]);
      h.seedTask("步骤");
      const out = await h.call("muteki_run", { challenge: "t-cancelerr", limit: 1 });
      assert.equal(out.stoppedReason, "flag");
      assert.equal(out.hardCancel.cancelled, 1);
      assert.equal(out.hardCancel.errors.length, 1, "interrupt 失败应进 errors");
      assert.ok(out.hardCancel.errors[0].includes("UNAUTHORIZED"));
      assert.ok(h.activations[0].disposed, "interrupt 失败后 dispose 兜底仍应收束");
      const log = readFileSync(h.ledger("subagents.jsonl"), "utf8");
      assert.ok(log.includes("cancel-errors"), "失败应留痕 subagents.jsonl");
    },
  );
});

test("hard cancel: bulk 不做全局首解收束（别的题还要打）", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { mode: "bulk", tier: "lite", flagAlert: true },
      worker: async ({ childId, board }) => {
        if (childId === "child-1") {
          await sleep(300);
          board(["flag", "flag{bulk1}", "--source", "t"]);
          board(["task", "done", "1"]);
        } else {
          await sleep(1500);
          board(["task", "done", "2"]);
        }
      },
    },
    async (h) => {
      h.board(["use", "t-bulk-nocancel"]);
      h.seedTask("题一");
      h.seedTask("题二");
      const out = await h.call("muteki_run", { challenge: "t-bulk-nocancel" });
      assert.ok(out.bulk, "应走 bulk 路径");
      assert.ok(!h.activations[1].interrupted, "bulk 里慢 worker 不应被首解收束");
      assert.ok(!h.activations[1].disposed);
    },
  );
});

test("hard cancel: muteki_dispatch 自由派单同样被哨兵收束", { skip: SKIP_REASON }, async () => {
  await withHarness(
    {
      config: { flagAlert: true },
      worker: async ({ board, cancelled }) => {
        await sleep(1200);
        board(["flag", "flag{dispatch}", "--source", "t"]);
        const guard = Date.now() + 8000;
        while (!cancelled() && Date.now() < guard) await sleep(50);
      },
    },
    async (h) => {
      h.board(["use", "t-dispatch-watch"]);
      const out = await h.call("muteki_dispatch", { prompt: "自由步骤：背景+预期证据+停止边界" });
      assert.equal(out.kind, "activation");
      await Promise.race([
        h.activations[0].result,
        sleep(8000).then(() => { throw new Error("dispatch worker 未被哨兵收束"); }),
      ]);
      assert.ok(h.activations[0].interrupted, "dispatch 派出的 worker 应被首解收束");
      assert.ok(h.activations[0].disposed);
    },
  );
});
