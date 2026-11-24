/**
 * muteki-orchestrator 的本地测试脚手架（只在测试时用，不属于 DSH 运行时）。
 *
 * 为什么需要它：插件逻辑（额度、派单循环、停止条件）以前只能进 DSH 实机验证，
 * 一轮反馈几分钟。这里用 mock ctx + mock subagents 驱动**真实插件代码**，
 * 黑板侧则调**真实 board.py**（子进程），因此额度/停滞/首解这些逻辑可以在本地回归。
 *
 * 依赖：DSH profile 的 node_modules（插件 import 了 @deepseek-ai/schemastery 与
 * @deepseek-ai/dsh-tools）。用环境变量 DSH_NODE_MODULES 指向它，例如：
 *
 *   DSH_NODE_MODULES=<你的 DSH home>/profiles/desktop/node_modules \
 *     node --test tests/test_orchestrator.mjs
 *
 * 找不到依赖时导出的 SKIP_REASON 为字符串，测试应据此 skip 而不是 fail。
 * 负向对照：设 MUTEKI_TEST_PLUGIN 指向旧版插件文件，即可用同一套用例证明缺陷存在。
 * 本文件不写死任何本机绝对路径。
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const PLUGIN_PATH =
  process.env.MUTEKI_TEST_PLUGIN ||
  join(REPO_ROOT, "plugins", "dsh-muteki-orchestrator", "plugin-v13.mjs");
export const BOARD_PY = join(REPO_ROOT, "board", "board.py");
export const PYTHON = process.env.MUTEKI_TEST_PYTHON || "python";

export function findNodeModules() {
  const candidates = [
    process.env.DSH_NODE_MODULES,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, "profiles", "desktop", "node_modules") : null,
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "@deepseek-ai", "schemastery")) &&
      existsSync(join(candidate, "@deepseek-ai", "dsh-tools"))
    ) {
      return candidate;
    }
  }
  return null;
}

export const NODE_MODULES = findNodeModules();
export const SKIP_REASON = NODE_MODULES
  ? false
  : "找不到 DSH 的 node_modules；设 DSH_NODE_MODULES 指向 <profile>/node_modules 后重跑";

/** 读 JSON 文件，坏了/不存在都返回 fallback。 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data), "utf8");
}

/**
 * 建一个隔离的插件运行环境。
 *
 * @param {object} options
 *   config        覆盖插件配置（python/boardPy/storageDir 已给好测试值）
 *   worker        模拟子代理干活的异步函数：({childId,name,prompt,cwd,board}) => any
 *   workerDelayMs 模拟子代理耗时（用于首解硬 cancel / 等待类测试）
 */
