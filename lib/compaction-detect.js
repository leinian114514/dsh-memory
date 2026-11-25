/**
 * 「刚才是不是发生了一次上下文压缩」的判据。
 *
 * 单独成模块是为了**能测** —— 这段判据在 2026-11-25 之前一直恒为 false，
 * 三处依赖它的功能全是死代码，而因为写在 index.js 里（入口，require 会初始化插件），
 * 一直没有回归测试能盯住它。
 *
 * 三种形态（都实测过，按出现时间排）：
 *
 *   ① 当前 DSH（2026-11 实测）—— 压缩后插的那条消息**只有 content，没有 source、没有 id**：
 *        {"content":[{"type":"text","text":"This is an automatically generated checkpoint
 *          condensing an earlier span of the conversation to free up context. …"}]}
 *      存档证据：session-3089b9f5 的 seq 87615 / 87702。
 *
 *   ② 11-24 之前的老 DSH —— 带原生标记：
 *        { source: { kind: 'compact-checkpoint', compactionId: '…' } }
 *
 *   ③ 第三代第三方插件当年发的：
 *        "[auto-checkpoint] 你刚被压缩过：…"
 *
 * 判据必须扫 **messages 整份**，不能看"最后一条用户消息"：
 * 压缩后那一步的顺序是「压缩摘要 → 用户的新提问 → system-reminder → 各种注入」，
 * 最后一条用户文本永远是他的新问题，前缀判据一辈子碰不到摘要。
 */

/** 压缩摘要的固定开头（英文那句是 DSH 自己拼的模板，逐字复制）。 */
export const COMPACT_SUMMARY_HEADS = [
  'This is an automatically generated checkpoint condensing',
  '[auto-checkpoint] 你刚被压缩过',
]

/** 把一条消息里所有 text 块拼起来。 */
export function messageText(m) {
  const content = m && m.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

/**
 * 本步 messages 里有没有「压缩刚发生」的那条摘要。有就返回那条，没有返回 null。
 * 从后往前扫 —— 同一步里若有多条，新的在后。
 */
export function findCompactionMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== 'object') continue
    if (m.source && m.source.kind === 'compact-checkpoint') return m
    const t = messageText(m).trimStart()
    for (const head of COMPACT_SUMMARY_HEADS) {
      if (t.startsWith(head)) return m
    }
  }
  return null
}

/** 稳定指纹（djb2）：摘要消息没有 id，用它保证「同一次压缩只重灌一次」。 */
export function textFingerprint(s) {
  let h = 5381
  const str = String(s ?? '')
  const n = Math.min(str.length, 4000)
  for (let i = 0; i < n; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * 这一次压缩的 id —— 同一个 id 只做一次重注入。
 * 优先级：原生 compactionId › 消息 id › 正文指纹。
 */
export function findCompactionId(messages) {
  const m = findCompactionMessage(messages)
  if (!m) return ''
  const src = m.source
  if (src && src.kind === 'compact-checkpoint' && src.compactionId) {
    return String(src.compactionId)
  }
  if (m.id) return String(m.id)
  return `compact-${textFingerprint(messageText(m))}`
}
