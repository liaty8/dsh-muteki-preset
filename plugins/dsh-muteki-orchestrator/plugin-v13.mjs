/**
 * muteki-orchestrator — Muteki 蜂群预设的程序化派单层。
 *
 * 挂在 preset-muteki 的 plugins 数组里（agent scope），因此：
 *   - 工具对使用该预设的会话可见；
 *   - execute 收到的 exec.agent 就是调用者本人，能通过 subagents 的
 *     "exact live parent agent" 校验。
 *
 * 提供：
 *   1. muteki_dispatch 工具：认领 lane（可选）→ startActivation 起子代理；
 *   2. muteki_tick 工具：从黑板任务队列取 open 任务，原子认领后批量派单；
 *   3. muteki_run 工具：自动循环 tick，等子代理完成、发现 flag 即停止调度；
 *   4. 子代理生命周期记账（subagents.jsonl）；
 *   5. 额度闸门：派单令牌桶（buckets.json，容量=突发、按小时回填）+ 每小时成本（costs.json）
 *      + 整题累计总闸（totals.json），按 mode（attended 人主导 / unattended 无人值守）取预设，
 *      显式 config 优先；attended 下令牌不足可等待（onQuota）或显式越过（override_quota，留痕）；
 *   6. muteki_cli 工具：用本地 Claude Code CLI（config-worker 干净配置）跑异构 Step。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawnSync, execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "muteki-orchestrator";

export const inject = ["tools"];

export const PRESETS = {
  // attended：人坐在屏幕前主导做题，额度放宽（硬题需要几十上百个 Step），
  //           开局给一大桶突发额度，令牌不够时愿意等一会儿而不是直接停。
  // unattended：无人值守 / 定时任务，额度收紧、不给突发、绝不自作主张等待。
  attended: {
    runsPerHour: 40, costPerHour: 15, runsPerChallenge: 300, costPerChallenge: 50,
    burstRuns: 60, onQuota: "wait", maxWaitMinutes: 10,
  },
  unattended: {
    runsPerHour: 12, costPerHour: 5, runsPerChallenge: 100, costPerChallenge: 15,
    burstRuns: 12, onQuota: "stop", maxWaitMinutes: 0,
  },
};

/** 显式 config 优先于 mode 预设；缺失/非法值回落到预设。导出供测试与文档核对。 */
export const resolveLimits = (config) => {
  const mode = PRESETS[config?.mode] ? config.mode : "attended";
  const preset = PRESETS[mode];
  const pick = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const pickNonNeg = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const onQuota = config?.onQuota === "wait" || config?.onQuota === "stop" ? config.onQuota : preset.onQuota;
  return {
    mode,
    runsPerHour: pick(config?.maxRunsPerHour, preset.runsPerHour),
    costPerHour: pick(config?.maxCostUsdPerHour, preset.costPerHour),
    runsPerChallenge: pick(config?.maxRunsPerChallenge, preset.runsPerChallenge),
    costPerChallenge: pick(config?.maxCostUsdPerChallenge, preset.costPerChallenge),
    burstRuns: pick(config?.burstRuns, preset.burstRuns),
    onQuota,
    maxWaitMinutes: pickNonNeg(config?.maxWaitMinutes, preset.maxWaitMinutes),
  };
};

export const Config = z.object({
  python: z.string().default("python"),
  boardPy: z.string().default(join(homedir(), ".dsh-muteki", "board.py")),
  storageDir: z.string().default(join(homedir(), ".dsh-muteki", "artifacts")),
  mode: z
    .union([z.const("attended"), z.const("unattended")])
    .default("attended")
    .comment("attended=人主导（额度宽、给突发、可等待）；unattended=无人值守/定时任务（额度紧、不等待）"),
  maxRunsPerHour: z
    .number()
    .step(1)
    .min(1)
    .comment("派单令牌的每小时回填速率；省略则用 mode 预设（attended 40 / unattended 12）"),
  burstRuns: z
    .number()
    .step(1)
    .min(1)
    .comment("令牌桶容量=开局可一次性派多少单；省略则用 mode 预设（attended 60 / unattended 12）"),
  onQuota: z
    .union([z.const("wait"), z.const("stop")])
    .comment("muteki_run 令牌不足时：wait=等回填（最多 maxWaitMinutes）；stop=立即停。省略按 mode（attended wait / unattended stop）"),
  maxWaitMinutes: z
    .number()
    .min(0)
    .comment("onQuota=wait 时单次最长等待分钟数；省略按 mode（attended 10 / unattended 0）"),
  maxCostUsdPerHour: z
    .number()
    .comment("每题每小时成本上限（美元，估算口径）；省略则用 mode 预设（attended 15 / unattended 5）"),
  maxRunsPerChallenge: z
    .number()
    .step(1)
    .min(1)
    .comment("整题累计派单总闸（不随小时重置）；省略则用 mode 预设（attended 300 / unattended 100）"),
  maxCostUsdPerChallenge: z
    .number()
    .comment("整题累计成本总闸（美元，不随小时重置）；省略则用 mode 预设（attended 50 / unattended 15）"),
  hardCancelOnFlag: z.boolean().default(true),
  claudeBin: z.string().default("claude"),
  claudeConfigDir: z.string().default(""),
  enabled: z.boolean().default(true),
});