export async function createHarness(options = {}) {
  if (!NODE_MODULES) throw new Error(SKIP_REASON);
  const root = join(
    tmpdir(),
    `muteki-orch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(root, { recursive: true });
  // junction 让插件的 ESM import 能解析到 DSH 的依赖；清理时先 unlink，绝不递归进去。
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "junction");
  copyFileSync(PLUGIN_PATH, join(root, "plugin.mjs"));

  const storageDir = join(root, "storage");
  const ws = join(root, "ws");
  const artifacts = join(root, "artifacts");
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(artifacts, "artifacts"), { recursive: true });
  writeFileSync(join(artifacts, "index.jsonl"), "");

  const savedEnv = { ...process.env };
  process.env.MUTEKI_ARTIFACT_DIR = artifacts;
  delete process.env.MUTEKI_BOARD_DB;
  delete process.env.MUTEKI_CHALLENGE;

  const board = (argv, cwd = ws) => {
    const run = spawnSync(PYTHON, [BOARD_PY, ...argv], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: process.env,
    });
    return {
      status: run.status ?? 1,
      out: `${run.stdout || ""}${run.stderr || ""}`.trim(),
      stdout: run.stdout || "",
      stderr: run.stderr || "",
    };
  };

  const mod = await import(pathToFileURL(join(root, "plugin.mjs")).href);
  const tools = new Map();
  const events = [];
  const activations = [];
  const worker = options.worker || (async () => {});
  /** 触发插件注册的生命周期监听器（模拟 DSH 的 emitLifecycle）。 */
  const emit = (event, info) => {
    for (const [name, fn] of events) {
      if (name !== event) continue;
      try {
        fn(info);
      } catch {
        /* 监听器内部应当自己容错，这里再兜一层 */
      }
    }
  };

  const subagents = {
    async startActivation(opts) {
      const childId = `child-${activations.length + 1}`;
      const name = opts.name || opts.label || "worker";
      const cwd = opts.cwd || ws;
      const record = { childId, name, opts, cwd, interrupted: false, disposed: false, error: null };
      activations.push(record);
      const info = {
        runId: childId,
        id: childId,
        provider: "spawn",
        local: false,
        parentSessionId: "parent-test",
      };
      emit("subagent/start", info);
      // rc.5 的 receipt 带 dispose()（硬收束）；interrupt 对外部后端 = abort + dispose。
      // mock 用 deferred 模拟：dispose 立即结算 result，worker 协程靠 cancelled() 自觉退出。
      const disposed = Promise.withResolvers();
      record.dispose = () => {
        if (record.disposed) return Promise.resolve();
        record.disposed = true;
        emit("subagent/end", { ...info, stopReason: "aborted" });
        disposed.resolve({ ok: false, childId, disposed: true });
        return Promise.resolve();
      };
      record.cancelled = () => record.interrupted || record.disposed;
      const work = (async () => {
        if (options.workerDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.workerDelayMs));
        }
        try {
          await worker({
            childId,
            name,
            cwd,
            prompt: opts.prompt?.[0]?.text || "",
            board: (argv, c) => board(argv, c || cwd),
            cancelled: record.cancelled,
          });
        } catch (err) {
          record.error = String(err);
        }
        // DSH 0.2.2-rc.3 的 subagent/end 只带 runInfo + stopReason + lastAssistantMessage，
        // 没有 token usage；options.endInfo 可注入 usage 字段来测「未来版本带 usage」的分支。
        emit("subagent/end", { ...info, stopReason: "completed", ...(options.endInfo || {}) });
        return { ok: true, childId };
      })();
      record.result = Promise.race([work, disposed.promise]);
      return record;
    },
    interrupt(childId) {
      const record = activations.find((item) => item.childId === childId);
      if (!record) return;
      if (options.interruptError) throw new Error(options.interruptError);
      record.interrupted = true;
      record.dispose();
    },
  };

  const logs = [];
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (key) => {
      if (key === "subagents") return subagents;
      // 会话工作目录服务：与 dsh-subagent 省略 cwd 时同源，供 cwd 默认值回归用。
      if (key === "workingDirectory") return { ensure: async () => ws };
      return undefined;
    },
    on: (event, fn) => events.push([event, fn]),
    logger: {
      info: (...a) => logs.push(["info", format(...a)]),
      warn: (...a) => logs.push(["warn", format(...a)]),
    },
  };

  const config = {
    python: PYTHON,
    boardPy: BOARD_PY,
    storageDir,
    hardCancelOnFlag: true,
    claudeBin: "claude",
    claudeConfigDir: "",
    enabled: true,
    ...(options.config || {}),
  };
  mod.apply(ctx, config);

  const exec = { agent: { id: "parent-test" }, signal: undefined };
  const call = (name, args = {}) => tools.get(name).execute({ cwd: ws, ...args }, exec);

  const makeArtifact = (id = "atest0001-000000", content = "hello") => {
    const file = join(artifacts, "artifacts", `${id}.json`);
    writeJson(file, { id, tool: "pwsh", ok: true, content });
    const index = join(artifacts, "index.jsonl");
    writeFileSync(
      index,
      readFileSync(index, "utf8") +
        JSON.stringify({ id, tool: "pwsh", ok: true, file }) +
        "\n",
      "utf8",
    );
    return id;
  };

  /** 把账本里的时间戳整体往回拨，用来模拟「一小时窗口已经滚过去了」。 */
  const ageLedger = (file, ms) => {
    const data = readJson(file, []);
    if (!Array.isArray(data)) return;
    writeJson(file, data.map((item) => ({ ...item, ts: (item.ts || Date.now()) - ms })));
  };

  const cleanup = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    try {
      unlinkSync(join(root, "node_modules"));
    } catch {
      /* 已经不在就算了 */
    }
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    ws,
    storageDir,
    artifacts,
    mod,
    tools,
    config,
    events,
    logs,
    activations,
    emit,
    board,
    call,
    exec,
    makeArtifact,
    ageLedger,
    cleanup,
    seedTask: (title, detail = "预期证据 + 停止边界") =>
      board(["task", "add", title, "--detail", detail]),
    ledger: (name) => join(storageDir, name),
  };
}