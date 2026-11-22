# muteki-preset

Muteki 蜂群**预设本体**的 market 可装 bundle。装它 = 得到完整预设（人格 + 派单编排 + 证据捕获 + 黑板技能），不再需要跑 `install.ps1`。

## 为什么需要这个包

DSH market 的安装动作只有两步：往 profile `package.json` 加依赖、往 `dsh.profile.bundles` 加白名单。它不会执行脚本、不会写 `cordis.patch.yml`。此前仓库里只有 `muteki-workbench`（工作台 UI）是 bundle，预设本体是一条 profile 级 patch + 四个外置文件，只能手动安装——从 market 装完必然「有工作台、没预设」。本包把预设本体也做成 bundle，补齐这条分发路径。

## 包内容

| 导出 | 作用 |
| --- | --- |
| `muteki-preset`（`.` → bootstrap.mjs） | root 插件：首启铺设 `$DSH_HOME/skills/muteki-board/{board.py,SKILL.md}`，缺 `~/.dsh-muteki/config.json` 时创建（已有绝不覆盖） |
| `muteki-preset/orchestrator` | 派单编排（muteki_run/tick/dispatch/review/cli），挂在预设 plugins 里 |
| `muteki-preset/core` | 工具证据捕获（root 插件，监听 tools/result 落盘证据） |
| `cordis.patch.yml` | 三条 insert：muteki-bootstrap + preset-muteki + muteki-core |

orchestrator/core 与手动安装路径共用同一份源文件（`scripts/sync_bundle.py` 同步，`tests/test_bundle_sync.py` 守漂移）。patch 里不写死本机路径：`python/boardPy/storageDir` 由插件运行时按「显式 config > `~/.dsh-muteki/config.json` > 内置默认」解析。

## 安装（market 路径）

1. market 安装 `muteki-preset`（预设本体）与 `muteki-workbench`（工作台 UI，可选但推荐）。
2. **完整退出并重启 DSH Desktop**（预设注册表在进程启动时建树，只新开会话不够）。
3. 新开会话，预设下拉选「Muteki 蜂群」。

首启时 bootstrap 自动铺设黑板技能与配置；`$DSH_HOME` 的解析与宿主一致（环境变量优先，缺省 `~/.dsh`）。需要 Python 3（默认命令 `python`，可在 `~/.dsh-muteki/config.json` 改 `python` 字段，改完重启）。

**手动安装过（install.ps1）的机器**：两条路径二选一。要改走 market，先把 `cordis.patch.yml` 里手动追加的 `preset-muteki` / `muteki-core` 段删掉（否则 insert id 重复），再装 bundle；`~/.dsh-muteki/config.json` 与黑板数据会被保留。

## 边界

- bootstrap 只写技能文件与缺失的 config.json；绝不触碰 `board.db`、`artifacts/`、`settings.json`、`flags.jsonl`。
- 同版本内重复启动不重写技能文件（版本戳 `.muteki-preset-version`），用户手工修改不会被冲掉；包升级才重新生成。
- 铺设失败只 warn 不抛错，不拖垮 profile 启动。
- 宿主版本要求见 `package.json` 的 `peerDependencies`（0.2.2-rc.3 ≤ host < 0.2.3）。

## 回归

```bash
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_bootstrap.mjs
DSH_NODE_MODULES=<profile>/node_modules node --test tests/test_orchestrator.mjs
python -m unittest tests.test_bundle_sync -v
python scripts/sync_bundle.py --check
```