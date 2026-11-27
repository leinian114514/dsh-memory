/**
 * 「刚才是不是发生了一次上下文压缩」的判据。
 *
 * 单独成模块是为了**能测** —— 这段判据在 2026-11-25 之前一直恒为 false，
 * 三处依赖它的功能全是死代码，而因为写在 index.js 里（入口，require 会初始化插件），
 * 一直没有回归测试能盯住它。
 *
 * 三种形态（都实测过，按出现时间排）：
 *
 *   ① 当前 DSH（2026-11 实测）—— 压缩后**发给模型**的那条消息只有 content，没有 source、没有 id：
 *        {"content":[{"type":"text","text":"This is an automatically generated checkpoint
 *          condensing an earlier span of the conversation to free up context. …"}]}
 *      ⚠️ 2026-11-27 更正：这句是 `dsh-compaction-basic/src/summarizer.ts` 里的
 *      `CHECKPOINT_PREAMBLE`，DSH **发给模型时现场拼**的，**不保证落盘** ——
 *      本会话 91246 条存档事件里搜不到这句（存档里 `compaction/summary` 的 text
 *      是模型产出的 `## Primary Request and Intent…`），而 pre-step 的 messages
 *      只是本步新认领的那批 ⇒ **这个判据在真机上恒为 false**。
 *      现在主判据是 `index.js` 的 `lastCompactionEnd()`（从会话事件流倒扫
 *      `compaction/end`，插件重载也不丢）；本模块的文本判据只留作兜底，
 *      别再把它当成「一定能命中」的东西。
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

/**
 * 「最后一次压缩」是不是「刚刚压过」—— 2026-11-27 加的**时间闸**。
 *
 * 为什么必须有：`readSeen().compactions` 这个账本只能拦"已经认领过的 id"。
 * 老会话里躺着几天前的 compaction/end，账本里当然没有（那会儿判据还是坏的，
 * 从来没认领过）⇒ 重启后第一次 pre-step 就把它当成"刚压缩过"，
 * 给一个根本没压缩的会话注入 `⟪记忆重注入 · 压缩后⟫` 还去找落档。
 * 实测两条：`a6b2f860`（952a682a，11-25 12:22）、`f2f717c8`（3089b9f5，02:28 但已过 15 分钟 + 两次重启）。
 *
 * 阈值取 2 小时：正常路径是「压缩 → 插件重载（19 秒）→ 用户下次说话」，中间可能隔一阵；
 * 而真正的历史压缩至少隔夜。2 小时落在空档里，既不漏接棒，也不翻旧账。
 */
export const COMPACTION_FRESH_MS = 2 * 60 * 60 * 1000

/**
 * 时间闸的**兜底**窗口（默认 10 分钟），只在「压缩后已经跑过一轮」时才用。
 *
 * 🛑 2026-11-27 主人一句点破：「二个小时会有问题，因为有的时候高强度工作可能到不了二个小时就压缩了」——
 *    光靠墙钟，高强度工作下（一小时压两三次）会把「上一轮的历史压缩」也认成刚压过，
 *    每天重启几次就多注入几次。所以主判据换成**事件顺序**（见 isCompactionFresh），
 *    时间只在「顺序判不出来」时兜底。
 */
export const COMPACTION_FALLBACK_MS = 10 * 60 * 1000

/**
 * @param timeMs 那条 `compaction/end` 事件的 time（毫秒）
 * @param now 当前时间（毫秒），便于测试注入
 * @param windowMs 判定窗口，默认 2 小时
 */
export function isFreshCompaction(timeMs, now = Date.now(), windowMs = COMPACTION_FRESH_MS) {
  const t = Number(timeMs)
  if (!Number.isFinite(t) || t <= 0) return false
  const age = now - t
  // 未来时间戳（时钟回拨 / 别处的机器）也算新鲜：宁可多灌一次，也别在真压缩后漏掉接棒
  if (age < 0) return true
  return age < windowMs
}

/**
 * 「这条压缩是不是该接棒」的**最终判据**（时间闸只作兜底）。
 *
 * 主判据是**事件顺序**：压缩发生在回合末尾，所以刚压完时，日志里那条 `compaction/end`
 * **之后不会再有 assistant/message**；一旦压缩后模型又回答过，就说明接棒这一轮早过去了，
 * 不该再补。这比「多久以前」准得多，也不受压缩频率影响。
 *
 * 时间兜底（10 分钟）只处理一种情况：压缩后被自动 followup（比如反思催办）抢跑了一轮，
 * 顺序判据因此说不清，但时间上确实是刚刚。
 *
 * @param info `lastCompactionEnd()` 的返回：`{ id, seq, timeMs, answeredAfter }`
 * @param now 当前时间（毫秒）
 */
export function isCompactionFresh(info, now = Date.now()) {
  if (!info) return false
  // 压缩之后**没有**回答过 ⇒ 接棒这一轮还没跑 ⇒ 该做
  if (info.answeredAfter !== true) return true
  // 已经回答过了：只有刚刚（10 分钟内）压的才兜底认一次
  return isFreshCompaction(info.timeMs, now, COMPACTION_FALLBACK_MS)
}
