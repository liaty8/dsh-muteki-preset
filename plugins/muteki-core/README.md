# muteki-core

证据捕获插件：监听 DSH 的 `tools/result` 事件，把每次工具调用的结果落盘成可引用、可校验的 **artifact**，供黑板 `board.py fact --artifact <id>` 使用。

没有它，黑板只能记「文本证据」；有了它，fact 必须指向真实存在的工具输出，伪造 id 会被 `board.py` 拒绝（exit 2）。

## 安装

复制到 profile 目录，然后在 profile 的 `cordis.patch.yml` 加一行全局 insert：

```powershell
$p = "$env:DSH_HOME\profiles\desktop"
Copy-Item .\muteki-core.mjs "$p\muteki-core.mjs" -Force
```

```yaml
- insert:
    - id: muteki-core
      name: ./muteki-core.mjs
      config:
        artifactDir: 'C:\Users\you\.dsh-muteki\artifacts'
        maxPayloadBytes: 2097152
        enabled: true
```

（相对路径以 patch 文件所在目录为基准，所以放在 profile 根即可。）

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `artifactDir` | `~/.dsh-muteki/artifacts` | 证据目录 |
| `maxPayloadBytes` | `2097152`（2MB） | 单条结果上限，超出截断并标 `truncated` |
| `enabled` | `true` | 总开关 |

## 产出

```
<artifactDir>/artifacts/<id>.json    # 单条：tool / ts / ok / session / digest / bytes / value|content
<artifactDir>/index.jsonl            # 索引：id / tool / ok / summary（board.py 读这个校验）
```

- id 形如 `a` + base36 时间戳 + `-` + 6 位 hex，例如 `amwhs6uy4-8451fa`；
- `board.py artifact list` / `artifact show <id>` 可直接查看；
- 结果超过上限时保留前部并标 `truncated: true`，`digest` 仍是原始内容的 sha256。

## 注意

- 只捕获 **DSH 会话内** 的工具调用；Claude Code CLI 进程里跑的命令不会产生 artifact（跨引擎时需在宿主机先跑一次同一请求，或改记 observation）。
- 监听器内部 try/catch，不会因为写盘失败影响工具本身。