const HOUR = 3600_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function apply(ctx, config) {
  if (!config.enabled) return;

  /** 把模板里的 {{PYTHON}} / {{BOARD}} / {{STORAGE}} 替换成本机配置。 */
  const fillCmd = (text) =>
    String(text)
      .replaceAll("{{PYTHON}}", config.python || "python")
      .replaceAll("{{BOARD}}", config.boardPy || "board.py")
      .replaceAll("{{STORAGE}}", config.storageDir);

  const runsFile = join(config.storageDir, "runs.json");
  const subagentLog = join(config.storageDir, "subagents.jsonl");
  mkdirSync(config.storageDir, { recursive: true });

  const readRuns = () => {
    try {
      const parsed = JSON.parse(readFileSync(runsFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => (typeof x === "number" ? { ts: x, challenge: "" } : x))
        .filter((x) => x && typeof x.ts === "number");
    } catch {
      return [];
    }
  };
  // 额度按「题」独立：只统计当前题最近一小时内的派单，其他题的记录不占本题额度。
  const recentRuns = (challenge) =>
    readRuns().filter((x) => Date.now() - x.ts < HOUR && x.challenge === (challenge ?? ""));
  const recordRun = (challenge) => {
    // 保留 24h 内所有题的记录，切回旧题时额度仍连续；只清理过期项。
    const runs = readRuns().filter((x) => Date.now() - x.ts < 24 * HOUR);
    runs.push({ ts: Date.now(), challenge: challenge ?? "" });
    try {
      writeFileSync(runsFile, JSON.stringify(runs), "utf8");
    } catch {
      /* 账本写不进去不影响派单 */
    }
    bumpTotals(challenge, { runs: 1 });
    consumeToken(challenge);
  };

  // ── 成本记账（CLI 引擎按 Claude Code 上报的 total_cost_usd 累计）──────────
  const costsFile = join(config.storageDir, "costs.json");
  const readCosts = () => {
    try {
      const parsed = JSON.parse(readFileSync(costsFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => (x && typeof x.ts === "number" ? { ...x, challenge: x.challenge ?? "" } : null))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const recentCosts = (challenge) =>
    readCosts().filter((x) => Date.now() - x.ts < HOUR && x.challenge === (challenge ?? ""));
  const totalCost = (challenge) =>
    recentCosts(challenge).reduce((sum, x) => sum + (Number(x.usd) || 0), 0);
  const recordCost = (usd, engine, challenge) => {
    const value = Number(usd) || 0;
    if (value <= 0) return;
    try {
      const all = readCosts().filter((x) => Date.now() - x.ts < 24 * HOUR);
      all.push({ ts: Date.now(), usd: value, engine, challenge: challenge ?? "" });
      writeFileSync(costsFile, JSON.stringify(all), "utf8");
    } catch {
      /* 记账失败不影响结果 */
    }
    bumpTotals(challenge, { usd: value });
  };

  // ── 整题累计总闸（totals.json）──────────────────────────────────────────
  // runs.json / costs.json 只保留 24h（供滚动小时窗口用）。整题总闸要跨小时累计，
  // 所以另记一份不清理的 totals：每小时上限防的是「短时间失控」，整题总闸防的是
  // 「一道题连打八小时把预算烧穿」——后者以前没有任何东西拦得住。
  const totalsFile = join(config.storageDir, "totals.json");
  const readTotals = () => {
    try {
      const parsed = JSON.parse(readFileSync(totalsFile, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const totalsFor = (challenge) => {
    const row = readTotals()[challenge ?? ""] || {};
    return { runs: Number(row.runs) || 0, usd: Number(row.usd) || 0 };
  };
  const bumpTotals = (challenge, delta) => {
    try {
      const all = readTotals();
      const key = challenge ?? "";
      const cur = all[key] || {};
      all[key] = {
        runs: (Number(cur.runs) || 0) + (delta.runs || 0),
        usd: Number(((Number(cur.usd) || 0) + (delta.usd || 0)).toFixed(6)),
        since: cur.since || Date.now(),
        updated: Date.now(),
      };
      mkdirSync(config.storageDir, { recursive: true });
      writeFileSync(totalsFile, JSON.stringify(all), "utf8");
    } catch {
      /* 记账失败不影响派单 */
    }
  };

  // ── 令牌桶（buckets.json）──────────────────────────────────────────────
  // 滚动小时窗口是「悬崖」：打满上限后最坏要干等 60 分钟才腾出 1 个额度。
  // 令牌桶把速率限制变成「容量 + 回填」：开局能一次性派 burstRuns 个，把 recon
  // 与第一轮 exp 全铺出去，之后按 runsPerHour 持续供给，没有悬崖。
  const bucketsFile = join(config.storageDir, "buckets.json");
  const readBuckets = () => {
    try {
      const parsed = JSON.parse(readFileSync(bucketsFile, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const bucketFor = (challenge) => {
    const limits = resolveLimits(config);
    const row = readBuckets()[challenge ?? ""] || {};
    const capacity = limits.burstRuns;
    const stored =
      typeof row.tokens === "number" && Number.isFinite(row.tokens) ? row.tokens : capacity;
    const updated = Number(row.updated) || Date.now();
    const elapsed = Math.max(0, Date.now() - updated);
    const tokens = Math.min(capacity, stored + (elapsed / HOUR) * limits.runsPerHour);
    return { tokens, capacity, refillPerHour: limits.runsPerHour };
  };
  const saveBucket = (challenge, tokens) => {
    try {
      const all = readBuckets();
      all[challenge ?? ""] = { tokens: Number(tokens.toFixed(6)), updated: Date.now() };
      mkdirSync(config.storageDir, { recursive: true });
      writeFileSync(bucketsFile, JSON.stringify(all), "utf8");
    } catch {
      /* 记账失败不影响派单 */
    }
  };
  const consumeToken = (challenge) => {
    const bucket = bucketFor(challenge);
    saveBucket(challenge, Math.max(0, bucket.tokens - 1));
  };
  /** 还差多少毫秒才回填出 need 个令牌（0 = 现在就够）。 */
  const tokenWaitMs = (challenge, need = 1) => {
    const bucket = bucketFor(challenge);
    if (bucket.tokens >= need) return 0;
    return Math.ceil(((need - bucket.tokens) / bucket.refillPerHour) * HOUR);
  };

  const LIMIT_LABELS = {
    tokens: "派单令牌",
    costPerHour: "每小时成本($)",
    runsPerChallenge: "整题累计派单",
    costPerChallenge: "整题累计成本($)",
  };

  /** 统一额度判定：dispatch / tick / run / cli 四个闸门都用它，避免口径分叉。 */
  const quotaState = (challenge) => {
    const limits = resolveLimits(config);
    const bucket = bucketFor(challenge);
    const runsHour = recentRuns(challenge).length;
    const costHour = totalCost(challenge);
    const totals = totalsFor(challenge);
    const hits = [];
    if (bucket.tokens < 1) {
      hits.push({
        limit: "tokens",
        used: Number(bucket.tokens.toFixed(2)),
        cap: bucket.capacity,
        waitMs: tokenWaitMs(challenge),
      });
    }
    if (costHour >= limits.costPerHour) {
      hits.push({ limit: "costPerHour", used: Number(costHour.toFixed(4)), cap: limits.costPerHour });
    }
    if (totals.runs >= limits.runsPerChallenge) {
      hits.push({ limit: "runsPerChallenge", used: totals.runs, cap: limits.runsPerChallenge });
    }
    if (totals.usd >= limits.costPerChallenge) {
      hits.push({ limit: "costPerChallenge", used: Number(totals.usd.toFixed(4)), cap: limits.costPerChallenge });
    }
    return {
      ok: hits.length === 0,
      hits,
      limits,
      bucket,
      runsHour,
      costHour,
      runsTotal: totals.runs,
      costTotal: totals.usd,
    };
  };

  const quotaSummary = (state) => ({
    mode: state.limits.mode,
    tokens: Number(state.bucket.tokens.toFixed(2)),
    burstRuns: state.bucket.capacity,
    runsPerHour: state.limits.runsPerHour,
    onQuota: state.limits.onQuota,
    maxWaitMinutes: state.limits.maxWaitMinutes,
    runsHour: state.runsHour,
    runsTotal: state.runsTotal,
    runsPerChallenge: state.limits.runsPerChallenge,
    costHour: Number(state.costHour.toFixed(4)),
    costPerHour: state.limits.costPerHour,
    costTotal: Number(state.costTotal.toFixed(4)),
    costPerChallenge: state.limits.costPerChallenge,
    limitHit: state.hits.map((hit) => hit.limit).join(","),
  });

  const quotaMessage = (challenge, state) => {
    const parts = state.hits.map((hit) =>
      hit.limit === "tokens"
        ? `派单令牌 ${hit.used}/${hit.cap}（按 ${state.limits.runsPerHour} 次/小时回填，约 ` +
          `${Math.max(1, Math.ceil((hit.waitMs || 0) / 60000))} 分钟后有 1 个）`
        : `${LIMIT_LABELS[hit.limit]} ${hit.used}/${hit.cap}`,
    );
    const tokens = state.hits.some((hit) => hit.limit === "tokens");
    const hourly = state.hits.some((hit) => hit.limit === "costPerHour");
    const total = state.hits.some((hit) => hit.limit.endsWith("PerChallenge"));
    return (
      `额度已用尽（题 ${challenge}，模式 ${state.limits.mode}）：${parts.join("；")}。` +
      (tokens
        ? "令牌会持续回填：muteki_run 在 onQuota=wait 时会自动等；手动派单可带 override_quota=true 越过本轮速率限制（仅 attended）。"
        : "") +
      (hourly ? "每小时成本上限等窗口滚动就会恢复。" : "") +
      (total
        ? "整题总闸不随时间恢复、也不能被 override_quota 越过：换一道新题（不继承本题额度），或在配置里提高 maxRunsPerChallenge / maxCostUsdPerChallenge。"
        : "")
    );
  };

  const quotaSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string" },
      tokens: { type: "number" },
      burstRuns: { type: "number" },
      runsPerHour: { type: "number" },
      onQuota: { type: "string" },
      maxWaitMinutes: { type: "number" },
      runsHour: { type: "number" },
      runsTotal: { type: "number" },
      runsPerChallenge: { type: "number" },
      costHour: { type: "number" },
      costPerHour: { type: "number" },
      costTotal: { type: "number" },
      costPerChallenge: { type: "number" },
      limitHit: { type: "string" },
    },
  };

  /** 越过速率限制要留痕：黑板写一条 observation（无证据，不算事实）+ 一行账本。 */
  const logOverride = (challenge, cwd, reason) => {
    try {
      runBoard(
        [
          "fact",
          "额度越过（人工授权）",
          `题 ${challenge} 显式 override_quota：${reason}。只越过派单速率限制，成本与整题总闸仍然生效。`,
        ],
        cwd,
      );
    } catch {
      /* 留痕失败不阻断派单 */
    }
    try {
      mkdirSync(config.storageDir, { recursive: true });
      appendFileSync(
        join(config.storageDir, "overrides.jsonl"),
        JSON.stringify({ ts: Date.now(), challenge: challenge ?? "", reason }) + "\n",
        "utf8",
      );
    } catch {
      /* 同上 */
    }
  };

  /**
   * 取额度；令牌不足时按 onQuota 决定等还是停（只有 allowWait=true 的调用方会等）。
   * 只有「派单令牌」这一条可等待 / 可越过；成本与整题总闸是钱的闸，绝不放宽。
   */
  const ensureQuota = async (challenge, args, exec, cwd, allowWait = false) => {
    let state = quotaState(challenge);
    if (state.ok) return { state, waitedMs: 0, overridden: false, overrideNote: "" };
    const onlyTokens = state.hits.every((hit) => hit.limit === "tokens");

    if (args?.override_quota === true) {
      // 不抛异常：让调用方按「额度不足」正常停/拒，并把原因带出去。
      // 否则 run 跑到一半撞上钱的闸时会整个工具报错，而不是优雅收束。
      if (state.limits.mode !== "attended") {
        return {
          state, waitedMs: 0, overridden: false,
          overrideNote: "override_quota 只在 mode=attended（人主导）下可用；无人值守模式不允许越过额度。",
        };
      }
      if (!onlyTokens) {
        return {
          state, waitedMs: 0, overridden: false,
          overrideNote: "override_quota 只能越过派单速率限制，不能越过成本/整题总闸。",
        };
      }
      logOverride(challenge, cwd, args.override_reason || "人工显式授权越过本轮速率限制");
      return { state: { ...state, ok: true }, waitedMs: 0, overridden: true, overrideNote: "" };
    }

    let waitedMs = 0;
    if (allowWait && onlyTokens && state.limits.onQuota === "wait" && state.limits.maxWaitMinutes > 0) {
      const capMs = Math.round(state.limits.maxWaitMinutes * 60_000);
      const deadline = Date.now() + Math.min(tokenWaitMs(challenge), capMs);
      const began = Date.now();
      while (Date.now() < deadline) {
        if (exec?.signal?.aborted) break;
        await sleep(Math.min(1000, Math.max(20, deadline - Date.now())));
        if (quotaState(challenge).ok) break;
      }
      waitedMs = Date.now() - began;
      state = quotaState(challenge);
    }
    return { state, waitedMs, overridden: false, overrideNote: "" };
  };

  const overrideParams = {
    override_quota: {
      type: "boolean",
      description:
        "仅 mode=attended（人主导）有效：显式越过本轮派单速率限制（令牌不足）。" +
        "不能越过成本上限与整题总闸。会往黑板写一条 observation 并记 overrides.jsonl 留痕。",
    },
    override_reason: {
      type: "string",
      description: "越过额度的原因（写进留痕，便于复盘）。",
    },
  };

  const logSubagent = (kind, info) => {
    try {
      appendFileSync(
        subagentLog,
        JSON.stringify({ kind, ts: new Date().toISOString(), ...info }) + "\n",
        "utf8",
      );
    } catch {
      /* 记账失败不应中断子代理 */
    }
  };
  ctx.on("subagent/start", (info) => logSubagent("start", info));
  ctx.on("subagent/end", (info) => logSubagent("end", info));

  const runBoard = (argv, cwd) => {
    const run = spawnSync(config.python, [config.boardPy, ...argv], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return { status: run.status ?? 1, out: `${run.stdout || ""}${run.stderr || ""}`.trim() };
  };

  const openTasks = (cwd) => {
    const run = runBoard(["task", "list", "--status", "open", "--json"], cwd);
    if (run.status !== 0) throw new Error(`读取任务队列失败：${run.out}`);
    try {
      const parsed = JSON.parse(run.out || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error(`任务队列 JSON 解析失败：${run.out.slice(0, 200)}`);
    }
  };

  const boardJson = (cwd) => {
    const run = runBoard(["context", "--json"], cwd);
    if (run.status !== 0) return null;
    try {
      return JSON.parse(run.out);
    } catch {
      return null;
    }
  };

  const knownFlags = (cwd) => {
    const data = boardJson(cwd);
    return Array.isArray(data?.flags) ? data.flags : [];
  };

  const currentChallenge = (cwd) => {
    const run = runBoard(["current"], cwd);
    return run.status === 0 ? run.out.trim() || "default" : "default";
  };

  const flagValue = (flag) =>
    typeof flag === "string" ? flag : String(flag?.value ?? flag?.flag ?? flag);

  const openReviews = (cwd) => {
    const run = runBoard(["review", "list", "--status", "open", "--json"], cwd);
    if (run.status !== 0) return [];
    try {
      const parsed = JSON.parse(run.out || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const openReviewIds = (cwd) => openReviews(cwd).map((row) => row.id);
  const reviewRow = (cwd, id) => openReviews(cwd).find((row) => row.id === id);

  const agentOptionsFor = (args) => {
    const options = {};
    if (args.provider && args.model) {
      options.provider = args.provider;
      options.model = args.model;
      if (args.reasoning_effort) options.reasoningEffort = args.reasoning_effort;
    }
    return options;
  };

  const workerPrompt = (task, contextText, challenge) => fillCmd(`你是 Muteki 蜂群的一名 Worker，只执行下面这一个有界 Step。

当前题：${challenge || "default"}（黑板已按题隔离；你的所有 board.py 命令都只作用于这道题，不会看到旧题的结论）

## 团队黑板（只读摘要）
${contextText}

## 你的任务
任务编号：t${task.id}
标题：${task.title}
详情：${task.detail || "（无）"}

## 硬要求
1. 开始前先跑一次 \`board.py context\`：如果图中已有 flag，立刻 \`board.py task done ${task.id}\` 并结束，不要重复劳动。
2. 只推进这个任务；每条结论都要有真实工具输出作为证据。
3. 结束前用黑板记录（命令行，命令说明见 muteki-board 技能）：
   - 有证据的新结论：\`{{PYTHON}} {{BOARD}} fact "<标题>" "<本 Step 的增量结论>" --artifact <证据id>\`
     证据 id 必须先用 \`board.py artifact list\` 查真实存在的 a 开头 id；伪造会被 exit 2 拒绝。
   - 实测排除的方向：\`board.py deadend "<原因>" --tested "<测试范围>" --observed "<实际结果>"\`
   - 候选 flag：\`board.py flag "<值>" --source "<来源>"\`
   - 完成后：\`board.py task done ${task.id}\`
4. 不写没有证据的"事实"；不确定的内容省略 --artifact（会记为 observation）。
5. 提交完立即结束，不要续做别的任务。`);

  /** 认领并派发一个任务；返回 activation 或 null（认领失败）。 */
  const dispatchTask = async (task, parent, exec, cwd, args, contextText, challenge) => {
    const claim = runBoard(["task", "claim", String(task.id), "--owner", parent.id], cwd);
    if (claim.status !== 0) return null;
    const activation = await ctx.get("subagents").startActivation({
      provider: "spawn",
      label: `tick-t${task.id}`,
      prompt: [{ type: "text", text: workerPrompt(task, contextText, challenge) }],
      parent,
      signal: exec.signal,
      delivery: "parent",
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(Object.keys(agentOptionsFor(args)).length
        ? { agentOptions: agentOptionsFor(args) }
        : {}),
    });
    recordRun(challenge);
    return activation;
  };

  ctx.tools.register(defineTool({
    name: "muteki_dispatch",
    description:
      "派发一个 Muteki 子代理执行一个有界 Step。可选先认领 lane（同一目标同时只允许一个执行者），" +
      "并受额度闸门约束（每小时派单/成本 + 整题累计总闸，按 mode 取预设）。子代理是全新上下文，不会继承当前会话历史；" +
      "任务描述要自带背景、预期证据和停止边界。",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description:
          "交给子代理的完整任务：背景、要回答的问题、预期可观察证据、停止边界。" +
          "子代理看不到当前会话，必须自包含。",
      },
      name: {
        type: "string",
        description: "子代理短名：小写字母/数字/连字符，最多 32 字符；省略时自动生成。",
      },
      lane: {
        type: "string",
        description: "可选：先认领的资源 lane（如 target-1.2.3.4:80、challenge-web-01）。认领失败则不派单。",
      },
      lane_ttl: {
        type: "number",
        description: "lane 认领的有效秒数，默认 900。",
      },
      provider: {
        type: "string",
        description: "子代理 LLM provider id（与 model 同时提供才生效）。",
      },
      model: {
        type: "string",
        description: "子代理 model id（与 provider 同时提供才生效）。",
      },
      reasoning_effort: {
        type: "string",
        description: "子代理思考强度 id（requires provider + model）。",
      },
      cwd: {
        type: "string",
        description: "子代理工作目录；也决定 board.py 使用哪个工作区级黑板。",
      },
      ...overrideParams,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "activation" },
          childId: { type: "string", required: true },
          name: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `已派发子代理 ${value.name}（${value.childId}）` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) {
        throw new Error("muteki_dispatch 需要一个调用者 agent（exec.agent 为空）");
      }
      const subagents = ctx.get("subagents");
      if (!subagents) {
        throw new Error("muteki_dispatch 需要 subagents 服务，但当前 scope 不可用");
      }

      const cwd = args.cwd || process.cwd();
      const challenge = currentChallenge(cwd);

      const { state: quota, overrideNote } = await ensureQuota(challenge, args, exec, cwd, false);
      if (!quota.ok) {
        throw new Error(
          `muteki_dispatch ${quotaMessage(challenge, quota)}${overrideNote ? ` ${overrideNote}` : ""}`,
        );
      }

      if (args.lane) {
        if (!existsSync(config.boardPy)) {
          throw new Error(`lane 认领失败：找不到 board.py（${config.boardPy}）`);
        }
        const claimed = spawnSync(
          config.python,
          [
            config.boardPy,
            "claim",
            args.lane,
            "--owner",
            parent.id,
            "--ttl",
            String(args.lane_ttl ?? 900),
            "--note",
            (args.name || args.prompt.slice(0, 60)).replace(/\s+/g, " "),
          ],
          { cwd, encoding: "utf8", windowsHide: true },
        );
        if (claimed.status !== 0) {
          const detail = `${claimed.stdout || ""}${claimed.stderr || ""}`.trim();
          throw new Error(`lane 认领失败：${detail || `exit ${claimed.status}`}`);
        }
      }

      const activation = await subagents.startActivation({
        provider: "spawn",
        label: args.name || "muteki-worker",
        ...(args.name ? { name: args.name } : {}),
        prompt: [{ type: "text", text: args.prompt }],
        parent,
        signal: exec.signal,
        delivery: "parent",
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(Object.keys(agentOptionsFor(args)).length
          ? { agentOptions: agentOptionsFor(args) }
          : {}),
      });

      recordRun(challenge);
      return { kind: "activation", childId: activation.childId, name: activation.name };
    },
  }));

  ctx.tools.register(defineTool({
    name: "muteki_tick",
    description:
      "驱动一轮 Muteki 调度：从黑板任务队列取最高优先级的 open 任务（最多 limit 个），" +
      "原子认领后各派一个全新上下文的子代理执行，返回派单结果。子代理结束后会把结论写回黑板并把任务标 done。",
    parameters: {
      limit: {
        type: "number",
        description: "本轮最多派几个任务，1-3，默认 2。",
      },
      cwd: {
        type: "string",
        description: "黑板工作目录（决定用哪个工作区的 board.db），默认当前进程目录。",
      },
      ...overrideParams,
      provider: {
        type: "string",
        description: "子代理 LLM provider id（与 model 同时提供才生效）。",
      },
      model: {
        type: "string",
        description: "子代理 model id（与 provider 同时提供才生效）。",
      },
      reasoning_effort: {
        type: "string",
        description: "子代理思考强度 id（requires provider + model）。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "tick" },
          dispatched: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: "number", required: true },
                childId: { type: "string", required: true },
                name: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.dispatched.length
            ? `本轮派发 ${value.dispatched.length} 个任务：` +
              value.dispatched.map((item) => `t${item.taskId}→${item.name}`).join("、")
            : "任务队列里没有可派发的 open 任务。",
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("muteki_tick 需要一个调用者 agent（exec.agent 为空）");
      const subagents = ctx.get("subagents");
      if (!subagents) throw new Error("muteki_tick 需要 subagents 服务，但当前 scope 不可用");
      const cwd = args.cwd || process.cwd();
      const limit = Math.max(1, Math.min(3, args.limit ?? 2));
      const tasks = openTasks(cwd).slice(0, limit);
      if (tasks.length === 0) return { kind: "tick", dispatched: [] };

      const context = runBoard(["context"], cwd);
      const contextText = context.out.slice(0, 6000);
      const challenge = currentChallenge(cwd);

      const dispatched = [];
      for (const task of tasks) {
        const { state } = await ensureQuota(challenge, args, exec, cwd, false);
        if (!state.ok) break;
        const activation = await dispatchTask(task, parent, exec, cwd, args, contextText, challenge);
        if (!activation) continue;
        dispatched.push({
          taskId: task.id,
          childId: activation.childId,
          name: activation.name,
        });
      }
      return { kind: "tick", dispatched };
    },
  }));

  ctx.tools.register(defineTool({
    name: "muteki_run",
    description:
      "自动循环驱动 Muteki 蜂群：反复从任务队列认领 open 任务并派子代理，等这一批完成后检查黑板，" +
      "队列空、出现 flag、超时或额度用尽就停止，返回 stoppedReason、quota 明细与 resumeAt。" +
      "派单速率用令牌桶（开局可突发 burstRuns 个，之后按 maxRunsPerHour 回填）；" +
      "onQuota=wait 时令牌不足会等回填（最多 maxWaitMinutes），attended 下也可带 override_quota=true 显式越过速率限制（留痕，不越过成本/整题总闸）。" +
      "适合「给一批任务，自己跑到出结果」。",
    parameters: {
      challenge: {
        type: "string",
        description:
          "本轮题名（如 web-8080）。开工前会执行 board.py use 切到这道题，" +
          "旧题的 fact/deadend/task/flag 全部不可见，不会污染本轮首解判定。" +
          "省略时自动生成 run-<时间戳>。",
      },
      max_minutes: {
        type: "number",
        description: "最长运行分钟数，默认 20，上限 120。",
      },
      max_rounds: {
        type: "number",
        description: "最多轮数，默认 10，上限 50。",
      },
      limit: {
        type: "number",
        description: "每轮最多并行派几个子代理，1-3，默认 2。",
      },
      cwd: {
        type: "string",
        description: "黑板工作目录（决定用哪个工作区的 board.db），默认当前进程目录。",
      },
      ...overrideParams,
      provider: {
        type: "string",
        description: "子代理 LLM provider id（与 model 同时提供才生效）。",
      },
      model: {
        type: "string",
        description: "子代理 model id（与 provider 同时提供才生效）。",
      },
      reasoning_effort: {
        type: "string",
        description: "子代理思考强度 id（requires provider + model）。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "run" },
          challenge: { type: "string", required: true },
          rounds: { type: "number", required: true },
          dispatched: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: "number", required: true },
                childId: { type: "string", required: true },
                name: { type: "string", required: true },
              },
            },
          },
          flags: {
            type: "array",
            required: true,
            items: { type: "string" },
          },
          stoppedReason: { type: "string", required: true },
          quota: quotaSchema,
          resumeAt: { type: "number" },
          waitedMs: { type: "number" },
          overridden: { type: "boolean" },
          overrideNote: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            `muteki_run 结束（题 ${value.challenge}，${value.stoppedReason}）：${value.rounds} 轮，` +
            `派发 ${value.dispatched.length} 个子代理` +
            (value.flags.length ? `，本轮新 flag：${value.flags.join(", ")}` : "") +
            (value.waitedMs ? `，等令牌 ${Math.round(value.waitedMs / 1000)}s` : "") +
            (value.overridden ? "，本轮显式越过速率限制（已留痕）" : "") +
            (value.quota
              ? `\n额度（${value.quota.mode}）：令牌 ${value.quota.tokens}/${value.quota.burstRuns}` +
                `（回填 ${value.quota.runsPerHour} 次/h，${value.quota.onQuota}）；` +
                `整题 ${value.quota.runsTotal}/${value.quota.runsPerChallenge} 次、` +
                `$${value.quota.costTotal}/${value.quota.costPerChallenge}；` +
                `每小时成本 $${value.quota.costHour}/${value.quota.costPerHour}` +
                (value.quota.limitHit ? `（命中 ${value.quota.limitHit}）` : "")
              : "") +
            (value.overrideNote ? `\n${value.overrideNote}` : "") +
            (value.resumeAt
              ? `\n约 ${new Date(value.resumeAt).toLocaleTimeString()} 回填出下一个令牌；要继续可再跑一次 muteki_run，或带 override_quota=true（仅 attended、只越过速率限制）。`
              : ""),
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("muteki_run 需要一个调用者 agent（exec.agent 为空）");
      const subagents = ctx.get("subagents");
      if (!subagents) throw new Error("muteki_run 需要 subagents 服务，但当前 scope 不可用");
      const cwd = args.cwd || process.cwd();
      const limit = Math.max(1, Math.min(3, args.limit ?? 2));
      const maxRounds = Math.max(1, Math.min(50, args.max_rounds ?? 10));
      const maxMs = Math.max(1, Math.min(120, args.max_minutes ?? 20)) * 60_000;
      const started = Date.now();

      // 按题隔离：开工前切到本轮题名，旧题数据全部不可见；
      // 再快照现有 flag 作为 baseline，只有本轮新出现的 flag 才算首解。
      const challenge =
        String(args.challenge || "").trim() ||
        `run-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
      const used = runBoard(["use", challenge], cwd);
      if (used.status !== 0) {
        throw new Error(`切换题名 ${challenge} 失败：${used.out.slice(0, 200)}`);
      }
      const baseline = new Set(knownFlags(cwd).map(flagValue));
      const freshFlags = () =>
        knownFlags(cwd).filter((flag) => !baseline.has(flagValue(flag)));

      const dispatched = [];
      let rounds = 0;
      let stoppedReason = "empty";
      let waitedMs = 0;
      let overridden = false;
      let overrideNote = "";

      // 开工前回收「上一个会话中断后卡在 claimed」的任务，否则队列会一直是空的。
      try {
        runBoard(["task", "reclaim", "--minutes", "30"], cwd);
      } catch {
        /* 没有卡住的任务时这条命令只打印提示，不影响派单 */
      }

      try {
        while (rounds < maxRounds) {
        if (Date.now() - started > maxMs) {
          stoppedReason = "timeout";
          break;
        }
        const gate = await ensureQuota(challenge, args, exec, cwd, true);
        waitedMs += gate.waitedMs;
        overridden = overridden || gate.overridden;
        overrideNote = gate.overrideNote || overrideNote;
        if (!gate.state.ok) {
          stoppedReason = "budget";
          break;
        }
        // 本轮批次内的额度判定：override 只放宽「派单令牌」，成本与整题总闸照常拦。
        const roundQuotaOk = () => {
          const state = quotaState(challenge);
          if (state.ok) return true;
          return gate.overridden && state.hits.every((hit) => hit.limit === "tokens");
        };
        const tasks = openTasks(cwd).slice(0, limit);
        if (tasks.length === 0) {
          stoppedReason = "empty";
          break;
        }

        rounds += 1;
        const context = runBoard(["context"], cwd);
        const contextText = context.out.slice(0, 6000);
        const batch = [];
        for (const task of tasks) {
          if (!roundQuotaOk()) break;
          const activation = await dispatchTask(
            task,
            parent,
            exec,
            cwd,
            args,
            contextText,
            challenge,
          );
          if (!activation) continue;
          batch.push({ task, activation });
          dispatched.push({
            taskId: task.id,
            childId: activation.childId,
            name: activation.name,
          });
        }
        if (batch.length === 0) {
          stoppedReason = "empty";
          break;
        }

        // 等这一批：正常完成，或任一子代理写回 flag 后立即中断其余（首解硬 cancel）。
        let batchDone = false;
        const resultsPromise = Promise.allSettled(batch.map((item) => item.activation.result)).then(() => {
          batchDone = true;
        });
        const flagPromise = (async () => {
          while (!batchDone) {
            await sleep(2000);
            if (freshFlags().length > 0) return true;
          }
          return freshFlags().length > 0;
        })();
        const winner = await Promise.race([
          resultsPromise.then(() => "done"),
          flagPromise.then((hit) => (hit ? "flag" : "done")),
        ]);
        if (winner === "flag") {
          if (config.hardCancelOnFlag !== false) {
            for (const item of batch) {
              try {
                subagents.interrupt(item.activation.childId, { kind: "ancestor", agent: parent });
              } catch {
                /* 已完成或已释放的子代理：中断是可接受的 no-op */
              }
            }
          }
          stoppedReason = "flag";
          break;
        }

        const flags = freshFlags();
        if (flags.length > 0) {
          stoppedReason = "flag";
          break;
        }
        if (Date.now() - started > maxMs) {
          stoppedReason = "timeout";
          break;
        }
        // 额度不在这里判：回到循环顶部由 ensureQuota 统一处理（onQuota=wait 时会等令牌回填）。
        // 若在这里直接 budget 停掉，刚派完一批就退出，等待机制永远没机会生效。
        await sleep(500);
      }

      if (rounds >= maxRounds && stoppedReason === "empty") {
        const tasks = openTasks(cwd);
        if (tasks.length > 0) stoppedReason = "rounds";
      }

      const exitQuota = quotaState(challenge);
      const tokenHit = exitQuota.hits.find((hit) => hit.limit === "tokens");
      return {
        kind: "run",
        challenge,
        rounds,
        dispatched,
        flags: freshFlags().map(flagValue),
        stoppedReason,
        quota: quotaSummary(exitQuota),
        resumeAt: tokenHit ? Date.now() + (tokenHit.waitMs || 0) : 0,
        waitedMs,
        overridden,
        overrideNote,
      };
      } finally {
        // 无论正常结束、超时还是被用户中断，都把本轮「派出但没做完」的任务
        // 释放回 open，避免任务卡死在 claimed 让下一轮 muteki_run 取到空队列。
        for (const item of dispatched) {
          try {
            runBoard(["task", "reopen", String(item.taskId)], cwd);
          } catch {
            /* 已完成（done）的任务 reopen 会失败，属正常 */
          }
        }
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: "muteki_review",
    description:
      "起一个只读 Reviewer 子代理审当前黑板：质疑没有证据的结论、指出重复、找验证缺口，" +
      "并把意见写回黑板（review add）。它不碰目标、不执行攻击命令；审完返回本次新增意见。",
    parameters: {
      cwd: {
        type: "string",
        description: "黑板工作目录（决定审哪个工作区），默认当前进程目录。",
      },
      focus: {
        type: "string",
        description: "可选：本次重点审什么，例如「只看 web 链路的事实是否真有证据」。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "review" },
          childId: { type: "string", required: true },
          name: { type: "string", required: true },
          created: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "number", required: true },
                kind: { type: "string", required: true },
                note: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.created.length
            ? `Reviewer 写了 ${value.created.length} 条意见：` +
              value.created.map((item) => `r${item.id}[${item.kind}]`).join("、")
            : "Reviewer 没有发现需要记录的问题。",
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) {
        throw new Error("muteki_review 需要一个调用者 agent（exec.agent 为空）");
      }
      const subagents = ctx.get("subagents");
      if (!subagents) {
        throw new Error("muteki_review 需要 subagents 服务，但当前 scope 不可用");
      }
      const cwd = args.cwd || process.cwd();
      const before = new Set(openReviewIds(cwd));
      const board = runBoard(["context"], cwd);
      const boardText = board.out.slice(0, 8000);
      const challenge = boardJson(cwd)?.challenge || currentChallenge(cwd);
      const focus = args.focus ? `4. 本次重点：${args.focus}\n` : "";

      const prompt = fillCmd(`你是 Muteki 蜂群的 Reviewer（只读审图者）。
你只审黑板上的结论，不接触目标、不执行攻击命令、不修改黑板以外的任何东西。

当前题：${challenge}（黑板已按题隔离；只审这道题，不要引入旧题的结论）

## 当前黑板
${boardText}

## 你的职责
1. 质疑证据不足：observation 被当结论用、fact 的证据与内容对不上、来源不明。
2. 指出重复：同一结论换了措辞写了两遍（指出 target）。
3. 找验证缺口：哪些结论只是猜测、哪些方向没被测过、哪些 flag 候选没验证。
${focus}
## 输出方式（必须用命令行写回黑板，不能只写在回复里）
每条意见一条命令：
{{PYTHON}} {{BOARD}} review add --kind challenge --target f3 --note "<具体质疑>"
{{PYTHON}} {{BOARD}} review add --kind merge --target f5 --note "<与 f4 重复>"
{{PYTHON}} {{BOARD}} review add --kind gap --note "<缺什么验证>"
最多 6 条；没有问题就不要写。完成后回复一句：写了 N 条复核意见。`);

      const activation = await subagents.startActivation({
        provider: "spawn",
        label: "review",
        prompt: [{ type: "text", text: prompt }],
        parent,
        signal: exec.signal,
        delivery: "parent",
        cwd,
      });

      try {
        await activation.result;
      } catch {
        /* 审图失败也要把已经写进去的意见带回来 */
      }

      const created = openReviewIds(cwd)
        .filter((id) => !before.has(id))
        .map((id) => {
          const row = reviewRow(cwd, id);
          return { id, kind: row?.kind || "gap", note: row?.note || "" };
        });

      return { kind: "review", childId: activation.childId, name: activation.name, created };
    },
  }));

  // ── muteki_cli：用本地 Claude Code CLI 跑一个异构 Step ────────────────────
  ctx.tools.register(defineTool({
    name: "muteki_cli",
    description:
      "用本地 Claude Code CLI（独立 config-worker 配置、DeepSeek 后端、无插件无记忆）跑一个自包含 Step，" +
      "返回它的最终输出与本次花费。用于与 DSH 子代理做异构竞速：同一道题让不同引擎各打一遍，" +
      "结论仍写回同一块黑板。注意它是独立进程，不占 subagents 席位。",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description:
          "完整自包含的任务。必须告诉它：先用 board.py context 读黑板、只推进这一条、" +
          "结论用 board.py fact --artifact 写回、结束后 task done。",
      },
      cwd: { type: "string", description: "工作目录（决定黑板库与附件位置），默认当前目录。" },
      timeout_minutes: {
        type: "number",
        description: "超时分钟数，默认 5，范围 1-30。",
      },
      model: { type: "string", description: "可选：传给 claude 的模型 id，默认由 config-worker 决定（deepseek-flash）。" },
      ...overrideParams,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "cli" },
          exitCode: { type: "number", required: true },
          result: { type: "string", required: true },
          costUsd: { type: "number", required: true },
          stopped: { type: "string", required: true },
          ms: { type: "number", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: [
            `muteki_cli 结束（已调用 Claude Code CLI）：exit ${value.exitCode}，花费 $${value.costUsd.toFixed(4)}，状态 ${value.stopped}，耗时 ${value.ms}ms。`,
            value.result ? `输出：\n${value.result.slice(0, 400)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = args.cwd || process.cwd();
      const challenge = currentChallenge(cwd);
      const { state: quota, overrideNote } = await ensureQuota(challenge, args, exec, cwd, false);
      if (!quota.ok) {
        throw new Error(
          `muteki_cli ${quotaMessage(challenge, quota)}${overrideNote ? ` ${overrideNote}` : ""}`,
        );
      }
      if (!existsSync(config.claudeBin)) {
        throw new Error(`找不到 Claude Code CLI：${config.claudeBin}`);
      }
      const timeoutMs = Math.max(1, Math.min(30, args.timeout_minutes ?? 5)) * 60_000;
      const prompt = String(args.prompt || "").slice(0, 24_000);
      const argv = ["-p", prompt, "--output-format", "json"];
      if (args.model) argv.push("--model", String(args.model));

      const startedAt = Date.now();
      // 必须异步执行：spawnSync 会同步阻塞整个 DSH 主进程（Electron 单线程），
      // 上一版在 CLI 长时间不返回时表现为 UI 卡死、看不到结果、最终被强制重启。
      const run = await new Promise((resolve) => {
        execFile(
          config.claudeBin,
          argv,
          {
            cwd,
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
            killSignal: "SIGKILL",
            env: { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir, NO_COLOR: "1" },
          },
          (error, stdout, stderr) => {
            resolve({
              error,
              stdout,
              stderr,
              status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            });
          },
        );
      });

      if (
        run.error &&
        run.error.code !== "ETIMEDOUT" &&
        run.error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ) {
        throw new Error(`claude 启动失败：${run.error.message}`);
      }

      const stdout = `${run.stdout || ""}`.trim();
      const stderr = `${run.stderr || ""}`.trim();
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const text = String(parsed?.result ?? parsed?.content ?? stdout ?? "").trim();
      const costUsd = Number(parsed?.total_cost_usd ?? parsed?.cost_usd ?? 0) || 0;
      const timedOut = Boolean(run.error && (run.error.killed || run.error.code === "ETIMEDOUT"));
      const stopped = timedOut ? "timeout" : run.status === 0 ? "completed" : "error";
      recordCost(costUsd, "claude-cli", challenge);
      recordRun(challenge);
      try {
        mkdirSync(config.storageDir, { recursive: true });
        appendFileSync(
          join(config.storageDir, "cli.jsonl"),
          JSON.stringify({
            ts: Date.now(),
            ms: Date.now() - startedAt,
            exitCode: typeof run.status === "number" ? run.status : 1,
            costUsd,
            stopped,
            prompt: prompt.slice(0, 120),
          }) + "\n",
        );
      } catch {
        // 日志写失败不影响主结果
      }

      if (stopped === "error" && !text && stderr) {
        throw new Error(`claude 执行失败（exit ${run.status}）：${stderr.slice(0, 1500)}`);
      }

      return {
        kind: "cli",
        exitCode: typeof run.status === "number" ? run.status : 1,
        result: text.slice(0, 4000),
        costUsd,
        stopped,
        ms: Date.now() - startedAt,
      };
    },
  }));
}
