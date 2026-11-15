/**
 * muteki-core —— 阶段 1：工具证据捕获
 *
 * 监听 `tools/result`（emit 模式，冻结的最终结果），把每次工具执行的
 * 名称 / 参数 / 输出落盘为证据文件，并向 index.jsonl 追加索引。
 * muteki-board 的 fact / deadend 用 `--artifact <id>` 引用这些证据，
 * 校验不过直接拒写——「猜的」永远进不了事实区。
 *
 * 设计约束：
 *  - 监听器绝不抛错（工具结果不能被证据捕获拖垮）；
 *  - 同步写盘（顺序稳定，重启后可读）；
 *  - 单个 payload 超过 maxPayloadBytes 时截断 value/content；
 *  - 不注册任何模型可见工具，不占用上下文。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'muteki-core'
export const inject = ['tools']

export const Config = z.object({
  artifactDir: z.string().default('D:\\dsh\\home\\storages\\muteki-core'),
  maxPayloadBytes: z.natural().default(2 * 1024 * 1024),
  enabled: z.boolean().default(true),
})

/** 把 ContentBlock[] 拍平成文本。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || block === undefined) continue
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** JSON.stringify 的安全版本：BigInt / 循环引用都不让监听器崩。 */
function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    try {
      return JSON.stringify(String(value))
    } catch {
      return '"<unserializable>"'
    }
  }
}

export function apply(ctx, config) {
  if (config && config.enabled === false) return
  const dir = String((config && config.artifactDir) || 'D:\\dsh\\home\\storages\\muteki-core')
  const maxBytes = Number((config && config.maxPayloadBytes) || 2 * 1024 * 1024)
  const artifactsDir = join(dir, 'artifacts')
  const indexPath = join(dir, 'index.jsonl')
  let ready = false

  const ensureDir = () => {
    if (ready) return
    mkdirSync(artifactsDir, { recursive: true })
    ready = true
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      ensureDir()
      const ts = new Date().toISOString()
      const id = 'a' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
      const text = contentText(result && result.content)
      const preview = text.length > 240 ? text.slice(0, 240) + '…' : text
      const payload = {
        id,
        ts,
        tool: String((exec && exec.name) || 'unknown'),
        callId: String((exec && exec.callId) || ''),
        session: exec && exec.agent ? String(exec.agent.id) : '',
        arguments: (exec && exec.arguments) ?? null,
        ok: !(result && result.isError),
        value: (result && result.value) ?? null,
        content: text,
      }
      let raw = safeStringify(payload)
      let truncated = false
      if (Buffer.byteLength(raw) > maxBytes) {
        payload.value = null
        payload.content = text.slice(0, 4000)
        payload.truncated = true
        raw = safeStringify(payload)
        truncated = true
      }
      const digest = createHash('sha256').update(raw).digest('hex')
      const file = join(artifactsDir, id + '.json')
      writeFileSync(file, raw, 'utf8')
      appendFileSync(
        indexPath,
        safeStringify({
          id,
          ts,
          tool: payload.tool,
          ok: payload.ok,
          session: payload.session,
          digest,
          bytes: Buffer.byteLength(raw),
          truncated,
          preview,
          file,
        }) + '\n',
        'utf8',
      )
    } catch {
      // 证据捕获失败绝不能影响工具结果
    }
  })
}
