/**
 * dsh-memory — 独立记忆系统插件。
 *
 * 设计目标是**自己掌控**：不依赖外部记忆插件的代码与更新节奏，
 * 数据放在 <workspace>/.dsh-memory/memory.db。
 *
 * 记忆分四层（核心 / 项目 / 分支 / 细节），每层带一个 category 做层内分类。
 *
 * 两条注入路径：
 *   首轮 —— 核心层的身份 + 偏好 + 原则与禁令(重要性>=2) + 项目名
 *   每条 —— 细节层里按关键词打分取前 hitTopK 条
 *
 * 安全边界：只往 messages 追加一条 user 消息，从不 reject、从不改用户输入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  bumpHit,
  CATEGORIES,
  DEFAULT_CATEGORY,
  isGlobalProject,
  LEVELS,
  list,
  listProjectNames,
  openFor,
  parseKeywords,
  planLeftItems,
  planProgress,
  projectListOf,
  projectCovers,
  toDoc,
  SEARCH_LEVELS,
} from './db.js'
import { bm25Search, docText, hasPhonetic, tokenize } from './search.js'
import {
  buildSessionIndexAsync,
  listSessionFiles,
  openSessionIndex,
  recentSessionMessages,
  searchConversations,
  sessionIndexStats,
  sessionMessageAt,
} from './session-index.js'
import {
  findCompactionId,
  findCompactionMessage,
  isCompactionFresh,
} from './compaction-detect.js'
import { ensureSchema } from './schema.js'
// v5：向量检索是**可选增强**。模型/依赖不在时 vector.js 自己返回 null，调用方退回 BM25。
import { getEncoder, loadDocVectors, rrfMerge, vectorTopK } from './vector.js'
import {
  buildHitInjection,
  buildInjectionBody,
  findTouchedCore,
  formatCoreTouch,
  formatHitInjection,
  markSeen,
  readSeen,
  readSeenSet,
} from './inject.js'
// 项目核心（次一级核心层）：按关键词把"当前活跃项目"的专属规则注入进来。
// 为什么要单独一层：全局核心 MEMORY.md 只能放通用规则，项目专属的塞进去会臃肿、还污染无关会话。
import {
  buildProjectCoreSection,
  DEFAULT_MAX_CHARS,
  listSessionChoices,
  // 2026-11-21：`parent` 支持多父（数组），新建项目时要归一化
  parentsOf,
  PROJECT_CORE_ROOT,
  projectCoreSnapshot,
  readInjected,
  readProjectConfig,
  resetInjected,
  setOverride,
  setProjectCoreRoot,
  setLocked,
  touchSession,
} from './project-core.js'

export const name = 'dsh-memory'
// webServer 用于侧栏面板的两个 HTTP 路由；connection 只在运行时探测（拿它做信任围栏）
// tokenMeter：落档催办要按真实 token 判断水位，
// 而 cordis 的服务必须在 inject 里声明才注入 —— 没声明时 ctx.tokenMeter 是 undefined，
// 表现为 pressure 永远 null（实测踩到）。
export const inject = ['tools', 'webServer', 'tokenMeter']

/** DSH 家目录：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const src = m.source || {}
    if (src.kind && src.kind !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('\n')
    }
  }
  return ''
}

/**
 * 压缩前最近几轮的原话。
 *
 * 为什么要它：摘要只留梗概 —— 具体的命令、文件名、刚验证过的结论、踩过的坑，
 * 在摘要里通常只剩一句"调试过某功能"。压缩后接手最容易在这里做反或重做。
 * 参考 dsh-world 的做法（它把最近这段原文重放回上下文，默认 200 轮，因为原文
 * 是它唯一的记忆来源）；我们有记忆库兜底，只补最近几轮、控制在几千字，
 * 免得注入本身把水位又顶到压缩线上。
 *
 * 数据来自会话存档，和 memory_search 的 includeConversations 同一个解析器；
 * 里面已经滤掉插件自己的注入块 —— 不然注入内容会被当成对话原文再注入一遍，滚雪球。
 */
export function recentConversationText(sessionId, opts = {}) {
  const maxMsgs = Number.isFinite(opts.maxMsgs) ? opts.maxMsgs : 8
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 3000
  try {
    const sid = String(sessionId ?? '')
    if (!sid) return ''
    const files = listSessionFiles(path.join(os.homedir(), '.dsh', 'sessions'))
    // 只认精确匹配：模糊匹配（endsWith）可能把别的会话原文注入进来 ——
    // 那种错比"这次没补上"严重得多。匹配不上就静默不补。
    const mine = files.filter((f) => f.sid === sid || f.sid === `session-${sid}` || sid === `session-${f.sid}`)
    if (mine.length === 0) return ''
    mine.sort((a, b) => b.mtime - a.mtime)
    // 只解尾部若干帧（recentSessionMessages）：整个文件全解在 70MB 的会话上要 4 秒，
    // 而这里跑在 pre-step 的同步路径上。
    const msgs = recentSessionMessages(fs.readFileSync(mine[0].path))
    if (msgs.length === 0) return ''
    // 从最近往前攒，攒满预算为止，再按时间正序输出 —— 读起来才是正常的对话顺序
    const picked = []
    let used = 0
    for (let i = msgs.length - 1; i >= 0 && picked.length < maxMsgs; i--) {
      const text = String(msgs[i].text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (picked.length > 0 && used + text.length > maxChars) break
      picked.unshift(`【${msgs[i].role === 'user' ? '用户' : '我'}】${text.slice(0, maxChars)}`)
      used += text.length
    }
    return picked.join('\n')
  } catch {
    return ''
  }
}

/**
 * 已经为哪个 compactionId 清过「项目核心已注入」记录（按会话）。
 * 为什么需要：同一个 compactionId 会在连续几个 step 里都出现在 messages 里，
 * 每步都清一次的话，项目核心会被反复重灌（一次 900~1500 字）。
 */
const lastCompactionReset = new Map()

/**
 * 每个会话上一次测到的上下文水位（token 数）。
 *
 * 🛑 2026-11-19 审计后加：用来给「压缩真的发生了吗」提供一道**伪造不了的证据**。
 * 只靠文本（消息以 `[auto-checkpoint] 你刚被压缩过` 开头）判定是不够的 ——
 * 用户把催办原文粘回来问一句，文本就命中了，而它后面挂着一串破坏性动作
 * （清空注入记录、重灌 16000 字符、推进反思锚点）。
 * 水位骤降这个信号只有真压缩才产生：贴一段文字不会让 token 量级掉下来。
 */
const lastPressureSeen = new Map()
const lastPressureOf = (sessionId) => {
  const v = lastPressureSeen.get(sessionId)
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * 已经扫过「这个会话有没有子智能体授权」的会话 id。
 *
 * 只为省开销：那个判断要扫 `session.log`（大会话九万多条事件），不能每轮都扫。
 * 只在本进程内有效 —— 重启后重扫一次，一次 append 之后就不会再写第二遍。
 */
const subagentPolicyScanned = new Set()

/**
 * 从**会话事件流**里找最后一次成功的压缩。
 *
 * 🛑 2026-11-27 第三修。前两版都空转过，而且这一版之前还有一版是**内存**方案：
 *    `pendingCompaction` Map（session/event 收到 compaction/end 就记、pre-step 取走）。
 *    它死在：**压缩完成后 DSH 会把插件整个重载**（实测 19:33:56 压完 → 19:34:15 重载，
 *    22 个工具重注册；见下面 compactHandler 那段注释①），模块级 Map 直接清空，
 *    重载之后再 pre-step 就什么都不剩 —— 表现和前一版一模一样：一条日志不报、静默空转。
 *    ⇒ 判据必须能从**持久事件流**读回来。`agent.session.log` 是唯一扛得住重载的地方。
 *
 * 判据历史（别再走回头路）：
 *    ① `source.kind === 'compact-checkpoint'` —— 当前 DSH 那条消息没有 source
 *    ② 扫 messages 找 `This is an automatically generated checkpoint…` ——
 *       那是 `CHECKPOINT_PREAMBLE`，DSH **发给模型时现场拼**的，不落盘（本会话 91246 条
 *       存档事件里搜不到），pre-step 的 messages 又只是本步新认领的那批 ⇒ 恒为 false
 *    ③ ✅ `session.append('compaction/end', …)` 是**真会话事件**，`Session.commit()`
 *       对所有 append 无类型过滤地派发；从 `session.log` 倒扫就能拿到
 *
 * 最近一条 `compaction/end` 带 `error` 说明**这次没压成**（实测见过
 * "DeepSeek Messages request aborted"），返回 null，别拿旧的那条冒充。
 */
function lastCompactionEnd(session) {
  try {
    const logArr = session && session.log
    if (!Array.isArray(logArr)) return null
    // 倒扫时顺手记一件事：这条 compaction/end **之后**有没有出现过 assistant/message。
    // 这是判断「压缩后到底跑过没跑过一轮」的硬证据，比时间准得多（见下面 isCompactionFresh）。
    let answeredAfter = false
    for (let i = logArr.length - 1; i >= 0; i--) {
      const e = logArr[i]
      if (!e) continue
      if (e.type === 'assistant/message') {
        answeredAfter = true
        continue
      }
      if (e.type !== 'compaction/end') continue
      const d = e.data || {}
      if (d.error) return null
      return {
        id: String(d.compactionId || `seq-${e.seq}`),
        seq: e.seq,
        timeMs: Number(e.time) || 0,
        answeredAfter,
      }
    }
  } catch {
    /* 事件流读不出来就当没有 */
  }
  return null
}

/**
 * 「最后一次压缩」离现在多久以内才算「刚刚压过」。
 *
 * 🛑 2026-11-27 隔壁窗口（会话 f5cb8c0e）揪出来的误判：光看「账本里没有这个 id」不够 ——
 *    老会话里躺着**几天前的** compaction/end，账本里当然没有它（那会儿判据还是坏的，
 *    从来没认领过），于是重启后第一次 pre-step 就把它当成"刚压缩过"，
 *    给一个根本没压缩的会话注入 `⟪记忆重注入 · 压缩后⟫` 还去找落档。
 *    实测两条：`a6b2f860`（952a682a，11-25 12:22）、`f2f717c8`（3089b9f5，今天 02:28 但已过 15 分钟+两次重启）。
 *
 * 阈值为什么是 2 小时而不是隔壁建议的 5~10 分钟：
 *   正常路径是「压缩 → 插件重载（实测 19 秒）→ 用户下次说话」，中间用户去干别的很正常；
 *   而真正的历史压缩至少隔夜。2 小时落在两者的空档里，既不漏接棒，也不会翻旧账。
 *   超过这个窗口的压缩直接当历史 —— 落档文件还在，用户要我读我自己会读。
 */

/**
 * 两组 token 的 Jaccard 相似度（交集 / 并集）。
 *
 * 为什么查重要用它、而不是 BM25 分数：实测拿条目自己的内容去检索，
 * 「最像的另一条」BM25 分数中位就有 1356（长文本天然匹配多），
 * 完全无法区分"同一条写了两遍"和"讲同一件事的两条"。
 * 换成 Jaccard 后分界很干净（中等规模的库、几百对候选实测）：
 *   真重复（同一条对自身）= 1.000
 *   库里最像的两条不同条目 = 0.430
 *   中位 = 0.057
 * ⇒ 阈值取 0.65，落在空隙里。
 */
function jaccardOf(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * 查重 + 近邻检测：在全部 active 条目里找跟草稿最像的那条。
 * 先用 BM25 粗筛 8 个候选（快），再逐个算 Jaccard（准）。
 *
 * 返回两种结果，语义不同：
 *   · duplicate —— Jaccard ≥ threshold，判定「同一条写了两遍」→ 调用方应当拦下
 *   · related   —— Jaccard 落在 [relatedFloor, threshold)，近似但不足重复
 *                  → 不拦，但值得提一句「这和 XX 可能相关，注意是不是同一件事的新旧版本」
 *
 * 加 related 这一档的理由：记忆是会演化的（先说 A、后来改成 B）。那种情况
 * 既不该硬拦（信息是新的），也不该闷声写进去（库里就会出现两条互相打脸的记录）。
 * @returns {{duplicate: (null|{j:number,doc:object}), related: (null|{j:number,doc:object})}}
 */
/**
 * 从文本里抽「有具体值的断言」—— 端口 / 路径 / 版本号 / 百分比 / 门牌式数字。
 *
 * 🛑 为什么冲突判定不能靠相似度：两条记忆可以很像但说的是同一件事（那是重复），
 *    也可以很像但**数字不一样**（那才是冲突）。Jaccard 对这两种完全一视同仁。
 *    所以真正能判冲突的信号是「同一个槽位、填了不同的值」。
 *
 * 只抽这四类，因为它们的"槽位"含义明确、误报少：
 *   port  端口    —— 3000 vs 8000
 *   path  路径    —— D:\A vs E:\B（大小写不敏感）
 *   ver   版本号  —— v0.3.2 vs v0.3.3
 *   pct   百分比  —— 65% vs 85%
 * 自由数字（"三天""两次"）不抽，太容易误报。
 */
export function factsOf(text) {
  const t = String(text || '')
  const out = new Set()
  for (const m of t.matchAll(/(?:端口|port)\s*[:：]?\s*(\d{2,5})|(\d{2,5})\s*(?:号端口|端口)/gi)) {
    const v = m[1] || m[2]
    if (v) out.add('port:' + v)
  }
  for (const m of t.matchAll(/(?:[A-Za-z]:[\\/][^\s，。；）)」"\]]+)/g)) {
    out.add('path:' + m[0].replace(/[\\/]+$/, '').toLowerCase())
  }
  for (const m of t.matchAll(/\bv(\d+\.\d+(?:\.\d+)?)\b/gi)) {
    out.add('ver:' + m[1])
  }
  for (const m of t.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    out.add('pct:' + m[1])
  }
  return out
}

const FACT_LABEL = { port: '端口', path: '路径', ver: '版本', pct: '百分比' }

/**
 * 两条文本之间有没有「同槽位、不同值」。
 * 返回 [] 表示没发现冲突；否则返回人类可读的冲突点。
 *
 * 判据要保守：只在**两边都提到这类值、而且值集合没有交集**时才报。
 * 一边提到一边没提，不算冲突（那是补充信息，不是矛盾）。
 *
 * 🛑 **path 不参与冲突判定**（2026-11-19 真库实测后弃用）：
 *    拿两千多条在役记录跑，扫出的 3 对"冲突"全是路径误报 ——
 *    同一个目录带不带尾斜杠、一条记录里列了好几个路径。
 *    路径不同是常态（不同记录说不同文件），不是矛盾。
 *    factsOf 仍然抽 path（别处有用），只是这里跳过。
 */
const CONFLICT_SKIP = new Set(['path'])
export function factConflicts(aText, bText) {
  const group = (set) => {
    const m = new Map()
    for (const s of set) {
      const i = s.indexOf(':')
      if (i < 0) continue
      const k = s.slice(0, i)
      const v = s.slice(i + 1)
      if (!m.has(k)) m.set(k, new Set())
      m.get(k).add(v)
    }
    return m
  }
  const ga = group(factsOf(aText))
  const gb = group(factsOf(bText))
  const out = []
  for (const [k, va] of ga) {
    if (CONFLICT_SKIP.has(k)) continue
    const vb = gb.get(k)
    if (!vb || vb.size === 0) continue
    // 有交集 = 说的是同一个值，不算冲突
    let same = false
    for (const v of va) if (vb.has(v)) same = true
    if (same) continue
    out.push(`${FACT_LABEL[k] || k}：${[...va].join(' / ')} ↔ ${[...vb].join(' / ')}`)
  }
  return out
}

/** 命中「疑似冲突」时给调用方的提示：说清矛盾在哪、两条路怎么选 */
function conflictHint(hit, threshold) {
  const preview = String(hit.doc.content || '').replace(/\s+/g, ' ').slice(0, 200)
  return (
    `\n\n⚠️ 可能和已有条目矛盾（相似度 ${hit.j.toFixed(2)}，判为"相关"不是"重复"）\n` +
    `[${hit.doc.level}] ${hit.doc.id}\n` +
    `${hit.doc.title ? String(hit.doc.title) + '\n' : ''}${preview}\n` +
    `矛盾点：${hit.reasons.join('；')}\n` +
    `· 新的才对 → memory_update 改那条（保留原 id，别开新条目），或用 memory_conflict action="resolve" 选 keep_new\n` +
    `· 旧的对、新的记错了 → memory_conflict action="resolve" 选 keep_old\n` +
    `· 两个都对但分时期 → 选 both，旧的标 stale 并注明"已被 X 取代"`
  )
}

/**
 * 毫秒 → 「2026-11-19 11:20」本地时间。
 *
 * 🛑 别再直接 `new Date(x).toISOString()` 给用户看了 —— 那是 **UTC**，
 *    本机 UTC+8 下每个时间都会少 8 小时（`memory_recent` 里 11:20 显示成 03:20，
 *    `memory_read` 的「建立/更新」同理），看着像数据错乱。
 *    （2026-11-19 用户体验测试发现，属于"没说错，但看着就是不对"那类。）
 */
function fmtLocalTime(v) {
  const ms = msOf(v)
  if (!ms) return '（无）'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把时间字段统一转成毫秒数。
 *
 * 🛑 必须用这个、不要直接 `a.updated_at - b.updated_at`：历史数据里混过字符串
 * （`'2026-10-27 12:14:00'`，老数据里普遍如此），字符串相减得到 **NaN**，
 * 而 `Array.prototype.sort` 的比较函数返回 NaN 时**不保证改变顺序** ——
 * 结果就是排序静默失效、数组保持插入顺序（memory_recent 曾经因此
 * 永远只返回第一层 core 的条目，2026-11-19 用户体验测试发现）。
 * 数据已经在 schema migrate v2 里清洗过，这里再兜一层，防止再混进来。
 */
function msOf(v) {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : 0
}

/** 事件发生时间：接受毫秒数 / 秒级时间戳 / ISO 或 "2026-11-18" 字符串 */
export function normalizeTime(v) {
  if (v === undefined || v === null || v === '') return null
  // 统一出口：只接受**合理区间**的正数毫秒。
  // 🛑 0 和负数一律当"未填"：`at = happened_at ?? created_at` 和
  //    `COALESCE(happened_at, created_at)` 都只跳过 NULL，0 会被当真值，
  //    时间轴上会冒出 1970-01-01 的条目（2026-11-19 审计发现）。
  // 🛑 上限 2100 年（2026-11-20 压力测试加的）：传 `99999999999999999999` 这种
  //    有限但离谱的数会被原样存进库，渲染时 `new Date(1e20)` 变 Invalid Date，
  //    界面上显示成 `NaN-NaN-NaN NaN:NaN` —— 不崩，但一眼脏。
  const MAX_MS = 4102444800000 // 2100-01-01T00:00:00Z
  const ok = (t) => (Number.isFinite(t) && t > 0 && t < MAX_MS ? Math.round(t) : null)
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    // 🛑 判据必须是「10 位区间」而不是「小于 1e11」。
    //    `v < 1e11` 会把 `86400000`（一天的毫秒数）也当成秒级，乘 1000 变成
    //    86,400,000,000（1972 年）；更要命的是面板「没动过就回传原毫秒」那条路径
    //    （panel.html），库里任何小于 1e11 的毫秒值每保存一次就会再放大一千倍。
    //    秒级时间戳的现实区间是 1e9(2001-09) ~ 1e11(5138 年)，落在区间外的按毫秒原样返回。
    return ok(v >= 1e9 && v < 1e11 ? v * 1000 : v)
  }
  const s = String(v).trim()
  if (/^\d{13}$/.test(s)) return ok(Number(s))
  if (/^\d{10}$/.test(s)) return ok(Number(s) * 1000)
  // 🛑 纯日期按**本地**零点算。
  //    原先直接丢给 Date.parse，而 `Date.parse('2026-11-18')` 是按 UTC 解析的
  //    ⇒ 在 UTC+8 下会变成本地 08:00，跟 `normalizeTimeEnd` 的本地 23:59:59 差 8 小时，
  //    "筛 11-18 这一天"会漏掉当天上午 8 点前的记录。
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0)
    return ok(dt.getTime())
  }
  return ok(Date.parse(s))
}

/** 情境：接受对象或 JSON 字符串，统一存成 JSON 文本（太长就截断） */
export function normalizeContext(v) {
  if (v === undefined || v === null || v === '') return null
  let o = v
  if (typeof o === 'string') {
    const s = o.trim()
    if (!s) return null
    try {
      o = JSON.parse(s)
    } catch {
      // 不是 JSON 就当一句纯文本情境（"改 dsh-memory 时 / 深夜排障"）
      return s.slice(0, 300)
    }
  }
  if (typeof o !== 'object') return null
  const out = {}
  for (const k of ['scene', 'task', 'with', 'where']) {
    if (o[k] !== undefined && o[k] !== null && String(o[k]).trim()) {
      out[k] = String(o[k]).trim().slice(0, 120)
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

/**
 * 情绪：`{label, intensity, confidence, source}`
 *
 * 🛑 source 必须是 `explicit`（他明说的）或 `inferred`（我推断的），**默认 explicit**
 *    是错的 —— 所以这里要求调用方自己标；没标就按 `inferred` 算，宁可保守。
 *    推断出来的情绪不能当事实用，时间相关也不等于因果。
 */
export function normalizeMood(v) {
  if (v === undefined || v === null || v === '') return null
  let o = v
  if (typeof o === 'string') {
    const s = o.trim()
    if (!s) return null
    try {
      o = JSON.parse(s)
    } catch {
      return JSON.stringify({ label: s.slice(0, 60), source: 'inferred' })
    }
  }
  if (typeof o !== 'object') return null
  const out = {}
  if (o.label) out.label = String(o.label).trim().slice(0, 60)
  const iv = Number(o.intensity)
  if (Number.isFinite(iv)) out.intensity = Math.max(0, Math.min(1, iv))
  const cf = Number(o.confidence)
  if (Number.isFinite(cf)) out.confidence = Math.max(0, Math.min(1, cf))
  out.source = o.source === 'explicit' ? 'explicit' : 'inferred'
  if (!out.label) return null
  return JSON.stringify(out)
}

/**
 * `until` 专用：只给日期（`2026-11-18`）时取**那一天的结束**。
 * 否则 Date.parse('2026-11-18') 是当天 00:00，当天的记忆全被排除 —— 典型的差一天。
 */
export function normalizeTimeEnd(v) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(y, m - 1, d, 23, 59, 59, 999)
    // 和 normalizeTime 对齐：0/负数一律当未填，上限同样是 2100 年。
    // 原来这里直接返回 getTime()，'1969-06-01' 会得到 -18432000001 落进库，
    // 和 normalizeTime 的 t>0 成了两套语义（2026-11-19 复审发现）。
    const t = dt.getTime()
    return Number.isFinite(t) && t > 0 && t < 4102444800000 ? Math.round(t) : null
  }
  return normalizeTime(v)
}

function findNearDuplicate(db, draft, threshold, relatedFloor = 0.3) {
  const pool = []
  for (const layer of LEVELS) {
    for (const raw of list(db, layer, { status: 'active' })) pool.push(toDoc(raw, layer))
  }
  const none = { duplicate: null, related: null, conflict: null, refSimilar: null }
  if (pool.length === 0) return none

  const keywords = Array.isArray(draft.keywords) ? draft.keywords : []
  const probe = `${draft.title || ''} ${draft.content} ${keywords.join(' ')}`
  const candidates = bm25Search(probe, pool, { k: 8 })
  if (candidates.length === 0) return none

  const mine = new Set(tokenize(`${draft.title || ''} ${draft.content}`))
  let best = null
  let related = null
  let conflict = null
  // 🛑 参考资料单独收着，**不参与"重复/冲突"判断**（2026-11-21 复查 P0）。
  //    资料类条目天生和后来源自它的结论高度重合（实测 Jaccard 0.88）。判成重复的后果是三环连锁：
  //      ① 要照着做的那条结论**没写进库**；
  //      ② 提示建议「合进那条」→ 结论被并进 reference；
  //      ③ 而 reference 不进主排序、不进自动命中 ⇒ 等于写进了一个没人看得见的地方。
  //    所以它只报一句"附近有相近的资料"，不拦写入、也不劝合并。
  let refSimilar = null
  const myText = `${draft.title || ''} ${draft.content || ''}`
  for (const c of candidates) {
    const cText = `${c.title || ''} ${c.content || ''}`
    const j = jaccardOf(mine, new Set(tokenize(cText)))
    if (String(c.category ?? '') === 'reference') {
      if (refSimilar === null || j > refSimilar.j) refSimilar = { j, doc: c }
      continue
    }
    const why = factConflicts(myText, cText)
    if (j >= threshold) {
      // 🛑 高相似 ≠ 重复。「同一件事只改了一个数字」相似度能到 0.9+，
      //    但那是**冲突**不是重复 —— 判成重复就会把新说法直接拦下，
      //    人就永远不知道旧的那条已经错了。
      //    所以这里按「有没有同槽不同值」分岔：
      //      有具体值矛盾 → conflict（放行 + 报矛盾点）
      //      没有          → duplicate（老规矩，拦下让合并）
      if (why.length > 0) {
        if (conflict === null || j > conflict.j) conflict = { j, doc: c, reasons: why }
      } else if (best === null || j > best.j) {
        best = { j, doc: c }
      }
      continue
    }
    if (j >= relatedFloor) {
      if (related === null || j > related.j) related = { j, doc: c }
      if (why.length > 0 && (conflict === null || j > conflict.j)) {
        conflict = { j, doc: c, reasons: why }
      }
    }
  }
  return {
    duplicate: best,
    related,
    conflict,
    refSimilar,
  }
}

/** 查重命中时给调用方的提示：说清"为什么没写"和"接下来能做什么" */
function nearDuplicateHint(hit, threshold) {
  const preview = String(hit.doc.content || '').replace(/\s+/g, ' ').slice(0, 200)
  return (
    `⚠️ 没有写入：与已有条目高度重合（Jaccard ${hit.j.toFixed(2)} ≥ ${threshold}）。\n` +
    `[${hit.doc.level}] ${hit.doc.id}\n` +
    `${hit.doc.title ? String(hit.doc.title) + '\n' : ''}${preview}\n\n` +
    '是同一件事 → 用 memory_update 把新信息合进那条（保留原 id，别再开新条目）；\n' +
    '确实不同 → 再调一次并加 force: true。'
  )
}

/**
 * 写入成功但发现一条「像它但不完全一样」的旧条目时，附一句提醒。
 * 不阻断写入 —— 记忆会演化，新版本该记下来；但也别让两条互相打脸的记录悄悄并存。
 */
function relatedHint(hit) {
  const preview = String(hit.doc.content || '').replace(/\s+/g, ' ').slice(0, 120)
  return (
    `\n\n💡 近邻提示：这条与 [${hit.doc.level}] ${hit.doc.id} 有 ${Math.round(hit.j * 100)}% 重合。\n` +
    `   那条说的是：${preview}\n` +
    '   如果这是同一件事的新版本，把旧那条 memory_update 成 stale（或直接把内容合并过去）；' +
    '要是两件事那就这样放着。'
  )
}

/**
 * 写入成功、但附近有一条**内容相近的参考资料**时的提示。
 *
 * 为什么不拦、也不劝合并：reference 用的是「看过了，留着」的判据，
 * 它天生和后来照着做出的结论高度重合（实测 Jaccard 0.88）。
 * 判成重复会让结论写不进去；听劝合并更糟 —— 合进 reference 之后
 * 它既不进主排序、也不进自动命中，等于写进了一个没人看得见的地方。
 */
function refSimilarHint(hit, threshold) {
  const preview = String(hit.doc.content || '').replace(/\s+/g, ' ').slice(0, 120)
  return (
    `\n\n📎 附近有一条相近的**参考资料**（[${hit.doc.level}/reference] ${hit.doc.id}，` +
    `重合 ${Math.round(hit.j * 100)}%）—— 它只是留档备查的，**不算重复**，这条已经照常写入。\n` +
    `   那条讲的是：${preview}` +
    (hit.j >= threshold
      ? '\n   别把结论合并进它：参考资料不参与排序、也不会自动注入，合进去就没人看得见了。'
      : '')
  )
}

/**
 * 各层要写的列不完全一样（core 没有 project 列，其余三层都有）。
 * 抽成一个纯函数，省得在工具里堆 if 链。
 */
/**
 * 自动捕获规则：把明确的长期偏好/规则直接落库，不用等我动手。
 *
 * 判据宁缺毋滥 —— 抓错会污染库，比漏记更糟。所以只认「带时间副词」或「明说记住」
 * 或「明确好恶」或「带对象的禁令」，纯当轮指令（"我不要这个"）一律不抓。
 */
/**
 * 落档催办（pre-step 预制发送）。
 *
 * 为什么不用 auto-checkpoint 自己的催办：它走 `sessionController.prompt()`，那是「插入」语义
 * —— 消息进输入框等用户点确定。用户在干活时根本不会注意到，于是每次都是「突然压缩」。
 * 而塞进输入框的话，用户不点确认就不会发出去。
 */
// 🛑 2026-11-25：前缀原来是 `[auto-checkpoint] 上下文即将压缩（当前 `——
//    故意蹭第三方插件的前缀，好让它的自检也认出来。现在那个插件已归档，
//    前缀改回自己的，不再依赖任何外部文本约定。
//    ⚠️ 但 `findCompactionId` 里还留着一个兼容分支认老前缀（见那里），
//    因为**历史会话里已经有这种消息**，改得太干净会让老会话的压缩检测失效。
const PRECOMPACT_NUDGE_LEAD = '[dsh-memory] 上下文即将压缩（当前 '
const PRECOMPACT_FILE_RE = /^precompact-.*\.md$/i

/**
 * 扫工作区找最新的 precompact-*.md，返回 { path, mtime } 或 null。
 * 只看工作区根目录，不递归 —— 落档按约定就在根上。
 */
/**
 * 找工作区里**属于这个会话**的落档。
 *
 * 🛑 2026-11-25 修一个「压错会话」的真 bug（用户原话：
 *    「一边手动按压缩，另一边对话还没结束，他可能会等另一个对话结束之后，压另一个对话」）。
 *
 * 成因（两层叠在一起）：
 *   1. 文件名匹配是 `^precompact-.*\.md$` —— **所有会话的落档都算**；
 *   2. 取的是 `mtime` 最大的那一个 —— **全局最新**。
 * 于是：A 会话刚写完落档 → B 会话回合结束时 `turn-stopping` 一跑，
 * 找到的是 A 的文件，判定"我的落档刚写完" ⇒ **压了 B**。
 *
 * 现在：只认 `precompact-<本会话sid8>.md`。找不到就返回 null ⇒ **不压**
 * （宁可这一轮不压，也不要压错人）。想用自定义文件名，得同时改这里。
 */
function findLatestPrecompact(workspace, sessionId) {
  const sid8 = String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
  if (!sid8) return null
  // sid8 是 [0-9a-f] 8 位，本身无需转义；直接拼，不去写那套容易写错的转义正则
  const mineRe = new RegExp('^precompact-' + sid8 + '\\.md$', 'i')
  // 🛑 2026-11-19 修：必须**同时扫根目录和 `_落档/`**。
  //
  // 原来只 readdirSync(workspace)（根目录），而 auto-checkpoint 的催办明确要求
  // 把落档写到 `<workspace>/_落档/precompact-<sid>.md` —— 两边约定不一致。
  // 后果：检测永远只看得到根目录里那几个**几天前的旧文件**，然后被
  // `Date.now() - found.mtime > precompactJustWrittenMs` 挡住 ⇒ **永远不触发压缩**，
  // 而且日志里一条都不写（静默）。
  // 实测：11-19 写完落档、水位 60 万早过线，auto-compact 一次都没跑。
  const dirs = [workspace, path.join(workspace, '_落档')]
  let best = null
  for (const dir of dirs) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 目录不存在就跳过（不是每个工作区都有 _落档）
    }
    for (const e of entries) {
      if (!e.isFile() || !mineRe.test(e.name)) continue
      const p = path.join(dir, e.name)
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (best === null || st.mtimeMs > best.mtime) {
        best = { path: p, mtime: st.mtimeMs, name: e.name }
      }
    }
  }
  return best
}

/**
 * 落档催办文案。开头用 PRECOMPACT_NUDGE_LEAD，好让 auto-checkpoint 的自检也认出它。
 */
/**
 * 读 auto-checkpoint 的 remindTokens（压缩提醒水位）。
 * 读到就用它当判据 —— 这是「跟压缩插件用同一个水位」的唯一正确做法。
 */
/**
 * 水位默认值 = 65 万（65%）。
 *
 * 🛑 **别往上调。** 2026-11-25 踩过一次：调到 734000（73.4%）之后，
 * 上下文还没到就已经被压缩了，催办差几万永远轮不到 —— 表现就是「界面都 70% 了却不催」。
 *
 * ⚠️ 窗口是 **100 万**（用户确认过多次）。65 万和 60 万两个值都实测能正常触发催办，
 * 这是经验值，比任何从 `contextWindow - maxTokens` 推出来的数都可信。
 */
const DEFAULT_REMIND_TOKENS = 650000
let cachedRemindTokens = null
let cachedRemindMtime = -1
/**
 * 压缩水位（token）。**读自己的配置，不读别人的。**
 *
 * 🛑 2026-11-25 改：原来读 `~/.dsh/auto-checkpoint.json` —— 那是第三方插件
 * `dsh-auto-checkpoint` 的文件。用户明确要求「我的插件不要依赖其他人的插件的工具」，
 * 而且那个插件已经归档，文件随时可能被删（删了这里就退回硬编码 700000）。
 *
 * 现在的查找顺序：
 *   ① 环境变量 `DSH_MEMORY_REMIND_TOKENS`
 *   ② 自己的 `~/.dsh/dsh-memory.json` 里的 `remindTokens`
 *   ③ 硬编码默认 `DEFAULT_REMIND_TOKENS`
 *
 * 🛑 2026-11-25 修一个**致命算错**：原来默认 700000，注释写「窗口 1M 的 70%」。
 *    但 `deepseek-flash` 的 `maxTokens` 是 **384000**（输出预留），
 *    真正能装对话的是 `1000000 - 384000 - 65536(headroom) ≈ 55 万`。
 *    阈值 700000/734000 **比可用窗口还大 ⇒ 永远达不到 ⇒ 催办一次都不会响**。
 *    （用户实测：界面都 70% 了、压缩也发生了，`precompact check` 却判定「没到水位」。）
 */
function readRemindTokens() {
  try {
    const env = Number(process.env.DSH_MEMORY_REMIND_TOKENS)
    if (Number.isFinite(env) && env > 0) return env
  } catch { /* 环境变量读不到就往下走 */ }
  try {
    const p = path.join(os.homedir(), '.dsh', 'dsh-memory.json')
    const st = fs.statSync(p)
    // 只在文件真改了才重读 —— 每轮一次 statSync 比每轮 JSON.parse 便宜得多，
    // 而且用户热改 remindTokens（面板或 POST 接口）后不用重启就能跟上。
    if (cachedRemindTokens !== null && cachedRemindMtime === st.mtimeMs) return cachedRemindTokens
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const n = Number(j.remindTokens)
    cachedRemindTokens = Number.isFinite(n) && n > 0 ? n : DEFAULT_REMIND_TOKENS
    cachedRemindMtime = st.mtimeMs
    return cachedRemindTokens
  } catch {
    // 读失败（文件不在 / 权限）不缓存失败值，下次还能重试；先退回上次成功值
    return cachedRemindTokens !== null ? cachedRemindTokens : 700000
  }
}

/**
 * 落档里是否已经有「🔑 这一轮定下的结论」这一节，且那一节不是空的。
 * 照 dsh-auto-checkpoint 的内容闸门：只追加别处的内容不算数。
 */
function hasConclusionSection(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const m = text.match(/^##\s*🔑[^\n]*$/m)
    if (m === null) return false
    const after = text.slice(m.index + m[0].length)
    const next = after.search(/^##\s/m)
    const section = next >= 0 ? after.slice(0, next) : after
    return section.trim().length > 20
  } catch {
    return false
  }
}

function precompactNudgeText(workspace, found, sessionId) {
  // 🛑 2026-11-25：没有落档时给的绝对路径必须是**本会话**的 `precompact-<sid8>.md`。
  //    原来写的是字面量 `precompact-<session>.md` —— 模型照着把文件名写成
  //    `<session>` 的话，`findLatestPrecompact` 永远匹配不上（它只认 8 位 sid）。
  const sid8 = String(sessionId ?? '').replace(/^session-/, '').slice(0, 8) || 'session'
  const abs = found ? found.path : path.join(workspace, '_落档', `precompact-${sid8}.md`)
  const age = found ? Math.round((Date.now() - found.mtime) / 60000) : -1
  return (
    `${PRECOMPACT_NUDGE_LEAD}落档已 ${age < 0 ? '不存在' : age + ' 分钟没更新'}）。\n` +
    `\n` +
    `🛑 **现在就写，别等手上这步做完** —— 压缩一旦触发，这一段对话的原文就没了，` +
    `而摘要里不会写「我读过什么、试过什么、哪里行不通」。\n` +
    `\n` +
    `写进这个文件（绝对路径，就写它）：\n` +
    `\n` +
    `    ${abs}\n` +
    `\n` +
    `第一行标题照抄：\`# precompact 落档（session-<id>，<今天日期>）\`\n` +
    `\n` +
    `🛑 **先写 \`## 🔑 这一轮定下的结论\` 这一节** —— 3~7 条，一条一句，写成「以后照着做的那句话」。\n` +
    `验收判据：**压缩后的我漏了这一条会不会白干/推反方向** —— 会，才写进来。\n` +
    `**不要写「我干了什么」**，要写「想明白了什么机制/判据」。\n` +
    `\n` +
    `然后把这几节补齐（有就写，没有就略）：到哪一步 / 踩过的坑 / 下一步 / 环境事实。\n` +
    `写完回一句「落档完成」就停，别顺手干别的。`
  )
}


/**
 * 从落档 Markdown 里摘出「结论」那一节的正文。
 *
 * 为什么压缩后要把它**贴进注入**，而不是只给路径：
 * 只给路径等于把「最该继承的那几条结论」赌在「模型会不会真去读文件」上 ——
 * 实测赌输过（用户原话：「路径也没给，让你去看的也没给」）。
 * 判据：`## ` 开头且标题里带 🔑 的那一节，摘到下一个 `## ` 为止。
 */
function extractConclusionSection(md, maxChars = 2400) {
  if (typeof md !== 'string' || !md) return ''
  const lines = md.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && lines[i].includes('🔑')) {
      start = i + 1
      break
    }
  }
  if (start < 0) return ''
  const out = []
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    out.push(lines[i])
  }
  let body = out.join('\n').trim()
  if (!body) return ''
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + `\n…（这一节还有 ${body.length - maxChars} 字，读原文件）`
  }
  return body
}

const AUTO_CAPTURE_RULES = [
  // 「以后/今后/下次」+ 15 字内出现规则词。
  // 原来要求「以后」紧跟动作词，像「以后改代码前都先备份」这种自然说法中间隔了
  // 「改代码前」几个字就匹配不上，所以放宽到 15 字窗口。
  { name: '未来规则', re: /(以后|今后|从现在起|下次).{0,15}(都|要|别|不|必须|一律|统一|先|少|多)/ },
  { name: '记忆指令', re: /^(记住|记一下|记着|别忘了)[:：,，\s]/ },
  { name: '好恶', re: /(我|咱)(很|挺|有点|最|特别)?\s*(喜欢|不喜欢|讨厌|受不了|爱看|不爱看|习惯|一般会)/ },
  { name: '禁令', re: /(不要|别再|不许|不准)(再)?\s*(给我|跟我|帮我|让我)/ },
]

/**
 * 第二档：句式不匹配，但整句**像在陈述偏好 / 规则 / 纠正**。
 *
 * 🛑 为什么要有这一档（2026-11-19）：
 *   有些话完全不符合上面四类句式、却最该记 —— 比如"既然用 AI 了，
 *   就让它全自动一点，手动只作备选方案"这种**总方针**。
 *   它们没有任何句式特征，但恰恰是最该留下的东西。
 *   只靠句式匹配意味着"记住什么"取决于碰巧怎么说，那还是靠人。
 *
 * 做法：多个弱信号叠加，够 3 分才算。单条命中不抓（噪音太大）。
 * 抓进来的记录 importance 给 1、标题带「待确认」，方便日后清算。
 */
export function autoCaptureScore(text) {
  const s = String(text || '').trim()
  const hits = []
  let score = 0
  // 🛑 2026-11-19 实测误抓：「我觉得这个方案还可以**你觉得怎么样**」
  //    被当成偏好陈述存进了 detail。它靠「我」(+1) 和「我觉得」(+2) 刚好够 3 分，
  //    而那句话其实是在**征求意见**，不是陈述偏好。
  //    「你觉得怎么样」这种收尾没有问号，所以上面那条问句扣分拦不住。
  //
  //    审计后调轻：原来扣 2 分，会连「我觉得这样不好，你觉得呢」这种**真在说讨厌**的
  //    一起扣光。现在只扣 1 分，并且只认**句尾**的征求意见（句中的多是别的成分）。
  const askAtEnd = /(你觉得|你看|你说|你觉着|怎么样|如何|要不要|好不好|行不行|可以吗|对吗|呢)\s*[？?]?\s*$/.test(s)
  if (askAtEnd) {
    score -= 1
    hits.push('征求意见')
  }
  // 🛑 审计修：原来祈使句那条会把「你看」也算成祈使（两个闸口词表重叠），
  //    一句「你看呢」被扣 4 分。征求意见命中时不再算祈使。
  if (/(你|您)(自己)?(来|去|先|帮|看|弄|做|试|查|跑|改)/.test(s) && !askAtEnd) {
    score -= 2
    hits.push('祈使句')
  }
  if (/我/.test(s)) {
    score += 1
    hits.push('第一人称')
  }
  // 🆕 「明确反对」单独 +2：让「我觉得这样不好，你觉得呢」这种
  //    "陈述不喜欢 + 顺带问一句" 也能过 3 分。而「我觉得这个方案还可以，你觉得怎么样」
  //    没有明确反对词，扣完只剩 2 分，仍然不抓 —— 正好是我们要的分界。
  if (/(不好|不行|不喜欢|讨厌|受不了|太麻烦|很烦|难受|别扭|别扭)/.test(s)) {
    score += 2
    hits.push('明确反对')
  }
  if (/(应该|不该|没必要|必须|最好|不如|宁愿|宁可|值得|不值得|别搞|要搞)/.test(s)) {
    score += 1
    hits.push('判断')
  }
  // 「肯定 / 确实 / 当然」这类强调 + 「比较好 / 更好 / 还行」这类比较，
  // 通常出现在"我认为应该怎样"的句子里（实证：「我都用 ai 了，肯定全自动一点比较好」）
  if (/(肯定|确实|当然|一定|绝对)/.test(s)) {
    score += 1
    hits.push('强调')
  }
  if (/(比较好|更好|差点|还行|不错|差远了|不合适|合适)/.test(s)) {
    score += 1
    hits.push('评价')
  }
  if (/(我觉得|我认为|对我来说|我的理解|按我的|我更|我习惯|我一般|通常我|我是这样)/.test(s)) {
    score += 2
    hits.push('自我陈述')
  }
  if (/(不是这个意思|不对|错了|我说的是|搞错|理解错|别搞混)/.test(s)) {
    score += 2
    hits.push('纠正')
  }
  if (/(方便|快捷|省事|麻烦|啰嗦|简单点|干净点|清爽|顺手)/.test(s)) {
    score += 1
    hits.push('体验偏好')
  }
  // 「不要我」太泛（"不要我看/不要我管"是指令），收紧成"不要我操心"这种才是期望
  if (/(全自动|自动一点|别让我|不用我|省得我|不要我操心|不要我动手|别等人)/.test(s)) {
    score += 1
    hits.push('自动化期望')
  }
  // 「我能理解 / 说得通 / 认可」—— 在表达对某件事的接受或反对，是判断不是描述。
  // 实证：一句不带规则词、只表达态度的反馈，单靠这一条才够 3 分。
  if (/(能理解|可以理解|理解不了|说得通|说不通|认可|不认可|同意|不同意)/.test(s)) {
    score += 1
    hits.push('认同/反对')
  }
  if (/(原则|规矩|铁律|一律|统一|标准|规范)/.test(s)) {
    score += 1
    hits.push('规则词')
  }
  return { score, hits }
}

/** 命中返回规则名，否则 null。 */
export function matchAutoCapture(text) {
  const s = String(text || '').trim()
  if (s.length < 6 || s.length > 400) return null
  for (const r of AUTO_CAPTURE_RULES) {
    if (r.re.test(s)) return r.name
  }
  // 第二档：信号评分。前缀 `陈述·` 表示"没命中固定句式，是估出来的"
  const sc = autoCaptureScore(s)
  if (sc.score >= 3) return '陈述·' + sc.hits.slice(0, 2).join('/')
  return null
}

/**
 * 「用户正在描述一个方案」的句式识别（2026-11-19 加）。
 *
 * 🛑 为什么要有它：
 *   用户问「我跟你说这是一个方案，但没让你主动写进去，你会去写吗」——
 *   诚实答案是不会。而方案恰恰是**最该跨会话保持**的东西
 *   （`memory_plan` 存在的理由就是"聊完要做的事，压缩一下就没了"）。
 *   更关键的是他那句：「不然你让人每时每刻都能记得住自己要提醒 ai 一下估计有点麻烦」——
 *   **靠人记得提醒，等于没做**。
 *
 * 做法：命中就**自动建一份草稿方案**（标题带「草稿·待确认」），并在回执里
 * 让模型跟用户确认。不做"完美自动建档"：草稿错了用户能删能改，
 * 而漏掉一条方案是不可恢复的。
 *
 * ⚠️ 判定要保守：宁可漏，也别把他随口一句评价当成新方案建进库。
 */
const PLAN_INTENT_RULES = [
  { name: '明确是方案', re: /(这|那)\s*(是|算|就算)\s*(一?个)?\s*(方案|计划|思路|路线图|路线)/ },
  { name: '我的方案', re: /我\s*(的)?\s*(方案|计划|打算)\s*(是|就|如?下|这么)/ },
  // 🛑 2026-11-19 审计修（P0）：原来只要求「我打算 + 先|这么|分」，后面跟什么都算，
  //    结果「我打算先睡一觉，明天再说」「我准备先洗个澡」全被建成了草稿。
  //    唯一挡住它们的是 12 字长度闸 —— 那是运气，不是判据。
  //    ⇒ 后面必须接**工程类动作**才算在讲方案。
  {
    name: '打算这么做',
    re: /我\s*(打算|准备|计划|想)\s*(先|这么|这样|分).{0,12}(改|做|跑|写|拆|测|备|发|弄|实现|上线|补|加|调|试|换|删|建|查|排序|验证|整理|重写|修|重构)/,
  },
  { name: '分步走', re: /(分\s*\d+\s*步|第\s*一\s*步.{0,40}第\s*二\s*步|先.{0,20}再.{0,20}最后)/ },
]

export function matchPlanIntent(text) {
  const s = String(text || '').trim()
  // 上限从 600 放宽到 1500：原来把一整份 markdown 方案贴进来会返回 null ——
  // 越完整的方案越不认，正好反了。
  if (s.length < 12 || s.length > 1500) return null
  // 问句不是在宣布方案。
  // 🛑 2026-11-19 审计修（P0）：原来只认结尾的「？」，而中文口语用「吗/吧/呢」结尾
  //    常常不带标点 —— 实测「这是一个方案吗，我有点记不清了」被直接建成了草稿。
  if (/[？?]\s*$/.test(s)) return null
  // 「吗」基本只作疑问语气词，**出现即算问句** —— 不能只盯句尾：
  // 实测「这是一个方案吗，我有点记不清了」「我的方案是这样吗，你确认下」都漏过去了。
  if (/吗/.test(s)) return null
  // 「吧 / 呢 / 么」在句尾才算问句。「就这样吧」是决定不是提问，句中出现的多是别的成分。
  if (/(吧|呢|么)\s*[，,。.！!]?\s*$/.test(s)) return null
  // 否定闸：只拦「方案**本身**被否定」。
  // 🛑 原来判据是「含否定词 且 含方案|计划」就整句放弃，于是
  //    「我的计划是先跑压力测试，有问题就回滚」这种**最有执行细节**的反而被筛掉了 ——
  //    "有问题"在那里是条件分支，不是对方案的否定。
  if (/(这|那|这份|那份|你的)?\s*(方案|计划)\s*(本身)?\s*(不行|作废|放弃|别用|不要了|算了)/.test(s)) return null
  for (const r of PLAN_INTENT_RULES) if (r.re.test(s)) return r.name
  return null
}

/**
 * 疑似敏感内容 —— 命中的话**自动捕获不落库**。
 *
 * 🛑 为什么要有这道闸：自动捕获抓的是**原始消息**，未经提炼。
 *    用户经常在对话里贴 token / 密钥 / 连接串 / 身份证号（排障、让助手改配置），
 *    同一句话里再提一句"以后别贴这类东西"就会命中捕获规则。
 *    这些原文一旦进库，就会被检索命中、被注入带进别的会话。
 *    宁可不记这一条，也不要把它存成长期记忆 —— 要记可以手动 memory_remember 提炼后写。
 */
const SECRET_RE =
  /(token|passwd|password|secret|api[_-]?key|bearer\s+[a-z0-9._-]{10,}|sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|密码|密钥|私钥|口令|身份证|银行卡|信用卡|验证码)/i


/** 把 category 收敛到该层允许的取值里；非法或没传就用默认值 */
function resolveCategory(layer, raw) {
  const allowed = CATEGORIES[layer] || []
  const v = String(raw || '').trim()
  if (v && allowed.includes(v)) return v
  return DEFAULT_CATEGORY[layer] || 'fact'
}

/**
 * 规范化「原文出处」成 `sid#seq,sid#seq`。
 *
 * 为什么允许半截 id：手写常常只给后半截、或者只有 8 位。
 * 存半截照样能 LIKE 命中，不强迫他记全。缺 `session-` 前缀就补上。
 * 也接受 `sid@seq`、`sid:seq`、`[..]` 数组 —— 写法不该成为负担。
 */
function normalizeSourceRef(v) {
  if (v === undefined || v === null) return null
  const parts = Array.isArray(v) ? v : String(v).split(/[,，\n]/)
  const out = []
  for (const p of parts) {
    const s = String(p || '').trim()
    if (!s) continue
    const m = s.match(/^(.*?)(?:[#@]\s*(\d+))?$/)
    let sid = String((m && m[1]) || '').trim().replace(/[:：]$/, '')
    const seq = (m && m[2]) || ''
    if (!sid) continue
    // 长成 8-4-4-4-12 且没有前缀的，补 session-
    if (!/^session-/.test(sid) && /^[0-9a-f]{4,}/i.test(sid)) sid = `session-${sid}`
    out.push(seq ? `${sid}#${seq}` : sid)
  }
  return out.length ? out.join(',') : null
}

/**
 * 规范化「域」：**自由文本**，逗号分隔多条，最多留 4 个。
 *
 * 🛑 不做枚举校验。常见的也就五个范围，但其他人不一定，
 *    其他人还有可能干点比较神经的事情」。硬限定五个等于替别人决定他能干什么。
 *
 * 域是「谁写谁判断」：同一个 agent 自己写的时候标什么，判断当前轮时也用同一套词，
 * 两边自然对得上，不需要跨人统一。
 *
 * 只做三件事：去空白、去重、**限长**（防止把整段正文塞进标签字段）。
 */
function normalizeDomain(v) {
  if (v === undefined || v === null) return null
  const parts = Array.isArray(v) ? v : String(v).split(/[,，、\n]/)
  const seen = new Set()
  const out = []
  for (const p of parts) {
    const s = String(p || '').trim().slice(0, 40)
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
    // 一条记忆挂太多域等于没标
    if (out.length >= 4) break
  }
  return out.length ? out.join(',') : null
}

/**
 * 「这一轮在干什么」—— 域的推断。
 *
 * 为什么不能按项目推：同一个项目里写了很多代码，这算创作还是算编程？
 * 我个人看上去更像编程」。**项目是归属，域是性质**，同一个项目里两回事。
 *
 * 信号按信息量排（权重也按这个给）：
 *   ① 上一轮实际碰的路径 / 命令 —— ×2，最硬的事实（工具名本身几乎没信息量：
 *      `ops_bash` 跑 git 是编程、跑 ffmpeg 是创作）。
 *      🛑 来源是**工具执行时自己记的**（`recordToolForDomain`），不是从 messages 里翻 ——
 *      pre-step 的 messages 只有 `UserMessage[]`，一条 assistant 都没有（2026-11-20 实测）。
 *   ② 这一轮的消息文本 —— ×1
 *   ③ 本步消息里带的工具结果（role=tool）—— ×1.5，有就用，没有不影响
 *
 * 所以这永远是"猜"：判不出来就返回 null，调用方据此**不降权**（宁可不管，别瞎拦）。
 */
/**
 * 域推断的最低分：低于这个就当"判不出来"，不降权。
 *
 * 🛑 2026-11-20 两次实测调这个值：
 *    ① 原来写死 1.5 —— 上线后 40 多轮只判出 1 次，等于没生效；
 *    ② 降到 1.0 —— 补了词表之后能判出来，但「我重启好了」这种只命中一次的
 *       刚好等于 1.0，卡在边缘，少一个字就掉。
 *    现在是 0.5：用户话权重是 ×1，命中一次就过；工具参数是 ×2，命中一次就够。
 *    误判的代价只是**降权**（0.15 倍，不是 0），不是硬拦错误，所以宁可宽松。
 */
const DOMAIN_MIN_SCORE = 0.5

/**
 * 单条写入的硬上限（2026-11-20 压力测试逼出来的）。
 *
 * 🛑 之前工具层**一点上限都没有**：1MB 正文、10 万字标题、1000 个关键词
 *    全都能安安静静写进库，还不报错（实测 `test/tools-malformed.mjs`）。
 *    而 HTTP handler 那边早就有「标题上限 200 字」—— 同一个库的两条写入路径
 *    规矩不一致，等于白加。
 *
 * 为什么是「拒绝」不是「静默截断」：截断会丢内容且不留痕，调用方以为存进去了，
 * 日后搜不到还会再写一遍，库越写越乱。拒绝 + 说清怎么办，代价只是一次重试。
 *
 * 数值的来由：正文 20000 字 ≈ 正常 topic（3000）的 6 倍余量，但离 1MB 差两个数量级；
 * 标题 200 照抄 handler 的口径；关键词 50 个 × 60 字已经远超实际使用（一般 8~13 个）。
 */
const MAX_CONTENT = 20000
const MAX_TITLE = 200
const MAX_KEYWORDS = 50
const MAX_KEYWORD_LEN = 60
// 🛑 2026-11-20 边界审计：项目名原来没有上限。60 已经远超任何真实项目名
// （最长的是「父项目/子板块/更细」这种两三级的十来个字），
// 但足够挡住 5000 字符那种把面板列表和注入日志全污染的输入。
const MAX_PROJECT = 60

/**
 * 项目名归一化（2026-11-20 边界审计）。
 *
 * 为什么要有：`project` 是自由文本，实测这些畸形值都能写进库，而且**半通不通**——
 *   · `/`、`//`：查父查子都不通，就是一个叫 `/` 的怪项目；
 *   · `a/`：查父 `a` 能命中它（因为 `startsWith('a/')`），但查 `a/` 查不到 `a/b`；
 *   · `/a`：连父都匹配不上。
 * 多层语法里首尾斜杠本来就没意义，写入时统一掐掉；纯斜杠退化成「全局」。
 */
function normalizeProject(p) {
  const s = String(p ?? '').trim()
  if (!s) return '全局'
  if (/^\/+$/.test(s)) return '全局'
  const collapsed = s.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
  return collapsed || '全局'
}

/**
 * 关键词规范化：非数组直接丢空、去空串、限个数、限单词长度。
 *
 * 只做「防写坏」，不做提示 —— 提示由调用方（memory_remember）根据截断情况补。
 * 关键词丢了不影响正文检索（正文才是主索引），所以这里截断是安全的，
 * 和正文「超限就拒绝」不是一回事。
 */
function clampKeywords(list) {
  if (!Array.isArray(list)) return []
  return list
    // 🛑 只收字符串和数字。原来是 `String(x ?? '')`，对象会变成 `[object Object]`
    //    原样写进 keywords 字段（审计实测：传 `[1, {a:1}, null, true]` 时
    //    `"[object Object]"` 就落库了），既污染列表渲染，也让关键词检索出现幽灵词。
    .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS)
    .map((x) => (x.length > MAX_KEYWORD_LEN ? x.slice(0, MAX_KEYWORD_LEN) : x))
}

/**
 * 「上一轮实际干了什么」的原料。
 *
 * 🛑 2026-11-20 实测（第二次栽在同一类假设上）：`agent/pre-step` 的 payload 类型是
 *    `{ agent, messages: UserMessage[], turn, step, signal, modelSelection }`
 *    （`dsh-agent/src/runtime-types.ts`），`PreStepDecision.messages` 同样是 `UserMessage[]`
 *    —— **整条链路只有用户侧消息，一条 assistant 都摸不到**。
 *    所以"从 messages 里找上一轮的 tool-call"从写下那天起就恒为空（新加的诊断打得明明白白：
 *    `scan=0 shape=-`），域推断实际只靠"用户这一轮说了什么"在猜，两个主信号全是死的。
 *
 * 改法：**工具执行时自己记**。`mk` 的 execute 现在能拿到 `run.agent`（DSH 的
 * ToolRunContext），那就在这里按会话把"刚调了什么、参数里有什么"攒下来，pre-step 时取走。
 * 这比翻 session 历史便宜，而且就是"上一轮实际碰的东西"本身。
 */
const domainToolLog = new Map() // key -> { at, items: [string], count, turn }
const DOMAIN_TOOL_KEEP = 8 // 一次最多记 8 条，别让长会话把它撑爆
const DOMAIN_TOOL_TTL = 10 * 60 * 1000 // 10 分钟前的工具调用不算"这一轮在干什么"

/**
 * 把各种会话 id 归一成同一个 key。
 *
 * 两处拿到的形状不一样：`agent/pre-step` 的 `agent.id` 是 **12 位尾段**
 * （日志里 `session=abcdef123456`），而 `session/event` 给的 `session.id` 是
 * **完整 id**（`session-01234567-89ab-cdef-0123-456789abcdef`）。
 * 不归一就对不上，记了一堆查不到。
 */
function sidKey(id) {
  const s = String(id || '').replace(/^session-/, '')
  return s.length >= 12 ? s.slice(-12) : s
}

/** 给 memory_context 显示用的短 id：只留前 8 位（会话 id 长得像 UUID，全显示太吵）。 */
function shortSid(id) {
  const s = String(id || 'global').replace(/^session-/, '')
  return s.length > 8 ? s.slice(0, 8) + '…' : s
}

/**
 * 「有记忆、但没建项目核心」的项目清单（2026-11-22 加）。
 *
 * 🛑 为什么要有它：两条线是**独立**的 ——
 *    记忆条目的 `project` 字段是 `memory_remember` 时随便填的；
 *    而项目核心**必须手动登记进 `projects.json`** 才会出现在面板上、才会按关键词自动注入。
 *    于是「有记忆、没核心」的项目用户在面板上**完全看不见**，会以为这个项目的记忆根本不存在
 *    （2026-11-22 隔壁窗口报的可见性缺口：库里 26 个项目名、合计 700+ 条记忆没核心）。
 *
 * 跳过两类：
 *   · 「全局」—— 它是默认归属，不是一个项目
 *   · 子项目（`父/子`）—— 内容归父项目核心，自己不该有文件（Windows 文件名也不允许 `/`）
 */
function listOrphanProjects(db) {
  let names = []
  try {
    names = listProjectNames(db)
  } catch {
    return []
  }
  let have = new Set()
  try {
    const cfg = readProjectConfig()
    have = new Set(Object.keys((cfg && cfg.projects) || {}))
  } catch {
    have = new Set()
  }
  const out = []
  for (const n of names) {
    if (String(n).includes('/')) continue
    if (have.has(n)) continue
    let cnt = 0
    try {
      for (const table of ['project', 'branch', 'detail']) {
        // 用 instr 而不是 LIKE：项目名里的 _ 和 % 会被 LIKE 当通配符
        const r = db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE instr(',' || project || ',', ?) > 0 AND status != 'archived'`,
          )
          .get(`,${n},`)
        cnt += r?.n || 0
      }
    } catch {
      continue
    }
    if (cnt > 0) out.push({ name: n, count: cnt })
  }
  return out.sort((x, y) => y.count - x.count)
}

/**
 * 记录一次工具调用（数据源是 `session/event` 的 `tool/call`，见下面的监听）。
 *
 * 🛑 为什么不用 `mk` 的 execute 记：插件自己的工具全叫 `memory_*`，而这里要跳过的
 *    恰恰就是元操作 —— 结果是一条都记不到。真正要看的是 `ops_bash` / `read` /
 *    `write` / `computer` 这些**别的插件和内置工具**，只有会话事件看得见。
 */
function recordToolForDomain(id, name, argsText, turn) {
  const key = sidKey(id)
  if (!key) return
  // memory_* 是元操作，两个方向都不算 —— 免得把"我在整理记忆"算成编程域
  if (String(name || '').startsWith('memory_')) return
  try {
    const cur = domainToolLog.get(key) || { at: 0, items: [], count: 0, turn: -1 }
    // 换轮了就把上一轮残留扔掉：只留"最近这一轮"的工具调用
    if (Number.isFinite(turn) && turn !== cur.turn) {
      cur.items = []
      cur.count = 0
      cur.turn = turn
    }
    cur.items.push(String(argsText || '').slice(0, 1500))
    if (cur.items.length > DOMAIN_TOOL_KEEP) cur.items.splice(0, cur.items.length - DOMAIN_TOOL_KEEP)
    cur.count += 1
    cur.at = Date.now()
    domainToolLog.set(key, cur)
  } catch {
    /* 记不下不影响工具本身 */
  }
}

/**
 * 取走并**销账**：读过的这批不再计入下一轮。
 * 不清的话，一轮的工具调用会在后面每一轮都算一遍，域就永远粘在同一个标签上。
 *
 * 返回 `{ text, count }`：
 *   - `text` 给域推断当信号（×2）
 *   - `count` 给反思催办加权（干了多少事）；这个数是**真实工具调用数**，
 *     以前用 `countLastTurnToolCalls(messages)` 数 assistant 里的块 —— 同样永远数到 0，
 *     导致加权轮次退化成"每轮固定 +1"。
 */
function takeDomainToolText(id) {
  const key = sidKey(id)
  if (!key) return { text: '', count: 0 }
  const cur = domainToolLog.get(key)
  if (!cur) return { text: '', count: 0 }
  const { items, count, at } = cur
  cur.items = []
  cur.count = 0
  if (Date.now() - at > DOMAIN_TOOL_TTL) {
    domainToolLog.delete(key)
    return { text: '', count: 0 }
  }
  domainToolLog.set(key, cur)
  return { text: items.join('\n'), count: Number(count) || 0 }
}

/**
 * 只读"上一轮调了几个工具"，**不销账**。
 *
 * 给反思催办的加权轮次用：它每轮都要算，而且短消息（「1」「嗯」）不触发域推断、
 * 也就没有销账 —— 这时计数必须还在，不能因为"没被域推断取走"就当成 0 个工具。
 *
 * 🛑 `turn` 必须传（2026-11-20 逻辑审计 P1）：
 *    原来不判轮次，而 `recordToolForDomain` 里「换轮清空」的前提是**新的一轮里有工具调用**。
 *    纯聊天的轮次没有 `tool/call` 事件 ⇒ `cur.turn`/`count` 停在上一轮，于是
 *    turn N 调了 10 个工具之后，turn N+1、N+2…… 每轮都读到 10 ⇒ `weight=3`。
 *    设计意图是「纯聊天 18 轮催一次」，实际变成 6 轮催一次 —— 正好违反
 *    实测口径：纯聊天七轮一次没必要，15~20 轮都行。
 *    只认「上一轮」（`cur.turn === turn - 1`），别的轮次一律当 0。
 */
function peekDomainToolCount(id, turn) {
  const key = sidKey(id)
  if (!key) return 0
  const cur = domainToolLog.get(key)
  if (!cur) return 0
  if (Date.now() - cur.at > DOMAIN_TOOL_TTL) {
    domainToolLog.delete(key)
    return 0
  }
  // turn 没给（老调用方）就保持原行为，给了就必须是紧邻的上一轮
  if (Number.isFinite(turn) && cur.turn !== turn - 1) return 0
  return Number(cur.count) || 0
}

const DOMAIN_HINTS = [
  [
    '编程',
    /(\bgit\b|\bpnpm\b|\bnpm\b|\bnode\b|python|\.js\b|\.mjs\b|\.cjs\b|\.ts\b|\.py\b|lib\/|test\/|function|const |=>|import |报错|堆栈|接口|函数|编译|依赖|插件|schema|sql|http|debug|日志|断言)/i,
  ],
  [
    '创作',
    /(ComfyUI|comfy|custom_nodes|workflow|Lora|LoRA|models\/|\.png\b|\.jpg\b|\.jpeg\b|\.mp4\b|\.webp\b|构图|画风|tag\b|提示词|出图|姿势|表情|分镜|剧本|立绘|分格|镜头)/i,
  ],
  [
    '系统',
    // 🛑 2026-11-20 补：第一版词表漏了最基础的运维词 —— 实测「我重启好了」这一轮
    //    原始分数是"无"，一个域都没命中，域推断直接等于没上线。这类词必须进去。
    /(备份|恢复|驱动|显卡|ROCm|CUDA|\.bat\b|\.ps1\b|注册表|环境变量|防火墙|代理|镜像|磁盘|挂载|服务|进程|端口|重启|开机|关机|休眠|蓝屏|装好|装完|卸载|更新|升级|日志|配置)/i,
  ],
  [
    '生活',
    /(吃饭|睡觉|心情|好累|好笑|梗图|休息|周末|今天|明天|晚上|焦虑|烦)/i,
  ],
]

/** 数一段文本在每个域上命中多少次（不区分大小写，全局匹配） */
function scoreText(text, weight, acc) {
  if (!text) return
  const s = String(text).slice(0, 4000)
  for (const [d, rx] of DOMAIN_HINTS) {
    const m = s.match(new RegExp(rx.source, 'gi'))
    if (!m) continue
    acc.set(d, (acc.get(d) || 0) + m.length * weight)
  }
}

/**
 * @returns {null | Array<{d:string, s:number}>} 按分数降序，最多两项；总分不够就 null
 */
function domainOfTurn(messages, toolText) {
  // 统一返回 `{ list, debug }`：list 为 null = 判不出来（调用方不降权），
  // debug 永远带上原始分数，否则线上只能看到"没判出来"，看不出为什么。
  const msgs = Array.isArray(messages) ? messages : []
  if (msgs.length === 0 && !toolText) {
    return { list: null, debug: { top: [], toolCalls: 0, raw: [] } }
  }
  const acc = new Map()

  // ① 上一轮实际干的事 —— 来自**工具执行时**记下的参数，不是从 messages 里找
  //    （pre-step 只有 UserMessage[]，一条 assistant 都没有，见 recordToolForDomain 的注释）。
  //    权重 ×2：工具碰过哪个路径、跑了什么命令，是比"说了什么"硬得多的事实。
  let toolCalls = 0
  if (toolText) {
    const lines = String(toolText).split('\n').filter(Boolean)
    toolCalls = lines.length
    for (const line of lines) scoreText(line, 2, acc)
  }

  // ② 这一轮的消息文本（×1）
  scoreText(lastUserText(msgs), 1, acc)

  // ③ 本步消息里的工具结果（role=tool / source.kind=tool-result）。
  //    pre-step 的 messages 里除了用户输入，还可能带上一步的工具续接，
  //    里面就是真实输出（报错堆栈、文件内容）—— 有就用，没有也不影响。
  for (const m of msgs) {
    if (!m) continue
    const isTool =
      m.role === 'tool' ||
      (m.source && typeof m.source.kind === 'string' && m.source.kind.startsWith('tool'))
    if (!isTool) continue
    const t = typeof m.content === 'string' ? m.content : ''
    if (t.trim()) scoreText(t, 1.5, acc)
  }

  const ranked = [...acc.entries()]
    .map(([d, s]) => ({ d, s: Math.round(s * 10) / 10 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
  // 把原始分数吐出去，供调用方打日志 —— 只返回 null 的话看不出"为什么判不出来"，
  // 实测上线后 40 多轮里只成功判出 1 次，全靠这个才知道是阈值卡太死。
  const debug = { top: ranked, toolCalls, raw: [...acc.entries()].map(([d, s]) => `${d}=${Math.round(s * 10) / 10}`) }
  if (ranked.length === 0 || ranked[0].s < DOMAIN_MIN_SCORE) return { list: null, debug }
  return { list: ranked, debug }
}

function insertPlan(args, layer, id, body, now) {
  // 🛑 长度是**库的约束**，不是某个工具入口的约束（2026-11-20 逻辑审计 P1）。
  //    之前只把闸装在 `memory_remember` 的入口，于是三条路都能绕过：
  //    `memory_update`（原样 UPDATE）、面板「新增/修改」（只掐标题）、自动捕获。
  //    闸放在这个唯一插入漏斗上，谁写都躲不过。
  //    超限抛异常：调用方（工具层 / pre-step 的捕获）都有 try/catch，
  //    会变成一条明确的「⚠️ … 超长」而不是把库写脏。
  const bodyLen = String(body ?? '').length
  if (bodyLen > MAX_CONTENT) {
    throw new Error(`正文 ${bodyLen} 字，超过单条上限 ${MAX_CONTENT} 字，没有写入`)
  }
  const titleLen = args && args.title != null ? String(args.title).trim().length : 0
  if (titleLen > MAX_TITLE) {
    throw new Error(`标题 ${titleLen} 字，超过上限 ${MAX_TITLE} 字，没有写入`)
  }
  // 🛑 2026-11-20 边界审计 A7：`project` 原来**一个字闸都没有** ——
  //    content 有 MAX_CONTENT、title 有 MAX_TITLE，就它可以原样写 5000 字符进库，
  //    然后污染面板的项目列表、写入提示、注入日志（`projects.json` 里永远没这个键）。
  //    这里拒绝而不是截断：截断会和别的项目名撞车。
  const projectLen = args && args.project != null ? String(args.project).trim().length : 0
  if (projectLen > MAX_PROJECT) {
    throw new Error(`项目名 ${projectLen} 字，超过上限 ${MAX_PROJECT} 字，没有写入`)
  }
  const cols = [
    'id', 'category', 'title', 'content', 'importance', 'keywords', 'status',
    'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at',
    // 包 B 后半 + 包 D 的三个字段（2026-11-19 加的列，老库已迁移补齐）
    'happened_at', 'context', 'mood',
    // v3（2026-11-20）：原文出处，格式 `sid#seq,sid#seq`
    'source_ref',
    // v4（2026-11-20）：域（这件事的性质）。自由文本，逗号分隔多条。
    'domain',
  ]
  const vals = [
    id,
    resolveCategory(layer, args.category),
    args.title || null,
    body,
    clamp(args.importance ?? 1, 1, 4),
    // 关键词统一走 clampKeywords（限 50 个 × 60 字）：压力测试发现 1000 个词
    // 能原样写进库，8891 字符的 keywords 字段会拖累列表渲染和体检统计。
    JSON.stringify(clampKeywords(args.keywords)),
    'active',
    // 🛑 2026-11-19 复查修：原来这里写死 'dsh-memory'，于是 inject.js 里那句
    //    `if (sessionId && d.source_session === sessionId) continue`（"本会话刚写的
    //    就别再回注给自己"）**永远是假** —— 自动捕获一旦真能写库了，同一会话下一轮
    //    就会把自己刚说的话当成"记忆命中"再灌回来，非常怪。
    //    能拿到 sessionId 的调用方（自动捕获）必须传进来。
    String(args.sourceSession || 'dsh-memory'),
    0,
    now,
    now,
    null,
    normalizeTime(args.happened_at ?? args.happenedAt),
    normalizeContext(args.context),
    normalizeMood(args.mood),
    normalizeSourceRef(args.source ?? args.sourceRef),
    normalizeDomain(args.domain),
  ]
  // core 没有 project（核心记忆是跨项目的）；另外三层都有
  if (layer !== 'core') {
    cols.splice(2, 0, 'project')
    vals.splice(2, 0, normalizeProject(args.project))
  }
  return { cols, vals }
}

/**
 * 🛑 已删除（2026-11-20）：原 `countLastTurnToolCalls(messages)` / `countToolCalls(messages)`。
 *
 * 它们都在数 assistant 消息里的 `{type:'tool-call'}` 块，而 `agent/pre-step` 的 payload 是
 * `messages: UserMessage[]`、`PreStepDecision.messages` 也是 `UserMessage[]`
 * （`dsh-agent/src/runtime-types.ts`）—— **一条 assistant 都进不来**，
 * 所以两个函数从写下那天起就恒返回 0，加权轮次等于永远"每轮 +1"。
 *
 * 现在"上一轮调了几个工具"来自 `recordToolForDomain` / `takeDomainToolText`
 * （工具执行时按会话记，`mk` 的 execute 拿得到 `run.agent`）。别再写数 assistant 的代码。
 */

function countHumanMessages(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    if (!m || m.role !== 'user') continue
    const src = m.source || {}
    if (src.kind && src.kind !== 'user') continue
    n++
  }
  return n
}

/**
 * 造一条「插件注入」的 user 消息。
 * 三条注入路径（首轮快照 / 每条命中 / 压缩后重注入）外加反思提醒，形状必须一致，
 * 否则客户端的折叠逻辑和"这是插件注入的还是用户输入的"判断都会乱。
 */
/**
 * 构造「压缩后接棒」的正文：落档提示（含 🔑 结论摘抄）+ 记忆快照 + 最近几轮原话。
 *
 * 🛑 2026-11-27 抽出来是为了**两处共用同一份文案**：
 *    ① `agent/turn-stopping` 里 auto-compact 成功的回调 —— **压完立刻 followup**（主路）
 *    ② pre-step 里的兜底 —— 万一那次 followup 没发出去，用户先说话时补上
 *    两处文案必须同源，否则内容会漂（用户最在意的就是「压缩完要有人叫我读落档」）。
 *
 * @param {object} a
 * @param {string} a.workspace 工作区根（落档在 `<workspace>/_落档/precompact-<sid8>.md`）
 * @param {string} a.sessionId 会话 id（用来定位落档）
 * @param {string} a.body 记忆库快照正文（由调用方用 buildInjectionBody 算好）
 */
function buildReanchorPayload({ workspace, sessionId, body, maxMsgs = 8, recentMaxChars = 3000 }) {
  const recent = recentConversationText(sessionId, { maxMsgs, maxChars: recentMaxChars })
  const sid8 = String(sessionId).replace(/^session-/, '').slice(0, 8) || 'session'
  const noteAbs = path.join(workspace, '_落档', `precompact-${sid8}.md`)
  let noteHint = ''
  let noteFound = false
  // 摘进注入的结论字数（0 = 落档里没有 🔑 节，或者文件读不出来）
  let noteConclusionChars = 0
  try {
    const st = fs.statSync(noteAbs)
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000)
    noteFound = true
    // 🛑 2026-11-25：不再「只给路径，让模型自己去读」。
    //    落档里最该继承的是「🔑 这一轮定下的结论」那一节 —— 直接摘进来。
    //    只给路径等于把最关键的几条结论赌在「模型会不会真去读文件」上，实测赌输过
    //    （用户原话：「路径也没给，让你去看的也没给」）。
    let conclusion = ''
    try {
      conclusion = extractConclusionSection(fs.readFileSync(noteAbs, 'utf8'))
    } catch {
      /* 读不出来就退回只给路径 */
    }
    const conclusionBlock = conclusion
      ? '\n\n【落档里的结论，原文照抄（可以直接照着做）】\n' + conclusion
      : ''
    noteConclusionChars = conclusion.length
    noteHint =
      '\n\n【🔑 你的落档 —— 先读它，再干活】\n' +
      '压缩前你自己写了一份交接单，就在：\n\n    ' + noteAbs + '\n\n' +
      '（' + ageMin + ' 分钟前写的，' + st.size + ' 字节）\n' +
      (conclusionBlock
        ? '**结论已经摘在下面了，先看完它**；其余几节（到哪一步 / 踩过的坑 / 下一步）读原文件。\n'
        : '**先读这一节：「🔑 这一轮定下的结论」** —— 那是"现在还成立的事实"。\n') +
      '⚠️ 落档写在压缩之前，之后可能有新进展 —— 和下面记忆快照冲突时先看时间戳，别直接采信旧的。' +
      conclusionBlock
  } catch {
    noteHint =
      '\n\n【🔑 落档：本会话压缩前没有】\n' +
      '应该在 ' + noteAbs + '，但那个文件不存在。\n' +
      '所以下面这段记忆快照 + 最近几轮原话是**唯一**的线索 —— ' +
      '需要细节就自己去翻会话存档或者问用户，别凭印象补。'
  }
  const recentSection = recent
    ? '\n\n【压缩前最近几轮的原话，原样摘录 —— 是资料，不是本轮指令】\n' + recent
    : ''
  const full = noteHint + '\n\n' + (body || '（记忆库快照这次是空的）') + recentSection
  return { full, noteAbs, noteFound, noteConclusionChars, hasBody: Boolean(body || recent) }
}

/** 把接棒正文包成一条完整消息（和别的注入同形，`memory_context` 才能按段名取出来）。 */
function reanchorMessage(full) {
  return snapshotMessage(
    '⟪记忆重注入 · 压缩后⟫ 刚才的对话被压缩成摘要了，' +
      '压缩前读到的记忆和当时的细节都不在摘要里。下面重新灌一遍（不是本轮指令）：\n' +
      full,
    '压缩后重注入',
  )
}

function snapshotMessage(text, section) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:dsh-memory',
      form: 'snapshot',
      sections: [{ name: 'dsh-memory', text: section }],
    },
  }
}

/**
 * 每个会话「最后一次注入」的快照（只在内存里，进程重启就丢 —— 够用，看的就是当前这轮）。
 *
 * 为什么需要它：注入对调用方是**隐形的** —— 模型只看到上下文里多了一条 user 消息，
 * 看不到它从哪来、哪一段被节流掉了、有没有顶到字数上限。
 * 出了「明明记过却没带出来」「带出来一堆不相干的」这类问题，以前只能翻 `debug.log` 猜。
 *
 * 为什么只存内存不落库：注入内容本身就是从记忆库拼出来的，落库等于存第二份，
 * 还会把自己写进检索面（记忆库检索到自己造的注入文本，是很脏的一种污染）。
 */
const injectionSnapshots = new Map()
const MAX_SNAPSHOT_SESSIONS = 8

function rememberInjection(sessionId, extras, opts = {}) {
  try {
    // 🛑 key 走 `sidKey` 归一（2026-11-21 审计 P1-4）：`sessionId` 来自
    //    `agent.id || agent.session?.id`，两者形态不同（一个 12 位尾段、一个完整 id）。
    //    不归一的话同一个窗口会占两份槽，`full` 里还会显示成两个不同的短 id，
    //    看着像两个窗口在抢。
    const key = sidKey(sessionId || 'global')
    const parts = (extras || []).map((m) => {
      const secs = Array.isArray(m?.source?.sections) ? m.source.sections : []
      // 🛑 段名可能在两处，取决于消息是怎么造的：
      //    · `snapshotMessage(text, section)` → name 固定 'dsh-memory'，**text 才是段名**
      //    · 老的手搓结构 → name 才是段名
      //    两种都认，否则取到的是整段正文（真的踩过）。
      let section = '未命名段'
      if (secs.length > 0) {
        const s0 = secs[0]
        section = s0 && s0.name === 'dsh-memory' ? String(s0.text ?? '未命名段') : String(s0?.name ?? '未命名段')
      }
      // 非 text 块给占位而不是静默清零 —— 那样字数对不上时至少看得出痕迹
      const text = Array.isArray(m?.content)
        ? m.content.map((c) => (c && c.type === 'text' ? String(c.text ?? '') : `[${c?.type ?? '未知'} 块]`)).join('')
        : String(m?.content ?? '')
      return { section, text, chars: text.length }
    })
    const totalChars = parts.reduce((n, p) => n + p.chars, 0)
    injectionSnapshots.delete(key) // 重新插入以刷新顺序（Map 保插入序，用它当 LRU）
    injectionSnapshots.set(key, {
      at: Date.now(),
      turn: Number.isFinite(opts.turn) ? opts.turn : null,
      totalChars,
      parts,
    })
    while (injectionSnapshots.size > MAX_SNAPSHOT_SESSIONS) {
      const oldest = injectionSnapshots.keys().next().value
      injectionSnapshots.delete(oldest)
    }
  } catch {
    /* 快照失败绝不能影响注入本身 */
  }
}

/** 自动反思的提醒文案。刻意写成"可以不理"的语气 —— 提醒不是命令。 */
/**
 * 反思提醒的固定开头。后面会拼上「当前有哪些项目」——
 * 光说「该记了」没用，得让人看到**现在能往哪儿记**。
 *
 * 🛑 2026-11-23：这里的「7 轮」原来是**写死**的。阈值从 18 改成 10 之后它还在说
 *   "7 轮"，用户一眼就看穿了（原话「他现在那边还是写到七轮，你提示词方面好像没有调」）。
 *   ⇒ 改成按实际阈值算：权重攒够 `reflectWeight` 才催，每轮重活 +3、纯聊天 +1，
 *   所以折算出来是个区间（重活几轮 ~ 纯聊天几轮）。不说死一个数更诚实。
 */
function reflectLead(weight) {
  const heavy = Math.max(2, Math.round(weight / 3))
  const light = Math.max(heavy + 1, weight)
  return (
    `⟪记忆反思⟫ 已经有 ${heavy}~${light} 轮的活没往长期记忆里写了。\n` +
    '压缩一旦触发，这些细节就只剩摘要 —— 现在花 10 秒记几条，比之后重新摸索便宜得多。\n'
  )
}

/** 反思提醒的清单部分（不含项目列表）。 */
const REFLECT_CHECKLIST =
  '\n先扫一遍，命中哪条就记哪条（一条 memory_remember，提炼成祈使句 + 8~13 个关键词）：\n' +
  '· **这个项目有哪些功能 / 各自的边界** → project 层（category: features，要短）\n' +
  '· **某个功能怎么实现的、当初为什么这么定** → detail 层（category: impl，可以长）\n' +
  '   ↳ 三行就够：改了哪个文件/函数、怎么改的、为什么没选另一种做法。\n' +
  '   ↳ **刚改完代码那几轮最该记这个** —— 隔几轮就只剩「我改过」，细节全没了。\n' +
  '· **项目走到今天分了哪几个阶段**（只写变化点，删掉时间就不成立的那种）→ project 层（category: history）\n' +
  // 🛑 2026-11-20 立的规矩：年表要边干边补，别攒到压缩再回想。
  //    一次对话撑到 65% 也能覆盖两天，等到压缩前再写，先后顺序早就记不清了。
  '   ↳ **干几轮就补一行，别攒到压缩**：一次对话撑到 65% 也能覆盖两天，\n' +
  '     等到压缩前再回想，要么记不清先后、要么那几轮已经被压没了。\n' +
  '   ↳ 每行都要**指向一条 detail 条目**（`mem-xxxx` 或「史·xxx」），只写一句结论的年表没什么用。\n' +
  '· 某个阶段的具体经过（试了几版、哪版被推翻）→ detail 层，标题带「史·」前缀\n' +
  '· 定下了方案/取舍 → branch 层（category: decision）\n' +
  '· 某个项目的现状/怎么跑起来 → branch 层（category: ops）\n' +
  '· 还没做的事 → branch 层（category: todo）\n' +
  '· 踩了坑、摸清了机制 → detail 层（category: lesson）\n' +
  // 🆕 2026-11-21 体检查出来的：超长条目里 `lesson` 占最大一块。
  //    根因就是这条约束一直只写在记忆里、没写进这份每轮都会出现的清单。
  '   ↳ **正文 ≤300 字，只留「症状 → 根因 → 修法」三句**。\n' +
  '     写长了在检索打分时会被长度归一化压下去，等于白写。\n' +
  '     详细过程要留就另起一条 `category: topic`（专题允许到 3000 字）。\n' +
  '· 一套能照着执行的操作流程 → detail 层（category: procedure）\n' +
  // 🆕 2026-11-19 补的：七轮里加一条，有比较好的流程就顺手写一下。
  //    要强调"顺手"而不是"完美"，否则又是一条因为门槛太高而永远没人写的提示（impl 就是这么荒的）。
  '   ↳ **这次干得特别顺的事，顺手写成 procedure**：步骤清楚、下次还能照着复现就行，\n' +
  '     三五行也够。别等它"完美"再写 —— 等完美就永远不会写。\n' +
  '     典型：一套测试+发布的流程、一次排障的固定顺序、一个批量处理的套路。\n' +
  // 🛑 2026-11-24 用户点名要的一条（原话：「我的意思是让你在提示词里写一下，
  //    你记得要写完整链路。不然老是出这种问题，我以为你知道」）。
  //    病根：摸清一整条链路后习惯性拆成四五条零散 lesson，检索只能撞到一半，
  //    出问题时拼不出"卡在哪一步"，每次都要重新翻代码。
  '· 🛑 **摸清了一整条链路**（从触发到落地，中间经过哪几道门 / 哪几步）\n' +
  '  → **整条写成一条** `topic` 或 `procedure`，**别拆成零散 lesson**\n' +
  '   ↳ 判据：这条流程里**任何一个环节坏掉**，别人只靠这一条能不能定位到是哪一步？\n' +
  '     不能，就是拆碎了 —— 那等于没写。\n' +
  '   ↳ 真事（2026-11-24）：压缩链路有 12 道门，从来没一条完整记录，\n' +
  '     结果「压缩前不催落档」查了两天才发现是 `inject` 漏声明、催办一次都没发出去。\n' +
  '   ↳ 零散的坑照样可以单独记 lesson（≤300 字），但那条**主干**必须是完整的一份。\n' +
  '· 他提了新偏好或禁令 → core 层（category: preference / rule）\n' +
  '· 一条客观事实（版本号、路径、端口） → detail 层（category: fact）\n' +
  // 🆕 2026-11-21 三路审计 P0：这份清单是模型挑分类时照着看的，没有 reference
  //    就等于那个分类不存在（库里最初那 2 条也是对话里顺带写的，不是清单触发的）。
  '· **看过的外部资料 / 别人怎么解决的 / 竞品做了什么**（现在用不上，以后可能启发思路）\n' +
  '  → detail 层（category: reference）\n' +
  '   ↳ 判据是「看过了，留着」，不是「要照着做」也不是「不能这么干」。\n' +
  '     它不参与主结果排序，只在末尾报个数量；但真遇到同类问题时能翻出来。\n' +
  // 🆕 2026-11-20 补：光说"一条记忆可以指向多个项目"不够明确，
  //    实际写的时候还是会下意识二选一。
  '· **一件事同时属于两个项目 → `project` 里用逗号全写上**（`项目甲,项目乙`），\n' +
  '  不要二选一。两个项目都能搜到它，比只挂一边强得多。\n' +
  '  判据：这条记忆在 A 项目和 B 项目里都该被看到吗？是 → 两个都写。\n' +
  '\n⚠️ 加/改功能时优先补 features 和 impl —— 缺了这两层，下次改同一个项目会不知道原来有什么，\n' +
  '   于是把两个功能合成一个、或者重造已经有的轮子（2026-11-18 真踩过）。\n' +
  // 🆕 2026-11-20 补：零散条目可以写，但事后有了完整流程要记得合并成一条。
  //    碎片攒一堆，检索只能撞到一半，拼不出全貌。
  '\n⚠️ **零散条目本身不是错，攒着不收拾才是**：同一个坑踩了三次、同一套流程记了四段，\n' +
  '   就该合并成一条完整的（features / procedure / topic，视内容定）——\n' +
  '   旧的标 stale 并注明「已并入 mem-xxx」，别直接删（删了没人知道它曾经存在）。\n' +
  '   判据：讲同一件事的零散条目到 **3 条**就该合并。\n' +
  '\n⚠️ 东西废掉或换代了**不要删**：旧条目标成「留档」+ ⛔ 已停用/已被取代，\n' +
  '   让以后搜到的人知道它不算数了 —— 删了就没人知道它曾经存在（2026-11-18 定的规矩）。\n' +
  '\n都没有就忽略这句，不必回应。'

/**
 * 版本历史里不需要记录的字段：计数与访问时间每读一次就变，
 * 记进去会让历史表瞬间被刷爆，而且没有追溯价值。
 */
const HIST_IGNORED_FIELDS = new Set(['hit_count', 'last_accessed_at', 'updated_at'])

/** 比对新旧两行，返回真正变化的字段名 */
function changedFieldsOf(before, after) {
  if (!before || !after) return []
  const touched = []
  for (const key of Object.keys(after)) {
    if (HIST_IGNORED_FIELDS.has(key)) continue
    if (String(before[key] ?? '') !== String(after[key] ?? '')) touched.push(key)
  }
  return touched
}

/**
 * 把「改动前的完整快照」写进 `<层>_hist`。
 *
 * 为什么在工具层写、不用 SQLite 触发器：
 *   ① 触发器没法排除 hit_count / last_accessed_at（那两个每次读都变），会把历史表刷爆；
 *   ② 各层列不一样（core 没有 project 列，其余三层都有），触发器要写四份；
 *   ③ 我们的写入都走工具，工具层记就够了。
 * 历史表的数据格式：hid / src_id / op / old_json / changed_at。
 */
function recordHistory(db, layer, srcId, beforeSnapshot) {
  try {
    db.prepare(
      `INSERT INTO ${layer}_hist (src_id, op, old_json, changed_at) VALUES (?, ?, ?, ?)`
    ).run(srcId, 'update', JSON.stringify(beforeSnapshot), Date.now())
  } catch {
    /* 版本表不存在或写失败都不影响主流程 */
  }
}

/** 把数字夹到区间里（工具参数都要防一手 NaN / 越界） */
function clamp(value, low, high) {  const n = Number(value)
  if (!Number.isFinite(n)) return low
  return Math.min(high, Math.max(low, Math.round(n)))
}

/** 逗号分隔的参数值转数组（工具参数常让用户写 "a,b,c"） */
function splitCsv(value) {
  if (value === undefined || value === null) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * id 前缀匹配的 LIKE 参数。
 * 🛑 必须先转义 `%` `_` `\`：传 id="%" 会命中该层第一行，
 * 而 memory_update 会拿它去改 —— 一条命令改错一条记忆。
 * 配套 SQL 要写 `LIKE ? ESCAPE '\'`。
 */
function idPrefix(value) {
  return String(value).replace(/[\\%_]/g, (c) => '\\' + c) + '%'
}

/**
 * 原子写文本文件：先写 `.tmp-<pid>` 再 rename。
 * 直接 writeFileSync 是"先截断再写"，写到一半被杀 / 磁盘满 就留半截文件，
 * 项目核心正文和 projects.json 一旦截断，规则和配置一起废。
 */
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw e
  }
}

/**
 * 🛑 已删除（2026-11-20）：原 `countToolCalls` / `wroteMemoryThisStep` /
 * `hasToolResult` / `hasMemoryWriteCall` —— 四个函数都在翻 assistant 消息里的
 * `tool-call` / `tool-result` 块，而 pre-step 的 messages 只有 `UserMessage[]`，
 * 一条 assistant 都进不来，所以**全部恒返回 false/0**。
 *
 * 这已经是同一个假设连栽四次的记录：
 *   2026-11-19 `hasToolResult`；2026-11-20 `hasMemoryWriteCall`、域推断的工具信号、
 *   加权轮次的工具计数。每一次都是"pre-step 在模型生成之前，看不到这一轮的工具调用"。
 *
 * 现在的替代品（都已上线）：
 *   · "上一轮调了哪些工具、参数里有什么" → `recordToolForDomain` / `takeDomainToolText`
 *   · "最近写过记忆没有" → `lastMemoryWriteAt` 时间戳（工具执行时更新），不是按轮次数
 */

/**
 * 把一条记忆渲染成给人看的文本。
 *
 * 五个工具（search / read / project / recent / dream）的输出形态其实是同一件事：
 * 「标签 + id + 标题 + 正文 +（可选）元数据」。原先各自手拼字符串，
 * 改一处格式要动五处，而且每份都不太一样。抽到这里统一。
 *
 * @param {object} doc  - 至少含 id / level / content；可选 title / keywords / project
 * @param {object} opts - { contentMax, withMeta, score, extraLines }
 */
function renderRecord(doc, opts = {}) {
  const contentMax = Number.isFinite(opts.contentMax) ? opts.contentMax : 0
  const title = String(doc.title ?? '').trim()
  const raw = String(doc.content ?? '')
  const body = contentMax > 0 ? raw.slice(0, contentMax) : raw

  const label = opts.score !== undefined ? `${doc.id} (${Number(opts.score).toFixed(2)})` : doc.id
  // 层 + 分类一起印在方括号里（`[detail/lesson]`）：只给层的话，
  // 想筛出「这个项目里的教训」还得逐条 memory_read 才知道分工（2026-11-19 实测 56 次）。
  const cat = doc.category ? `/${doc.category}` : ''
  const lines = [`[${doc.level}${cat}] ${label}`]
  if (title) lines.push(title)
  if (body) lines.push(body)
  if (opts.withMeta === true) {
    lines.push(`keywords: ${(doc.keywords || []).join(', ')}`)
    lines.push(`project: ${doc.project || '（全局）'}`)
    // 时间：让人一眼看出「这条是新建的还是被改过的」，不用再 read 一次
    const bits = []
    if (doc.happened_at) bits.push(`发生: ${fmtLocalTime(doc.happened_at)}`)
    if (doc.updated_at) bits.push(`更新: ${fmtLocalTime(doc.updated_at)}`)
    if (bits.length) lines.push(bits.join('  ·  '))
    if (doc.status && doc.status !== 'active') lines.push(`状态: ${doc.status}`)
  }
  if (typeof opts.extraLines === 'string' && opts.extraLines) lines.push(opts.extraLines)
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  // 顺序有意义：dbPath 的默认值挂在 workspace 下面，所以先定 workspace。
  // 默认取进程 cwd（DSH 按会话工作区运行），库落在 <workspace>/.dsh-memory/memory.db。
  // ⚠️ 不要在这里写死某个盘符 —— 那样「换个工作区」或「别人装上」都会写到同一个地方，
  //    实测踩过：空库测试因此写进了真库。
  const workspace =
    typeof config.workspace === 'string' && config.workspace ? config.workspace : process.cwd()
  const dbPath =
    typeof config.dbPath === 'string' && config.dbPath
      ? config.dbPath
      : path.join(workspace, '.dsh-memory', 'memory.db')
  // 项目核心目录：默认 <workspace>/_项目核心，可用 config.projectCoreRoot 覆盖。
  // 🛑 必须在 project-core.js 被真正用到之前设好（pre-step 每轮都会读它）。
  try {
    setProjectCoreRoot(
      typeof config.projectCoreRoot === 'string' && config.projectCoreRoot
        ? config.projectCoreRoot
        : path.join(workspace, '_项目核心'),
    )
  } catch (e) {
    log(`setProjectCoreRoot failed: ${e && e.message}`)
  }
  const enableFirstTurn = config.firstTurn !== false
  const enableHit = config.hit !== false
  // 压缩后重注入：上下文被压成摘要时，把长期记忆快照再灌一遍。
  // 这是「压缩之后忘得太狠」的直接对策：压缩完把记忆重新灌一遍。
  const enableReanchor = config.reanchor !== false
  // 写入查重阈值（Jaccard）。0.65 的依据见 jaccardOf 的注释；设 1 可关掉。
  const dedupeJaccard = Number.isFinite(config.dedupeJaccard) ? Number(config.dedupeJaccard) : 0.65

  // ── 自动反思 ────────────────────────
  // 判据用「距上次写记忆多久」，而不是「连续几个工具步」。
  // 原因：pre-step 跑在**模型生成之前**，本步的工具调用还不存在，数不到。
  // 而「多久没往库里写东西」是可靠的全局信号，工具自己就能维护。
  // ── 落档催办 ────────────────────────
  // 用 pre-step 预制发送（直接进上下文），不用用户点确定。
  const enablePrecompactNudge = config.precompactNudge !== false
  /** 每多少轮检查一次落档新鲜度 */
  const precompactEveryTurns = Number.isFinite(config.precompactEveryTurns)
    ? Number(config.precompactEveryTurns)
    : 15
  /** 落档多久没更新算「旧」 */
  const precompactFreshMs = Number.isFinite(config.precompactFreshMs)
    ? Number(config.precompactFreshMs)
    : 30 * 60 * 1000
  /** 上次催的时候那份落档的 mtime —— 同一份旧档只催一次 */
  /** 落档写完就自己按冲水键压缩 */
  const autoCompactAfterPrecompact = config.autoCompactAfterPrecompact !== false
  /** 落档「刚写完」的判定窗口。
   *  2026-11-19 从 10 分钟放宽到 30 分钟：改完代码要重启 DSH 才生效，
   *  而重启本身要花时间，10 分钟窗口经常在"改完→重启→能检测"这段里错过。
   *  放宽到 30 分钟和 precompactFreshMs 一致，重启后还来得及。 */
  const precompactJustWrittenMs = Number.isFinite(config.precompactJustWrittenMs)
    ? Number(config.precompactJustWrittenMs)
    : 30 * 60 * 1000
  /** 上次压缩时的那份落档 mtime —— 同一份只压一次 */
  let lastCompactedPrecompactMtime = -1
  /** 🛑 2026-11-19 修：压完要有冷却期。
   *
   *  实测事故：
   *    02:40 写落档 → 02:46:55 auto-compact START（压了）
   *    → 02:47 落档催办才到 → 我为了回应催办**又重写了一遍落档**
   *    → mtime 变了，`found.mtime === lastCompactedPrecompactMtime` 这条保护失效
   *    → 02:47:55 又触发一次压缩 → FAILED（撞上正在压缩）
   *
   *  根因：保护用的是「同一份文件的 mtime」，而重写落档就会改 mtime。
   *  所以另加一条跟文件无关的冷却：压完 N 分钟内一律不再压。
   *  压缩是重操作，10 分钟内不可能真的又需要压一次。
   */
  const compactCooldownMs = Number.isFinite(config.compactCooldownMs)
    ? Number(config.compactCooldownMs)
    : 10 * 60 * 1000
  let lastCompactDoneAt = 0
  let lastPrecompactNudgedMtime = -1
  /** 诊断只打一次，看 pre-step 的 payload 到底有没有 agent */
  let precompactDiagDone = false


  // ── 自动捕获 ────────────────────────
  // 🛑 **默认关闭**（2026-11-22 定）。
  //
  // 理由：显式 `memory_remember` 写进来的条目有提炼、有 project、有真关键词，质量高一个量级；
  // 而自动抓的是**原始消息截 200 字**，没提炼、没归属，keywords 还是 BM25 的 2 字滑窗碎片。
  // 实测这一条路的产物命中率极低、还会在检索里当噪音把真结果挤下去。
  //
  // 为什么不调判据而直接关：中文口头语没法用正则可靠区分 ——「我觉得」「以后」这两种词
  // 在闲聊里出现得比在规则陈述里还密。调紧会漏真规则，调松就进垃圾，两头都不划算。
  // 而「该记什么」本来就该由模型在干活时自己判断：正常干活几轮就会调一次记忆工具，
  // 纯聊天那种没什么内容，七轮一次的反思催办兜底已经够（清闲场景十轮以上写一次也合理）。
  //
  // 想重新打开：配置传 `autoCapture: true`（函数与规则都留着，没删）。
  const enableAutoCapture = config.autoCapture === true
  /** 每隔几轮允许捕获一次 */
  const autoCaptureEveryTurns = Number.isFinite(config.autoCaptureEveryTurns)
    ? Number(config.autoCaptureEveryTurns)
    : 2
  /** 每次会话最多写几条，防刷 */
  const autoCaptureMaxPerSession = Number.isFinite(config.autoCaptureMaxPerSession)
    ? Number(config.autoCaptureMaxPerSession)
    : 12
  // 🛑 2026-11-19 审计修：这三样必须**按会话隔离**。
  //    `turn` 是每个会话独立计数的（新会话从 0/1 起），而这三个状态原来是全局的
  //    ⇒ 会话 A 走到 turn=100 后，新开的会话 B 里 `1 - 100 < everyTurns` 恒成立，
  //    B 永远捕获不到东西，而且日志上只表现为"没命中规则"，看不出来。
  const capStateBySession = new Map()
  /** 会话数上限，防止 Map 无限涨（满了淘汰最久没被碰过的一个，见 evictOldest） */
  const CAP_MAX_SESSIONS = 200
  /**
   * 淘汰最老的**一个**（不是整块 clear）。
   * 🛑 整块 clear 会把当前所有活跃会话的状态一起归零：每会话 12 条的防刷上限失效、
   *    最近写过的话头忘了、lastTurn 回到 -999 立刻又能捕获。Map 的迭代顺序就是插入
   *    顺序，取第一个 key 就是最老的。
   */
  function evictOldest(map) {
    const first = map.keys().next()
    if (!first.done) map.delete(first.value)
  }
  function capStateOf(sid) {
    const k = String(sid || 'global')
    const hit = capStateBySession.get(k)
    if (hit) {
      // LRU：命中也算"用过"，挪到队尾，免得把最活跃的会话淘汰掉
      // （FIFO 会先删最老插入的那个 = 通常就是本次运行的主会话）
      capStateBySession.delete(k)
      capStateBySession.set(k, hit)
      return hit
    }
    if (capStateBySession.size >= CAP_MAX_SESSIONS) evictOldest(capStateBySession)
    const st = { lastTurn: -999, count: 0, seen: new Set() }
    capStateBySession.set(k, st)
    return st
  }

  /** 轮次闸：够轮数 + 没超上限 + 不是同一句。 */
  function autoCaptureAllowed(sid, turnNo, text) {
    const st = capStateOf(sid)
    const t = Number.isFinite(turnNo) ? turnNo : 0
    if (st.count >= autoCaptureMaxPerSession) return false
    if (t - st.lastTurn < autoCaptureEveryTurns) return false
    if (st.seen.has(text.slice(0, 80))) return false
    return true
  }


  const enableReflect = config.reflect !== false
    // ⚠️ 时间判据默认**关掉**（设 0），按轮次算。
    //    原因：隔一周再开会话时 `now - lastMemoryWriteAt` 一开始就是 7 天，
    //    第一次干活就催，跟「干了多久」完全脱钩。想退回时间模式就把它设回毫秒数。
    const reflectIdleMs = Number.isFinite(config.reflectIdleMs) ? Number(config.reflectIdleMs) : 0
    /** 干满多少轮还没写记忆就提醒一次（按轮次，不按时间） */
    const reflectEveryTurns = Number.isFinite(config.reflectEveryTurns) ? Number(config.reflectEveryTurns) : 7
  const reflectCooldownMs = Number.isFinite(config.reflectCooldownMs)
    ? Number(config.reflectCooldownMs)
    : 40 * 60 * 1000
  /** 上次真正写入/更新记忆的时刻。启动时置为现在，避免刚拉起就催。 */
  let lastMemoryWriteAt = Date.now()
  /** 上次发出反思提醒的时刻 */
  let lastReflectAt = 0
  /** 最后一次写记忆时的轮次（-999 = 本轮会话还没写过）
   *  ⚠️ 原来的 lastReflectTurn / lastMemoryWriteTurn 两个**全局**锚点已被
   *    reflectStateOf(sessionId) 取代（按会话隔离），这里不再保留。 */
  // 🛑 2026-11-19 审计修：轮次锚点也必须**按会话隔离** —— 和 autoCapture 同一个根因。
  //    turn 是每会话独立计数的，全局锚点会让新会话的 `t - 锚点` 是负数，
  //    「够 7 轮没写记忆」永远不成立 ⇒ 新会话一次都不催。
  const reflectStateBySession = new Map()
  /**
   * 🛑 2026-11-19 修：轮次锚点**必须落盘**。
   *
   * 原来这只存在内存 Map 里，进程一重启就清空，懒初始化时又把锚点推到**当前轮** ——
   * 于是每次重启都要重新数满 `reflectEveryTurns` 轮才可能提醒。
   * 实测：从最后一次提醒起，隔了近 40 轮一次都没催，
   * 因为中间重启了六七次，每次倒计时归零。
   * 频繁重启时这个提醒**永远不会触发**，而它的意义恰恰在于"不等人催"。
   */
  const reflectStatePath = path.join(workspace, '.dsh-memory', 'reflect-state.json')
  function loadReflectState() {
    try {
      const raw = fs.readFileSync(reflectStatePath, 'utf8')
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== 'object') return
      let n = 0
      for (const [k, v] of Object.entries(obj)) {
        if (n++ >= CAP_MAX_SESSIONS) break
        if (!v || typeof v !== 'object') continue
        reflectStateBySession.set(k, {
          lastTurn: Number.isFinite(v.lastTurn) ? v.lastTurn : -999,
          lastWriteTurn: Number.isFinite(v.lastWriteTurn) ? v.lastWriteTurn : -999,
          lastPrecompactTurn: Number.isFinite(v.lastPrecompactTurn) ? v.lastPrecompactTurn : -999,
        })
      }
    } catch {
      /* 没有这个文件、或读坏了，都当第一次跑 */
    }
  }
  function saveReflectState() {
    try {
      const obj = {}
      for (const [k, v] of reflectStateBySession) obj[k] = v
      fs.mkdirSync(path.dirname(reflectStatePath), { recursive: true })
      const tmp = reflectStatePath + '.tmp-' + process.pid
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
      fs.renameSync(tmp, reflectStatePath)
    } catch {
      /* 写不了盘最多是重启丢锚点，不能因此影响对话 */
    }
  }
  loadReflectState()
  function reflectStateOf(sid) {
    const k = String(sid || 'global')
    const hit = reflectStateBySession.get(k)
    if (hit) {
      // LRU（同 capStateOf）：不刷新的话淘汰的正是最老的主会话
      reflectStateBySession.delete(k)
      reflectStateBySession.set(k, hit)
      return hit
    }
    if (reflectStateBySession.size >= CAP_MAX_SESSIONS) evictOldest(reflectStateBySession)
    // lastTurn 反思提醒 / lastWriteTurn 上次写记忆 / lastPrecompactTurn 上次落档检查，
    // 三个都是**按轮次**的锚点，都必须是每会话一份。
    const st = { lastTurn: -999, lastWriteTurn: -999, lastPrecompactTurn: -999, weightSinceNudge: 0 }
    reflectStateBySession.set(k, st)
    return st
  }
  const hitTopK = Number.isFinite(config.hitTopK) ? Number(config.hitTopK) : 2
  /**
   * 按域给检索降权 —— **默认关**（2026-11-20 关掉）。
   *
   * 为什么关：
   *   它只有一个用途：命中之后把"不同域"的条目排后面。但
   *   ① 收益从没验证过 —— 落档里长期挂着"域降权压掉的条目到底该不该压"；
   *   ② 风险是**静默丢失**：判错域时该出现的记忆被压到 0.15 倍，不报错、没提示，
   *      界面上只是"这条记忆没被注入"，你要是不知道它存在，根本发现不了；
   *   ③ 成本是每轮一次推断 + 一堆日志，为了一个没验证的排序微调。
   *
   * `domain` 字段本身留着（面板筛选、体检看分布都用得上），只是不再拿它压实时注入。
   * 想开回来：配置 `domainDownweight: true`。
   */
  const enableDomain = config.domainDownweight === true
  // v5（2026-11-20）：按项目降权 —— 用户提的降噪方案。
  //   「当前窗口的主项目权重 1，其他项目除非有注入（触发项目核心），不然按 0.7 / 0.5」。
  //   跟域降权不同：项目是 `memory_remember` 时**明确标**的，不存在"猜错"，
  //   所以这条可以**默认开**（0.7，温和档：主项目仍排前面，别的项目不会被压死）。
  //   `activeProjects` 为空（新会话还没注入任何项目核心）时 inject 那边完全不降。
  //   设成 1 就是关掉。
  const projDownweight = (() => {
    const v = Number(config.projectDownweight)
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.7
  })()
  // v5：混合检索开关。**默认关** ——
  // 向量要额外装 `@huggingface/transformers` + 92MB 模型（`models/bge-small-zh-v1.5`），
  // 不该是默认负担。自己用的时候可以在 profile 里打开；别人装了这个插件，
  // 让他自己的 AI 去问他的用户要不要加（工具描述里写清了这一点）。
  const vectorEnabled = config.vector === true
  // 反思催办的**加权轮次**阈值（2026-11-20 定）。
  //
  // 为什么不用「每 N 轮」：原来那套里「刚写完别催」是个死逻辑 ——
  // `hasMemoryWriteCall()` 在 pre-step 里恒 false（pre-step 跑在生成之前，工具还没执行），
  // 于是纯聊天和连调几十个工具的重活，催的频率一模一样。
  //
  // 现在按「这一轮干了多少事」加权：工具调用 0 个 +1、1~5 个 +2、6 个以上 +3。
  // 攒到阈值就催一次并清零。实测口径：纯聊天七轮一次没必要，15~20 轮都行。
  // 🛑 2026-11-23 从 18 调到 10（用户原话：「又有十几轮没有写记忆了…之前我还没叫他写记忆」
  //    「至少十轮之内总得记一次吧？」）。
  //    原来的 18 配上"每轮 +1~3"的实际权重，重活要 6 轮、一般活要 9 轮才催，
  //    而用户体感是「十几轮都没动静」—— 观察值（状态文件里卡在 14/12）正好印证。
  //    10 = 重活 3~4 轮一次、一般 5 轮、纯聊天 10 轮，落在"不烦人但不会忘"的区间。
  const reflectWeight = Number.isFinite(config.reflectWeight) ? Number(config.reflectWeight) : 10

  /**
   * 本会话刚写过记忆 ⇒ 把**本会话**的加权轮次清零，别催它。
   *
   * 🛑 2026-11-23 修一个「多窗口互相顶掉」的真 bug（用户报的）：
   *   「我跟隔壁交流了这么久，我都是主动让他记的。他全程都在干活，不科学啊！
   *     为什么至少十轮之内总得记一次吧？」
   *
   * 成因：判据原来是 `wroteRecently = now - lastMemoryWriteAt < 30 分钟`，
   * 而 `lastMemoryWriteAt` 是**模块级全局变量**（1822 行），任何会话写记忆都刷新它。
   * 于是——他开几个窗口，我在其中一个写得勤，别的窗口永远看到"刚有人写过"⇒
   * `turnDue = 权重够 && !wroteRecently` 恒为 false ⇒ **那些窗口一辈子不催**。
   *
   * 修法：把"刚写过"从一个**全局时间**改成**按会话清零权重**——
   * 谁写的清谁，别的窗口不受影响。`lastTurnCtx.sessionId` 是 pre-step 记的当前会话，
   * 写操作一定紧跟在它那一轮之后，够准（万一多窗口串了，后果只是"这次少催一轮"，无害）。
   */
  const noteMemoryWriteForCurrentSession = () => {
    try {
      const sid = lastTurnCtx && lastTurnCtx.sessionId
      if (typeof sid !== 'string' || !sid) return
      const st = reflectStateOf(sid)
      st.weightSinceNudge = 0
      if (Number.isFinite(lastTurnCtx.turn) && lastTurnCtx.turn > 0) st.lastWriteTurn = lastTurnCtx.turn
      saveReflectState()
    } catch {
      /* 状态坏了不能影响写记忆本身 */
    }
  }
  // 首轮注入上限。2026-11-19 从 8000 提到 16000：
  // core 层三段的**总字数约是 8000 的三倍**，只装得下三成，连「关于用户」
  // 整整一段都一条进不去。按「装下全部规则 + 一部分偏好」来配
  // （规则漏了会直接做错事，偏好漏了只是不够贴合）。
  const firstTurnMaxChars = Number.isFinite(config.firstTurnMaxChars)
    ? Number(config.firstTurnMaxChars)
    : 16000
  const debugFile = typeof config.debugFile === 'string' ? config.debugFile : ''
  // 过渡期用：跟别的插件注册的 memory_* 同名会被 DSH 拒绝注册，
  // 加个前缀就能两套并存，方便逐句对比谁更准。切换完成后留空即可。
  const toolPrefix = typeof config.toolPrefix === 'string' ? config.toolPrefix : ''
  // 是否把 memory_core（编辑 MEMORY.md）也注册进来。
  // 默认 false —— dsh-core-memory 已提供同名工具，同时注册会被宿主拒。
  // 想让记忆功能完全自足时：禁用 dsh-core-memory + 这里设 true + 重启。
  const coreTool = config.coreTool === true
  const coreMemoryPath =
    typeof config.coreMemoryPath === 'string' && config.coreMemoryPath
      ? config.coreMemoryPath
      : path.join(dshHome(), 'memory', 'MEMORY.md')

  const log = (msg) => {
    ctx.logger?.info?.(`[dsh-memory] ${msg}`)
    if (debugFile) {
      try {
        fs.appendFileSync(debugFile, `${new Date().toISOString()} ${msg}\n`)
      } catch {}
    }
  }

  let db = null
  const getDb = () => {
    if (db) return db
    try {
      // 库不存在就建 —— 别人第一次装插件时工作区里是空的，
      // 原先「文件不在就返回 null」等于让他们一条记忆都写不进去。
      const dir = path.dirname(dbPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const isNew = !fs.existsSync(dbPath)
      db = new DatabaseSync(dbPath)
      // 🛑 2026-11-18：并发设置必须在**每次连上**就设。
      //    库文件本身的 journal_mode 会持久（已切 wal），但 busy_timeout 是**连接级**的，
      //    不设就是 0 —— 两个会话同时写时第二个会立刻 SQLITE_BUSY，而不是排队等。
      try {
        db.exec('PRAGMA journal_mode=WAL')
        db.exec('PRAGMA busy_timeout=5000')
      } catch (e) {
        log(`pragma setup failed: ${e && e.message}`)
      }
      try {
        // 新旧库都跑一遍：语句全是 IF NOT EXISTS，对已有库只补缺的表，不碰数据
        const mi = ensureSchema(db)
        log(`${isNew ? 'created' : 'opened'} db ${dbPath} (schema v${(mi && mi.version) || 0})`)
        // 迁移结果必须留痕：加了哪些列、有没有出错。
        // 出错了还闷头继续用等于埋雷 —— 之后每次写入都是 no such column，
        // 而日志里看不出原因（2026-11-19 审计发现原来这里是个空 catch）。
        if (mi && mi.added && mi.added.length) log(`migrate: +${mi.added.join(', ')}`)
        if (mi && mi.errors && mi.errors.length) {
          log(`migrate FAILED: ${mi.errors.join(' | ')}`)
          ctx.logger?.warn?.(`[dsh-memory] 记忆库结构迁移没做完：${mi.errors.join(' | ')}`)
        }
      } catch (e) {
        log(`ensureSchema failed: ${e && e.message}`)
      }
    } catch (e) {
      log(`open db failed: ${e && e.message}`)
      db = null
    }
    return db
  }

  // ---------------- 工具 ----------------

  /**
   * 最近一轮 pre-step 看到的东西 —— 用来给新记忆**自动**补 `context`。
   *
   * 🛑 为什么要自动，而不是"想起来就填"：
   *    答案是"不会" —— 这个字段上线之后长期是空的，
   *    而 `detail/impl` 是同一个剧本（最后只剩个位数）。靠自觉的字段最后都会空着。
   *    所以改成：没传就自己补一条最小的「哪个窗口 · 当时在说什么」，
   *    不增加"写的那一刻要多想一层"的成本。
   *
   * 只补**最小场景**，不猜项目（project 字段本来就有）、不猜情绪（猜错就是脏数据）。
   */
  let lastTurnCtx = { sessionId: '', text: '', at: 0 }

  /**
   * 最近一次看到的 agent —— 只作「冲水键」的兜底。
   *
   * 🛑 2026-11-25：这个变量的定位改过一次，别按老注释理解它。
   *    · 压缩已经从 `commands.execute(agent,'/compact')` 改成直调
   *      `ctx.compaction.compactNow(agent, signal)`（那条命令只是这层服务的一行包装）。
   *    · `memory_compact` 工具**优先用 DSH 传进来的 `run.agent`** —— 那才是"谁按的键"。
   *    · 这里记的是"最后一个结束回合的 agent"，跟谁在按键**毫无关系**。
   *      2026-11-20 实测过：另一个窗口按冲水键，压掉的是本窗口。
   *      所以只有拿不到 run.agent 时才用它，而且必须在回话里明说"这是猜的"。
   */
  let lastAgentSeen = { agent: null, at: 0 }
  // 超时就不补：隔了十几分钟才落库的，多半是别处补记的，套上"当前会话"反而误导。
  const AUTO_CTX_TTL_MS = 10 * 60 * 1000
  const autoContextHint = () => {
    if (!lastTurnCtx.sessionId) return ''
    if (Date.now() - lastTurnCtx.at > AUTO_CTX_TTL_MS) return ''
    const short = String(lastTurnCtx.sessionId).replace(/^session-/, '').slice(0, 8)
    const said = String(lastTurnCtx.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    return said ? `会话 ${short} · 当时在说「${said}」` : `会话 ${short}`
  }

  const mk = (toolName, description, props, exec, meta = {}) => ({
    name: toolName,
    description,
    parameters: { type: 'object', properties: props, additionalProperties: false },
    // 🛑 2026-11-20：第二个参数 `run` 是 DSH 的 ToolRunContext —— `dsh-tools/src/contracts.ts`
    //    的 `ToolExecutionInput` 里带 `agent?: Agent`，注释原文 "The agent on whose behalf
    //    the call runs (set by the agent loop)"，就是「谁调的这次工具」。
    //    以前只收 `(args)`，于是根本拿不到调用者会话：`memory_compact` 退而用插件全局的
    //    `lastAgentSeen` 去猜，而那个变量记的是"最后一个结束回合的 agent" ——
    //    多窗口时另一个窗口按一下冲水键，压掉的是最后收尾的那个会话（2026-11-20 实测）。
    execute: async (args, run) => {
      const d = getDb()
      if (!d) return { text: `⚠️ 记忆库不存在：${dbPath}` }
      // 🛑 参数类型粗检（2026-11-20 压力测试发现的）。
      //    以前 `String({a:1})` 会变成 "[object Object]" 一路流下去：
      //    `memory_read({id:{a:1}})` 回你「没找到 [object Object]」，
      //    `memory_search({query:{a:1}})` 拿 "[object Object]" 去检索 —— 不崩，但纯废。
      //    这里只查 schema 里声明成 string 的参数，正常调用一个字都不受影响。
      //
      // ⚠️ 例外 `mood` / `context`：它们的 schema 是 string，但**描述里直接给了对象结构**
      //    （`{"label":"焦虑",…}` / `{"scene":…}`），`normalizeMood`/`normalizeContext`
      //    实现里也明确收对象。模型照描述传对象是**正确行为**，粗检拦下来等于把
      //    文档鼓励的写法当场拒掉（2026-11-20 逻辑审计抓到的回归）。
      const OBJECT_ARG_OK = new Set(['mood', 'context'])
      for (const [k, spec] of Object.entries(props || {})) {
        if (!spec || spec.type !== 'string') continue
        if (OBJECT_ARG_OK.has(k)) continue
        const v = args && args[k]
        if (v === undefined || v === null) continue
        if (typeof v === 'object') {
          return { text: `（参数 ${k} 要给字符串，你传的是${Array.isArray(v) ? '数组' : '对象'}）` }
        }
      }
      try {
        return await exec(d, args || {}, run)
      } catch (e) {
        return { text: `⚠️ ${toolName} 失败：${e && e.message}` }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_a, v) => [{ type: 'text', text: String(v?.text || '') }],
    },
    ...meta,
  })

  // ── 历史对话索引（懒加载，用到才建）────────────────────────
  // 记忆库存的是"沉淀下来的结论"；要回答"我以前说过什么/这事什么时候干过"，
  // 只能翻会话存档。索引放独立库，不碰主记忆库。
  let convDb = null
  const convDbPath = path.join(workspace, '.dsh-memory', 'sessions.db')

  /**
   * 索引重建的**单飞闸门**：同一时刻只允许一路在跑，其它调用方复用在飞的那一个。
   *
   * 🛑 2026-11-19 审计修（P1）：分片版的 buildSessionIndexAsync 会在事务中间
   *    `await setImmediate` 让出，这时第二路进来（面板点两下「重建」、或者面板重建
   *    的同时另一个会话在 memory_search 触发自动重建）会撞上同一个连接上没提交的事务，
   *    报 "cannot start a transaction within a transaction"，**每路静默丢几个会话**，
   *    而 errors 只取前 5 条、两个调用方都不把它报给用户。
   *    老版是纯同步循环，一段跑完才轮到下一段，结构上撞不上 —— 这是分片化带进来的。
   */
  let convBuild = null
  function ensureConvIndex() {
    if (!convDb) convDb = openSessionIndex(convDbPath)
    if (!convBuild) {
      convBuild = buildSessionIndexAsync(convDb)
        .then((r) => {
          // 出口自检的回报：清了子会话残留就说明「入口按目录名挡」漏了，
          // 这时候必须留一行日志 —— 否则它会一直静默地清、也没人知道判据坏了。
          if (r && r.purgedSubagents > 0) {
            log(
              `索引自检：清掉 ${r.purgedSubagents} 条子会话残留（conv_file 里出现纯 uuid 的 sid）` +
                ` —— 检查 listSessionFiles 的目录名前缀判据是不是失效了`,
            )
          }
          return r
        })
        .finally(() => {
          convBuild = null
        })
    }
    return convBuild
  }

  /** 确保索引是新的，返回索引行（给工具和面板共用）。 */
  async function convSearchRows(query, k) {
    if (!convDb) convDb = openSessionIndex(convDbPath)
    let st = { files: 0, msgs: 0, lastScannedAt: 0 }
    try {
      st = sessionIndexStats(convDb)
    } catch {}
    // 过期就重建：一次都没建过，或者上次扫描已超过 30 分钟
    // 🛑 必须用异步版：同步版会把事件循环卡住 2 秒多，搜索时整个界面僵住。
    if (st.files === 0 || Date.now() - st.lastScannedAt > 30 * 60 * 1000) {
      try {
        const r = await ensureConvIndex()
        log(
          `会话索引: 扫 ${r.scanned} 文件，更新 ${r.updated}，跳过 ${r.skipped}，` +
            `${r.msgs} 条消息，${r.ms}ms` +
            (r.errors && r.errors.length ? `，⚠️ ${r.errors.length} 个文件失败：${r.errors[0]}` : ''),
        )
        st = sessionIndexStats(convDb)
      } catch (e) {
        log(`会话索引构建失败: ${e && e.message}`)
      }
    }
    let rows = []
    try {
      rows = searchConversations(convDb, query, { k })
    } catch {}
    return { rows, stats: st }
  }

  /** 给工具用的文本形式。 */
  async function convSearch(query, k) {
    let out
    try {
      out = await convSearchRows(query, k)
    } catch (e) {
      return { text: `（会话索引打不开：${e && e.message}）` }
    }
    const { rows, stats: st } = out
    const tail =
      `\n\n（索引：${st.msgs} 条消息 / ${st.files} 个会话。` +
      `要读某条原文用 session_event_read，传 sid 和 seq。）`
    if (rows.length === 0) return { text: `（历史对话里没找到这个说法）${tail}` }
    const lines = rows.map((r) => {
      const t = r.time ? fmtLocalTime(r.time) : ''
      const body = String(r.text).replace(/\s+/g, ' ').slice(0, 260)
      return `[历史对话] ${r.sid.slice(-12)} · seq=${r.seq} · ${r.role} · ${t}\n  ${body}`
    })
    return { text: lines.join('\n\n') + tail }
  }

  // ① 检索
  const tSearch = mk(
    'memory_search',
    '按关键词找记忆，相关度从高到低排（不是按时间）。' +
        '默认查细节层（事实/教训/专题/规程/实现/参考资料）和分支层（决策/现状/待办/金句/方案），外加项目层（概览/结构/功能/年表）。' +
        '⚠️ **参考资料（reference）默认不参与主结果排序**，只在末尾报个数量 —— 要专门翻它就传 category=reference。' +
        '**不含核心层** —— 核心记忆是每会话常驻注入的，不用靠检索捞；要搜它显式传 level=core。' +
        '⚠️ 项目相关的东西必须显式传 project 参数才查得全，' +
        '不带就该用 memory_project(项目名)。不知道有这个参数时最容易犯的判断错误是「搜不到 = 没记过」。' +
        '遇到「我以前说过」「你找一下」「记得吗」「难道真没有」这类问法时，先查这里再回答：' +
        '不要凭印象，也不要说「你没说过」。',
    {
      query: { type: 'string', description: '检索关键词，多个词用空格分隔（AND）' },
      level: { type: 'string', description: '逗号多选：core,project,branch,detail' },
      project: { type: 'string', description: '项目名，逗号多选；支持多层 `父/子/孙`（如 `父项目/子板块`，查父会自动带出所有下级，层级不限）；全局条目永远通过' },
      status: {
        type: 'string',
        description:
          'active / stale / archived / all / noarchived。' +
          '默认 noarchived（在役 + 完结留档，stale 本来就该能搜到）；' +
          '要连归档一起搜传 all，只要在役的传 active',
      },
      days: { type: 'number', description: '只看最近 N 天创建的（按**记录**时间粗筛）' },
      since: {
        type: 'string',
        description:
          '起始时间（含）："2026-11-10" / ISO / 毫秒。按**事件发生时间**筛' +
          '（happened_at 优先，没填退回记录时间）。补记旧事时用它，days 会漏',
      },
      until: {
        type: 'string',
        description: '结束时间（含）：只写日期时自动取那一天结束（到 23:59:59）',
      },
      k: { type: 'number', description: '条数上限，默认 8，最大 50' },
      category: {
        type: 'string',
        description:
          '按分类筛，逗号多选。detail 层：fact / lesson / topic / procedure / impl / reference；' +
          'branch 层：decision / ops / todo / quote / plan；project 层：overview / structure / features / history。' +
          '「只看踩过的坑」就传 lesson。' +
          '**reference（参考资料）默认不参与主结果排序**，只在末尾报个数量 —— 专门翻它就传 category=reference。',
      },
      onlyProject: {
        type: 'boolean',
        description:
          'true = 只返回该项目自己的条目，**不夹带「全局」条目**。' +
          '默认 false（全局永远通过）—— 但你只想看某个项目的东西时，' +
          '全局条目常常占九成，把项目自己的结论挤掉。',
      },
      has_source: {
        type: 'boolean',
        description:
          'true = 只看**带原文出处**的条目（记的时候传过 source 的那些）。' +
          '想找「有原话可以回溯确认」的结论时用；找到后拿 source 里的 sid#seq 跳回原文。',
      },
      useVector: {
        type: 'boolean',
        description:
          'true = 这次搜索额外走一遍**向量召回**，跟 BM25 用 RRF 合并（换说法也能查到）。' +
          '默认跟随插件配置（本机默认关）。\n' +
          '⚠️ 这个增强需要额外装 `@huggingface/transformers`（约 30MB）和模型 ' +
          '`bge-small-zh-v1.5` 的 ONNX 版（约 92MB，放 `<插件目录>/models/`）。' +
          '**如果你的用户没装过、也不确定要不要装，先去问他一句**再开 —— ' +
          '不装也能用，就是退回纯 BM25（字面对得上时其实更稳，只是换个说法容易查不到）。',
      },
      domain: {
        type: 'string',
        description:
          '按域筛，逗号多选（如 "编程,系统"）。**精确子串匹配**：传「编程」能命中 ' +
          '`domain: "编程"` 和 `"编程/插件"`。想看某个领域踩过什么坑时用。',
      },
      content_max: {
        type: 'number',
        description:
          '每条正文截断字符数，默认 200；0 = 不截断。' +
          '结果会在这一轮之后的每一步被重发，所以默认压小：' +
          '要看全某一条就用 memory_read 按 id 读，要更多条就分次搜。',
      },
      includeConversations: {
        type: 'boolean',
        description:
          '连历史对话原文一起搜（默认 false）。记忆库只装"沉淀下来的结论"，' +
          '要找"我以前说过的某句话""这件事什么时候干过"才开这个。' +
          '它会扫全部会话存档（几百个文件、上百万字）；索引过期时首次会花十几秒重建。' +
          '开了之后结果末尾多一段「历史对话」，每条带 session 与消息序号，可用 session_event_read 回原文。',
      },
    },
    async (d, a) => {
      // 默认 8 条 × 200 字：结果会随之后每一步重发，默认量压小（照 dsh-world 的实测口径），
      // 要看全某条用 memory_read，要更多条分次搜。
      const limit = clamp(a.k ?? 8, 1, 50)
      const contentMax = clamp(a.content_max ?? 200, 0, 5000)

      // 默认查 detail + branch + project（SEARCH_LEVELS）。
      // 不含 core —— 核心记忆是每会话常驻注入的，不用靠检索捞；要搜显式传 level=core。
      const wanted = a.level
        ? splitCsv(a.level).filter((s) => LEVELS.includes(s))
        : SEARCH_LEVELS.slice()
      if (wanted.length === 0) {
        return { text: '（没有合法的 level。可选：' + LEVELS.join(', ') + '）' }
      }

      const projects = splitCsv(a.project)
      // 分类筛：只想看「踩过的坑」就传 category=lesson，不用靠关键词碰运气
      // 🛑 统一小写（2026-11-21 复查 P1）。原来 `splitCsv` 保留原样，
      //    于是传 `category: 'Reference'` 或拼错 `refrence` 时，过滤严格相等比不到任何东西，
      //    最终返回「这个筛选范围里没有记忆」—— 模型据此认定「这事真没记过」，
      //    然后写一条重复记忆。这与 `memory_remember`（非法值明确 ⚠️ 报错）
      //    是同一个工具族的两套脾气，而这条最危险：它给的是「没有」。
      const cats = splitCsv(a.category).map((s) => s.toLowerCase())
      // 严格项目模式：不夹带全局条目。
      // 默认让全局通过是给「我记得跟这个项目有关」的场景用的；但想看
      // 「这个项目自己的结论」时，全局条目能占九成，把项目结论挤下去
      // （2026-11-19 实测：传某个项目名搜「坑」，结果绝大多数是全局条目）。
      // 🛑 2026-11-20：`onlyProject` 和「我只要全局」是两件不同的事。
      //    `memory_search({project:'全局', onlyProject:true})` 的本意是"只要全局那批"，
      //    但 onlyProject 的实现是"排除全局" —— 改前能查到、改后返回 0 条（审计 E1）。
      //    项目名里显式写了全局时，让 onlyProject 让位。
      const strictProject = a.onlyProject === true && !projects.some((p) => isGlobalProject(p))
      // v3（2026-11-20）：只看带出处的条目。想找「有原话可以回溯」的结论时用。
      const onlySourced = a.has_source === true
      // v4：按域筛。自由文本，逗号多选，「相等 / 互相包含」都算命中。
      const wantDomains = splitCsv(a.domain)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      // 🛑 默认只搜「在役」条目 —— 工具描述写的就是 active 默认。
      //    原来 splitCsv(undefined) 得空数组 ⇒ 不加状态过滤 ⇒ archived 全进池，
      //    与描述完全相反（已经封存的条目照样冒出来）。要全量得显式传 all。
      // 🛑 默认「在役 + 完结留档」，不含归档。
      //    stale 的语义就是「完结但留档，**仍能被搜到**」（工具描述原话），
      //    可原来的默认是 ['active'] ⇒ stale 用普通搜索根本搜不到，
      //    和 archived 的可见差别变成 0（2026-11-19 实测确认）。
      //    stale 通常只有零星几条，放进池子不会淹掉结果。
      const rawStatus = String(a.status ?? '').trim()
      const statuses =
        rawStatus === ''
          ? ['active', 'stale']
          : rawStatus === 'all'
            ? []
            : rawStatus === 'noarchived'
              ? ['active', 'stale']
              : splitCsv(rawStatus).filter((s) => s !== 'all')
      const daysBack = Number(a.days)
      const cutoff = Number.isFinite(daysBack) && daysBack > 0 ? Date.now() - daysBack * 864e5 : null
      // 按「这件事发生在什么时候」筛（happened_at 优先，没填就记录时间）。
      // `days` 是按**记录**时间的粗筛，这两个是精确时段 —— 补记旧事时 days 会漏，
      // 因为那条是今天写进来的（created_at 是今天），但事情发生在上周。
      const sinceMs = normalizeTime(a.since)
      const untilMs = normalizeTimeEnd(a.until)

      // 🛑 2026-11-21：reference（参考资料）**默认不进主池**。
      //    它的用途是「以后可能启发思路」，现在用不上；让它跟 lesson / procedure
      //    抢排序，会把那些"要照着做"的东西挤下去（BM25 分不可比，一条长参考资料
      //    很容易顶掉一条短教训）。但也不能埋掉 —— 所以只在结果末尾报个数量，
      //    想看的人传 category: reference 重搜。
      // 🛑 只有「**只查参考资料**」时才放它进主池（2026-11-21 审计 P1-2）。
      //    第一版写的是 `cats.includes('reference')`，于是传 `reference,lesson` 时
      //    reference 也会进主池抢排序 —— 而它本该永不参与主排序；同时 refHint 被跳过，
      //    结果里连一句「这批是留档备查的」说明都没有。
      const wantRefOnly = cats.length === 1 && cats[0] === 'reference'
      const pool = []
      const refPool = []
      for (const layer of wanted) {
        for (const raw of list(d, layer, {})) {
          const doc = toDoc(raw, layer)
          if (statuses.length && !statuses.includes(doc.status)) continue
          if (cats.length > 0 && !cats.includes(String(doc.category ?? ''))) continue
          if (projects.length > 0) {
            // 🛑 2026-11-20：改成 projectCovers，支持「子项目」（`父项目/子板块`）。
            //    原来用 projectListOf(...).includes(p) 精确匹配，
            //    于是查父项目时子项目的条目一条都搜不到。
            // ⚠️ 但 projectCovers 对「空 project / 全局」返回 true（注入场景要的宽松语义），
            //    而这里必须严格：全局条目归 globalPass 管，不能被 ownMatch 顺手放行，
            //    否则 onlyProject（strictProject）就形同虚设。所以先排除全局再判断。
            const ownMatch =
              !isGlobalProject(doc.project) && projects.some((p) => projectCovers(doc.project, p))
            const globalPass = !strictProject && isGlobalProject(doc.project)
            if (!ownMatch && !globalPass) continue
          }
          if (cutoff !== null && doc.created_at < cutoff) continue
          // doc.at = happened_at ?? created_at，所以这里筛的是"事情发生的时间"
          if (sinceMs !== null && (doc.at || 0) < sinceMs) continue
          if (untilMs !== null && (doc.at || 0) > untilMs) continue
          if (onlySourced && !doc.source_ref) continue
          // v4：按域筛。域是自由文本，用「相等 / 互相包含」判，不做枚举。
          if (wantDomains.length > 0) {
            const have = String(doc.domain || '')
              .split(/[,，、]/)
              .map((s) => s.trim())
              .filter(Boolean)
            const hit = have.some((d) =>
              wantDomains.some((w) => d === w || d.includes(w) || w.includes(d)),
            )
            if (!hit) continue
          }
          // 筛完之后再分流：reference 进备查池，不参与主排序。
          if (String(doc.category ?? '') === 'reference' && !wantRefOnly) {
            refPool.push(doc)
            continue
          }
          pool.push(doc)
        }
      }
      // 历史对话原文（可选）：记忆库存的是"沉淀下来的结论"，
      // 有些问题要的是"我什么时候说过这句话"，那只能翻会话存档。
      let convPart = ''
      if (a.includeConversations === true) {
        try {
          const r = await convSearch(String(a.query ?? ''), limit)
          convPart = r.text
        } catch (e) {
          convPart = `（历史对话检索失败：${e && e.message}）`
        }
      }

      // 参考资料：不参与主排序，但要在末尾报个数量，别让它彻底埋掉。
      // 判据用「字面命中」而不是 BM25 分数 —— 中文是 bigram 切词，只要沾两个字
      // 就能拿分，空搜也会有一堆结果（理由同下面 hasLiteral 那段）。
      // 🛑 取文必须用 `docText()`，跟 BM25 同源（2026-11-21 审计 P1）。
      //    第一版手写 `title + content`，漏了 keywords —— 而 keywords 正是写记忆时
      //    专门填的同义词/别名。实测真实库 6 个查询里 4 个漏报：refHint 报 0 条，
      //    照着提示显式重搜却查得到 2 条，方向正好相反（说「没有」，实际有）。
      const refQ = String(a.query ?? '')
        .split(/[\s,，、]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 2)
      let refLiteral = []
      if (!wantRefOnly && refPool.length > 0 && refQ.length > 0) {
        refLiteral = refPool.filter((doc) => {
          const low = docText(doc).toLowerCase()
          return refQ.some((t) => low.includes(t))
        })
      }
      // 🛑 数量措辞别给死数（审计 P1-3）：N 是「本次筛选下的全部字面命中」，
      //    而用户照提示重搜时受 limit、status、时间/域参数是否复现、切词方式
      //    三重影响，实际看到的条数会不一样。所以超过单次上限时明说截断。
      let refHint = ''
      if (refLiteral.length > 0) {
        // 🛑 措辞用「本次」而不是「单次最多给 N 条」（复查 P1-1）：
        //    `limit` 是**这次请求**的 k，而用户照提示重搜时用的是新的 k（默认 8）。
        //    原文案会被读成「重搜也只能拿 N 条」—— 实测 k=1 时提示「单次最多给 1 条」，
        //    而真的重搜默认一次给 8 条，自相矛盾。
        const capNote =
          refLiteral.length > limit
            ? `（本次最多报 ${limit} 条，重搜时用 k 控制数量）`
            : ''
        refHint =
          `\n\n（另有 ${refLiteral.length} 条「参考资料」提到这些词${capNote} —— ` +
          `它们是留档备查的，不参与上面排序。要翻就传 category: reference 重搜。）`
      }

      if (pool.length === 0) {
        // 🛑 这块不能一律说「这个筛选范围里没有记忆」（审计 P0）。
        //    加了 reference 之后 pool 空 ≠ 范围内没条目：一个只放了参考资料的项目、
        //    或刚建的新项目，都会走到这里。上层模型会把那句话当成「这事真没记过」，
        //    然后写一条重复记忆 —— 正是这个插件一直在治的病。
        const refOnlyNote =
          refPool.length > 0
            ? `（主记忆里没有命中。另有 ${refPool.length} 条「参考资料」落在当前筛选范围内 —— ` +
              `它们不参与主排序，要看就传 category: reference。）`
            : '（这个筛选范围里没有记忆）'
        if (convPart) {
          return { text: convPart + (refPool.length > 0 ? '\n\n' + refOnlyNote : '') }
        }
        return { text: refOnlyNote }
      }

      // ── v5（2026-11-20）：混合检索 ────────────────────────
      // BM25 在"换说法"的查询上会整片落空（实测：「压缩完还记得刚才说的话是怎么做的」
      // 按字面一个词都撞不上正文里的「压缩后补最近几轮原话」）；向量比的是意思，能对上。
      // 但字面对得上时 BM25 更稳，所以**两路都跑，用 RRF 合并**（只看排名，不比不可比的分数）。
      //
      // 🛑 默认关（`useVector` / config.vector 才开）：
      //    向量要额外装 `@huggingface/transformers` + 92MB 模型，不该是默认负担。
      //    任何一步失败都**静默退回 BM25** —— 向量是增强，不是必需品。
      let hits = bm25Search(String(a.query ?? ''), pool, { k: limit })
      const wantVector = a.useVector === true || (a.useVector === undefined && vectorEnabled)
      if (wantVector && pool.length > 0 && String(a.query ?? '').trim()) {
        try {
          const store = await loadDocVectors(workspace, pool)
          const enc = store ? await getEncoder() : null
          if (store && enc) {
            const [qv] = await enc([String(a.query ?? '')])
            const vhits = vectorTopK(qv, store, Math.max(limit * 3, 30))
            // RRF 合并：两路**不等权** —— 向量赢在"换说法也能找到"，
            // BM25 只在字面对得上时稳。等权时 BM25 排第一的错条目只要也在向量前 24，
            // 两项一加还是第一，混合反而把纯向量的好结果挤掉（实测）。
            const merged = rrfMerge(
              [hits.map((h) => ({ id: h.id })), vhits.map((h) => ({ id: h.id }))],
              { weights: [0.3, 1.0] },
            )
            const byId = new Map(pool.map((d) => [d.id, d]))
            const bmById = new Map(hits.map((h) => [h.id, h]))
            const out = []
            for (const m of merged) {
              const doc = byId.get(m.id)
              if (!doc) continue
              const base = bmById.get(m.id) || {}
              out.push({
                ...doc,
                ...base,
                id: m.id,
                score: Math.round(m.score * 1000) / 10, // RRF 分太小，放大成好读的数
                rrf: m.score,
                viaVector: vhits.some((v) => v.id === m.id),
              })
              if (out.length >= limit) break
            }
            if (out.length > 0) hits = out
            log(`vector search: ${vhits.length} 条候选，合并后 ${hits.length} 条`)
          }
        } catch (e) {
          log(`vector search 失败（已退回 BM25）：${e && e.message}`)
        }
      }

      // 🛑 「搜不到就直说」。
      //    BM25 对中文是 bigram 切词，只要有两个字沾上就能拿分（搜 `zzzqqq`
      //    能靠 `qq` 撞上 QQ 群那条还排第一）。光看分数判断不了
      //    「库里没有」还是「我词不对」—— 分数还受文档长度和词频影响，
      //    不同查询之间根本不可比（实测出现过 0.29 和 70.91）。
      //    所以这里看**字面**：有没有任何一条真的包含查询里的某个完整词。
      //    一条都没有 = 只是碎片沾边，直接告诉用户"可能没记过"。
      const qterms = String(a.query ?? '')
        .split(/[\s,，、]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 2)
      // 🛑 取文必须用 `docText()`，跟 BM25 与上面的 refHint 同源（2026-11-21 复查 P0）。
      //    原来手写 `title + content`，漏了 keywords —— 而 keywords 正是写记忆时
      //    专门填的同义词/别名。于是真实库能出现**同一段输出自相矛盾**：
      //      上半句「没有任何一条记忆真的提到「dsh-memory-tiers」」（只看正文）
      //      下半句「另有 2 条参考资料提到这些词」（docText 含 keywords）
      //    模型读第一句就认定没记过，接着写一条重复记忆 —— 正是这个插件在治的病。
      const hasLiteral = (h) => {
        const low = docText(h).toLowerCase()
        return qterms.some((t) => low.includes(t))
      }
      const realHits = hits.filter(hasLiteral)
      let warn = ''
      if (hits.length > 0 && realHits.length === 0 && qterms.length > 0) {
        warn =
          // ⚠️ 措辞必须限定「主结果里」（2026-11-21 复查）：参考资料已经被分流出去，
          //    所以可能出现「主结果一条真命中都没有、末尾却说另有 N 条参考资料提到这些词」。
          //    原来写「没有任何一条记忆真的提到」，在这种场景下与下句自相矛盾。
          `⚠️ 主结果里没有任何一条真的提到「${qterms.join(' / ')}」—— 下面这些只是字面沾边。\n` +
          '   要么换个说法，要么这件事确实没记过' +
          '（也可以带 includeConversations 翻历史对话原文）。\n\n'
      }

      // 🛑 总字数闸（2026-11-20 压力测试加的）。
      //    `k` 本身 clamp 到 50、`content_max` clamp 到 5000，但两者相乘是 25 万字符 ——
      //    而工具结果会在这一轮**之后的每一步**重发，一次搜爆就是整段对话都背着它。
      //    （实测：k=1e9 被 clamp 成 50，返回 20901 字，已经过大。）
      //    超了就少返几条并明说，别让调用方以为"就这么多"。
      const MAX_RESULT_CHARS = 12000
      const memPieces = []
      let usedChars = 0
      for (const h of hits) {
        const piece = renderRecord(h, { contentMax, withMeta: true, score: h.score })
        if (usedChars + piece.length > MAX_RESULT_CHARS) break
        memPieces.push(piece)
        usedChars += piece.length
      }
      const memPart = memPieces.join('\n\n---\n\n')
      let charHint = ''
      if (memPieces.length < hits.length) {
        charHint =
          `\n\n（命中 ${hits.length} 条，只显示了前 ${memPieces.length} 条 —— 总长度到了上限。` +
          `要更多就把 query 收窄，或者传更小的 content_max。）`
      }
      if (!memPart && !convPart) {
        // 🛑 2026-11-20 逻辑审计修（P0）：原来是直接 `return '（没有命中）'`。
        //    但 `memPart` 为空不代表没命中 —— 只要**第一条** piece 就超过总闸
        //    （`content_max=0` 表示不截断，一条 9k 字的 topic 就能顶爆 12000），
        //    循环第一次就 break，`memPieces` 空 ⇒ 明明命中却报「没有命中」，
        //    连上面那句「没有一条真的提到」和 charHint 一起吞掉。
        //    上层模型会因此认定"这事真没记过"，然后再写一条重复记忆 ——
        //    正是这个插件一直在治的病。
        if (hits.length > 0) {
          return {
            text:
              warn +
              `（命中 ${hits.length} 条，但第一条就超过单次返回的总长度上限 ${MAX_RESULT_CHARS} 字 —— ` +
              `一条都没显示。\n   把 content_max 调小（默认 200）再搜，或者收窄 query。）` +
              charHint +
              refHint,
          }
        }
        return { text: '（没有命中）' + refHint }
      }

      if (memPart && convPart) {
        return { text: warn + memPart + charHint + refHint + '\n\n===== 历史对话 =====\n\n' + convPart }
      }
      return { text: warn + (memPart || convPart) + charHint + refHint }
    },
    { isConcurrencySafe: () => true }
  )

  /**
   * 只接受 LEVELS 白名单里的层名 —— 层名要**拼进 SQL 表名**，不能直接信工具参数。
   * 传了非法值直接报错，不静默回退成全层（那会让越权请求被当成正常查询）。
   */
  const pickLayers = (level) => {
    if (level === undefined || level === null || String(level).trim() === '') return LEVELS.slice()
    const want = String(level).trim()
    return LEVELS.includes(want) ? [want] : null
  }

  // ② 读单条
  const tRead = mk(
    'memory_read',
    '按 id 读一条记忆的完整内容 + 全部元数据。id 可以只给前 12 位。' +
      '看到检索结果想确认原文、或要判断「这条现在还准不准」时用它。',
    {
      id: { type: 'string', description: '记忆 id（前 12 位即可）' },
      level: { type: 'string', description: '已知在哪层就传，能少查几张表' },
    },
    async (d, a) => {
      const want = String(a.id ?? '').trim()
      if (!want) return { text: '（缺 id）' }
      const layers = pickLayers(a.level)
      if (!layers) return { text: `（level 只能是 ${LEVELS.join(' / ')}）` }
      const stamp = (v) => fmtLocalTime(v)
      for (const layer of layers) {
        const row = d.prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ? ESCAPE '\\'`).get(want, idPrefix(want))
        if (!row) continue
        // 真被读了才算「用过」（注入/检索都不算，避免曝光率刷分）
        bumpHit(d, layer, row.id)
        return {
          text: [
            `id: ${row.id}`,
            `层级: ${layer}`,
            `标题: ${row.title || '（无）'}`,
            `分类: ${row.category || '（无）'}`,
            `项目: ${row.project || '（全局）'}`,
            `状态: ${row.status}`,
            `重要性: ${row.importance}`,
            `关键词: ${row.keywords}`,
            `来源会话: ${row.source_session || '（未记录）'}`,
            `建立: ${stamp(row.created_at)}`,
            `更新: ${stamp(row.updated_at)}`,
            // 🛑 2026-11-19：happened_at / context / mood 三个字段一直**写得进、读不出** ——
            //    用户在面板和工具回执里都看不到它们，等于白存在（他当天就问了
            //    「你真的会记得填吗」，而填了之后这里又看不到，那更没人会填）。
            //    happened_at 只在"跟建立时间不是同一天"时才打印，否则每行都重复一遍很吵。
            ...(row.happened_at && Number(row.happened_at) !== Number(row.created_at)
              ? [`发生: ${stamp(row.happened_at)}`]
              : []),
            ...(row.context ? [`情境: ${row.context}`] : []),
            ...(row.mood ? [`情绪: ${row.mood}`] : []),
            // v3（2026-11-20）：原文出处。读到这里就知道去哪跳回原话。
            ...(row.source_ref ? [`原文: ${row.source_ref}  （用 memory_source 直接拉）`] : []),
            // v4（2026-11-20）：域（这件事的性质）
            ...(row.domain ? [`域: ${row.domain}`] : []),
            `上次命中: ${
              row.last_accessed_at
                ? `${fmtLocalTime(row.last_accessed_at)}（累计 ${row.hit_count} 次）`
                : '（从未）'
            }`,
            '',
            String(row.content ?? ''),
          ].join('\n'),
        }
      }
      return { text: `（没找到 ${want}。id 可以只给前 12 位）` }
    },
    { isConcurrencySafe: () => true }
  )

  // ③ 写入
  const tRemember = mk(
    'memory_remember',
    // 描述按「人的心智模型」写，不按「存储实现」写。
    // 四层是作用域从大到小，跟存储表名一一对应。
    '记一条新的长期记忆。\n' +
      '\n' +
      '**写法**（比分类更重要）：\n' +
      '· 正文写**提炼后的祈使句**，不要抄原话。原话里有语气词、重复、当时的情绪，\n' +
      '  对以后执行没有帮助，却会每次注入都占位置。\n' +
      '· 原话要留就单独存一条「金句」（level: branch + category: quote），需要时再翻。\n' +
      '· 自检：这句话里有多少词是在描述「当时的场景和情绪」？有就删掉。\n' +
      '· 现象+原因+做法三段一体的，按这个顺序写，别写成日志。\n' +
      '\n' +
      '**四层，先想清楚属于哪一层**：\n' +
      '· **core 核心** —— 跟他本人或跟我长期有关，每个会话都该知道，跨项目通用。\n' +
      '    category: identity 身份 / preference 偏好 / principle 原则 / rule 禁令\n' +
      '· **project 项目** —— 某个项目的静态画像。\n' +
      '    category: overview 概览 / structure 结构（路径、端口、模块怎么组织） / features 功能清单 / history 历史年表\n' +
      '· **branch 分支** —— 某个项目里进行中的事，会过时会变。\n' +
      '    category: decision 决策 / ops 现状 / todo 待办 / quote 金句 / plan 方案\n' +
      '· **detail 细节** —— 最小颗粒的积累，挂在项目上的具体东西。\n' +
      '    category: fact 事实 / lesson 教训 / topic 专题 / procedure 规程 / impl 实现细节 / reference 参考资料\n' +
      '\n' +
      '**detail 的几种要分清**（这里最容易混）：\n' +
      '· **fact** —— 一句话的客观事实（版本号、路径、端口、某个数值）\n' +
      '· **lesson** —— 现象 + 原因 + 做法。**中文记忆的默认形态**：踩过的坑、摸到的规律都放这。\n' +
      '  不要把一条硬拆成「知识」和「教训」两半，中文记忆是三段一体的，拆不开。\n' +
      '· **topic** —— 一个完整的小专题，可到 3000 字（机制 + 判据 + 反例 + 出处）\n' +
      '· **procedure** —— **能照着执行的操作规程**：步骤 + 命令 + 检查清单。\n' +
      '  区别：topic 回答「为什么会这样」，procedure 回答「我该按什么顺序做」。\n' +
      '  当出现「这件事又是零零散散几条、拼不出完整流程」的情况，就是缺 procedure。\n' +
      '· **reference** —— **参考资料**：现在用不上、但以后可能启发思路的东西。\n' +
      '  典型：别人怎么解决同一个问题、竞品做了什么、某个项目的设计取舍。\n' +
      '  判据：它不是「我要照着做」也不是「我不能这么干」，是「看过了，留着」。\n' +
      '  检索时它不跟主结果抢排序（只在末尾报个数量），要看就传 category: reference。\n' +
      '\n' +
      '关键词给 8-13 个。写入前会自动查重：与已有条目高度重合就不写，返回那条的 id 让你决定合并还是另立。',
    {
      content: { type: 'string', description: '内容。**必须自包含**：未来会话看不到当前对话，要写清背景和出处；上限 20000 字' },
      level: { type: 'string', description: '放哪一层：' + LEVELS.join('、') },
      category: {
        type: 'string',
        description:
          '层内分类。core: identity/preference/principle/rule · ' +
          'project: overview/structure/features/history · ' +
          'branch: decision/ops/todo/quote/plan · detail: fact/lesson/topic/procedure/impl/reference。不传用该层默认值。\n' +
          '⚠️ **reference = 参考资料**：现在用不上、以后可能启发思路的（别人怎么解决同一问题、竞品做了什么）。' +
          '不是「要照着做」也不是「不能这么干」，是「看过了，留着」。它不参与常规检索排序。\n' +
          '⚠️ project 层的 **features = 这个项目有哪些功能**（边界、谁跟谁能组合，要短）。' +
          '某个功能**怎么实现的**放 detail 层的 **impl**（可以长，需要时再搜）。' +
          '改一个项目之前先 memory_project 看 features，否则会不知道原来有什么。\n' +
          '⚠️ project 层的 **history = 历史年表**：只记"什么时候、按什么顺序变成现在这样"，' +
          '只写变化点（现状归 features、机制归 impl），每行指向一条 detail 条目。' +
          '判据：**删掉时间就不成立**的才归 history。\n' +
          // 🆕 2026-11-21：库里超长条目是普遍现象，根因就是这里只说了"能放多长"、
          //    没说"该多短"。模型看不到目标长度，就会把所有细节都塞进来。
          '⚠️ **各类的目标长度（写超了检索打分时会被长度归一化压下去，等于白写）**：\n' +
          '   · `fact` **≤100 字**，一句话事实（版本号、路径、端口）\n' +
          '   · `lesson` **≤300 字**，只留「症状 → 根因 → 修法」三句\n' +
          '   · `topic` 可到 3000（完整小专题：机制 + 判据 + 反例）\n' +
          '   · `procedure` 可到 3000（步骤 + 命令 + 检查点）\n' +
          '   · `impl` 可到 3000（改了哪个文件/函数、怎么改的、为什么没选另一种）\n' +
          // 🆕 2026-11-21 审计 P0：标题写着「各类」，实际只列了五类 ——
          //    而实现里早就给 reference 定了 3000 上限（落库时超了才提示），
          //    提示词落后于实现，模型写之前根本拿不到目标长度。
          '   · `reference` 可到 3000（别人怎么做的 + 哪一点能借鉴，别整篇抄进来）',
      },
      project: { type: 'string', description: '归属项目名。**一条记忆可以同时属于多个项目：用逗号分隔写全，不要二选一**（如 `项目甲,项目乙`，两个项目都能搜到它）。也可用多层 `父/子/孙` 划分板块（如 `父项目/子板块`，层级不限）。全局填「全局」（core 层不用传）' },
      keywords: { type: 'array', items: { type: 'string' }, description: '关键词 8~13 个。**它参与检索**：写别人可能用来找的说法（同义词、缩写、报错原文），别只抄正文里的词' },
      importance: { type: 'number', description: '重要性 1~4：1 琐事 / 2 一般 / 3 重要 / 4 核心级' },
      title: { type: 'string', description: '标题（可选，上限 200 字）。一句话说清这条讲什么，列表里显示的就是它' },
      force: {
        type: 'boolean',
        description: 'true = 跳过查重直接写。确认和已有条目确实是两件事时才用',
      },
      happened_at: {
        type: 'string',
        description:
          '事件**发生**的时间（不是写进库的时间）。可传 "2026-11-18" / ISO / 毫秒数。' +
          '不传 = 当成"就是现在发生的"。补记旧事时才需要传它区分',
      },
      context: {
        type: 'string',
        description:
          '情境：场景 / 任务 / 参与者。可传纯文本（"改记忆插件时 / 深夜排障"）' +
          '或 JSON {"scene":"","task":"","with":""}。回答"这话是在什么情况下说的"',
      },
      mood: {
        type: 'string',
        description:
          '情绪 JSON {"label":"焦虑","intensity":0.7,"confidence":0.8,"source":"explicit|inferred"}。' +
          '⚠️ source 必须标：explicit=他明说的，inferred=我推断的。**推断的不能当事实用**，' +
          '时间相关也不等于因果',
      },
      source: {
        type: 'string',
        description:
          '这条结论的**原文出处**，格式 `会话id#消息序号`，多条用逗号分隔。' +
          '例如 "session-01234567-89ab-cdef-0123-456789abcdef#22452"。' +
          '可以只给前 8 位（"01234567#22452"）。' +
          '为什么值得填：记忆是提炼过的话，细节早丢了；带出处以后能一条命令跳回原话确认。' +
          '做年表、项目计划这类"这条结论是哪次定的"尤其要带。',
      },
      domain: {
        type: 'string',
        description:
          '这件事的**性质**，不是项目名。自由文本，多条用逗号分隔（最多 4 个）。' +
          '常用值：编程 / 创作 / 生活 / 系统 / 其它 —— **只是建议，不强制**，' +
          '你干的事这五个装不下就自己起名。' +
          '标了的作用：面板按域筛选、`memory_health` 看分布。' +
          // 🛑 2026-11-20 逻辑审计 P1：原来这里写着「不同域的记忆会降权」，
          //    但域降权已经默认关掉（`domainDownweight`），`turnDomains` 恒为 null。
          //    工具描述是这个插件最主要的提示词面，卖一个不存在的功能比没功能更糟 ——
          //    模型会为了"降噪收益"白花 token 标域，而收益是 0。
          '它**不参与**注入时的排序（那套按域降权的机制默认关闭）。',
      },
    },
    async (d, a) => {
      const layer = String(a.level ?? 'detail')
      if (!LEVELS.includes(layer)) {
        return { text: `（非法 level：${layer}。可选：${LEVELS.join('、')}）` }
      }
      const body = String(a.content ?? '').trim()
      if (!body) return { text: '（内容为空）' }

      // 🛑 长度硬闸（2026-11-20 压力测试加的，见 MAX_CONTENT 的注释）。
      //    必须在查重之前挡：以前不挡，1MB 的正文还会先被算一遍 Jaccard 相似度。
      if (body.length > MAX_CONTENT) {
        return {
          text:
            `（正文 ${body.length} 字，超过单条上限 ${MAX_CONTENT} 字 —— **没有写入**。\n` +
            `   拆成几条按主题分开，或者压到 ${MAX_CONTENT} 字以内再写。）`,
        }
      }
      const rawTitle = a.title == null ? '' : String(a.title).trim()
      if (rawTitle.length > MAX_TITLE) {
        return {
          text:
            `（标题 ${rawTitle.length} 字，超过上限 ${MAX_TITLE} 字 —— **没有写入**。\n` +
            `   标题只当索引和列表标签，正文里再展开。）`,
        }
      }
      // 关键词超量/超长是截断不是拒绝（关键字丢了不伤正文），但必须说一声，
      // 否则调用方以为自己塞的 1000 个词都进去了。
      const kwIn = Array.isArray(a.keywords) ? a.keywords : []
      const kwOut = clampKeywords(a.keywords)
      let kwHint = ''
      if (kwIn.length > MAX_KEYWORDS) {
        kwHint = `\n💡 关键词 ${kwIn.length} 个，只留了前 ${MAX_KEYWORDS} 个（够用即可，一般 8~13 个）。`
      }

      // 注意：**这里不再硬拦截**。
      // 原来的「超 200 字拒绝写入」有两个问题：
      //   ① 真有一句话说不完的经验，被拦了只能加 long:true 或硬塞 topic，反而更乱
      //   ② 实测 lesson 层会越堆越多（占全库过半）、topic 层反而很空 ——
      //      硬拦没纠正倾斜，只是让人绕过它
      // 现在改为写入后附一句「这类东西下次放哪层更合适」（见下面的 layerHint）。

      // 查重（除明确 force）。只提示、不静默改写：合并成什么样必须由调用方决定。
      // 三档结果：duplicate 拦下；conflict 放行但明确报「哪里矛盾」；related 只附一句近邻提示。
      let related = null
      let conflict = null
      let refNear = null
      if (a.force !== true) {
        const near = findNearDuplicate(
          d,
          { title: a.title, content: body, keywords: a.keywords },
          dedupeJaccard
        )
        if (near.duplicate !== null) return { text: nearDuplicateHint(near.duplicate, dedupeJaccard) }
        related = near.related
        conflict = near.conflict
        // 相近的**参考资料**只提一句，不拦写入（它本来就不该跟结论比"重复"）
        refNear = near.refSimilar
      }

      // 分层建议（**只提示、不拦截**）。
      //
      // 原来的做法是「超过 200 字直接拒绝写入」，实测两个问题：
      //   ① 真有一句话说不完的经验，被拦了只能加 long:true 或硬塞别的层，反而更乱
      //   ② 硬拦没纠正倾斜，只是让人绕过它
      // 所以改成：**照常写入**，只在返回里附一句「这类东西下次放哪层更合适」。
      let layerHint = ''
      if (layer === 'detail' && resolveCategory(layer, a.category) === 'fact' && body.length > 400) {
        layerHint = `\n💡 这条 ${body.length} 字，更像一个完整知识块 —— 下次这类可以放 category: topic。`
      } else if (layer === 'detail' && resolveCategory(layer, a.category) === 'lesson' && body.length > 1500) {
        layerHint =
          `\n💡 这条 ${body.length} 字，教训通常能压到一两句；` +
          `如果它其实是一个完整专题（机制 + 判据 + 反例），下次更适合 category: topic。`
      } else if (layer === 'detail' && resolveCategory(layer, a.category) === 'topic' && body.length > 3000) {
        layerHint = `\n💡 这条 ${body.length} 字，已超过单个知识块 —— 考虑拆成两条 topic，主题分开更好检索。`
      } else if (
        layer === 'detail' &&
        resolveCategory(layer, a.category) === 'reference' &&
        body.length > 3000
      ) {
        layerHint =
          `\n💡 这条 ${body.length} 字，参考资料留档也别太长 —— ` +
          `压到 3000 以内，只留「别人怎么做的 + 哪一点能借鉴」。`
      }

      // 🛑 分类填了个不存在的值，不能静默换成默认值。
      //    实测：传 category「随便乱写的分类」+ level=branch，回「已写入 branch/ops」
      //    —— 用户以为自己那个分类生效了，其实被改成了 ops。
      //    更别扭的是 level 填错会明确报错，category 却不报，同一个工具两套脾气
      //    （2026-11-19 用户体验测试发现）。
      const wantCat = String(a.category ?? '').trim()
      const realCat = resolveCategory(layer, wantCat)
      let catHint = ''
      if (wantCat && wantCat !== realCat) {
        const allowed = (CATEGORIES[layer] || []).join(' / ')
        catHint =
          `\n⚠️ 你填的 category「${wantCat}」在 ${layer} 层不存在，**实际存成了「${realCat}」**。` +
          `\n   ${layer} 层可选：${allowed}`
      }

      // 💡 落层提示：默认落到 fact 时，看正文更像别的哪一类。
      //    为什么加这个（2026-11-19 实测真库）：detail 层里
      //    **lesson 占了七成、impl 只有个位数** —— 记忆被写成了"踩坑日记"。
      //    下次改这个项目，只知道踩过什么坑，不知道当时是怎么实现的。
      //    这里只在**落到默认分类**时提示，不拦写入。
      if (layer === 'detail' && realCat === 'fact') {
        if (/(我改|改成|加了|实现了|函数|参数|默认值|缓存|索引|字段|接口|阈值|开关|逻辑|调用|钩子)/.test(body)) {
          catHint +=
            '\n💡 这段读着像「怎么实现的」→ 更该用 category: impl。' +
            '\n   只记教训的话，下次改这项目会不知道原来是怎么做的。'
        } else if (/(第一步|先.{0,6}再|最后|步骤|流程|检查清单|照着)/.test(body)) {
          catHint += '\n💡 这段像一套步骤 → 更该用 category: procedure（能照着执行的那种）。'
        }
      }

      // 💡 时间线索：正文里明明写了「昨天 / 上周 / 11月18日」，却没传 happened_at。
      //    实测真库里带 happened_at 的只有个位数百分比 —— 等于这个字段白设计了。
      //    这里只提示，不自动推断（把"昨天"算成日期，猜错就是脏数据且不可逆）。
      if (a.happened_at === undefined) {
        const tw = body.match(/(今天|昨天|前天|上周|上个月|去年|本周|\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月)/)
        if (tw) {
          catHint +=
            `\n💡 正文提到「${tw[1]}」，但没传 happened_at —— 以后查不出「这事什么时候发生的」。` +
            '\n   补法：memory_update 传 happened_at="2026-11-19"（补记旧事时尤其要带）。'
        }
      }

      const id = 'mem-' + randomUUID().slice(0, 18)
      // 💡 `context` 自动补（见 autoContextHint 的注释）：没传、或传了空串，就自己带一条。
      //    放在 insertPlan 之前，跟"用户显式传了"走同一条写入路径。
      //
      // 🛑 2026-11-19 真机事故：**绝不能写 `a.context = auto`** ——
      //    DSH 传给工具的 args 是**冻结对象**，赋值直接抛
      //    `Cannot add property context, object is not extensible`，
      //    于是「不传 context 的一律写不进记忆」（那是绝大多数调用）。
      //    改成一个浅拷贝再交给 insertPlan，原对象一个字不碰。
      let autoCtx = false
      let ctxValue = a.context
      if (a.context === undefined || String(a.context).trim() === '') {
        const auto = autoContextHint()
        if (auto) {
          ctxValue = auto
          autoCtx = true
        }
      }
      const argsForInsert = ctxValue === a.context ? a : { ...a, context: ctxValue }
      const { cols, vals } = insertPlan(argsForInsert, layer, id, body, Date.now())
      const marks = cols.map(() => '?').join(',')
      d.prepare(`INSERT INTO ${layer} (${cols.join(',')}) VALUES (${marks})`).run(...vals)
      lastMemoryWriteAt = Date.now()
      noteMemoryWriteForCurrentSession()
      return {
        text:
          `已写入 ${layer}/${realCat} id=${id}` +
          (autoCtx
            ? '\n📎 context 自动带上了（哪个窗口 · 当时那句话）。要改就 memory_update 传 context。'
            : '') +
          // 🛑 用宽松判空 `!= null`：空库时 findNearDuplicate 可能不带这个字段，
          //    `undefined !== null` 是 true，会把 undefined 当有值传下去炸掉。
          (conflict != null
            ? conflictHint(conflict, dedupeJaccard)
            : related != null
              ? relatedHint(related)
              : '') +
          // 相近的参考资料：只提一句，绝不拦写入（理由见 refSimilarHint 的注释）
          (refNear != null ? refSimilarHint(refNear, dedupeJaccard) : '') +
          catHint +
          kwHint +
          layerHint,
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ④ 项目全景
  const tProject = mk(
    'memory_project',
    '把一个项目的记忆全部取出来，按分类分组。' +
      '动手改某个项目之前先读它 —— 省得把已经定过的结论推翻重来。' +
      '这里列 project（项目画像：概览/结构）和 branch（进行中的事：决策/现状/待办/金句）两层；' +
      'detail 层的零散事实与经验只报个数量，要查全部就用 memory_search 带上 project 参数。',
    { project: { type: 'string', description: '项目名；支持多层 `父/子/孙`（传父名会一并带出所有下级，层级不限），也支持多选' } },
    async (d, a) => {
      const name = String(a.project ?? '').trim()
      if (!name) return { text: `（缺 project。现有项目：${listProjectNames(d).join(' / ')}）` }

      // 🛑 `project` 字段里存的是**逗号分隔的多个项目**（'项目甲,项目乙'，
      //    表示一条记忆同时归属两个项目），不是单个名字。原来用 `project = ?` 精确匹配，
      //    于是凡是"一条记忆归属多个项目"的，用其中任何一个名字都查不到 ——
      //    库里这种组合值很多，等于一大半项目画像取不出来。
      //    这里用「把两边都补上逗号再找子串」，既支持组合、又不会被
      //    名字里带 _ 或 % 的当通配符（那是 LIKE 的坑）。
      const pick = (table) => {
        try {
          return d
            .prepare(
              // 🛑 2026-11-20：支持子项目（`/` 分层，11-21 起层级不限）。查父要带上所有下级，
              //    所以多一个 `instr(',' || project || ',', ',父/')` 条件 ——
              //    它能命中 `父项目/子板块`、`父项目/子板块,别的项目` 这类值。
              `SELECT * FROM ${table} WHERE (instr(',' || project || ',', ?) > 0 OR instr(',' || project || ',', ?) > 0) AND status != 'archived'`,
            )
            .all(`,${name},`, `,${name}/`)
        } catch {
          return []
        }
      }
      const rowsOf = [
        ['project', pick('project')],
        ['branch', pick('branch')],
      ]
      // detail 层的零散条目也要算进「这个项目到底存不存在」：
      // 只有 detail、没有画像（project/branch）的项目很常见（临时项目、试验项目）。
      // 原来 total 只看那两层，于是会回「没有项目 X」，而**同一句输出里的项目清单
      // 又明明列着 X** —— 自相矛盾，用户第一下就被自己的数据挡在门外
      // （2026-11-19 用户体验测试发现）。
      // 用 instr 而不是 LIKE：项目名里的 _ 和 % 会被 LIKE 当通配符。
      let detailN = 0
      try {
        detailN = d
          .prepare(
            "SELECT COUNT(*) AS n FROM detail WHERE (instr(',' || project || ',', ?) > 0 OR instr(',' || project || ',', ?) > 0) AND status = 'active'",
          )
          .get(`,${name},`, `,${name}/`).n
      } catch {
        /* 表不存在就跳过 */
      }
      const total = rowsOf.reduce((n, [, rs]) => n + rs.length, 0) + detailN
      if (total === 0) {
        return { text: `（没有项目「${name}」）\n现有项目：${listProjectNames(d).join(' / ')}` }
      }

      // 🔍 这个项目有没有**核心文件**？两条线是独立的：记忆条目的 `project` 字段随便填，
      //    而核心必须手动登记进 `projects.json` 才会出现在面板上、才会按关键词自动注入。
      //    于是「有记忆、没核心」的项目，用户在面板上完全看不见，以为记忆根本不存在
      //    （2026-11-22 隔壁窗口报告的可见性缺口：库里 26 个项目名合计 700+ 条记忆没核心）。
      let coreNote = ''
      try {
        const cfg = readProjectConfig()
        const hasCore = Boolean(cfg && cfg.projects && cfg.projects[name])
        if (!hasCore) {
          if (name.includes('/')) {
            const parent = name.split('/')[0]
            coreNote =
              `📁 **这是子项目**（\`父/子\`）—— 内容归父项目「${parent}」的核心，` +
              `子项目自己不需要文件（Windows 文件名也不允许 \`/\`）。\n` +
              `   面板上看不到它是对的；查「${parent}」会把这一支一起带出来。`
          } else {
            coreNote =
              `⚠️ **这个项目没有核心文件** —— 面板的「项目核心」里看不到它，也不会被关键词自动注入到上下文里` +
              `（只有 memory_search / memory_project 能查到）。\n` +
              `   要建：\`memory_project_core(action="write", project="${name}")\`。`
          }
        }
      } catch {
        /* 读不到配置就不提示，不影响正文 */
      }

      const out = [`# 项目：${name}`]
      if (coreNote) out.push('', coreNote)
      for (const [layer, rows] of rowsOf) {
        if (!rows.length) continue
        out.push(`\n## ${layer} 层（${rows.length} 条）`)
        const grouped = new Map()
        for (const row of rows) {
          const key = row.category || '（未分类）'
          if (!grouped.has(key)) grouped.set(key, [])
          grouped.get(key).push(row)
        }
        for (const [cat, items] of grouped) {
          out.push(`\n### ${cat}（${items.length}）`)
          for (const r of items) {
            const title = String(r.title || '').trim()
            const flag = r.status === 'active' ? '' : `〔${r.status}〕`
            out.push(`- ${r.id}${flag} ${title ? title + '：' : ''}${String(r.content || '').slice(0, 200)}`)
          }
        }
      }

      // 同项目的细节散在 detail 层；不报数会让人以为「就这几十条」
      // ⚠️ 括号里别写死分类名（复查 P1）：`detailN` 是 `COUNT(*)`，含全部 6 类，
      //    原来只列 4 个名字，一个只放了参考资料的项目会显示成「1 条（事实/教训/专题/规程）」。
      if (detailN > 0) {
        out.push(`\n---\n另有 detail 层 ${detailN} 条（事实/教训/专题/规程/实现/参考资料，要全量就搜）`)
        out.push(`要查这些用 memory_search 并传 project=${name}`)
      }
      return { text: out.join('\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑤ 修改已有条目
  const tUpdate = mk(
    'memory_update',
    '改一条已有记忆，只传要改的字段，不传的一点不动。' +
      'status 三个值：active = 在役 / stale = 完结但留档（仍能被搜到）/ archived = 不再用（检索不返回）。' +
      '合并两条重复记忆就靠它：把新信息合进内容更全的那条，另一条标 archived，' +
      '不要留着两条各说一半。',
    {
      id: { type: 'string', description: '记忆 id' },
      content: { type: 'string', description: '新内容（上限 20000 字）。只传要改的字段，其余不动' },
      keywords: { type: 'array', items: { type: 'string' }, description: '新关键词（8~13 个，参与检索）' },
      importance: { type: 'number', description: '新重要性 1~4' },
      status: { type: 'string', description: 'active / stale / archived' },
      project: { type: 'string', description: '新归属项目。同样支持**逗号多值**（`项目甲,项目乙`，一条记忆同时属于几个项目）和 `父/子/孙` 多层' },
      title: { type: 'string', description: '新标题（上限 200 字）' },
      happened_at: {
        type: 'string',
        description: '事件发生时间（"2026-11-18" / ISO / 毫秒）。传空串可清空',
      },
      context: { type: 'string', description: '情境（纯文本或 JSON）。传空串可清空' },
      mood: { type: 'string', description: '情绪 JSON，含 source: explicit|inferred。传空串可清空' },
      source: {
        type: 'string',
        description: '原文出处，格式 `会话id#消息序号`，多条用逗号分隔。传空串可清空',
      },
      domain: {
        type: 'string',
        description: '这件事的性质（域），自由文本，多条用逗号分隔。传空串可清空',
      },
      category: {
        type: 'string',
        description:
          '新的层内分类（改分类用）。必须是该层允许的取值，见 memory_remember 的说明；传非法值会报错',
      },
    },
    async (d, a) => {
      const id = String(a.id ?? '').trim()
      if (!id) return { text: '（缺 id）' }
      const levels = LEVELS
      let found = null
      for (const lv of levels) {
        const row = d.prepare(`SELECT id FROM ${lv} WHERE id = ? OR id LIKE ? ESCAPE '\\'`).get(id, idPrefix(id))
        if (row) {
          found = { lv, realId: row.id }
          break
        }
      }
      if (!found) return { text: `（没找到 ${id}）` }
      const sets = []
      const vals = []
      if (a.category !== undefined) {
        const allowed = CATEGORIES[found.lv] || []
        const c = String(a.category).trim()
        if (!allowed.includes(c)) {
          return {
            text: `（${found.lv} 层不接受 category=${c}。可选：${allowed.join(' / ')}）`,
          }
        }
        sets.push('category = ?')
        vals.push(c)
      }
      if (a.content !== undefined) {
        // 🛑 长度是库的约束（2026-11-20 逻辑审计 P1）：update 原来原样写入，
        //    能绕开 `memory_remember` 入口的那道闸，把 1MB 塞进已有条目。
        const cNew = String(a.content)
        if (cNew.length > MAX_CONTENT) {
          return {
            text:
              `（正文 ${cNew.length} 字，超过单条上限 ${MAX_CONTENT} 字 —— 没有修改。\n` +
              `   拆成几条，或者压到 ${MAX_CONTENT} 字以内再写。）`,
          }
        }
        sets.push('content = ?')
        vals.push(cNew)
      }
      if (Array.isArray(a.keywords)) {
        // 这里原来连 clampKeywords 都没走 —— 1000 个词、对象元素都能塞进已有条目。
        sets.push('keywords = ?')
        vals.push(JSON.stringify(clampKeywords(a.keywords)))
      }
      if (a.importance !== undefined) {
        sets.push('importance = ?')
        vals.push(Math.round(Number(a.importance)))
      }
      // 🛑 工具层也要校验 status：接口层已经有 400 了，模型这条路径一直没拦。
      //    写进 status='deleted' 会让这条记忆在**所有查询里消失**，而且毫无提示。
      if (a.status !== undefined) {
        const st = String(a.status)
        if (!['active', 'stale', 'archived'].includes(st)) {
          return {
            text: `⚠️ status 只能是 active / stale / archived，收到「${st}」。没做任何修改。`,
          }
        }
        sets.push('status = ?')
        vals.push(st)
      }
      // 🛑 core 表没有 project 列。无条件拼 `project = ?` 会在 prepare 阶段
      //    直接抛 `no such column: project`，整条更新挂掉。
      //    面板那边有 level!=='core' 兜底，工具这条路径一直没有（2026-11-19 审计发现）。
      //    这里选择「跳过 + 回执里说明」，而不是整条报错 —— 用户可能同时改了正文，
      //    不该因为一个改不了的字段把能改的也一起废掉。
      let projectSkipped = false
      if (a.project !== undefined) {
        if (found.lv === 'core') projectSkipped = true
        else {
          // 🛑 2026-11-20 边界审计：project 也要有上限，而且要走同一套归一化 ——
          //    否则 `memory_remember('')` 写成「全局」、`memory_update('')` 写成空串，
          //    库里会同时存在两种"全局"。斜杠畸形（`/`、`a/`、`/a`）也在归一化里处理掉。
          const pNew = normalizeProject(a.project)
          if (pNew.length > MAX_PROJECT) {
            return { text: `（项目名 ${pNew.length} 字，超过上限 ${MAX_PROJECT} 字 —— 没有修改。）` }
          }
          sets.push('project = ?')
          vals.push(pNew)
        }
      }
      if (a.title !== undefined) {
        // 和 content 同理：标题上限也要在 update 这条路上挡（原来是原样写入）
        const tNew = String(a.title)
        if (tNew.trim().length > MAX_TITLE) {
          return { text: `（标题 ${tNew.trim().length} 字，超过上限 ${MAX_TITLE} 字 —— 没有修改。）` }
        }
        sets.push('title = ?')
        vals.push(tNew)
      }
      // 包 B 后半 + 包 D 的三个字段。
      // 传空字符串 / null = 显式清空（补记时写错了要能抹掉）。
      if (a.happened_at !== undefined) {
        sets.push('happened_at = ?')
        vals.push(normalizeTime(a.happened_at))
      }
      if (a.context !== undefined) {
        sets.push('context = ?')
        vals.push(normalizeContext(a.context))
      }
      if (a.mood !== undefined) {
        sets.push('mood = ?')
        vals.push(normalizeMood(a.mood))
      }
      // v3（2026-11-20）：原文出处。传空串 = 显式清空。
      if (a.source !== undefined) {
        sets.push('source_ref = ?')
        vals.push(normalizeSourceRef(a.source))
      }
      // v4（2026-11-20）：域。传空串 = 显式清空。
      if (a.domain !== undefined) {
        sets.push('domain = ?')
        vals.push(normalizeDomain(a.domain))
      }
      if (sets.length === 0) {
        // 只给 core 条目传 project 时 sets 是空的 —— 不在这里单独说一句，
        // 下面那句「core 层没有项目归属」永远走不到，调用方会以为参数名写错了。
        if (projectSkipped) {
          return {
            text: '⚠️ core 层没有「项目」归属，project 改不了（这次也没有其他字段要改）。',
          }
        }
        return { text: '（没有要改的字段）' }
      }
      sets.push('updated_at = ?')
      vals.push(Date.now())
      vals.push(found.realId)

      // 改动前先留快照 —— 时间线（memory_timeline）就靠它
      const before = d.prepare(`SELECT * FROM ${found.lv} WHERE id = ?`).get(found.realId)

      d.prepare(`UPDATE ${found.lv} SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

      const after = d.prepare(`SELECT * FROM ${found.lv} WHERE id = ?`).get(found.realId)
      const touched = changedFieldsOf(before, after)
      if (touched.length > 0) recordHistory(d, found.lv, found.realId, before)

      bumpHit(d, found.lv, found.realId) // 维护过也算「用过」
      lastMemoryWriteAt = Date.now()
      noteMemoryWriteForCurrentSession()
      return {
        text:
          `已更新 ${found.lv} ${found.realId}` +
          (touched.length > 0 ? `\n改动字段：${touched.join(', ')}` : '') +
          (projectSkipped ? '\n（core 层没有「项目」归属，project 这次没写）' : '') +
          (touched.length > 0 ? '\n（改前快照已进版本历史，可用 memory_timeline 回看）' : ''),
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ⑥ 最近改动
  const tRecent = mk(
    'memory_recent',
    '最近写入或改过的记忆，跨全部四层，按更新时间倒序。' +
      '想快速知道「库里最近多了什么」用它；要按天分组看改动清单用 memory_dream。',
    {
      n: { type: 'number', description: '条数，默认 12' },
      level: { type: 'string', description: '只查某层：core / project / branch / detail。**这是层不是分类**，写 lesson/fact 这类会返回空' },
      project: { type: 'string', description: '只看某项目；支持逗号多值，也认 `父/子/孙`（传父名带出所有下级，层级不限）' },
    },
    async (d, a) => {
      // 🛑 2026-11-20 压力测试修：这里原来是 `Math.max(1, Math.min(100, Math.round(a.n ?? 12)))`。
      //    `Math.round(NaN)` 还是 NaN，而 Math.min/max 碰 NaN 一律返回 NaN ——
      //    于是 `LIMIT NaN` 直接抛 `datatype mismatch`，被工具层包成「⚠️ memory_recent 失败」。
      //    别手写这套夹取，用现成的 clamp()（它对非有限数返回下限）。
      const n = clamp(a.n ?? 12, 1, 100)
      const levels = a.level
        ? [String(a.level)]
        : LEVELS
      const all = []
      for (const lv of levels) {
        if (!LEVELS.includes(lv)) continue
        for (const row of d.prepare(`SELECT * FROM ${lv} ORDER BY updated_at DESC LIMIT ?`).all(n)) {
          all.push({ lv, row })
        }
      }
      all.sort((x, y) => msOf(y.row.updated_at) - msOf(x.row.updated_at))
      const picked = all
        // 🛑 2026-11-20：原来是 `String(row.project) === String(a.project)`（精确等于），
        //    于是「最近改动」里看不到子项目刚写的东西（`父项目/子板块` ≠ `父项目`），
        //    组合值 `甲项目,父项目` 也匹配不上。改用跟 memory_search 同一套 projectCovers。
        .filter(({ row }) => !a.project || projectCovers(row.project, a.project))
        .slice(0, n)
      if (picked.length === 0) return { text: '（没有记录）' }
      const lines = picked.map(({ lv, row }) => {
        const t = fmtLocalTime(row.updated_at)
        const head = String(row.title ?? row.content ?? '').replace(/\s+/g, ' ').slice(0, 70)
        return `${t}  [${lv}] ${row.id.slice(0, 20)}  ${head}`
      })
      return { text: lines.join('\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // ④c 删除一条记忆
  // 🛑 为什么要单独一个工具：`memory_health` 的报告里写着
  //    「确认不再需要的可以直接删」，可 13 个工具里根本没有删除能力 ——
  //    用户只能去改 status，而「改 status」和「删」在语感上不是一回事，
  //    于是卡在那里（2026-11-19 用户体验测试发现的落差）。
  //    这里也不做真删：默认归档（可恢复），要物理删必须显式 hard=true。
  const tForget = mk(
    'memory_forget',
    '删一条记忆。**默认只归档**（status=archived），想找回来随时能找回来；' +
      '只有传 hard=true 才是物理删除。' +
      '「删了怕以后想不起来」就用默认的归档，别用 hard。' +
      '归档的条目：面板勾「含已归档」能看到，memory_search 传 status="archived" 能搜到，' +
      '恢复用 memory_update 传 status="active"。',
    {
      id: { type: 'string', description: '记忆 id' },
      hard: {
        type: 'boolean',
        description: 'true = 物理删除（不可恢复，但会留快照）。默认 false = 只归档',
      },
      reason: { type: 'string', description: '为什么删（写进 debug 日志，方便以后回看）' },
    },
    async (d, a) => {
      const id = String(a.id ?? '').trim()
      if (!id) return { text: '（缺 id）' }
      let found = null
      for (const lv of LEVELS) {
        const row = d
          .prepare(`SELECT * FROM ${lv} WHERE id = ? OR id LIKE ? ESCAPE '\\'`)
          .get(id, idPrefix(id))
        if (row) {
          found = { lv, row, realId: row.id }
          break
        }
      }
      if (!found) return { text: `（没找到 ${id}）` }
      const reason = String(a.reason ?? '').trim()
      const suffix = reason ? `（原因：${reason}）` : ''

      if (a.hard === true) {
        // 硬删也要先留快照：不留的话「这条曾经存在」这件事就永久没了，
        // 事后连它长什么样都查不出来。
        try {
          recordHistory(d, found.lv, found.realId, found.row)
        } catch {}
        d.prepare(`DELETE FROM ${found.lv} WHERE id = ?`).run(found.realId)
        lastMemoryWriteAt = Date.now()
        noteMemoryWriteForCurrentSession()
        log(`forget(hard) ${found.lv} ${found.realId}${reason ? ' · ' + reason : ''}`)
        return {
          text:
            `已**物理删除** ${found.lv} ${found.realId}${suffix}\n` +
            '（删除前留了快照，memory_timeline 还能查出它存在过）',
        }
      }

      if (found.row.status === 'archived') {
        return { text: `（${found.realId} 已经是归档状态了，不用再删一次）` }
      }
      d.prepare(`UPDATE ${found.lv} SET status = ?, updated_at = ? WHERE id = ?`).run(
        'archived',
        Date.now(),
        found.realId,
      )
      try {
        recordHistory(d, found.lv, found.realId, found.row)
      } catch {}
      lastMemoryWriteAt = Date.now()
      noteMemoryWriteForCurrentSession()
      log(`forget(archive) ${found.lv} ${found.realId}${reason ? ' · ' + reason : ''}`)
      return {
        text:
          `已归档 ${found.lv} ${found.realId}${suffix}\n` +
          '想找回来：memory_update 传 status="active"，或 memory_search 带 status="archived" 搜它。\n' +
          '真要物理删除：同一条再调 memory_forget 并传 hard=true。',
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ⑦ 常驻核心记忆（MEMORY.md）分节编辑
  const tCore = mk(
    'memory_core',
    '编辑常驻核心记忆 MEMORY.md 的某个分节（append=追加到节尾 / replace=整节替换 / remove=删节）。' +
      '改完下一轮就生效，不需要重启。写之前会自动备份 .bak。<3000 字符为宜。',
    {
      action: { type: 'string', description: 'append / replace / remove' },
      section: { type: 'string', description: '分节名（## 后面的标题），如「用户」「环境」' },
      text: { type: 'string', description: '要写入的内容（append/replace 必填）' },
    },
    async (d, a) => {
      if (!fs.existsSync(coreMemoryPath)) return { text: `（找不到 ${coreMemoryPath}）` }
      const action = String(a.action ?? 'append')
      const section = String(a.section ?? '').trim()
      if (!section) return { text: '（缺 section）' }
      const md = fs.readFileSync(coreMemoryPath, 'utf8')
      const lines = md.split('\n')
      const idx = lines.findIndex((l) => l.trim() === '## ' + section)
      if (idx < 0) {
        const names = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, '').trim())
        return { text: `（没有分节「${section}」）\n现有分节：${names.join(' / ')}` }
      }
      let end = lines.length
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^##\s+/.test(lines[i])) {
          end = i
          break
        }
      }
      if (action === 'remove') {
        lines.splice(idx, end - idx)
      } else if (action === 'replace') {
        lines.splice(idx + 1, end - idx - 1, '', String(a.text ?? ''), '')
      } else {
        lines.splice(end, 0, String(a.text ?? ''))
      }
      const next = lines.join('\n')
      try {
        fs.copyFileSync(coreMemoryPath, `${coreMemoryPath}.bak-${Date.now()}`)
      } catch {}
      writeFileAtomic(coreMemoryPath, next)
      return { text: `已${action === 'remove' ? '删除' : action === 'replace' ? '替换' : '追加'}分节「${section}」。MEMORY.md ${sizeHint(next.length, CORE_MEMORY_LIMIT)}` }
    },
    { isConcurrencySafe: () => false }
  )

  /**
   * 容量状态：超了说超多少，快满说还剩多少。
   * 为什么必须有：MEMORY.md 注入硬截 3000 字符、项目核心硬截 maxCharsPerProject，
   * 超了不报错，只是内容悄悄少一半 —— 写完当场说，比事后排查便宜得多。
   */
  const CORE_MEMORY_LIMIT = 3000
  const sizeHint = (n, limit) => {
    if (!Number.isFinite(limit) || limit <= 0) return `${n} 字符`
    const pct = Math.round((n / limit) * 100)
    if (n > limit) {
      return `${n}/${limit} 字符（${pct}%）⚠️ **已超 ${n - limit}**，注入时会被截断到 ${limit}，后半段读不到 —— 先压缩再加`
    }
    if (n >= Math.floor(limit * 0.85)) {
      return `${n}/${limit} 字符（${pct}%）⚠️ **快满了，只剩 ${limit - n}**，建议先压缩再加`
    }
    return `${n}/${limit} 字符（${pct}%），余量 ${limit - n}`
  }

  // ⑦b 项目核心文件读写：写入时当场报字数，不让它悄悄超限
  const tProjCore = mk(
    'memory_project_core',
    '读写项目核心 Markdown（每个项目一份，按关键词注入）。写入会返回字数与上限，超了当场说' +
      '"超多少、注入会被截断"，快满了提醒压缩。action=list 一次列出所有项目核心的字数。',
    {
      action: { type: 'string', description: 'list / read / write' },
      project: { type: 'string', description: '项目名，要和 projects.json 里的键一致（read/write 必填）' },
      content: { type: 'string', description: 'write 时的全文（要清空就传空串）' },
    },
    async (d, a) => {
      const cfg = readProjectConfig()
      const lim = Number.isFinite(cfg.maxCharsPerProject) ? cfg.maxCharsPerProject : DEFAULT_MAX_CHARS
      const action = String(a.action ?? 'list')
      const names = Object.keys(cfg.projects || {})
      if (action === 'list') {
        if (!names.length) return { text: '（projects.json 里一个项目都没有）' }
        const rows = names.map((n) => {
          const p = resolveCoreFile(cfg.projects[n] && cfg.projects[n].file)
          if (!p) return `- ${n}:（没配 file）`
          let len = -1
          try {
            len = fs.readFileSync(p, 'utf8').length
          } catch {}
          if (len < 0) return `- ${n}:（还没写文件）`
          const flag = len > lim ? `⚠️ 超 ${len - lim}` : len >= Math.floor(lim * 0.85) ? '⚠️ 快满' : 'ok'
          return `- ${n}: ${len}/${lim} ${flag}`
        })
        return { text: `项目核心字数（上限 ${lim} 字符/个）：\n${rows.join('\n')}` }
      }
      const name = String(a.project ?? '').trim()
      const def = cfg.projects[name]
      if (!def) return { text: `（projects.json 里没有项目「${name}」）\n现有：${names.join(' / ')}` }
      const p = resolveCoreFile(def.file)
      if (!p) return { text: `（项目「${name}」没配 file，或 file 越界/不是 .md：${def.file || '空'}）` }
      if (action === 'read') {
        let content = ''
        try {
          content = fs.readFileSync(p, 'utf8')
        } catch {}
        if (!content) return { text: `（${def.file} 还不存在或为空）` }
        return { text: `# ${name}（${def.file}）${sizeHint(content.length, lim)}\n\n${content}` }
      }
      if (action === 'write') {
        if (a.content === undefined) return { text: '（缺 content：要清空就传空串）' }
        const body = String(a.content)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        writeFileAtomic(p, body)
        return { text: `已写入 ${name} → ${def.file}\n${sizeHint(body.length, lim)}` }
      }
      return { text: '（action 只能是 list / read / write）' }
    },
    { isConcurrencySafe: () => false }
  )

  // ⑧ 待整理清单（只报告，不改库）
  const tDream = mk(
    'memory_dream',
    '最近 N 天有改动的条目，按层分组列出来，用来判断哪些该合并、哪些该降级。' +
      '只看不改 —— 真要动数据用 memory_update。',
    {
      days: { type: 'number', description: '看最近几天，默认 7' },
      n: { type: 'number', description: '最多列几条，默认 30' },
    },
    async (d, a) => {
      const days = Math.max(1, Math.min(365, Math.round(a.days ?? 7)))
      const n = Math.max(1, Math.min(200, Math.round(a.n ?? 30)))
      const since = Date.now() - days * 864e5
      const out = []
      const byLevel = new Map()
      for (const lv of LEVELS) {
        const rows = d
          .prepare(`SELECT * FROM ${lv} WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
          .all(since, n)
        if (rows.length === 0) continue
        byLevel.set(lv, rows)
        for (const r of rows) out.push({ lv, r })
      }
      if (out.length === 0) return { text: `（最近 ${days} 天没有新增或更新的记忆）` }
      out.sort((x, y) => msOf(y.r.updated_at) - msOf(x.r.updated_at))
      const parts = [`最近 ${days} 天内有改动的记忆：${out.length} 条（最多列 ${n}）`]
      for (const [lv, rows] of byLevel) {
        parts.push(`\n## ${lv}（${rows.length}）`)
        for (const r of rows.slice(0, n)) {
          const t = String(r.title ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 64)
          parts.push(`- ${r.id.slice(0, 20)}  ${t}`)
        }
      }
      parts.push('\n（要整理就用 memory_update 合并/归档，或 memory_remember 补写。本工具不改数据。）')
      return { text: parts.join('\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑨ 查重：给一条已存在记忆，找库里最像的几条
  //
  // 补这个是为了「这条还有没有更像的」，方便合并重复条目。
  // 没有它，写新记忆前只能凭印象判断「这条是不是记过了」——正是重复副本的来源
  //。
  const tFindSimilar = mk(
    'memory_find_similar',
    '给一条已有记忆的 id，找出库里跟它最相似的 k 条（跨全部四层、用同一套 BM25 含拼音与首字母层，不含自己）。' +
      '写新记忆之前想确认「是不是已经记过」时用它；结果里分数高的直接考虑用 memory_update 合并。',
    {
      id: { type: 'string', description: '已有记忆的 id（可只用前 12 位）' },
      k: { type: 'number', description: '返回几条，默认 5，最大 20' },
      content_max: { type: 'number', description: '每条正文截断字符数，默认 200' },
    },
    async (d, a) => {
      const id = String(a.id ?? '').trim()
      if (!id) return { text: '（缺 id）' }
      const k = Math.max(1, Math.min(20, Math.round(a.k ?? 5)))
      const contentMax = Math.max(0, Math.min(5000, Math.round(a.content_max ?? 200)))

      let src = null
      let srcLevel = ''
      for (const lv of LEVELS) {
        const row = d.prepare(`SELECT * FROM ${lv} WHERE id = ? OR id LIKE ? ESCAPE '\\'`).get(id, idPrefix(id))
        if (row) {
          src = row
          srcLevel = lv
          break
        }
      }
      if (!src) return { text: `（没找到 ${id}）` }

      // 检索词用「标题 + 正文 + 关键词」而不是 id：id 是随机串，拿它检索没有意义。
      // 这样"讲的是同一件事"的条目才会浮上来，而不是"id 前缀像"的。
      const query = [src.title ?? '', src.content ?? '', parseKeywords(src.keywords).join(' ')]
        .filter(Boolean)
        .join(' ')

      const pool = []
      for (const lv of LEVELS) {
        for (const raw of list(d, lv, { status: 'active' })) {
          if (String(raw.id) === String(src.id)) continue
          pool.push(toDoc(raw, lv))
        }
      }
      if (pool.length === 0) return { text: '（库里没有别的 active 条目）' }

      const hits = bm25Search(query, pool, { k })
      if (hits.length === 0) return { text: '（没有相似条目）' }

      const head =
        `源：[${srcLevel}] ${src.id}\n` +
        `${src.title ? String(src.title) + '\n' : ''}${String(src.content ?? '').slice(0, contentMax)}`
      const body = []
      for (const h of hits) {
        body.push(
          `[${h.level}] ${h.id} (${h.score.toFixed(2)})\n` +
            `${h.title ? String(h.title) + '\n' : ''}` +
            `${contentMax > 0 ? String(h.content ?? '').slice(0, contentMax) : String(h.content ?? '')}\n` +
            `keywords: ${h.keywords.join(', ')}\nproject: ${h.project || '（全局）'}`
        )
      }
      return {
        text: `${head}\n\n相似 ${hits.length} 条（分数越高越像）：\n\n${body.join('\n\n---\n\n')}`,
      }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑩ 库总览
  //
  // 补这个是为了「一眼看到库里都有些什么」，省得每次都要搜。
  // memory_recent 只看"最近 N 条"、memory_dream 只看"最近 N 天改动"，
  // 都回答不了「库里现在到底有多少、哪层最胖、有哪些项目」。
  const tHome = mk(
    'memory_home',
    '记忆库总览：库路径与体积、四层各自的 active/stale/archived 分布、项目清单、最近写入 5 条。' +
      '想知道「库里有什么、有多大、哪层最胖」时用这个。',
    {},
    async (d) => {
      const parts = []
      let sizeText = '（读不到）'
      try {
        const st = fs.statSync(dbPath)
        sizeText = `${(st.size / 1024 / 1024).toFixed(2)} MB`
        parts.push(`记忆库：${dbPath}\n体积：${sizeText}`)
      } catch {
        parts.push(`记忆库：${dbPath}\n体积：${sizeText}`)
      }

      // 各层状态分布（用 GROUP BY，不把整表读出来）
      const rows = []
      let total = 0
      for (const lv of LEVELS) {
        let counts
        try {
          counts = d.prepare(`SELECT status, COUNT(*) AS c FROM ${lv} GROUP BY status`).all()
        } catch {
          continue
        }
        if (counts.length === 0) continue
        const m = {}
        let sum = 0
        for (const r of counts) {
          m[r.status] = r.c
          sum += r.c
        }
        total += sum
        rows.push(
          `- ${lv.padEnd(8)} 共 ${String(sum).padStart(5)}　active ${m.active ?? 0}` +
            (m.stale ? `　stale ${m.stale}` : '') +
            (m.archived ? `　archived ${m.archived}` : '')
        )
      }
      parts.push(`\n## 四层（合计 ${total} 条）\n${rows.join('\n')}`)

      const names = listProjectNames(d)
      if (names.length > 0) {
        parts.push(`\n## 项目（${names.length} 个）\n${names.join(' / ')}`)
      }

      // 最近写入：先从每层取前 3 条，再合并排序取 5 条（避免全表扫描）
      const recent = []
      for (const lv of LEVELS) {
        for (const r of list(d, lv, { status: 'active' }).slice(0, 3)) recent.push({ lv, r })
      }
      recent.sort((x, y) => msOf(y.r.updated_at) - msOf(x.r.updated_at))
      if (recent.length > 0) {
        parts.push('\n## 最近写入')
        for (const { lv, r } of recent.slice(0, 5)) {
          const t = String(r.title ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 56)
          parts.push(`- [${lv}] ${String(r.id).slice(0, 20)}  ${t}`)
        }
      }
      return { text: parts.join('\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // ⚠️⚠️ tFindSimilar / tHome 写了但**故意不注册**：和已有功能重复。
  //
  // 背景：早先按「工具数量差集」判断漏了两个想补上，实际是当初就和已有功能重复才没注册的。
  //
  // 逐条看：
  //   · memory_find_similar(id) = `memory_read` 读出那条 → 用它的内容当 query 去 `memory_search`。
  //     两步操作，工具只是省了一步；真要查重时直接搜关键词更快，也不依赖"先有 id"。
  //   · memory_home = 各层条数（memory_project 已在报）+ 最近写入（memory_recent 就是它）
  //     + 项目清单（memory_project 不传参即可）+ 库体积（`ls -la` 一条命令）。
  //
  // 🛑 真正的代价不是"多两段代码"，而是**每个注册的工具都在每轮工具目录里占一份 description**：
  //    用不上的工具既烧 token，又干扰模型挑工具。这是"照旧清单补齐"最容易犯的错。
  // ⇒ 不要因为"旧插件有这个工具名"就往回补。判断标准是**有没有独占能力**，不是名字齐不齐。
  //
  // ⑨ 版本时间线
  const tTimeline = mk(
    'memory_timeline',
    '看一条记忆被改过几次、每次改了什么。数据来自 *_hist 版本表（每次 memory_update 都会留快照）。' +
      '想知道「这条结论以前是怎么写的、哪次变了」时用它 —— 排查「结论被改歪了」特别有用。',
    {
      id: { type: 'string', description: '记忆 id（前 12 位即可）' },
      level: { type: 'string', description: '已知在哪层就传，能少查几张表' },
      limit: { type: 'number', description: '最多显示几个版本，默认 20（取最近的）' },
      diff_chars: {
        type: 'number',
        description: '每个字段显示多少字，默认 400。改得长的地方原来只截 60 字，' +
          '正好把改动砍掉，看着像"两版一模一样"',
      },
      action: {
        type: 'string',
        description: 'view（默认，看历史）/ restore（把某一版写回去）',
      },
      version: {
        type: 'number',
        description: 'action=restore 时用：还原到第几版（编号就是 view 里列出来的那个，从 1 开始）',
      },
    },
    async (d, a) => {
      const want = String(a.id ?? '').trim()
      if (!want) return { text: '（缺 id）' }
      const layers = pickLayers(a.level)
      if (!layers) return { text: `（level 只能是 ${LEVELS.join(' / ')}）` }

      for (const layer of layers) {
        let row
        try {
          row = d.prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ? ESCAPE '\\'`).get(want, idPrefix(want))
        } catch {
          continue
        }
        if (!row) {
          // 🛑 行没了（被 memory_forget hard=true 物理删掉），**但快照还在** ——
          //    原来这里直接 continue，于是那些快照永远读不出来，
          //    `memory_forget` 回执里那句「还能查出它存在过」也就成了空话
          //    （2026-11-19 用户体验测试用一条真删除的条目验证出来）。
          let gone = []
          try {
            gone = d
              .prepare(
                `SELECT * FROM ${layer}_hist WHERE src_id = ? OR src_id LIKE ? ESCAPE '\\' ORDER BY changed_at`,
              )
              .all(want, idPrefix(want))
          } catch {
            /* 这层没有版本表 */
          }
          if (gone.length === 0) continue
          const outG = [
            `[${layer}] ${want}`,
            '（这条已经被**物理删除**了。下面是版本表里翻出来的最后状态）',
            '',
          ]
          const lastG = gone[gone.length - 1]
          try {
            const snap = JSON.parse(lastG.old_json)
            outG.push(`最后一次改动前（${fmtLocalTime(lastG.changed_at)}）：`)
            if (snap.title) outG.push(`标题: ${snap.title}`)
            if (snap.project) outG.push(`项目: ${snap.project}`)
            outG.push(String(snap.content ?? '').slice(0, 1500))
          } catch {
            outG.push('（快照解析失败）')
          }
          outG.push('', `共 ${gone.length} 份快照。想让它回来：把上面的内容用 memory_remember 重新写一条。`)
          return { text: outG.join('\n') }
        }

        let hist = []
        try {
          hist = d.prepare(`SELECT * FROM ${layer}_hist WHERE src_id = ? ORDER BY changed_at`).all(row.id)
        } catch {
          /* 这层没有版本表 */
        }
        if (hist.length === 0) {
          return {
            text:
              `[${layer}] ${row.id}\n` +
              '（没有版本历史：这条建立后没被改过，或改动发生在版本记录机制之前）',
          }
        }

        // 「改前快照」串成序列，末尾接当前版本 —— 逐对比较才看得出每次改了什么
        const versions = []
        for (const h of hist) {
          try {
            versions.push({ at: h.changed_at, snap: JSON.parse(h.old_json) })
          } catch {
            /* 坏数据跳过 */
          }
        }
        versions.push({ at: row.updated_at, snap: { ...row }, latest: true })

        // ── 还原到某一版 ────────────────────────
        // 「改坏了想退回」是 timeline 最该干的事之一，可原来只能看、不能动，
        // 而且看到的还是被截断的残片（2026-11-19 用户体验测试发现）。
        if (String(a.action ?? '').toLowerCase() === 'restore') {
          const vi = Math.trunc(Number(a.version))
          if (!Number.isFinite(vi) || vi < 1 || vi > versions.length) {
            return {
              text: `（version 要在 1~${versions.length} 之间；先不传 action 跑一次，看列出来的编号）`,
            }
          }
          const target = versions[vi - 1]
          if (target.latest) {
            return { text: '（这一版就是当前版本，不用还原）' }
          }
          // 只还原「内容类」字段：id / created_at / hit_count / 版本表自身绝不能动
          const RESTORE_FIELDS = [
            'content',
            'title',
            'keywords',
            'project',
            'category',
            'importance',
            'status',
            'happened_at',
            'context',
            'mood',
          ]
          const sets = []
          const vals = []
          for (const f of RESTORE_FIELDS) {
            if (target.snap[f] === undefined) continue
            sets.push(`${f} = ?`)
            vals.push(target.snap[f])
          }
          if (!sets.length) return { text: '（这一版没有可还原的字段）' }
          // 还原前先把**当前**这一版也存快照 —— 不然"还原"本身就不可撤销了
          try {
            recordHistory(d, layer, row.id, row)
          } catch {}
          sets.push('updated_at = ?')
          vals.push(Date.now())
          vals.push(row.id)
          d.prepare(`UPDATE ${layer} SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
          try {
            lastMemoryWriteAt = Date.now()
            noteMemoryWriteForCurrentSession()
          } catch {}
          log(`timeline restore ${layer} ${row.id} → v${vi}`)
          return {
            text:
              `已还原 [${layer}] ${row.id} 到第 ${vi} 版（${fmtLocalTime(target.at)}）\n` +
              `改动字段：${RESTORE_FIELDS.filter((f) => target.snap[f] !== undefined).join(', ')}\n` +
              '（还原前的那一版也留了快照，反悔可以再还原回去）',
          }
        }

        const out = [
          `[${layer}] ${row.id}`,
          String(row.title || '').trim() || '（无标题）',
          `共 ${versions.length} 个版本（含当前）`,
        ]
        // 版本多了全列会刷屏（实测有条改了 38 次）。默认只显示最近的，
        // 并且**保留被截断点的前一个版本**，否则第一行没法算 diff。
        const cap = clamp(a.limit ?? 20, 2, 200)
        const from = Math.max(1, versions.length - cap)
        if (from > 1) {
          out.push(`（更早的 ${from - 1} 个版本略过；要看全部就调大 limit）`)
        }
        out.push('')

        for (let i = from; i < versions.length; i += 1) {
          const v = versions[i]
          const prev = versions[i - 1]
          const when = fmtLocalTime(v.at)
          const touched = changedFieldsOf(prev.snap, v.snap)
          const tag = v.latest ? '（当前）' : ''
          out.push(`${i + 1}. ${when}${tag}  改了：${touched.join(', ') || '（无实质变化）'}`)
          // 每字段显示多少字：原来是 60，改得长的地方正好被砍在中间，
          // 前后两版看起来一模一样（实测"版本 2 和版本 3 内容完全相同"）。
          const dc = clamp(Number(a.diff_chars ?? 400), 20, 4000)
          for (const field of touched.slice(0, 8)) {
            const before = String(prev.snap[field] ?? '').replace(/\s+/g, ' ').slice(0, dc)
            const after = String(v.snap[field] ?? '').replace(/\s+/g, ' ').slice(0, dc)
            const cut = (s) => (String(s).length >= dc ? '…' : '')
            out.push(`   ${field}: 「${before}${cut(String(prev.snap[field] ?? ''))}」→「${after}${cut(String(v.snap[field] ?? ''))}」`)
          }
        }
        out.push('', `（最早那条是「第一次被改动之前」的快照，不是条目的诞生时刻）`)
        out.push('想退回某一版：memory_timeline 传 action="restore" 和 version=N')
        return { text: out.join('\n') }
      }
      return { text: `（没找到 ${want}）` }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑩ 记忆体检
  // ── 方案与任务清单 ────────────────────────
  // 2026-11-19 用户提的需求：讨论完先出一篇方案存进记忆库，
  //   做完打勾、没做完不勾 —— 这样项目推进不会乱，
  //   也能看出之前的活到底干完没有。
  // 关键取舍：**存在记忆库里，不是聊天记录里** —— 上下文压缩不会把它压没，
  // 换个会话也能捞回来。这是 branch 层新增的 `plan` 分类。

  // 数勾选进度用 db.js 的 planProgress（注入侧也要用，只留一份实现）

  /** 勾上 / 取消一项。按「文本包含」匹配，且**必须唯一** —— 含糊就报错，别赌一个 */
  function planToggle(text, needle, wantDone, note) {
    const lines = String(text || '').split('\n')
    const key = String(needle || '').trim()
    if (!key) return { ok: false, reason: '要勾哪一项？给 item（那一项的文字）' }
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([ \t]*[-*][ \t]*)\[([ xX])\]([\s\S]*)$/)
      if (m && m[3].includes(key)) hits.push(i)
    }
    if (hits.length === 0) return { ok: false, reason: `清单里没有含「${key}」的项` }
    if (hits.length > 1) {
      return { ok: false, reason: `有 ${hits.length} 项都含「${key}」，给更长的文字区分（或用 read 看全文）` }
    }
    const i = hits[0]
    const m = lines[i].match(/^([ \t]*[-*][ \t]*)\[([ xX])\]([\s\S]*)$/)
    const was = m[2].toLowerCase() === 'x'
    let rest = m[3]
    const clean = String(note || '').trim()
    // 包 E：勾选时顺手记下「怎么实现的」，收档生成 detail/impl 时直接用，不用回头重编。
    // 已经带过批注就不再追加（同一条反复 check 会把行越拖越长）。
    if (wantDone && clean && !/〔[^〕]*〕/.test(rest)) {
      const d = new Date()
      const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      rest = rest.replace(/\s*$/, '') + `　〔${stamp}｜${clean}〕`
    }
    const before = lines[i]
    lines[i] = m[1] + (wantDone ? '[x]' : '[ ]') + rest
    // 🛑 changed 要单独算：**已经勾上的项也要能补实现说明**（先勾了、过两天想起该写
    //    「怎么实现的」，那时候 was === wantDone，如果一律当"没动"就永远补不上）。
    const changed = lines[i] !== before
    return { ok: true, text: lines.join('\n'), item: m[3].trim(), was, changed }
  }

  /**
   * 从方案正文里抽「已勾选项 + 它们的批注」（包 E 的收档素材）。
   * 返回 [{item, note, raw}]：
   *   raw  = 原文（含反引号，用来判断是不是技术步骤）
   *   item = 清洗后的纯文字（去掉 markdown 标记）
   *   note = `11-19｜说明` 那一整段（空表示当时没写）
   */
  function planDoneItems(text) {
    const out = []
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^[ \t]*[-*][ \t]*\[[xX]\][ \t]*(\S.*)$/)
      if (!m) continue
      const raw = m[1].trim()
      const noteM = raw.match(/〔([^〕]*)〕/)
      const item = raw
        .replace(/\s*〔[^〕]*〕\s*$/, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!item) continue
      out.push({ item, note: noteM ? noteM[1].trim() : '', raw })
    }
    return out
  }

  const tPlan = mk(
    'memory_plan',
    '方案与任务清单：把「要做什么、分几步」存进记忆库，做完一项勾一项。' +
      '存在记忆库而不是聊天记录里 —— 上下文压缩不会把它压没，换个会话也捞得回来。' +
      '正文用 markdown 勾选清单：`- [x] 做完了` / `- [ ] 还没做`。' +
      '典型用法：聊完一个新功能 → create 建一份方案 → 边做边 check → 全勾完就 update 标 stale 收档。',
    {
      action: {
        type: 'string',
        description:
          'create 新建 / list 列出（默认）/ read 读全文 / check 勾上 / uncheck 取消 / add 追加几项 / update 覆盖正文 / archive 收档（生成年表+实现细节草稿，不直接写库）',
      },
      title: { type: 'string', description: '方案标题。create 必填；其它动作也能用它找方案（模糊匹配）' },
      id: { type: 'string', description: '方案 id（前几位也认）。不传就用 title 找' },
      project: { type: 'string', description: '归属项目，默认「全局」；**可逗号多值**（一条方案跨两个项目就都写上）；也认 `父/子/孙` 分层' },
      content: { type: 'string', description: '方案正文（markdown 勾选清单：`- [ ]` 没做 / `- [x]` 做完）。check / uncheck 就是按这个格式找行' },
      item: { type: 'string', description: 'check/uncheck 要动的那一项（按文本包含匹配，必须唯一）' },
      note: {
        type: 'string',
        description:
          '勾选时顺手记一句「怎么实现的」，会写成 `〔11-19｜说明〕`。收档生成 detail/impl 时直接用，不用回头重编',
      },
      items: { type: 'array', items: { type: 'string' }, description: 'add 要追加的几项，会写成 `- [ ] xxx`' },
      include_done: { type: 'boolean', description: 'list 时是否连「已全部勾完」的方案一起列，默认 false' },
      summary: {
        type: 'string',
        description:
          'archive 专用：模型读完素材后写的一句「变成了什么样」，会作为年表那一行（自动带今天日期）。' +
          '⚠️ 不要写"做了什么"，要写"变成了什么"——年表的判据是删掉时间就不成立',
      },
    },
    async (d, a) => {
      const action = String(a.action || 'list').toLowerCase()
      const now = Date.now()

      const findPlan = () => {
        const wantId = String(a.id || '').trim()
        const wantTitle = String(a.title || '').trim()
        if (wantId) {
          return (
            d
              .prepare(`SELECT * FROM branch WHERE category = 'plan' AND (id = ? OR id LIKE ?) LIMIT 1`)
              .get(wantId, wantId + '%') || null
          )
        }
        if (wantTitle) {
          return (
            d
              .prepare(
                `SELECT * FROM branch WHERE category = 'plan' AND title LIKE ? ORDER BY updated_at DESC LIMIT 1`,
              )
              .get('%' + wantTitle + '%') || null
          )
        }
        return null
      }

      if (action === 'create') {
        const title = String(a.title || '').trim()
        if (!title) return { text: '⚠️ 新建方案要有 title（一句话说清这份方案要干什么）' }
        let dup = null
        try {
          dup = d
            .prepare(`SELECT id FROM branch WHERE category = 'plan' AND title = ? AND status = 'active'`)
            .get(title)
        } catch {}
        if (dup) {
          return {
            text:
              `⚠️ 已经有同名方案「${title}」（${String(dup.id).slice(0, 14)}）。` +
              `要改它用 action=update，或者换个标题`,
          }
        }
        const body =
          String(a.content || '').trim() ||
          `# ${title}\n\n## 要解决什么\n- \n\n## 步骤\n- [ ] \n\n## 验收\n- [ ] \n`
        const cid = 'mem-' + randomUUID().slice(0, 18)
        const plan = insertPlan(
          {
            title,
            content: body,
            importance: 3,
            keywords: [],
            category: 'plan',
            project: String(a.project || '全局').trim() || '全局',
          },
          'branch',
          cid,
          body,
          now,
        )
        d.prepare(
          `INSERT INTO branch (${plan.cols.join(',')}) VALUES (${plan.cols.map(() => '?').join(',')})`,
        ).run(...plan.vals)
        const pg = planProgress(body)
        return {
          text:
            `✅ 方案已建：${title}\n` +
            `   id ${cid.slice(0, 14)} · 共 ${pg.total} 个勾选项\n` +
            `   勾进度：memory_plan(action="check", item="那几项的文字")`,
        }
      }

      if (action === 'list') {
        const includeDone = a.include_done === true
        const proj = String(a.project || '').trim()
        let rows = []
        try {
          rows = proj
            ? d
                .prepare(
                  `SELECT * FROM branch WHERE category = 'plan' AND status = 'active' AND project LIKE ? ORDER BY updated_at DESC`,
                )
                .all('%' + proj + '%')
            : d
                .prepare(
                  `SELECT * FROM branch WHERE category = 'plan' AND status = 'active' ORDER BY updated_at DESC`,
                )
                .all()
        } catch (e) {
          return { text: `⚠️ 读方案失败：${e && e.message}` }
        }
        if (rows.length === 0) {
          return { text: '（还没有任何方案。用 memory_plan(action="create", title="…") 建一份）' }
        }
        const items = rows.map((r) => ({ r, pg: planProgress(r.content) }))
        const isDone = (x) => x.pg.total > 0 && x.pg.todo === 0
        const finished = items.filter(isDone)
        const active = items.filter((x) => !isDone(x))
        const show = includeDone ? items : active
        const lines = [`# 方案（进行中 ${active.length} · 已完成 ${finished.length}）`]
        for (const { r, pg } of show) {
          const bar = pg.total > 0 ? `${pg.done}/${pg.total}` : '无勾选项'
          lines.push('')
          lines.push(`## [${bar}] ${r.title || '(无标题)'}`)
          lines.push(
            `   ${String(r.project || '全局')} · 更新 ${new Date(r.updated_at || now).toLocaleString('zh-CN')} · id ${String(r.id).slice(0, 14)}`,
          )
          // 把**没做完的项**列出来：一眼看到卡在哪，不用逐份 read
          const left = String(r.content || '')
            .split('\n')
            .map((l) => l.match(/^[ \t]*[-*][ \t]*\[[ \t]\][ \t]*(\S.*)$/))
            .filter(Boolean)
            .map((m) => m[1].trim())
          for (const l of left.slice(0, 6)) lines.push(`   · [ ] ${l}`)
          if (left.length > 6) lines.push(`   · …还有 ${left.length - 6} 项`)
        }
        if (!includeDone && finished.length > 0) {
          lines.push('')
          lines.push(`（另有 ${finished.length} 份已全部勾完，加 include_done=true 一起看）`)
        }
        return { text: lines.join('\n') }
      }

      const plan = findPlan()
      if (!plan) {
        return {
          text: `⚠️ 没找到这个方案${
            a.id ? `（id ${a.id}）` : a.title ? `（标题像「${a.title}」）` : '（要给 id 或 title）'
          }`,
        }
      }
      const before = { ...plan }
      const body = String(plan.content || '')

      if (action === 'read') {
        const pg = planProgress(body)
        return {
          text:
            `# ${plan.title}\n进度 ${pg.done}/${pg.total}（未完成 ${pg.todo}）\n` +
            `项目 ${plan.project || '全局'} · 更新 ${new Date(plan.updated_at || now).toLocaleString('zh-CN')}\n\n${body}`,
        }
      }

      if (action === 'check' || action === 'uncheck') {
        const wantDone = action === 'check'
        const res = planToggle(body, a.item, wantDone, a.note)
        if (!res.ok) return { text: `⚠️ ${res.reason}` }
        if (res.was === wantDone && !res.changed) {
          return { text: `（「${res.item}」本来${wantDone ? '就勾着' : '就没勾'}，没动）` }
        }
        recordHistory(d, 'branch', plan.id, before)
        d.prepare(`UPDATE branch SET content = ?, updated_at = ? WHERE id = ?`).run(res.text, now, plan.id)
        const pg = planProgress(res.text)
        const tail =
          pg.total > 0 && pg.todo === 0
            ? '\n🎉 全部勾完了 —— 可以用 memory_update 把它标 stale 收档'
            : `\n还剩 ${pg.todo} 项`
        return { text: `${wantDone ? '✅ 勾上' : '⬜ 取消勾选'}：${res.item}\n进度 ${pg.done}/${pg.total}${tail}` }
      }

      if (action === 'add') {
        const addList = Array.isArray(a.items)
          ? a.items.map((x) => String(x || '').trim()).filter(Boolean)
          : []
        if (addList.length === 0) return { text: '⚠️ add 要给 items（字符串数组）' }
        const append = addList.map((x) => `- [ ] ${x}`).join('\n')
        const next = body.replace(/\s*$/, '') + '\n' + append + '\n'
        recordHistory(d, 'branch', plan.id, before)
        d.prepare(`UPDATE branch SET content = ?, updated_at = ? WHERE id = ?`).run(next, now, plan.id)
        const pg = planProgress(next)
        return {
          text: `✅ 追加 ${addList.length} 项\n${addList.map((x) => '   - [ ] ' + x).join('\n')}\n进度 ${pg.done}/${pg.total}`,
        }
      }

      // ── 收档（包 E）：把方案变成「年表变化点 + 实现细节」的草稿 ──
      // 🛑 只生成**草稿**，一个字都不写库。原因：项目层的 history 判据很严
      //    （只收「删掉时间就不成立」的变化点），整篇方案搬进去就是把年表变流水账。
      //    这里把素材摊开给人挑，挑完再用 memory_remember 正式写。
      if (action === 'archive') {
        const pg = planProgress(body)
        const done = planDoneItems(body)
        const proj = plan.project || '全局'
        const title = String(plan.title || '(无标题)').replace(/\*\*/g, '').replace(/`/g, '')
        if (done.length === 0) {
          return { text: '⚠️ 这个方案一项都还没勾，收档没素材。先 check 几项再来' }
        }
        // 🛑 勾选项默认**都**是「做了什么操作」，而年表要的是「变成了什么样」。
        //    所以两把筛子：
        //      ① 写了实现说明的（note）→ 那是 impl 素材，不进年表（note 本身就在讲"怎么实现的"）
        //      ② 带技术标记的（反引号 / 文件扩展名 / 函数调用 / 下划线标识符）→ 代码步骤，同归 impl
        //    两把都过的才当年表候选 —— 那才是"能力/行为变了"这个级别的一句话。
        const TECH =
          /`|\.(?:js|mjs|cjs|py|json|yml|yaml|md|html|css|db|sh|bat)\b|\w+\(\)|\b[a-z]+_[a-z]+\b/i
        const isTech = (it) => !!it.note || TECH.test(it.raw)
        const histCands = done.filter((it) => !isTech(it))
        const implItems = done.filter((it) => it.note)
        const dateOf = (it) => {
          const dm = it.note.match(/^(\d{2}-\d{2})｜/)
          return dm ? dm[1] : '—'
        }
        const _d = new Date()
        const today = `${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
        const cleanSummary = String(a.summary || '')
          .replace(/\*\*/g, '')
          .replace(/`/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        // 💡 收档时顺带看一眼这个项目的 features 有没有落后 ——
        //    方案做完往往改变「这个项目有哪些功能」，而 features 是下次改代码前必读的那份。
        //    方案里原先写的「其他联动：同步 features」就落在这一句提示上：
        //    **只提示、不自动改写** —— features 是人手写的，机器覆盖一定跑偏。
        let featHint = ''
        try {
          const f = d
            .prepare(
              `SELECT id FROM project WHERE category = 'features' AND status = 'active' AND (instr(',' || project || ',', ?) > 0 OR instr(',' || project || ',', ?) > 0) LIMIT 1`,
            )
            .get(`,${proj},`, `,${proj}/`)
          featHint = f
            ? `💡 **别忘了同步 features**（project 层 ${f.id}）：方案做完往往会改变「这个项目有哪些功能」。` +
              `\n   改法：memory_update(id="${f.id}", content="<更新后的清单>")`
            : '💡 这个项目还没有 features 条目（project 层 category="features"）。补一份，' +
              '下次改代码就不会把两个功能合成一个。'
        } catch {}

        const out = [
          `# 收档草稿：${title}`,
          `进度 ${pg.done}/${pg.total}${pg.todo > 0 ? `，**还剩 ${pg.todo} 项没勾**（只能收已完成的部分）` : '（全部勾完）'}`,
          '',
          '## ① 年表变化点（project/history）',
          '⚠️ 只留「删掉时间就不成立」的——不要整张搬进年表。',
          '',
          '| 时间 | 变化点 |',
          '|---|---|',
          ...(cleanSummary
            ? [`| ${today} | ${cleanSummary} |`]
            : [
                '| — | （还没写总结。年表要的是「变成了什么样」，不是「做了哪几步」）|',
                ...(histCands.length ? ['', '手勾的候选（可参考，但多半是计划语言）：'] : []),
                ...histCands.map((it) => `| ${dateOf(it)} | ${it.item} |`),
              ]),
          '',
          done.length > 0
            ? `（另外 ${done.length} 项是技术步骤，已归到下面第②段；它们只讲"怎么做的"，不进年表）`
            : '',
          '',
          '## ② 实现细节（detail/impl）',
          `⚠️ 这一层收的是「怎么实现的」。共 ${implItems.length} 条带说明的。`,
          '',
          ...(implItems.length
            ? implItems.map((it) => `- **${it.item}**：${it.note.replace(/^\d{2}-\d{2}｜/, '').trim()}`)
            : ['（这一版没在任何勾选项上写实现说明，可以现在补：check 时加 note）']),
          '',
          '## 怎么落（草稿没写库，确认后再调）',
          `- 年表：memory_remember(level="project", category="history", project="${proj}", content="<挑出来的那几行>")`,
          '- 实现：memory_remember(level="detail", category="impl", content="<上面第②段>")',
          `- 全部收完：memory_update(id="${String(plan.id).slice(0, 14)}", status="stale")`,
          '',
          featHint,
        ]
        return { text: out.filter((x) => x !== '').join('\n').replace(/\n{3,}/g, '\n\n') }
      }

      if (action === 'update') {
        const next = String(a.content || '')
        if (!next.trim()) {
          return { text: '⚠️ update 要给 content（覆盖正文；不确定就先 action="read" 读出来改）' }
        }
        recordHistory(d, 'branch', plan.id, before)
        const sets = ['content = ?', 'updated_at = ?']
        const vals = [next, now]
        if (a.title) {
          sets.push('title = ?')
          vals.push(String(a.title).trim())
        }
        if (a.project) {
          sets.push('project = ?')
          vals.push(String(a.project).trim())
        }
        vals.push(plan.id)
        d.prepare(`UPDATE branch SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
        const pg = planProgress(next)
        return { text: `✅ 方案已更新：${a.title || plan.title}\n进度 ${pg.done}/${pg.total}` }
      }

      return {
        text: `⚠️ 不认识的 action：${action}（可选 create / list / read / check / uncheck / add / update）`,
      }
    },
  )

  // ── 冲突治理（包 C）────────────────────────
  // 「记忆会变」这件事光有版本历史不够用：现在只会「太像就拦下」，
  // 而真正麻烦的是**两条说法打架**——相似度不够高（拦不住），但结论相反。
  // 这里三件事：写入时提示冲突（在 findNearDuplicate / conflictHint 里已接）、
  // 扫全库找矛盾对、按人选的方案把两条理顺（留新/留旧/分期）。
  const tConflict = mk(
    'memory_conflict',
    '冲突治理：找出「相似但不重复」的记忆对（很可能说法打架），并把人选的处理方案落下去。' +
      '写入时如果和已有条目矛盾，memory_remember 的返回里也会提示。' +
      '判据：重复（同一件事）= 拦下让合并；冲突（说法不一样）= 不拦，交给人决定留哪个。' +
      '处理有四选一：keep_new / keep_old / both（分期）/ **merge（把对方正文当补充拼进来）**；' +
      '做错了可以用 action="undo" 撤销 —— 只清掉工具加的注记、把状态改回 active，不动你后来改的正文。',
    {
      action: {
        type: 'string',
        description: 'scan 扫（默认）/ show 看一对的双方 / resolve 处理一对',
      },
      project: { type: 'string', description: 'scan 时只看这个项目（强烈建议给，不然是全库两两比，慢）' },
      level: { type: 'string', description: 'scan 时只看某一层（detail/branch/project/core）' },
      floor: { type: 'number', description: '相似度下限，默认 0.45（低于这个视为无关，不当冲突）' },
      limit: { type: 'number', description: '最多列几对，默认 15' },
      a_id: { type: 'string', description: 'show / resolve 的第一条（旧的）' },
      b_id: { type: 'string', description: 'show / resolve 的第二条（新的）' },
      choice: {
        type: 'string',
        description:
          'resolve 的方案：keep_new 留新的（旧的标 stale 并注明被谁取代）/ keep_old 留旧的（新的标 archived）/ both 两条都留但旧的标 stale 分期',
      },
    },
    async (d, a) => {
      const action = String(a.action || 'scan').toLowerCase()
      const now = Date.now()

      const findById = (idish) => {
        const want = String(idish || '').trim()
        if (!want) return null
        for (const layer of LEVELS) {
          try {
            const r = d
              .prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ? LIMIT 1`)
              .get(want, want + '%')
            if (r) return toDoc(r, layer)
          } catch {}
        }
        return null
      }

      if (action === 'show') {
        const A = findById(a.a_id)
        const B = findById(a.b_id)
        if (!A || !B) return { text: '⚠️ a_id / b_id 要能各自找到一条记录' }
        const j = jaccardOf(
          new Set(tokenize(`${A.title || ''} ${A.content || ''}`)),
          new Set(tokenize(`${B.title || ''} ${B.content || ''}`)),
        )
        const why = factConflicts(`${A.title || ''} ${A.content || ''}`, `${B.title || ''} ${B.content || ''}`)
        return {
          text:
            `# 相似度 ${j.toFixed(2)}${why.length ? `　矛盾点：${why.join('；')}` : '（没发现同槽不同值）'}\n\n` +
            `## A [${A.level}/${A.category}] ${A.id}\n${A.title ? A.title + '\n' : ''}${String(A.content || '').slice(0, 600)}\n\n` +
            `## B [${B.level}/${B.category}] ${B.id}\n${B.title ? B.title + '\n' : ''}${String(B.content || '').slice(0, 600)}`,
        }
      }

      // resolve / undo 共用
      const rawOf = (doc) => d.prepare(`SELECT * FROM ${doc.level} WHERE id = ?`).get(doc.id)
      const tagOf = (doc) => `${doc.id}${doc.title ? `「${doc.title}」` : ''}`

      if (action === 'undo') {
        // 撤销一次 resolve：只清掉**我们加的那条注记**、把状态改回 active。
        // 🛑 不整体回滚 —— 万一用户在 resolve 之后又改过正文，整体回滚会把他的改动一起冲掉。
        const A = findById(a.a_id)
        const B = findById(a.b_id)
        if (!A || !B) return { text: '⚠️ 要 undo 得同时给 a_id 和 b_id' }
        const NOTE_RE = /\n+> *(?:⛔|⏳)[^\n]*/g
        const undone = []
        for (const doc of [A, B]) {
          const raw = rawOf(doc)
          if (!raw) continue
          const body = String(raw.content || '')
          const hasNote = /(?:^|\n)> *(?:⛔|⏳)/.test(body)
          if (!hasNote && raw.status === 'active') continue
          recordHistory(d, doc.level, doc.id, raw)
          d.prepare(
            `UPDATE ${doc.level} SET status = 'active', content = ?, updated_at = ? WHERE id = ?`,
          ).run(body.replace(NOTE_RE, '').replace(/\s*$/, ''), now, doc.id)
          undone.push(doc.id)
        }
        if (undone.length === 0) return { text: '（这两条看起来没被 resolve 改过，什么都没做）' }
        return {
          text: `✅ 已撤销：${undone.join(' / ')} 恢复成 active，并清掉了 resolve 加的注记。`,
        }
      }

      if (action === 'resolve') {
        const A = findById(a.a_id)
        const B = findById(a.b_id)
        if (!A || !B) return { text: '⚠️ a_id / b_id 要能各自找到一条记录' }
        const choice = String(a.choice || '').trim()
        if (!['keep_new', 'keep_old', 'both', 'merge'].includes(choice)) {
          return { text: '⚠️ choice 要是 keep_new / keep_old / both / merge' }
        }
        const mark = (doc, status, note) => {
          const raw = rawOf(doc)
          if (!raw) return false
          recordHistory(d, doc.level, doc.id, raw)
          const body = String(raw.content || '')
          // 加注只加一次，别越改越长
          const next = body.includes(note) ? body : body.replace(/\s*$/, '') + '\n\n' + note
          d.prepare(`UPDATE ${doc.level} SET status = ?, content = ?, updated_at = ? WHERE id = ?`).run(
            status,
            next,
            now,
            doc.id,
          )
          return true
        }
        let text = ''
        if (choice === 'keep_new') {
          mark(A, 'stale', `\n> ⛔ 已被 ${tagOf(B)} 取代（冲突治理：新条目更准确）。`)
          text = `✅ 留新的：${tagOf(B)} 保持 active；${tagOf(A)} 已标 stale 并注明被谁取代。`
        } else if (choice === 'keep_old') {
          mark(B, 'archived', `\n> ⛔ 与 ${tagOf(A)} 矛盾，未采用（旧条目更可信）。`)
          text = `✅ 留旧的：${tagOf(A)} 不动；${tagOf(B)} 已标 archived 并注明"未采用"。`
        } else if (choice === 'merge') {
          // 合并：B 保持 active，把 A 的正文当「补充」接在 B 后面（标明来源），A 标 archived。
          // 🛑 只做**机械拼接 + 标注出处**，不替用户改写文字 —— 自动合并的措辞一定会跑偏。
          const bRaw = rawOf(B)
          const aRaw = rawOf(A)
          if (!bRaw || !aRaw) return { text: '⚠️ 读不到其中一条的原文' }
          const merged =
            String(bRaw.content || '').replace(/\s*$/, '') +
            `\n\n---\n\n**来自 ${tagOf(A)} 的补充**（原更新时间 ${fmtLocalTime(aRaw.updated_at)}）\n\n` +
            String(aRaw.content || '')
          recordHistory(d, B.level, B.id, bRaw)
          d.prepare(
            `UPDATE ${B.level} SET content = ?, status = 'active', updated_at = ? WHERE id = ?`,
          ).run(merged, now, B.id)
          mark(A, 'archived', `\n> ⛔ 内容已合并进 ${tagOf(B)}，不再单独维护。`)
          text =
            `✅ 合并：把 ${tagOf(A)} 的正文作为「补充」接进了 ${tagOf(B)}（保持 active），${tagOf(A)} 标 archived。\n` +
            `   现在是两条机械拼起来的，**建议再过一遍 memory_update 润色** —— 工具不替你做文字合并。`
        } else {
          mark(A, 'stale', `\n> ⏳ 分时期保留：之后由 ${tagOf(B)} 接替，旧说法只作历史参考。`)
          text = `✅ 两条都留（分期）：${tagOf(A)} 标 stale 作历史；${tagOf(B)} 保持 active。`
        }
        return {
          text:
            text +
            '\n（改动都写了版本快照，可用 memory_timeline 回看/回滚）' +
            `\n要撤销这次处理：memory_conflict action="undo" a_id="${A.id}" b_id="${B.id}"`,
        }
      }

      // scan
      const floor = Number.isFinite(a.floor) ? Math.max(0.3, Math.min(0.95, a.floor)) : 0.45
      const limit = clamp(a.limit ?? 15, 1, 60)
      const proj = String(a.project || '').trim()
      const onlyLayer = String(a.level || '').trim()
      const layers = LEVELS.includes(onlyLayer) ? [onlyLayer] : LEVELS.slice()
      const pool = []
      for (const layer of layers) {
        try {
          for (const raw of list(d, layer, { status: 'active' })) pool.push(toDoc(raw, layer))
        } catch {}
      }
      if (pool.length < 2) return { text: '（在役条目不足两条，没什么可比的）' }

      // 🛑 不做全库两两比（条目一多就是百万级比较，会卡住）。
      //    用 bigram 倒排先挑候选：两条至少共享 2 个 bigram 才可能是"说同一件事"。
      //    然后只在候选里算 Jaccard。
      const inv = new Map()
      const toksOf = new Map()
      for (const doc of pool) {
        if (proj) {
          const pj = String(doc.project || '')
          // 🛑 2026-11-20 正确性审计：原来是 `pj.includes(proj)` 子串匹配 ——
          //    `父项目X` 会被算进 `父项目`（跨项目比相似度，报出假冲突），
          //    反向 `proj='真人'` 也会命中任何含「真人」二字的项目名。
          //    换成跟 memory_search / memory_project 同一套 projectCovers，
          //    全局条目照旧放行（它对所有项目都适用）。
          if (!isGlobalProject(pj) && !projectCovers(pj, proj)) continue
        }
        const toks = new Set(tokenize(`${doc.title || ''} ${doc.content || ''}`))
        toksOf.set(doc.id, toks)
        for (const t of toks) {
          if (!inv.has(t)) inv.set(t, [])
          inv.get(t).push(doc.id)
        }
      }
      const cands = new Map() // "idA|idB" -> 共享 bigram 数
      for (const ids of inv.values()) {
        if (ids.length < 2 || ids.length > 120) continue // 高频词（"记忆""这个"）跳过
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`
            cands.set(key, (cands.get(key) || 0) + 1)
          }
        }
      }
      const byId = new Map(pool.map((x) => [x.id, x]))
      const rows = []
      for (const [key, shared] of cands) {
        if (shared < 3) continue
        const [ia, ib] = key.split('|')
        const A = byId.get(ia)
        const B = byId.get(ib)
        if (!A || !B) continue
        // 跨层比没意义（detail 和 branch 本来就容易像）
        if (A.level !== B.level) continue
        const j = jaccardOf(toksOf.get(ia), toksOf.get(ib))
        if (j < floor) continue
        const why = factConflicts(`${A.title || ''} ${A.content || ''}`, `${B.title || ''} ${B.content || ''}`)
        rows.push({ A, B, j, why, shared })
      }
      rows.sort((x, y) => (y.why.length > 0 ? 1 : 0) - (x.why.length > 0 ? 1 : 0) || y.j - x.j)
      if (rows.length === 0) {
        return {
          text: `（没找到相似度 ≥ ${floor} 的同层条目对${proj ? `（项目：${proj}）` : ''}。换个 floor 或去掉 project 再试）`,
        }
      }
      const out = [
        `# 冲突候选（扫了 ${byId.size} 条在役记录，相似度下限 ${floor}${proj ? `，项目 ${proj}` : ''}）`,
        '先看带「⚠️ 矛盾点」的，那些是同一槽位填了不同值。',
        '',
      ]
      for (const r of rows.slice(0, limit)) {
        out.push(
          `## ${r.j.toFixed(2)}${r.why.length ? '　⚠️ ' + r.why.join('；') : ''}`,
          `- A [${r.A.level}] ${r.A.id}　${String(r.A.title || r.A.content || '').replace(/\s+/g, ' ').slice(0, 70)}`,
          `- B [${r.B.level}] ${r.B.id}　${String(r.B.title || r.B.content || '').replace(/\s+/g, ' ').slice(0, 70)}`,
          '',
        )
      }
      if (rows.length > limit) out.push(`（还有 ${rows.length - limit} 对，调 limit 看更多）`)
      out.push('要处理某一对：memory_conflict(action="show", a_id=..., b_id=...) 先看全文，再 action="resolve" 选方案。')
      return { text: out.join('\n') }
    },
  )

  const tHealth = mk(
    'memory_health',
    '记忆库体检：一次列出「没关键词 / 超长 / 沉底没被读过 / 缺项目归属 / 项目名不规范」的条目，' +
      '外加「结构偏科」「可补 happened_at」两项。' +
      '库用久了会脏，隔一阵跑一次。默认**只报告**；传 `fix: true` 会自动修**两类无损**的' +
      '（项目名去首尾空格、空归属改「全局」）。' +
      '⚠️ 超长 / 没关键词 / 沉底 / 补 happened_at **都不会自动动** —— 那几样要理解内容或涉及取舍，' +
      '机器替你决定就是添乱。' +
      '⚠️ 想知道「记忆该记成什么形状」（层与分类怎么选），也调这个 —— ' +
      '输出末尾带一份「写记忆的约定」，老会话里没收到首轮注入时靠它。',
    {
      stale_days: { type: 'number', description: '多久没被读过算「沉底」，默认 90 天' },
      sample: { type: 'number', description: '每类最多列几条，默认 8' },
      fix: {
        type: 'boolean',
        description:
          '默认 false（只报告）。传 true 自动修**两类无损**问题：' +
          '① `project` 每段去首尾空格（` 甲 , 乙 ` → `甲,乙`）' +
          '② `project` 是空串 / 全空格 → 「全局」（空归属等于按项目查不到）。' +
          '**只动 project 这一个字段**，不碰 content / updated_at / happened_at',
      },
    },
    async (d, a) => {
      const staleDays = clamp(a.stale_days ?? 90, 7, 3650)
      const sample = clamp(a.sample ?? 8, 1, 50)
      const now = Date.now()
      const staleCut = now - staleDays * 864e5

      const buckets = { noKeywords: [], tooLong: [], stale: [], malformed: [] }
      const projectNames = new Set()

      // 🔧 一键修（2026-11-21 加）：只修**能安全自动修**的那几类。
      //    🛑 必须跑在**扫描之前** —— 否则报告里的「归属异常 N 条」是修之前的数字，
      //       用户会以为还能修，再跑一遍又没了，白白怀疑工具坏了。
      //    为什么只修这几类：超长 / 没关键词 / 沉底都要理解内容才能判断，
      //    机器自动改就是替你做决定 —— 那不是"修"，是添乱。
      //    下面两类都是无损规范化：
      //      ① `project` 每一段去首尾空格（` 甲 , 乙 ` → `甲,乙`）
      //      ② `project` 是空串 / 全空格 → 「全局」（空归属等于按项目查不到）
      //    ⚠️ **不自动补 `happened_at`**（本来想补，测完否掉了）：
      //       它为 NULL 的语义是「没特别说明，就用记录时间」，补上 `created_at` 没增加任何信息，
      //       反而丢掉了"这条从来没填过事件时间"这个信号；而且真库上会一次改两千多条。
      //    ⚠️ 故意**不动 `updated_at`**：这是数据规范化、不是内容修改。
      //       动了会让「最近更新」排序和「沉底」判断全部失真 —— 体检刚修完就看不到沉底了。
      const fixLines = []
      if (a.fix === true) {
        let nProj = 0
        let nFail = 0
        for (const layer of LEVELS) {
          let rows = []
          try {
            rows = d.prepare(`SELECT id, project FROM ${layer}`).all()
          } catch {
            continue
          }
          for (const r of rows) {
            const raw = r.project === null || r.project === undefined ? null : String(r.project)
            if (raw === null) continue
            const segs = raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const nextProj = segs.length ? segs.join(',') : '全局'
            if (nextProj === raw) continue
            try {
              d.prepare(`UPDATE ${layer} SET project = ? WHERE id = ?`).run(nextProj, r.id)
              nProj += 1
            } catch {
              nFail += 1
            }
          }
        }
        fixLines.push(
          '## 🔧 已自动修（无损规范化，只动 project 字段）',
          `- 项目名去首尾空格 / 空归属改「全局」：**${nProj}** 条`,
          '- **没碰** `content` / `updated_at` / `happened_at` —— 只改了归属写法',
        )
        if (nFail > 0) fixLines.push(`- ⚠️ 有 ${nFail} 条写失败（多半是并发冲突），可以再跑一次`)
        if (nProj === 0) fixLines.push('- 没有需要修的，库本来就是干净的')
      }

      for (const layer of LEVELS) {
        let rows = []
        try {
          rows = d.prepare(`SELECT * FROM ${layer} WHERE status = 'active'`).all()
        } catch {
          continue
        }
        for (const r of rows) {
          if (parseKeywords(r.keywords).length === 0) buckets.noKeywords.push({ layer, r })
          if (String(r.content ?? '').length > 1200) buckets.tooLong.push({ layer, r })
          // 🛑 沉底统计跳过参考资料（2026-11-21 复查 P1）：它**按设计就不该被读**
          //    （不参与主排序、不进自动命中），所以满 stale_days 必然 100% 进这个桶，
          //    而报告的建议是「真过时的标 stale 或 memory_forget」——
          //    等于每次体检都点名资料、还劝人把它清掉，体检变成了新分类的清除器。
          if (
            String(r.category ?? '') !== 'reference' &&
            (r.hit_count ?? 0) === 0 &&
            msOf(r.updated_at) < staleCut
          ) {
            buckets.stale.push({ layer, r })
          }
          // project 为空才是「没归属」；「全局」是明确填过的，不算
          const proj = r.project === null || r.project === undefined ? null : String(r.project)
          // 🛑 光说"有 N 条归属异常"没用 —— 得让人看出**到底哪里异常**，
          //    是空串、还是名字首尾多了空格（2026-11-19 实测时就卡在这）。
          if (proj !== null && proj.trim() === '') {
            buckets.malformed.push({ layer, r, why: 'project 是空串' })
          }
          // 🛑 判断「首尾带空格」必须回到**原始字符串**自己切：
          //    `projectListOf` 内部已经 `.map(s => s.trim())` 了，从它那儿看永远看不出空格，
          //    于是这个检查原来一直是死逻辑（2026-11-19 补测试时才发现）。
          const rawProj = proj === null ? '' : String(proj)
          for (const seg of rawProj.split(',')) {
            if (!seg.trim()) continue
            if (seg !== seg.trim()) {
              buckets.malformed.push({
                layer,
                r,
                why: `project 里的「${seg}」首尾带空格`,
              })
            }
          }
          // 项目名收集用规范化过的那个（空格已去掉）
          for (const name of projectListOf(r.project)) {
            if (isGlobalProject(name)) continue
            projectNames.add(name)
          }
        }
      }

      // 🔧 一键修的结果已经在扫描前算好（fixLines），这里只负责把它塞进报告开头。

      const out = [
        `# 记忆体检（只看在役条目，沉底阈值 ${staleDays} 天）`,
        '',
        `- 没关键词：**${buckets.noKeywords.length}** 条 —— 没关键词几乎搜不到`,
        `- 超长（>1200 字）：**${buckets.tooLong.length}** 条 —— 条目越长，检索打分时被压得越狠，容易搜不出来`,
        `- 沉底：**${buckets.stale.length}** 条 —— ${staleDays} 天里没被任何一次检索命中过`,
        `- 归属异常：**${buckets.malformed.length}** 条 —— 项目字段是空的，或名字前后多了空格；按项目查的时候挂不上`,
      ]
      if (fixLines.length > 0) out.push('', ...fixLines)

      // 每一类都给「具体怎么修」：只说"有归属异常"而不说怎么办，
      // 等于把活丢回给用户（2026-11-19 体验测试里发现的：报了一堆，每条建议都落不到动作上）。
      const render = (title, list, how) => {
        if (list.length === 0) return
        out.push('', `## ${title}（${list.length}）`, `修法：${how}`)
        for (const item of list.slice(0, sample)) {
          const head = String(item.r.title || item.r.content || '').replace(/\s+/g, ' ').slice(0, 60)
          // why 是「这条为什么被算进这一类」；没有就不显示（其余三类靠类名已经够清楚）
          const why = item.why ? `（${item.why}）` : ''
          out.push(`- [${item.layer}] ${String(item.r.id).slice(0, 20)}  ${head}${why}`)
        }
        if (list.length > sample) out.push(`- …另有 ${list.length - sample} 条`)
      }
      render(
        '没关键词',
        buckets.noKeywords,
        'memory_update 传 keywords: ["词1","词2"]，5~10 个最有用。关键词是检索的主力。',
      )
      render(
        '超长',
        buckets.tooLong,
        '多数本该是 category: topic。先 memory_timeline 看看它改过没有，' +
          '再决定是拆成两条（主题分开更好搜）还是就这么留着。',
      )
      render(
        '沉底',
        buckets.stale,
        '不一定是坏事，冷门知识本来就少被用。真过时的：memory_update 传 status="stale"（完结留档，' +
          '还能搜到），或者 memory_forget（归档，面板勾「含已归档」还能翻回来）。',
      )
      render(
        '归属异常',
        buckets.malformed,
        'memory_update 传 project: "正确项目名"（别带首尾空格）。想标成通用的就传 "全局"。',
      )

      // 项目名近重（大小写/空格不同）会让「同一个项目」被拆成两份分别检索
      const groups = new Map()
      for (const name of projectNames) {
        const key = name.trim().toLowerCase()
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(name)
      }
      const clashes = [...groups.values()].filter((v) => v.length > 1)
      if (clashes.length > 0) {
        out.push('', `## 项目名疑似重复（${clashes.length} 组）`)
        for (const group of clashes.slice(0, sample)) {
          out.push(`- ${group.map((n) => `「${n}」`).join(' vs ')}`)
        }
        out.push('（统一成一个写法，否则同一个项目会被拆开检索）')
      }

      // 已归档堆积：不参与检索但占体积，也是最该清理的一类
      const archivedTally = []
      for (const layer of LEVELS) {
        try {
          const n = d.prepare(`SELECT COUNT(*) AS n FROM ${layer} WHERE status = 'archived'`).get().n
          if (n > 0) archivedTally.push(`${layer} ${n}`)
        } catch {
          /* 跳过 */
        }
      }
      if (archivedTally.length > 0) {
        out.push('', '## 已归档（不参与检索，但占体积）', `- ${archivedTally.join(' / ')}`)
        out.push(
          '想翻回来：memory_update 传 status="active"，或面板勾「含已归档」按条恢复。',
        )
        out.push('真要抹掉：memory_forget 传 hard=true（删除前会留快照，事后仍能查到它存在过）。')
      }

      // ── 结构偏科 ────────────────────────
      // 🛑 只看"有没有关键词/超长"是不够的：2026-11-19 实测真库，
      //    detail 里 lesson 占七成而 impl 只有个位数，
      //    project 的 history / features 也少得可怜 —— 整个库变成了"踩坑日记"。
      //    功能都在，但我只记一种东西，下次改这个项目照样不知道原来怎么实现的。
      try {
        const dist = {}
        for (const layer of LEVELS) {
          for (const r of d
            .prepare(`SELECT COALESCE(category,'') AS cat, count(*) AS n FROM ${layer} WHERE status='active' GROUP BY 1`)
            .all()) {
            dist[`${layer}/${r.cat}`] = r.n
          }
        }
        const EXPECT = [
          ['detail/impl', 20, '怎么实现的'],
          ['detail/procedure', 10, '能照着执行的步骤'],
          ['project/history', 10, '项目发展史'],
          ['project/features', 10, '这个项目有哪些功能'],
        ]
        const thin = EXPECT.filter(([k, min]) => (dist[k] || 0) < min).map(
          ([k, min, what]) => `- \`${k}\` 只有 ${dist[k] || 0} 条（${what}，建议 ≥${min}）`,
        )
        if (thin.length > 0) {
          out.push('', '## 记忆结构偏科', '下面这几类记得太少。功能/历史/实现细节缺了，下次改这个项目会不知道原来有什么：', ...thin)
          out.push('补法：看首轮注入里的「写记忆的约定」，或直接 memory_remember 时指定 category。')
        }
      } catch {
        /* 分类统计失败不影响体检其余部分 */
      }

      if (buckets.noKeywords.length + buckets.tooLong.length + buckets.stale.length + buckets.malformed.length === 0) {
        out.push('', '库里很干净，没什么要收拾的。')
      } else {
        out.push('', '（改之前会自动留版本快照；改坏了用 memory_timeline 传 action="restore" 能还原回去）')
      }

      // 📌 「写记忆的约定」这里再放一份。
      //    原因：那段约定是**首轮注入**才出现的，已经在跑的窗口永远看不到
      //    （2026-11-19 用户实测：老窗口里的 AI 根本不知道有新约定，
      //      于是"记什么形状"这件事对它们等于不存在）。
      //    体检是用户会主动调的工具，放这里等于给它一个随时可查的入口。
      out.push(
        '',
        '## 写记忆的约定（新会话自动注入；老会话看不到，所以这里也放一份）',
        '- 改了代码 / 加了参数 / 定了默认值 → `detail/impl`（怎么实现的）',
        '- 项目走过哪几个阶段、按什么顺序变的 → `project/history`',
        '- 这个项目现在**有哪些功能** → `project/features`',
        '- 一套能照着做的步骤 → `detail/procedure`',
        // ⚠️ 这一行和 `lib/inject.js` 的 CONVENTION 是同一份文案的两处副本，
        //    改一处必须同时改另一处（2026-11-21 审计就是靠这一点发现两份都漏了 reference）。
        '- 看过的外部资料 / 别人怎么解决的 / 竞品做了什么 → `detail/reference`（留档备查，不参与排序）',
        '- 这事发生在什么时候 → 传 `happened_at`；在什么场景下 → 传 `context`',
        '只记教训会让记忆变成"踩坑日记"：下次改代码还是不知道原来是怎么做的；',
        '反过来，看过觉得有用但现在用不上的资料也别扔，给它一条 reference。',
      )
      return { text: out.join('\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑪ 导出 Markdown
  const tExport = mk(
    'memory_export',
    '把记忆导成 Markdown 文件：可读、能进 git、能给别的 AI 或人看。' +
      '默认导出全部 active，可按层或项目筛。返回写入的完整路径。',
    {
      level: { type: 'string', description: '只导某一层（默认四层全导）' },
      project: { type: 'string', description: '只导某个项目（含全局条目）；支持 `父/子/孙` 多层，传父名会连下级一起导' },
      status: { type: 'string', description: 'active（在役，默认）/ stale（含完结留档）/ all（全要）' },
      max_chars: { type: 'number', description: '每条正文截断字符，默认 0 = 不截断' },
      include_global: {
        type: 'boolean',
        description: '指定项目时是否连「全局」条目一起导（默认 true，与检索语义一致）',
      },
      out_path: { type: 'string', description: '输出路径；不传就写到工作区《记忆导出-时间.md》' },
    },
    async (d, a) => {
      const layers = a.level ? splitCsv(a.level).filter((s) => LEVELS.includes(s)) : LEVELS
      if (layers.length === 0) return { text: `（没有合法的 level。可选：${LEVELS.join('、')}）` }
      const wantStatus = String(a.status ?? 'active').trim()
      const maxChars = clamp(a.max_chars ?? 0, 0, 100000)
      const wantProject = String(a.project ?? '').trim()
      const includeGlobal = a.include_global !== false

      const sections = []
      let count = 0
      for (const layer of layers) {
        let rows = []
        try {
          rows = d.prepare(`SELECT * FROM ${layer} ORDER BY updated_at DESC`).all()
        } catch {
          continue
        }
        const kept = rows.filter((r) => {
          // 三态口径对齐 memory_search：不传/active = 只要在役，all = 全量，
          // 其它值精确匹配。原来只判了 'active' 与「其它」，传 stale/archived
          // 反而把 active 条目也导出来 —— 等于筛选完全无效。
          if (wantStatus === 'active') {
            if (r.status !== 'active') return false
          } else if (wantStatus !== 'all') {
            if (r.status !== wantStatus) return false
          }
          if (wantProject) {
            const proj = r.project
            if (isGlobalProject(proj)) {
              // 全局条目：默认带上（和检索口径一致 —— 全局记忆对所有项目都适用），
              // 但 allow 关掉时不要，否则「只导某个项目」会被全局条目灌满。
              if (!includeGlobal) return false
            } else if (!projectCovers(proj, wantProject)) {
              // 🛑 2026-11-20：原来是 `projectListOf(proj).includes(wantProject)`（精确匹配），
              //    于是导出父项目时子项目（`父项目/子板块`）一条都导不出来 ——
              //    「搜得到、导不出」。改成跟 memory_search / memory_project 同一套 projectCovers。
              return false
            }
          }
          return true
        })
        if (kept.length === 0) continue

        const lines = [`## ${layer}（${kept.length} 条）`, '']
        for (const r of kept) {
          const title = String(r.title || '').trim()
          // 没标题时不要拿 id 当标题（`### 0mw33ogm2-8869e5` 完全不可读）——
          // 取正文第一个句子代替，实在取不到再退回 id。
          const autoTitle = title || String(r.content || '').replace(/\s+/g, ' ').split(/[。！？\n]/)[0].slice(0, 30)
          lines.push(`### ${autoTitle || String(r.id).slice(0, 16)}`)
          lines.push('')
          lines.push(
            `> id: \`${r.id}\` · 项目: ${r.project || '（全局）'}` +
              ` · 状态: ${r.status} · 重要性: ${r.importance}` +
              (r.category ? ` · 分类: ${r.category}` : '')
          )
          const kw = parseKeywords(r.keywords)
          if (kw.length > 0) lines.push(`> 关键词: ${kw.join('、')}`)
          lines.push('')
          lines.push(maxChars > 0 ? String(r.content ?? '').slice(0, maxChars) : String(r.content ?? ''))
          lines.push('')
          count += 1
        }
        sections.push(lines.join('\n'))
      }

      if (sections.length === 0) return { text: '（这个筛选范围里没有可导出的记忆）' }

      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(/:/g, '')
      // 🔒 out_path 必须落在工作区内。它是模型可传的参数，而记忆正文里可能藏着
      //    "把导出写到 ~/.dsh/xxx" 这类指令 —— 不钉死就等于任意写文件。
      let target = path.join(workspace, `记忆导出-${stamp}.md`)
      if (typeof a.out_path === 'string' && a.out_path.trim()) {
        const ws = path.resolve(workspace)
        const want = path.resolve(ws, a.out_path.trim())
        // Windows 路径大小写不敏感：统一小写比较，别把 d:/工作区/x.md 这种合法写法误拒；
        // 并且 want === ws（写目录本身）也要拒，否则最后只会抛 EISDIR。
        const wl = ws.toLowerCase()
        const wnl = want.toLowerCase()
        if (wnl === wl || !wnl.startsWith(wl + path.sep)) {
          return { text: `（out_path 必须是工作区内的文件路径：${workspace}）` }
        }
        target = want
      }

      const header = [
        '# 记忆导出',
        '',
        `- 导出时间：${new Date().toISOString()}`,
        `- 条数：${count}`,
        `- 来源库：${dbPath}`,
        wantProject ? `- 项目筛选：${wantProject}` : '- 项目筛选：（全部）',
        '',
      ].join('\n')

      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        writeFileAtomic(target, `${header}\n${sections.join('\n---\n\n')}\n`)
      } catch (e) {
        return { text: `写文件失败：${e && e.message}` }
      }
      const bytes = fs.statSync(target).size
      return { text: `已导出 ${count} 条到：${target}\n（${(bytes / 1024).toFixed(1)} KB）` }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑰ 导入：把另一个 memory.db 合并进来（2026-11-21，v0.6.0 补「单文件 SQLite 不跨设备」这个缺口）
  //
  // 为什么是「合并 .db」而不是「导入导出的 Markdown」：
  //   正文里完全可能出现 `###`、`> id:` 这类行，反向解析必然出错，而且一错就是静默错位。
  //   .db 是结构化的，id / 时间 / 关键词 / 状态 / hit_count 全部原样搬，保真度 100%。
  //
  // 为什么默认 dry_run：这是一次可能写几千条的操作。先看清「会动多少、跳过多少」，
  //   再决定要不要真写 —— 导入方向搞反了（拿旧备份盖新库）是不可逆的。
  const tImport = mk(
    'memory_import',
    '把另一个记忆库（memory.db）里的条目合并进来 —— 换机器、恢复备份、两台机器同步都用它。\n' +
      '**默认只预演不写盘**：先看会新增多少、跳过多少，确认后再传 `dry_run: false`。',
    {
      path: { type: 'string', description: '源库文件路径（另一个工作区的 `.dsh-memory/memory.db`）' },
      mode: {
        type: 'string',
        description:
          '同 id 冲突时怎么办：`skip`（默认，保留目标库原样）/ `overwrite`（用源库覆盖，只覆盖两边都有的列）',
      },
      level: { type: 'string', description: '只导某一层，默认四层全导（core/project/branch/detail）' },
      dry_run: { type: 'boolean', description: '默认 true = 只报告不写。确认后传 false 才真的写' },
    },
    async (d, a) => {
      const srcPath = String(a.path ?? '').trim()
      if (!srcPath) return { text: '（要给 path：源库文件路径）' }
      if (!fs.existsSync(srcPath)) return { text: `（找不到文件：${srcPath}）` }
      try {
        if (!fs.statSync(srcPath).isFile()) return { text: `（不是文件：${srcPath}）` }
      } catch (e) {
        return { text: `读不到源库：${e && e.message}` }
      }
      // 源库 = 目标库时要拒：同一个文件开两个连接去写，轻则死锁，重则把库写坏
      try {
        if (path.resolve(srcPath).toLowerCase() === path.resolve(dbPath).toLowerCase()) {
          return { text: '（源库和目标库是同一个文件，没有什么可导入的）' }
        }
      } catch {}

      const mode = String(a.mode ?? 'skip').trim()
      if (!['skip', 'overwrite'].includes(mode)) return { text: '（mode 只能是 skip 或 overwrite）' }
      const dry = a.dry_run !== false
      const layers = a.level ? splitCsv(a.level).filter((s) => LEVELS.includes(s)) : LEVELS
      if (layers.length === 0) return { text: `（没有合法的 level。可选：${LEVELS.join('、')}）` }

      let src
      try {
        src = new DatabaseSync(srcPath, { readOnly: true })
      } catch (e) {
        return { text: `打不开源库（可能被别的进程独占）：${e && e.message}` }
      }
      try {
        const tables = new Set(
          src
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => String(r.name))
        )
        const usable = layers.filter((l) => tables.has(l))
        if (usable.length === 0) {
          return { text: '（这个文件里没有 core/project/branch/detail 这几张表，不像记忆库）' }
        }

        const report = []
        let totalAdd = 0
        let totalUpd = 0
        let totalSkip = 0

        for (const layer of usable) {
          // 🛑 用**列交集**，不能让两边整列对齐：
          //    源库可能是老 schema（少 happened_at / domain 这类后来加的列）。
          //    按位置 `INSERT ... SELECT *` 会错位，按名字取交集最稳，缺的列落默认值。
          const destCols = new Set(d.prepare(`PRAGMA table_info(${layer})`).all().map((c) => String(c.name)))
          const srcCols = src.prepare(`PRAGMA table_info(${layer})`).all().map((c) => String(c.name))
          const cols = srcCols.filter((c) => destCols.has(c))
          if (!cols.some((c) => c === 'id') || !cols.some((c) => c === 'content')) {
            report.push(`${layer}：跳过（缺 id 或 content，结构不对）`)
            continue
          }
          const colSql = cols.map((c) => `"${c}"`).join(',')
          const rows = src.prepare(`SELECT ${colSql} FROM ${layer}`).all()
          if (rows.length === 0) {
            report.push(`${layer}：源库里没有条目`)
            continue
          }
          const destIds = new Set(d.prepare(`SELECT id FROM ${layer}`).all().map((r) => String(r.id)))
          const ins = d.prepare(
            `INSERT INTO ${layer} (${colSql}) VALUES (${cols.map(() => '?').join(',')})`
          )
          const updCols = cols.filter((c) => c !== 'id')
          const upd = updCols.length
            ? d.prepare(
                `UPDATE ${layer} SET ${updCols.map((c) => `"${c}" = ?`).join(',')} WHERE id = ?`
              )
            : null

          let add = 0
          let over = 0
          let skip = 0
          let badId = 0
          if (!dry) d.exec('BEGIN')
          try {
            for (const row of rows) {
              // 🛑 2026-11-21 审计实测抓到的真 bug：SQLite 对非 INTEGER 主键**允许 NULL**
              //    （而且允许多个 NULL），空串也能存。这类行导进来就是**永久不可操作**：
              //    `memory_read` / `update` / `forget` 全都按 id 找，永远找不到，
              //    但它在检索结果里占位置、显示成 `null` 或空白。所以直接不收。
              const rid = row.id === null || row.id === undefined ? '' : String(row.id)
              if (!rid.trim()) {
                badId += 1
                continue
              }
              const seen = destIds.has(rid)
              if (!seen) {
                if (!dry) ins.run(...cols.map((c) => row[c]))
                add += 1
                destIds.add(rid)
              } else if (mode === 'overwrite' && upd) {
                if (!dry) upd.run(...updCols.map((c) => row[c]), rid)
                over += 1
              } else {
                skip += 1
              }
            }
            if (!dry) d.exec('COMMIT')
          } catch (e) {
            // 一层出错就整层回滚 —— 半截导入比不导入更难收拾
            if (!dry) {
              try {
                d.exec('ROLLBACK')
              } catch {}
            }
            return {
              text: `导 ${layer} 时失败，这一层已回滚（**前面的层如果已经提交，保持已提交状态** —— 事务是按层开的，不是整批一个）：${e && e.message}`,
            }
          }
          totalAdd += add
          totalUpd += over
          totalSkip += skip
          if (badId > 0) {
            report.push(`  ⚠️ ${layer}：有 ${badId} 条的 id 是空值，已跳过（导进来也永远找不到它）`)
          }
          report.push(
            `${layer}：新增 ${add} · 覆盖 ${over} · 跳过 ${skip}（源库共 ${rows.length} 条，采用 ${cols.length} 列）`
          )
        }

        const head = dry
          ? `📋 预演（**没有写盘**）：会新增 ${totalAdd} 条、覆盖 ${totalUpd} 条、跳过 ${totalSkip} 条`
          : `✅ 已导入：新增 ${totalAdd} 条、覆盖 ${totalUpd} 条、跳过 ${totalSkip} 条`
        const tail = dry
          ? '\n确认无误后，**同样的参数**再调一次并传 `dry_run: false` 才会真的写。'
          : '\n新条目立即可检索。它们的项目名如果在目标库里没有对应项目核心，照样搜得到，只是不会跟着项目注入。'
        return { text: `${head}\n${report.join('\n')}${tail}` }
      } catch (e) {
        return { text: `导入失败：${e && e.message}` }
      } finally {
        try {
          src.close()
        } catch {}
      }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑮ 导出本轮实际注入的内容
  const tContext = mk(
    'memory_context',
    '把**这一轮实际注入给模型的记忆内容**原样导出来核对。\n' +
      '\n' +
      '注入对调用方是隐形的：模型只看到上下文里多了一条 user 消息，看不到它从哪来、' +
      '哪一段被节流掉了、有没有顶到字数上限。所以出了「明明记过却没带出来」' +
      '「带出来一堆不相干的」「注入的字数是不是太多了」这类疑问时，用它看真相，别靠猜。\n' +
      '\n' +
      '输出按「注入段」分组（首轮记忆 / 项目核心 / 关键词命中 / 触及核心 / 落档催办 / 反思提醒 / 压缩后重注入 / 方案草稿），' +
      '每段给字数、再给正文。快照只存在内存里、每个会话留最后一次，进程重启就没了。',
    {
      section: {
        type: 'string',
        description:
          '只看段名包含这个词的那几段（如 `命中`、`项目核心`、`催办`、`反思`）。不传 = 全部段都列。',
      },
      max_chars: {
        type: 'number',
        description:
          '每段正文最多显示多少字，默认 0 = 不截断。⚠️ 传 `full: true` 时默认会截到 800 字 —— 否则八份快照一起导出来可能十几万字，核对工具反而把你这一轮的上下文顶爆。',
      },
      full: {
        type: 'boolean',
        description:
          '默认只列**当前会话**的快照。传 true 列出所有会话（多窗口时用来看别的窗口被注入了什么）。',
      },
    },
    async (d, a, run) => {
      const snapshots = [...injectionSnapshots.entries()]
      if (snapshots.length === 0) {
        return {
          text:
            '（这个会话从来没有注入过）\n' +
            '可能的原因：刚开的新会话还没走到第一次注入；或者插件刚重启（快照只存内存，重启就清空）。\n' +
            '⚠️ 注意：「关掉注入」不会让快照变空，只会让它停在旧的一份 —— 那种情况这里会显示旧内容并标出轮次。',
        }
      }

      // 🛑 必须按**调用者会话**取快照（2026-11-21 审计 P0-2）。
      //    第一版没接 `run.agent`，直接拿"时间最近的那份"——多窗口时 A 窗口刚注入过，
      //    B 窗口一问就把 A 的内容当成"本轮注入"返回。而多窗口正是查这件事的典型场景。
      let sid = ''
      try {
        const ag = run && run.agent ? run.agent : null
        sid = ag ? String(ag.id || ag.session?.id || '') : ''
      } catch {
        sid = ''
      }
      // 没拿到身份时按「无会话」那一份查（写入端也是这么兜底的），别直接放弃
      const wantKey = sidKey(sid || 'global')
      const own = injectionSnapshots.get(wantKey) || null
      // 参数宽松处理（审计 P1-1/P1-2）：模型常把数字传成字符串、布尔传成 "true"。
      // `Math.floor(nCap) >= 1` 是防 0.5 这种：原来 `nCap > 0` 会让它通过，
      // floor 之后变成 0 = 静默不截断（审计 P2）。
      const nCap = Number(a.max_chars)
      const explicitCap = Number.isFinite(nCap) && Math.floor(nCap) >= 1
      const full = a.full === true || a.full === 'true' || a.full === 1
      let lookalike = '' // 没拿到会话 id 或没找到时，用来说明"下面这份其实是别人的"
      let picked
      if (own && !full) {
        picked = [[wantKey, own]]
        if (!sid) lookalike = '⚠️ 这次调用没拿到会话身份（DSH 没传 run.agent），下面是「无会话」那一份快照。'
      } else {
        snapshots.sort((x, y) => (y[1]?.at ?? 0) - (x[1]?.at ?? 0))
        picked = full ? snapshots : snapshots.slice(0, 1)
        if (!own) {
          lookalike = sid
            ? `⚠️ 没找到你这个会话（${shortSid(sid)}）的注入快照 —— 下面${full ? '这些' : '这份'}是最近写入的，**可能属于别的窗口**。`
            : `⚠️ 这次调用没拿到会话身份（DSH 没传 run.agent）—— 下面${full ? '这些' : '这份'}是最近写入的，**可能属于别的窗口**。`
        }
      }

      // 🛑 截断判据用 `full` 本身，不是 `picked.length > 1`：
      //    传了 full 但只有一个会话时，`length` 是 1，原来就退化成不截断，
      //    跟描述「传 full 默认截到 800 字」不符（2026-11-21 复查指出）。
      const cap = explicitCap ? Math.floor(nCap) : full ? 800 : 0
      const wantSec = String(a.section ?? '').trim().toLowerCase()

      const blocks = []
      const ageOf = (at) => {
        const m = Math.max(0, Math.round((Date.now() - (Number(at) || 0)) / 60000))
        return m < 1 ? '刚刚' : `${m} 分钟前`
      }
      for (const [key, snap] of picked) {
        const all = snap.parts || []
        const parts = all.filter((p) => !wantSec || String(p.section).toLowerCase().includes(wantSec))
        const stamp =
          `### 会话 ${shortSid(key)}（${fmtLocalTime(snap.at)} · ${ageOf(snap.at)}` +
          `${Number.isFinite(snap.turn) ? ` · 第 ${snap.turn} 轮` : ''}）`
        if (parts.length === 0) {
          blocks.push(
            stamp +
              '\n' +
              (wantSec
                ? `（按 section="${String(a.section).slice(0, 80)}" 过滤后一段都没剩 —— 这份快照里共 ${all.length} 段：` +
                  `${all.map((p) => p.section).join(' / ') || '空'}）`
                : `（这份快照是空的，一段都没有 —— 不该发生，` +
                  `说明 rememberInjection 收到空数组了，去查注入那段代码）`),
          )
          continue
        }
        const body = parts
          .map((p, i) => {
            const cut = cap > 0 && p.text.length > cap
            const shown = cut ? p.text.slice(0, cap) + `\n…（截断，原 ${p.text.length} 字）` : p.text
            return `${i + 1}. 【${p.section}】${p.chars} 字\n${shown}`
          })
          .join('\n\n')
        blocks.push(
          stamp +
            `\n共 ${parts.length} 段、合计 ${parts.reduce((n, p) => n + p.chars, 0)} 字` +
            (parts.length < all.length ? `（全量 ${all.length} 段，已按 section 过滤）` : '') +
            (cap > 0 ? `（每段截到 ${cap} 字）` : '') +
            `\n\n${body}`,
        )
      }

      // 🛑 明确标出「这份可能不是这一轮」（2026-11-21 复查 P0-5 的残留）。
      //    工具拿不到"当前是第几轮"，所以判不了"这份过没过期"；但能算它多久前写的。
      //    注入被关掉、或者这几轮全被节流时，快照就停在上一次 —— 不提醒的话，
      //    用户会对着几天前的内容当本轮看，还以为开关没生效。
      const newestAt = picked.length > 0 ? Number(picked[0][1]?.at ?? 0) : 0
      const ageMin = Math.max(0, Math.round((Date.now() - newestAt) / 60000))
      const staleNote =
        !full && ageMin >= 5
          ? `⚠️ 这份快照是 **${ageMin} 分钟前**写的 —— 如果这中间没有新的注入` +
            `（注入被关掉、或这几轮都被节流），它就是旧内容，**不代表这一轮**。\n`
          : ''

      const head =
        '这一轮模型实际收到的记忆内容（快照只在内存里，进程重启就没了）\n' +
        staleNote +
        (lookalike ? lookalike + '\n' : '') +
        (picked.length < snapshots.length
          ? `共存 ${snapshots.length} 份会话快照，这里只列 1 份 —— 要看全部传 full: true。\n`
          : '') +
        '\n'
      return { text: head + blocks.join('\n\n---\n\n') }
    },
    { isConcurrencySafe: () => true }
  )

  // 同类前例：tCore（memory_core）默认也**不注册** —— dsh-core-memory 已经提供了同名的
  // 「编辑 MEMORY.md」工具，我们再去占这个名字会撞车（去掉 toolPrefix 正式切换时尤其明显）。
  // 想让记忆功能完全自足（不再依赖官方那套）时，把配置 `coreTool` 设 true
  // ⑯ 冲水键：手动触发一次上下文压缩
  //    用户 2026-11-19 提出的要求：「你能手动摁一下冲水键」——DSH 界面没这个按钮，
  //    但在插件里能做：拿到最近那个 agent，fire-and-forget 调 `/compact`。
  const tCompact = mk(
    'memory_compact',
    '手动触发一次上下文压缩（冲水键）。' +
      '直接调宿主的压缩服务 `ctx.compaction.compactNow()`，**不经过 `/compact` 命令**。\n' +
      '注意：压缩是重操作，会等当前回合真正空闲后才执行，所以调用之后**不会立刻**看到结果 —— ' +
      '工具会先回一句"已排队"，压完界面上会有压缩提示。',
    {},
    async (_d, _args, run) => {
      // 🛑 2026-11-25：**不再走 `ctx.get('commands').execute(agent,'/compact')`**。
      //    那条路是从第三方 auto-checkpoint 抄来的临时方案（用户原话「那只是临时拉回来用的」）。
      //    `/compact` 命令本身只是 compaction 服务的一层包装 ——
      //    源码 `@deepseek-ai/dsh-command-compact/src/index.ts` 里就一句：
      //      `await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`
      //    自己插件要用，直接调服务：少一层命令注册、少一个「命令不存在」的失败面，
      //    也不用依赖 commands 服务有没有加载。
      const compaction = ctx.get('compaction')
      if (!compaction || typeof compaction.compactNow !== 'function') {
        return {
          text:
            '⚠️ compaction 服务拿不到（宿主没加载压缩实现）。\n' +
            '   查 profile 里有没有 `dsh-compaction-basic`（或别的 CompactionEngine 实现）。\n' +
            '   这一步失败不影响其它记忆功能。',
        }
      }
      // 🛑 2026-11-20 修：用 DSH 传进来的 `run.agent` —— 那才是「调用这个工具的那个会话」。
      //    以前用插件全局的 `lastAgentSeen`，它记的是"最后一个结束回合的 agent"：
      //    谁最后收尾就是谁，跟谁在按冲水键毫无关系。实测：另一个窗口让 AI 压缩，
      //    压掉的是本窗口（最后收尾的那个），本窗口凭空少了整段历史。
      //    `lastAgentSeen` 只留作兜底，且兜底命中时必须明说"这是猜的"。
      let agent = run && run.agent ? run.agent : null
      let guessed = false
      if (!agent) {
        const age = Date.now() - (lastAgentSeen.at || 0)
        if (lastAgentSeen.agent && age < 30 * 60 * 1000) {
          agent = lastAgentSeen.agent
          guessed = true
        }
      }
      if (!agent) {
        return {
          text:
            '⚠️ 拿不到调用者 agent（DSH 这次没传 run.agent），也没有最近 30 分钟内的兜底记录。\n' +
            '   先正常聊一轮再调它。',
        }
      }
      const sid = String(agent.id || agent.session?.id || '').replace(/^session-/, '').slice(0, 8) || '(未知)'
      // compactNow 的第一步是 `agent.runMaintenance(...)`；不是 Agent 实例就没有这条路。
      // 不显式挡的话会在后台抛 TypeError，日志里只剩一句看不懂的堆栈。
      if (typeof agent.runMaintenance !== 'function') {
        return {
          text:
            '⚠️ 拿到的 agent 没有 `runMaintenance`（不是 dsh-agent-loop 的 Agent 实例），压不了。\n' +
            '   压缩必须先占用宿主的 idle 维护通道。',
        }
      }
      // fire-and-forget —— 为什么必须异步：
      //   `compactNow` 内部第一件事是 `agent.runMaintenance(...)`，而 runMaintenance
      //   在 agent 非 idle 时**同步抛** `agent "…" already has active work`。
      //   工具是在一轮中间被调的，那时 agent 一定在跑（phase.kind === 'running'），
      //   直接调必然失败。所以先等回合收尾。
      void (async () => {
        try {
          if (typeof agent.whenIdle === 'function') {
            await Promise.race([
              agent.whenIdle(),
              new Promise((r) => setTimeout(r, 30000)), // 上限：别被"永远忙"挂死
            ])
          }
          // 让宿主的 phase 真正落回 idle 再进 maintenance（实测差几毫秒仍会撞 busy）
          await new Promise((r) => setTimeout(r, 500))
          log(`memory_compact: 开始压缩 session=${sid}${guessed ? '（兜底猜的）' : ''}`)
          const r = await compaction.compactNow(agent, new AbortController().signal)
          if (r === null) {
            log(`memory_compact: 没压（没有可安全折掉的历史）session=${sid}`)
            return
          }
          lastCompactDoneAt = Date.now() // 记账（不是闸）：自动路径据此算冷却
          log(
            `memory_compact: 完成 session=${sid} 折掉 ${r.shadowedSeqs.length} 条` +
              ` ~${r.shadowedTokenCount} tokens`,
          )
        } catch (e) {
          // ManualCompactionError 的 code：busy / cancelled / changed / summary / commit / persistence
          const code = e && e.code ? ` [${e.code}]` : ''
          log(`memory_compact: 失败${code} session=${sid}：${e && e.message}`)
        }
      })()
      return {
        text:
          '🧻 已按下冲水键 —— 排上队了，等这一回合真正空闲后开始压缩。\n' +
          `   压的是**本会话**（${sid}）` +
          (guessed ? '⚠️ 这次拿不到调用者 agent，用的是最近收尾会话的兜底记录，可能压错窗口。' : '。') +
          '\n   界面上出现压缩提示就说明它在跑了；这次压缩不会中断当前对话。',
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ⑰ 按出处回原文（v3）
  //
  // 为什么需要它：记忆是**提炼过的话**，细节早丢了。写的时候留了 source，
  // 但留了不等于能用 —— 得有人把 `sid#seq` 翻译回原话。这个工具就是那一跳。
  const tSource = mk(
    'memory_source',
    '把一条记忆的「原文出处」翻出来：给它记忆 id（或直接给 `会话id#序号`），' +
      '返回那段对话的原话和前后几轮。\n' +
      '记忆是提炼过的话，细节早丢了；写的时候留了出处，这里就能跳回原话确认。' +
      '做年表、项目计划这类「这条结论是哪次定的」尤其有用。',
    {
      id: { type: 'string', description: '记忆 id（可只给前 12 位），会读出它记的出处' },
      ref: {
        type: 'string',
        description: '直接给来源，格式 `会话id#序号`（可只给前 8 位）。传了就不看 id',
      },
      before: { type: 'number', description: '往前带几轮，默认 2' },
      after: { type: 'number', description: '往后带几轮，默认 2' },
    },
    async (d, a) => {
      const refs = []
      const rawRef = String(a.ref ?? '').trim()
      if (rawRef) {
        refs.push(...String(normalizeSourceRef(rawRef) || '').split(',').filter(Boolean))
      } else {
        const want = String(a.id ?? '').trim()
        if (!want) return { text: '（要么给 id，要么给 ref）' }
        let row = null
        for (const lv of LEVELS) {
          row = d
            .prepare(`SELECT id, source_ref FROM ${lv} WHERE id = ? OR id LIKE ? ESCAPE '\\'`)
            .get(want, idPrefix(want))
          if (row) break
        }
        if (!row) return { text: `（没找到 ${want}）` }
        if (!row.source_ref) {
          return {
            text:
              '（这条记忆没有记原文出处。写的时候带上 source="会话id#序号" 就能留）',
          }
        }
        refs.push(...String(row.source_ref).split(',').filter(Boolean))
      }

      const out = []
      for (const ref of refs) {
        const [sid, seq] = ref.split('#')
        if (!seq) {
          out.push(`〔${ref}〕只给了会话、没给序号，定位不到具体哪一条。`)
          continue
        }
        const r = sessionMessageAt(sid, seq, { before: a.before, after: a.after })
        if (!r) {
          out.push(`〔${ref}〕取不到会话存档`)
          continue
        }
        if (!r.found) {
          out.push(`〔${ref}〕${r.message || '没找到'}`)
          continue
        }
        const lines = r.window.map((m) => {
          const mark = Number(m.seq) === Number(seq) ? '▶' : ' '
          const t = m.time
            ? new Date(m.time).toISOString().slice(0, 16).replace('T', ' ')
            : ''
          return (
            `${mark} [${m.seq}] ${m.role === 'user' ? '用户' : '我'} ${t}\n` +
            `   ${String(m.text).replace(/\s+/g, ' ').slice(0, 600)}`
          )
        })
        out.push(`〔${r.sid} · seq=${seq}〕（这个会话索引到 ${r.total} 条）\n` + lines.join('\n'))
      }
      return { text: out.join('\n\n') || '（没有可查的出处）' }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑱ 批次固化（bake，2026-11-20）—— 思路取自 MindSlice
  //
  // 为什么要有它：单条有 `memory_timeline` 能看历史、能还原**一条**，
  // 但没有「批次」概念 —— 一次大整理（比如全库回填域改了几千条）
  // 想整体撤回去，只能一条条来，实际上等于没法撤。
  //
  // 粒度定成「上次 bake 之后动过的所有条目」，不用挑 id：
  // 凡是那段时间被创建或修改过的都进快照，漏不掉。代价是可能多收一些。
  const bakesDir = path.join(workspace, '.dsh-memory', 'bakes')
  const bakesIndexPath = path.join(bakesDir, 'index.json')
  const readBakesIndex = () => {
    try {
      const j = JSON.parse(fs.readFileSync(bakesIndexPath, 'utf8'))
      return Array.isArray(j?.bakes) ? j : { lastAt: 0, bakes: [] }
    } catch {
      return { lastAt: 0, bakes: [] }
    }
  }
  const writeBakesIndex = (idx) => {
    try {
      fs.mkdirSync(bakesDir, { recursive: true })
      fs.writeFileSync(bakesIndexPath, JSON.stringify(idx, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  const tBake = mk(
    'memory_bake',
    '把「上次固化之后动过的记忆」整批存成一个快照，以后能整体回到那个状态。\n' +
      '为什么要有：单条有 memory_timeline 能还原**一条**，但没有「批次」概念 ——\n' +
      '一次大整理（比如全库回填域改了几千条）想整体撤回去，只能一条条来。\n' +
      '粒度是「上次固化之后被创建或修改过的所有条目」，不用挑 id。\n\n' +
      'action：\n' +
      '  create（默认）—— 存一份快照，name 不起就按日期\n' +
      '  list —— 看有哪些版本\n' +
      '  restore —— 按 name 把快照里那些条目**恢复成当时的样子**\n' +
      '⚠️ restore 不会删掉快照之后新增的条目（那太危险），只把快照里有的改回去。',
    {
      action: { type: 'string', description: 'create（默认）/ list / restore' },
      name: {
        type: 'string',
        description: 'create 时的版本名（不起就按日期时间）；restore 时必填',
      },
    },
    async (d, a) => {
      const action = String(a.action ?? 'create').trim().toLowerCase()
      const idx = readBakesIndex()

      if (action === 'list') {
        if (!idx.bakes.length) return { text: '（还没有任何批次快照）' }
        const lines = idx.bakes.map(
          (b) =>
            `- **${b.name}**  ${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')}` +
            `  ${b.count} 条${b.note ? '  ' + b.note : ''}`,
        )
        return { text: `已有 ${idx.bakes.length} 个批次：\n${lines.join('\n')}` }
      }

      if (action === 'restore') {
        const want = String(a.name ?? '').trim()
        if (!want) return { text: '（restore 要给 name。先 action=list 看有哪些）' }
        const hit = idx.bakes.find((b) => b.name === want)
        if (!hit) return { text: `（没有叫「${want}」的批次）` }
        let snap
        try {
          snap = JSON.parse(fs.readFileSync(path.join(bakesDir, hit.file), 'utf8'))
        } catch (e) {
          return { text: `（快照文件读不出来：${e && e.message}）` }
        }
        const items = Array.isArray(snap.items) ? snap.items : []
        let done = 0
        let gone = 0
        for (const it of items) {
          const exists = d.prepare(`SELECT id FROM ${it.level} WHERE id = ?`).get(it.id)
          if (!exists) {
            gone++
            continue
          }
          try {
            d.prepare(
              `UPDATE ${it.level} SET category=?, title=?, content=?, keywords=?, importance=?,
                 status=?, project=?, happened_at=?, context=?, mood=?, source_ref=?, domain=?
               WHERE id=?`,
            ).run(
              it.category ?? null,
              it.title ?? null,
              it.content ?? '',
              it.keywords ?? '[]',
              it.importance ?? 1,
              it.status ?? 'active',
              it.project ?? null,
              it.happened_at ?? null,
              it.context ?? null,
              it.mood ?? null,
              it.source_ref ?? null,
              it.domain ?? null,
              it.id,
            )
            done++
          } catch {
            /* 单条失败不中断整批 */
          }
        }
        return {
          text:
            `♻️ 已恢复到「${want}」的状态：${done} 条改回原样` +
            (gone ? `，${gone} 条已被删除（跳过）` : '') +
            '\n（快照之后新增的条目没有动）',
        }
      }

      // ── create ──
      const now = Date.now()
      const since = Number(idx.lastAt) || 0
      const items = []
      for (const lv of LEVELS) {
        const rows = d
          .prepare(`SELECT * FROM ${lv} WHERE updated_at > ? OR created_at > ?`)
          .all(since, since)
        for (const r of rows) items.push({ ...r, level: lv })
      }
      if (items.length === 0 && since > 0) {
        return { text: '（上次固化之后没有任何改动，不用存）' }
      }
      const rawName = String(a.name ?? '').trim()
      const name =
        rawName ||
        new Date(now).toISOString().slice(0, 16).replace('T', ' ').replace(/[:]/g, '')
      if (idx.bakes.some((b) => b.name === name)) {
        return { text: `（已经有一个叫「${name}」的批次，换个名字）` }
      }
      const file = `bake-${now}-${idx.bakes.length + 1}.json`
      try {
        fs.mkdirSync(bakesDir, { recursive: true })
        fs.writeFileSync(
          path.join(bakesDir, file),
          JSON.stringify({ name, at: now, since, count: items.length, items }, null, 2),
          'utf8',
        )
      } catch (e) {
        return { text: `（快照写不进去：${e && e.message}）` }
      }
      idx.bakes.push({
        name,
        at: now,
        since,
        count: items.length,
        file,
        note: `自 ${since ? new Date(since).toISOString().slice(0, 10) : '最初'} 起`,
      })
      idx.lastAt = now
      if (!writeBakesIndex(idx)) return { text: '（快照写了，但索引写不进去）' }
      return {
        text:
          `📦 已固化「${name}」：${items.length} 条` +
          (since ? `（自上次固化以来的改动）` : '（第一次固化，收了全库）') +
          `\n位置：${path.join(bakesDir, file)}`,
      }
    },
    { isConcurrencySafe: () => false }
  )

  // 并禁用 dsh-core-memory，否则同名注册会失败。
  const toolsToRegister = [
    tSearch,
    tRead,
    tRemember,
    tProject,
    tUpdate,
    tForget,
    tRecent,
    tProjCore,
    tDream,
    tTimeline,
    tPlan,
    tConflict,
    tHealth,
    tExport,
    tImport,
    tCompact,
    tSource,
    tBake,
    tContext,
  ]
  if (coreTool === true) toolsToRegister.push(tCore)

  // ⚠️ 工具名冲突是这个插件最容易踩的坑：DSH 拒绝重名注册，而失败是**静默**的
  // （只抛异常，宿主不会拦启动）—— 表现就是「插件装上了但工具不见了」。
  // 所以这里把失败攒起来、结束时明确喊出来，并给两条解法。
  const failedTools = []
  for (const t of toolsToRegister) {
    try {
      if (toolPrefix) t.name = toolPrefix + t.name
      ctx.tools.register(t)
      log(`registered ${t.name}`)
    } catch (e) {
      const reason = String((e && e.message) || e)
      failedTools.push(`${t.name}（${reason}）`)
      log(`register ${t.name} FAILED: ${reason}`)
    }
  }
  if (failedTools.length > 0) {
    const warning =
      `[dsh-memory] ⚠️ ${failedTools.length} 个工具没注册成功，几乎都是名字被别的插件占了：\n  - ` +
      failedTools.join('\n  - ') +
      '\n  解法一：禁用占名的那个插件（它也注册同名 memory_*）；' +
      '\n  解法二：在本插件配置里设 toolPrefix（例如 "ext_"），工具就会叫 ext_memory_search。'
    log(warning)
    ctx.logger?.warn?.(warning)
  }
  log(`phonetic: ${hasPhonetic() ? 'on（拼音/首字母容错可用）' : 'off（没加载到拼音库，退化为纯字面检索）'}`)

  // ---------------- 注入钩子 ----------------

  /**
   * 落档写完 → 自己按冲水键压缩。
   *
   * 挂 turn-stopping 而不是 pre-step：压缩是重操作，在生成前阻塞会把整轮拖住；
   * 而「刚写完落档」那一刻通常正好是一个回合结束（写完→回一句→turn/end）。
   * dsh-auto-checkpoint 也是用这个钩子触发压缩的。
   */
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    // 📌 只是在没有 `run.agent` 时兜底（老版本 DSH / 别的进程）：工具的 execute 现在
    //    能收到 DSH 的 ToolRunContext，`run.agent` 就是「谁调的这次工具」，不用猜。
    //    🛑 这里记的是**最后一个结束回合的 agent**，多窗口时跟调用者无关 ——
    //    2026-11-20 实测：另一个窗口按冲水键，压掉的是本窗口。别把兜底当主路。
    try {
      if (agent && agent.id) lastAgentSeen = { agent, at: Date.now() }
    } catch { /* 存不下不影响压缩 */ }
    if (!autoCompactAfterPrecompact) return
    try {
      if (!agent || !agent.session) return
      // ① 水位：没到 remindTokens 不打扰
      let pressure = null
      try {
        const m = ctx.tokenMeter?.measure?.(agent.session)
        const n = Number(m?.totalTokens)
        if (Number.isFinite(n) && n > 0) pressure = n
      } catch { /* 量不到就不压 */ }
      if (pressure === null || pressure < readRemindTokens()) return

      // ② 落档刚写完 + ③ 有结论节
      // 先看冷却：刚压过就别再压。这一步必须**在找落档之前**，
      // 因为它防的正是「重写落档改了 mtime、绕过下面那条同文件保护」。
      if (Date.now() - lastCompactDoneAt < compactCooldownMs) return
      const found = findLatestPrecompact(workspace, agent.session && agent.session.id)
      if (found === null) return
      if (found.mtime === lastCompactedPrecompactMtime) return
      if (Date.now() - found.mtime > precompactJustWrittenMs) return
      if (!hasConclusionSection(found.path)) return

      // ④ 触发压缩
      // ⚠️ 不能在 turn-stopping 里直接调 —— turn-stopping 是回合**收尾中**触发的，
      //    那时 agent 还没转 idle；而 `compactNow` 内部第一件事是 `agent.runMaintenance`，
      //    它在 agent 非 idle 时**同步抛** `agent "…" already has active work`。
      //    等自己 idle 又不能写在 turn-stopping 里（会死锁），所以这里 fire-and-forget：
      //    开一个后台任务，等 idle 了再压。失败只记日志。
      //
      // 🛑 2026-11-25：不再走 `commands.execute('/compact')`（用户要求别依赖那条临时路）。
      //    直接调 `ctx.compaction.compactNow()` —— `/compact` 命令只是它的一行包装。
      const compaction = ctx.get('compaction')
      if (!compaction || typeof compaction.compactNow !== 'function') {
        log('auto-compact skipped: compaction 服务拿不到（宿主没加载压缩实现）')
        return
      }
      lastCompactedPrecompactMtime = found.mtime
      const fileName = found.name
      void (async () => {
        try {
          // 等 agent 空闲（它可能还在这轮收尾）
          if (typeof agent.whenIdle === 'function') await agent.whenIdle()
          // 再等一拍，让宿主的 phase 真正切到 idle（差几毫秒都会撞 busy）
          await new Promise((r) => setTimeout(r, 500))
          // 冷却从「按下冲水键」这一刻算起，不是从「压完」算。
          // 理由：实测 02:46:55 START 之后，那条调用 59 秒才回来且报 error，
          // 日志里**没有 DONE** —— 但上下文确实被压了。等 DONE 才起冷却会漏掉这种情况。
          lastCompactDoneAt = Date.now()
          log(`auto-compact START: pressure=${pressure} file=${fileName}`)
          const r = await compaction.compactNow(agent, new AbortController().signal)
          if (r === null) {
            lastCompactedPrecompactMtime = -1 // 允许下次再试
            log('auto-compact: 没压（没有可安全折掉的历史）')
          } else {
            log(
              `auto-compact DONE: 折掉 ${r.shadowedSeqs.length} 条` +
                ` ~${r.shadowedTokenCount} tokens`,
            )
            // 🛑 2026-11-27 用户要求：「压完立刻自己发一条再开一轮，别等我先说话。」
            //    原来接棒只在 pre-step 里发 —— 那要求"这个会话下一轮得有输入"，
            //    用户压完切到别的窗口，这条就永远发不出去
            //    （实测：游戏开发会话 05:30:47 压完，四十多分钟没动静）。
            //    压缩一成功就 followup，用户不用动；账本先记上，免得下一轮 pre-step 再发一遍。
            try {
              const sid = (agent.session && agent.session.id) || agent.id
              const endInfo = lastCompactionEnd(agent.session)
              if (sid && endInfo) {
                const body = buildInjectionBody(getDb(), { maxChars: config.firstTurnMaxChars })
                const rePayload = buildReanchorPayload({ workspace, sessionId: sid, body })
                if (rePayload.hasBody) {
                  markSeen(workspace, sid, 'compactions', [endInfo.id])
                  agent.followup(reanchorMessage(rePayload.full))
                  log(
                    `re-anchor 压缩成功后立刻 followup: ${rePayload.full.length} chars, ` +
                      `note=${rePayload.noteAbs} (${rePayload.noteFound ? 'found' : 'missing'}) ` +
                      `conclusion=${rePayload.noteConclusionChars || '无🔑节'}`,
                  )
                }
              }
            } catch (e) {
              log(`re-anchor 立刻 followup 失败：${e && e.message}（下一轮 pre-step 会补）`)
            }
          }
        } catch (e) {
          lastCompactedPrecompactMtime = -1
          const code = e && e.code ? ` [${e.code}]` : ''
          log(`auto-compact FAILED${code}: ${e && e.message}`)
        }
      })()
    } catch (e) {
      log(`auto-compact error: ${e && e.message}`)
    }
  })

  /**
   * 域推断的数据源：**所有**工具调用（含别的插件和内置工具）。
   *
   * 为什么要挂会话事件而不是在自己的工具里记：dsh-memory 的工具全叫 `memory_*`，
   * 而域推断要跳过的恰恰是它们 —— 只在自己的 execute 里记，等于一条都记不到。
   * 真正有信息量的是 `ops_bash` 跑的是什么命令、`read`/`write` 碰的什么文件。
   *
   * `session/event`（`dsh-session/src/index.ts:79`）在每条会话日志 append 之后触发，
   * `event` 就是记下来的那条，`tool/call` 的形状是
   * `{ turn, step, callId, name, arguments }`（`dsh-session/src/types.ts:369`）。
   * 拿到就存，pre-step 时按会话取走（见 takeDomainToolText）。
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = session && session.id
      // 🔑 压缩落盘 = 接棒信号（见 pendingCompaction 那段注释：文本判据两版都空转过）。
      if (event.type === 'compaction/end') {
        // 只是**观察日志**，不在这里记账：压缩完成后插件会整个重载，内存里的记账活不到下一轮。
        // 真正的判据是 pre-step 里 `lastCompactionEnd(agent.session)` 从事件流倒扫。
        const data = event.data || {}
        log(
          data.error
            ? `压缩落盘但失败：id=${String(data.compactionId || '').slice(0, 8)} ` +
                `err=${String(data.error).slice(0, 80)}（不触发接棒）`
            : `压缩落盘：compaction/end sid=${String(sid || '').slice(-12)} ` +
                `id=${String(data.compactionId || '').slice(0, 8)}`,
        )
        return
      }
      if (event.type !== 'tool/call') return
      recordToolForDomain(sid, event.name, event.arguments, event.turn)
    } catch {
      /* 记不下不影响会话本身 */
    }
  })

  ctx.on('agent/pre-step', async (payload, proceed) => {
    const decision = await proceed()
    const { step, turn, messages, agent } = payload || {}
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const d = getDb()
      if (!d) return decision

      // 🛑 2026-11-18 复核：原注释说「waterfall 参数里没有 agent」——那是旧版本的结论。
      //    实测证据（debug.log 2026-11-14）：
      //      payload diag: keys=messages,turn,step,signal,modelSelection,agent  agent=YES
      //    ⇒ agent 一直在 payload 里。能拿到就用真 sessionId，拿不到再退回 'global'。
      let sid = ''
      try {
        sid = (agent && (agent.id || (agent.session && agent.session.id))) || ''
      } catch {
        sid = ''
      }
      const sessionId = sid || 'global'

      // ── 给这个会话补「子智能体可选哪些模型」的授权 ───────────────────
      // 背景（2026-11-27）：DSH 只在**全新顶层会话**创建时（`firstLiveSeq === 0`）自动写
      // `subagent/model-selection-policy`，老会话永远没有 ⇒ 选不了别家模型当子智能体。
      //
      // 🛑 只能用 `agent.session.append()` 补，**绝不能手工改会话文件**：
      //    v4 校验要求 `event.seq === index`（dense，见
      //    `dsh-session-format-v3-to-v4/src/validation.ts:64`）。外部插一条会让它后面
      //    所有事件下标错位一位，重启加载直接
      //    `SessionFormatError: format v4 event N is not dense`，会话打不开。
      //    2026-11-27 实测踩到过：靠只摘掉文件尾部那一帧才救回来（130MB 前段一个字节没动）。
      //
      // 走 append 则 seq 由 DSH 自己按 log.length 算，内存与文件同步，永远不会错位。
      // 配置里没给 `subagentAllowedModels` 就完全不做 —— 这个插件不该替别的部署决定这事。
      if (sid && !subagentPolicyScanned.has(sid)) {
        try {
          const wantRoutes = Array.isArray(config.subagentAllowedModels)
            ? config.subagentAllowedModels.filter(
                (r) => r && typeof r.provider === 'string' && typeof r.model === 'string',
              )
            : []
          const sess = agent && agent.session
          if (wantRoutes.length > 0 && sess && typeof sess.append === 'function') {
            const hasPolicy =
              Array.isArray(sess.log) &&
              sess.log.some((e) => e && e.type === 'subagent/model-selection-policy')
            if (!hasPolicy) {
              sess.append('subagent/model-selection-policy', { allowedModels: wantRoutes })
              log(
                `已补子智能体模型授权 session=${String(sid).slice(-12)}：` +
                  wantRoutes.map((r) => `${r.provider}/${r.model}`).join(', '),
              )
            }
          }
          // 扫过一次就记住，别每轮都去扫几万条事件
          subagentPolicyScanned.add(sid)
        } catch (e) {
          // 不加进 Set：下轮再试（append 可能因为会话正在提交而失败）
          log(`补子智能体授权失败 session=${String(sid).slice(-12)}：${e && e.message}`)
        }
      }

      // 🛑 先登记窗口，再判文本。
      //    原因：用户经常**只发图不说话**，那种回合 text 为空、下面立刻 return，
      //    结果面板的下拉里永远看不到这个窗口（实测踩到）。
      if (sid) {
        try {
          touchSession(sid)
        } catch {}
      }

      const text = lastUserText(decision.messages) || lastUserText(messages)
      if (!text) return decision
      // 🛑 2026-11-20：这里**不能**取走销账，只能读计数。
      //    销账是域推断的事，而域推断有「至少 4 个字」的闸 —— 把 take 放在闸外面，
      //    用户回一个「1」「嗯」这种短消息时，上一轮的工具记录就被白白吃掉了，
      //    等下一轮真正要推断时反而什么都没剩（实测：用户发「1」，记录白丢一次）。
      //    所以：域推断分支里 take（用完销），反思催办这里只 peek（只读不销）。
      const lastToolCount = peekDomainToolCount(sid, turn)
      // 📎 记下"这一轮在说什么" —— memory_remember 没传 context 时用它自动补一条。
      //    为什么在这里记：pre-step 是唯一同时拿得到 sessionId 和原始消息的地方，
      //    而工具调用紧跟在它之后，同一个进程内存里取最近那次就够准。
      lastTurnCtx = { sessionId, text, at: Date.now(), turn: Number.isFinite(turn) ? turn : 0 }
      // 🛑 2026-11-19：**插件自己在说话的回合，不要拿它去检索记忆。**
      //    来源有两种：auto-checkpoint 注入的催办/压缩告知、dsh-memory 自己的 followup。
      //    为什么必须挡（真机证据：两条事件只隔 5 毫秒）：
      //      催办文案里有固定开头 `[auto-checkpoint] 上下文即将压缩`，而 core 层那条
      //      「落档催办必须立刻停手写」原则的正文里**原样引用了同一串字** ⇒ 关键词命中它自己
      //      ⇒ 同一次 pre-step 里又叠一条 `⟪触及原则⟫`，界面上看起来就是
      //      「压缩完了又催了一次压缩」。已复现两次（11-19 02:47 与 04:37）。
      //    连带好处：注入块不再被当成用户消息二次检索（自喂循环）。
      const headText = text.trimStart()
      // 「插件自己在说话」的判据：老前缀（历史消息）+ 自己的新前缀 + ⟪⟫ 包裹的注入。
      const isAutoInjected =
        headText.startsWith('[auto-checkpoint]') ||
        headText.startsWith('[dsh-memory]') ||
        headText.startsWith('⟪')
      // 压缩真的发生后的**第一轮**：这一轮的任务是读落档、把状态接回来，
      // 记忆命中 / 原则提醒 / 7 轮催办全是噪音，而且催办会紧贴着压缩完成弹出来。
      //
      // 🛑 2026-11-19 审计后加固（P0）：**光看文本前缀不够**。
      //    前缀是"用户也能打出来的东西" —— 他把催办原文整段粘回来问「这句什么意思」，
      //    就会连锁触发清空注入记录 + 重灌 16000 字符 + 推进反思锚点（代价不对称：
      //    误判一次不是"亏一轮检索"，是把压缩那条链路整个走一遍）。
      //    ⇒ 再加一道**伪造不了的硬证据**：上下文水位比上一轮骤降。
      //    压缩必然让水位大幅回落（实测能掉七八成），而贴一段文字不会
      //    改变 token 量级。真压缩 + 文本告知都对上才算。
      let pressureNow = null
      try {
        const m = ctx.tokenMeter?.measure?.(agent?.session)
        const n = Number(m?.totalTokens)
        if (Number.isFinite(n) && n > 0) pressureNow = n
      } catch { /* 量不到就只认文本（退回宽松侧，但不做重灌） */ }
      const prevPressure = lastPressureOf(sessionId)
      if (pressureNow !== null) lastPressureSeen.set(sessionId, pressureNow)
      // 掉 40% 以上才算"压缩过"。留这么大余量是因为压缩后模型自己还会立刻往下写，
      // 等 pre-step 跑到时水位已经涨了一截。
      const shrank = prevPressure !== null && pressureNow !== null
        ? pressureNow < prevPressure * 0.6
        : false
      // 🛑 2026-11-25 第三次修：判据改成**扫 messages 里的压缩摘要消息**。
      //
      //    原来为什么恒为 false（三个判据同时死）：
      //      ① `source.kind === 'compact-checkpoint'` —— 当前 DSH 版本产的那条消息
      //         **没有 source 字段**（存档 seq 87615 实测）
      //      ② 文本前缀只认 `[auto-checkpoint]` / `[dsh-memory]` —— 当前格式是
      //         `This is an automatically generated checkpoint condensing…`
      //      ③ 而 headText 取的是**最后一条用户消息**（压缩后就是他的新提问），
      //         就算有人往摘要上补前缀，也永远碰不到它
      //    ⇒ 依赖 isCompactionTurn 的三件事全是死代码：
      //        清空项目核心注入记录 / 压缩后重注入（含**落档路径**）/ 推进反思锚点
      //    ⇒ 用户看到的就是「压完闷头继续」+「落档路径也没给，还得我自己手动发」。
      // 🔑 判据：从**会话事件流**读「最后一次成功压缩」，再和持久账本比 —— 插件重载也成立。
      //    账本里已经有这个 id = 这一轮压缩的接棒已经做过了，别重复（否则每轮都当"刚压缩过"：
      //    反思锚点被每轮重置 = 催办永久失效，项目核心也会每轮重灌）。
      const cmpEnd = lastCompactionEnd(agent && agent.session)
      // 🛑 判据：**事件顺序为主、时间兜底**（见 compaction-detect.js 的 isCompactionFresh）。
      //    · 压缩之后还没回答过 ⇒ 接棒这一轮还没跑 ⇒ 该做
      //    · 已经回答过 ⇒ 只有 10 分钟内压的才兜底认一次
      //    用户 2026-11-27 点破的正是纯墙钟的漏洞：高强度工作一小时压两三次，
      //    光看"2 小时内"会把上一轮的历史压缩也认成刚压过。
      const cmpFresh = isCompactionFresh(cmpEnd)
      if (cmpEnd !== null && !cmpFresh) {
        const ageMin = Math.round((Date.now() - cmpEnd.timeMs) / 60000)
        log(
          `压缩判据：最后一条 compaction/end（${String(cmpEnd.id).slice(0, 8)}）是 ${ageMin} 分钟前的，` +
            `且它之后已经跑过一轮 ⇒ 不当成"刚压缩过"`,
        )
      }
      const evCompactionId =
        cmpFresh && !readSeen(workspace, sessionId).compactions.includes(cmpEnd.id) ? cmpEnd.id : ''
      const compactionMsg = findCompactionMessage(decision.messages)
      const hasNativeSignal = Boolean(
        compactionMsg && compactionMsg.source && compactionMsg.source.kind === 'compact-checkpoint'
      )
      const textSignal = Boolean(compactionMsg) && !hasNativeSignal
      if (evCompactionId) {
        log(
          `压缩判据：compaction/end 事件 id=${String(evCompactionId).slice(0, 8)}，` +
            `水位 ${prevPressure ?? '?'} → ${pressureNow ?? '?'}`,
        )
      } else if (compactionMsg) {
        log(
          `压缩判据：命中${hasNativeSignal ? '原生标记' : '摘要文本'}，` +
            `水位 ${prevPressure ?? '?'} → ${pressureNow ?? '?'}`,
        )
      }
      // 原生标记是宿主给的，伪造不了 ⇒ 直接采信。
      // 纯文本判据（摘要开头）用户理论上能粘贴 ⇒ 再要一道水位骤降作证；
      // 水位未知（插件刚重载、Map 是空的）时放行 —— 那种情况下宁可多灌一次，也不要漏掉接棒。
      const isCompactionTurn =
        Boolean(evCompactionId) ||
        hasNativeSignal ||
        (textSignal && (shrank || prevPressure === null))
      if (textSignal && !isCompactionTurn) {
        log(
          `压缩判据：messages 里有压缩摘要但水位没降（${prevPressure ?? '?'} → ${pressureNow ?? '?'}），` +
            `当成用户粘贴，不清注入、不重灌`,
        )
      }
      // 🔄 上下文**压缩之后**：把"项目核心已注入"的记录清空。
      //    压缩会把前面的对话换成摘要，项目核心原文就不在上下文里了；
      //    可 lastInjected 还记着"注入过"，节流会让它永远不再带出来
      //    ⇒ 压缩一次，这个项目的核心就永久失效。
      //    🛑 2026-11-18 审计修：判据必须是**压缩真的发生了**（messages 里出现
      //    compact-checkpoint 类型的消息），不是 auto-checkpoint 那条"即将压缩"的催办。
      //    原来用催办文案判断 ⇒ 在压缩**之前**就把记录清空，同一 step 里
      //    buildProjectCoreSection 又把项目核心全灌一遍并填回 lastInjected，
      //    而灌进去的内容随压缩一起被折进摘要 ⇒ 压缩后 lastInjected 仍是满的，
      //    原来那个 bug 一点没修好，还白白多灌一份。
      try {
        // 🛑 2026-11-19 审计修（P0）：判据换成 `isCompactionTurn`（文本 + 水位骤降）。
        //    只用 `findCompactionId`（纯文本）的话，用户把压缩告知粘回来也会清空注入记录。
        const cid = isCompactionTurn
          ? (evCompactionId || findCompactionId(decision.messages) || `compact-at-${Date.now()}`)
          : ''
        if (cid && lastCompactionReset.get(sessionId) !== cid) {
          lastCompactionReset.set(sessionId, cid)
          resetInjected(sessionId)
          log(`project-core: 压缩 ${String(cid).slice(0, 8)} 已发生，清空"已注入"，本步重新带出`)
        }
      } catch (e) {
        log(`project-core: resetInjected 失败 ${e && e.message}`)
      }
      // ⚠️ 不能用「messages 里有几条用户消息」判断首轮 —— pre-step 收到的 messages
      //    只是本步新认领的那一条，永远 =1，会让每条消息都走首轮分支、每轮注入
      //    8000 多字符。真正的首轮信号是 turn（每条新消息 turn+1）。
      // 真正的首轮信号是 turn（每条新消息 turn+1）。turn 的起始值是 0 还是 1 不确定，
      // 所以两个都认；turn 为 undefined 时**不**当首轮（宁可漏注入一次，也不能每轮灌 8000 字符）。
      const isFirstTurn = step === 1 && (turn === 1 || turn === 0)
      log(
        `pre-step: turn=${turn} step=${step} textLen=${text.length} ` +
          `session=${String(sessionId).slice(-12)} agent=${sid ? 'YES' : 'NO'} firstTurn=${isFirstTurn}`
      )

      // 首轮：不检索，结构化搬
      // ⚠️ 这段必须在**首轮分支之前**：首轮分支会直接 return，
      //    放在它后面等于「新会话的第一句话永远不被捕获」——
      //    放在后面，新会话的第一句话就永远捕获不到。
      // ── 自动捕获明确偏好（轮次闸，不按时间）────────
      // 放在反思之前：先自己抓一遍，抓到了就不用提醒。
      // 注意 currentProject 这个变量在 pre-step 里**不存在**（它只是 buildHitInjection 的参数名），
      // 所以 project 直接给 '全局'。
      if (enableAutoCapture && !isAutoInjected) {
        try {
          const ruleName = matchAutoCapture(text)
          // 第二档（信号评分估出来的）和第一档（命中固定句式）要区别对待：
          // 估出来的标「待确认」+ 重要性 1，别和"已确认的偏好"混在一起。
          const guessed = !!ruleName && ruleName.startsWith('陈述·')
          if (ruleName && autoCaptureAllowed(sessionId, turn, text)) {
            const near = findNearDuplicate(d, { title: '', content: text, keywords: [] }, dedupeJaccard)
            if (near.duplicate === null) {
              // 🛑 2026-11-19 审计修（P0）：**绝不能落 core**。
              //    core 是每个会话都常驻注入的（inject.js 的「关于用户」「原则与禁令」段），
              //    而这里写进去的是**原始消息截 200 字**、未提炼、无敏感词过滤 ——
              //    只要某句话说「别把 token 贴出来」命中「禁令」，那句原文就变成全库常驻，
              //    跟着进以后每一个会话、每一个项目。自动抓的东西只配进 detail（可检索、不常驻）。
              //    提炼成祈使句再进 core 是 memory_remember 的活，不是自动捕获的活。
              //
              //    另外：七层时代这里写的是 `user` 层（`INSERT INTO user`），四层的库没有这张表，
              //    一直抛 no such table 被 catch 吞掉，功能整个是死的。
              const capLayer = 'detail'
              const capCat = 'fact'
              if (SECRET_RE.test(text)) {
                log(`auto-capture skip (含敏感字样，不落库): ${text.slice(0, 40)}…`)
              } else {
                const cid = 'mem-' + randomUUID().slice(0, 18)
                const capBody = text.length > 200 ? text.slice(0, 200) + '…' : text
                const plan = insertPlan(
                  {
                    // title 不能空：空了注入和列表里都是裸正文，看不出这条是哪种规矩
                    // 第二档（规则名带 `陈述·` 前缀）是估出来的 → 标「待确认」、importance 1，
                    // 方便日后一眼看出哪些是机器猜的、哪些是他明说的。
                    title: guessed
                      ? `（自动·待确认）${capBody.slice(0, 20)}`
                      : `（自动捕获·${ruleName}）${capBody.slice(0, 20)}`,
                    content: capBody,
                    importance: guessed ? 1 : 2,
                    // 关键字不能空：findTouchedCore 靠它匹配，空了就只能吃 DANGER_HINTS 兜底
                    keywords: tokenize(capBody).slice(0, 6),
                    category: capCat,
                    project: '全局',
                    // 记下是谁写的，本会话下一轮就不会把自己刚说的话回注给自己
                    sourceSession: sessionId,
                  },
                  capLayer,
                  cid,
                  capBody,
                  Date.now()
                )
                d.prepare(`INSERT INTO ${capLayer} (${plan.cols.join(',')}) VALUES (${plan.cols.map(() => '?').join(',')})`).run(...plan.vals)
                lastMemoryWriteAt = Date.now()
                noteMemoryWriteForCurrentSession()
                const st = capStateOf(sessionId)
                st.lastTurn = Number.isFinite(turn) ? turn : 0
                st.count += 1
                st.seen.add(text.slice(0, 80))
                log(`auto-capture(${ruleName}/${capCat}) turn=${turn}: ${capBody.slice(0, 36)}… -> ${cid}`)
              }
            } else {
              log(`auto-capture skip (near dup of ${near.duplicate.doc.id})`)
            }
          }
        } catch (e) {
          log(`auto-capture failed: ${e && e.message}`)
        }
      }

      // ── 项目核心（2026-11-18 并入）────────────────────────
      // 按关键词实时判断"当前活跃项目"，把该项目的专属规则注入进来。
      // 节流在 project-core.js 里（只注入新进来的项目）。
      //
      // 🛑 2026-11-18 审计修：extras 提到这里声明。
      //    原来项目核心命中就 `return`，同一 step 里后面三段（关键词命中 /
      //    压缩后重注入 / 反思催办）全都轮不到。压缩后重注入尤其致命 ——
      //    compact-checkpoint 那条消息只出现一次，被吃掉就永久丢了。
      const extras = []
      // 🛑 走 `agent.followup()` 投递的段不在这里 —— 那是**投递**不是注入，
      //    不能混进 decision.messages（会让模型收到两遍）。但模型确实收到了，
      //    所以 memory_context 也得能看见它们。两条路在最后统一记快照时合并。
      const sideDelivered = []
      let projSection = ''
      try {
        // 🛑 2026-11-19 审计修（P1）：自动注入的消息不该拿来匹配项目。
        //    用压缩文案去匹配，命中会是含"压缩/记忆/检查点"这类词的项目名，
        //    而不是压缩前真正在干的那个 —— 重灌出来的项目核心是错的。
        //    首轮例外：首轮的 force 分支要按工作区把项目带出来，与这句话无关。
        if (isFirstTurn || !isAutoInjected) {
          projSection = buildProjectCoreSection(text, { force: isFirstTurn, sessionId, turn, step })
        }
      } catch (e) {
        log(`project-core failed: ${e && e.message}`)
      }

      // ── 方案意图 → 自动建草稿（2026-11-19 加）────────────────
      // 手记方案这件事很容易漏：聊天里随口提到"要不做个 X"，等想起来要记已经过去好几轮，
      // 细节全丢了。⇒ 由这里认出句式并**先存一份草稿**，不依赖"记得说一句记一下"。
      // 为什么不直接建一份"完整"的方案：这类句子里往往只有意图、没有步骤，
      // 编出来的步骤一定是假的。草稿 + 待确认，比一份看似完整的错清单好。
      if (!isAutoInjected) {
        try {
          const planKind = matchPlanIntent(text)
          // 🛑 2026-11-19 审计修（P0）：这里**不能**复用 `autoCaptureAllowed()`。
          //    它管的是「抓偏好」的配额（每会话 12 条上限、间隔 ≥2 轮、seen 去重），
          //    而自动捕获在同一轮里**先跑先记账**（更新了 st.lastTurn / st.count / st.seen）——
          //    于是方案这一段永远拿到 false，草稿一条都建不出来。实测三句全中，且**静默**。
          //    方案草稿只需要「同一句不要重复建」这一件事。
          const planAlready = capStateOf(sessionId).seen.has(String(text).slice(0, 80))
          if (planKind && !planAlready) {
            if (SECRET_RE.test(text)) {
              log('plan-draft skip (含敏感字样，不落库)')
            } else {
              const draftTitle = `（草稿·待确认）${text.replace(/\s+/g, ' ').trim().slice(0, 30)}`
              let exists = null
              try {
                exists = d
                  .prepare(`SELECT id FROM branch WHERE category = 'plan' AND title = ? AND status = 'active'`)
                  .get(draftTitle)
              } catch { /* 表结构异常就不去重，宁可多建一条也不能漏 */ }
              if (exists) {
                log(`plan-draft skip (已有同名草稿 ${String(exists.id).slice(0, 10)})`)
              } else {
                // 🛑 2026-11-19 审计修（P1）：只按标题精确匹配去重太松 ——
                //    措辞差一个字就是新的一条（「再跑测试」vs「再跑一轮测试」）。
                //    这里拿 Jaccard 在**已有 plan 内部**比一遍（不跨层：跨层会撞上
                //    自动捕获刚存的那句原文，那正是我们要绕开的）。
                let nearPlan = null
                try {
                  const mine = new Set(tokenize(text))
                  for (const r of d
                    .prepare(`SELECT id, title, content FROM branch WHERE category = 'plan' AND status = 'active'`)
                    .all()) {
                    const other = new Set(tokenize(`${r.title} ${r.content}`))
                    if (jaccardOf(mine, other) >= 0.6) { nearPlan = r; break }
                  }
                } catch { /* 比不了就直接建，宁可多一条也不要漏 */ }
                if (nearPlan) {
                  log(`plan-draft skip (与已有方案 ${String(nearPlan.id).slice(0, 10)} 高度重合)`)
                } else {
                const cid = 'mem-' + randomUUID().slice(0, 18)
                const body =
                  `# ${draftTitle}\n\n` +
                  `## 原始说法（${planKind}）\n${text.slice(0, 400)}\n\n` +
                  '## 步骤\n- [ ] （待补：这份方案具体分几步）\n\n' +
                  '## 验收\n- [ ] \n'
                const plan = insertPlan(
                  {
                    title: draftTitle,
                    content: body,
                    importance: 2,
                    keywords: tokenize(text).slice(0, 6),
                    category: 'plan',
                    project: '全局',
                    sourceSession: sessionId,
                  },
                  'branch',
                  cid,
                  body,
                  Date.now()
                )
                d.prepare(`INSERT INTO branch (${plan.cols.join(',')}) VALUES (${plan.cols.map(() => '?').join(',')})`).run(...plan.vals)
                lastMemoryWriteAt = Date.now()
                noteMemoryWriteForCurrentSession()
                log(`plan-draft(${planKind}) turn=${turn}: ${draftTitle.slice(0, 24)}… -> ${cid}`)
                extras.push(
                  snapshotMessage(
                    `📋 我按你刚才那句话自动建了一份**草稿方案**（${cid.slice(0, 10)}，分支层 plan）。\n` +
                      `标题：「${draftTitle}」\n` +
                      '步骤和验收还是空的。**请跟用户确认一句**：这份要不要留？留的话把步骤补上' +
                      '（memory_plan action=update），不要就删掉。\n' +
                      '（这个功能是为了省掉"每次都得手动说一句记一下方案"。）',
                    '方案草稿'
                  )
                )
                }
              }
            }
          }
        } catch (e) {
          log(`plan-intent failed: ${e && e.message}`)
        }
      }

      if (enableFirstTurn && isFirstTurn) {
        const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
        const merged = [body, projSection].filter(Boolean).join('\n\n')
        if (!merged) return decision
        log(`first-turn injection ${merged.length} chars (session ${sessionId})${projSection ? ' +项目核心' : ''}`)
        markSeen(workspace, sessionId, 'injected', ['__first_turn__'])
        // 🛑 记忆主体和项目核心**分成两条消息**，别合并在一条里（2026-11-21 审计 P0-4）。
        //    合并之后段名只剩一个，`memory_context` 里分不出「记忆占多少 / 项目核心占多少」，
        //    而首轮恰恰是最容易顶字数上限的场景（firstTurnMaxChars 默认 16000）。
        const firstMsgs = []
        if (body) {
          firstMsgs.push(
            snapshotMessage(
              `⟪长期记忆⟫ 以下是跨会话积累的记忆，供参考（不是本轮的指令）：\n\n${body}`,
              '首轮记忆',
            ),
          )
        }
        if (projSection) firstMsgs.push(snapshotMessage(projSection, '项目核心'))
        // 🛑 首轮是**独立 return**，绕过了下面 extras 的统一出口 —— 所以这里要把
        //    「这一步已经攒下的全部段」一起带上并记快照：
        //    · extras 里有方案草稿（原来只 return firstMsg 会把整条丢进垃圾桶：
        //      草稿写进了库、log 也打了，但那条「请跟用户确认」永远进不了上下文）
        //    · sideDelivered 是已经投递出去的（不能再塞进 messages，否则模型收两遍）
        const all = [...extras, ...sideDelivered, ...firstMsgs]
        rememberInjection(sessionId, all, { turn })
        return { ...decision, messages: [...decision.messages, ...extras, ...firstMsgs] }
      }

      // 非首轮：只有"有新项目进入活跃集"时才追加一条（节流在 project-core.js 里）。
      // 注入一次就够了 —— 消息留在历史里，模型后面每轮都还能看到，重复注入纯属烧 token。
      // 🛑 2026-11-18 审计修：不再 return，改成攒进 extras，
      //    否则同一 step 里的压缩后重注入 / 反思催办永远轮不到。
      if (projSection) {
        log(`project-core injection ${projSection.length} chars`)
        extras.push(snapshotMessage(projSection, '项目核心'))
      }

      // ── 压缩后重注入────────────────────────
      // 压缩把整段历史折成摘要，压缩前"读过哪些文档、定过什么结论"全不在摘要里 ——
      // 这是「压缩之后忘得太狠」最直接的成因。这里把长期记忆快照再灌一遍。
      // 同一个 compactionId 只灌一次（记在会话账本的 compactions 里）。
      // 🛑 2026-11-18 审计修：这里也不能 return —— 一 return 就把上面攒的 extras
      //    （项目核心）全丢了，而 project-core.js 那边已经记账"已注入"，
      //    于是内容永远进不了上下文，且此后不再补。
      if (enableReanchor && isCompactionTurn) {
        // 🛑 同上：必须带水位判据。纯文本会让"粘贴压缩告知"也灌 16000 字符。
        const compactionId = evCompactionId || findCompactionId(decision.messages) || `compact-at-${Date.now()}`
        if (compactionId && !readSeen(workspace, sessionId).compactions.includes(compactionId)) {
          const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
          // 文案统一由 buildReanchorPayload 生成 —— 和「压完立刻 followup」那条同源。
          // 🛑 分两处各写一份的结果一定是漂：改一处忘一处，用户看到的就是两个样。
          const rePayload = buildReanchorPayload({ workspace, sessionId, body })
          if (rePayload.hasBody) {
            const full = rePayload.full
            markSeen(workspace, sessionId, 'compactions', [compactionId])
            log(
              `re-anchor after compaction ${compactionId.slice(0, 8)}: ${full.length} chars, ` +
                `note=${rePayload.noteAbs} (${rePayload.noteFound ? 'found' : 'missing'}) ` +
                `conclusion=${rePayload.noteConclusionChars || '无🔑节'}`,
            )
            const reMsg = reanchorMessage(full)
            // 🛑 2026-11-27 用户纠正：「不是这样注入吧？是他自己自动发一条再开一轮，原来不都是这个样子的吗？」
            //    ⇒ 接棒词必须是**独立的一条消息 + 单独开一轮**（agent.followup），
            //      不能塞进用户这一轮的 messages 里：挤在一起模型会当成"本轮指令的一部分"，
            //      界面上也看不到"AI 自己开一轮去读落档"。
            let reDelivered = false
            if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
              try {
                agent.followup(reMsg)
                reDelivered = true
                sideDelivered.push(reMsg)
                log(`re-anchor followup delivered: turn=${turn}（单独开一轮去读落档）`)
              } catch (e) {
                log(`re-anchor followup failed: ${e && e.message}，回退注入当前回合`)
              }
            }
            if (!reDelivered) {
              extras.push(reMsg)
              log(`re-anchor 回退注入：turn=${turn}`)
            }
          }
        }
      }

      // 从这里开始攒「本步要追加的注入」：命中与反思可以同时出现，
      // 所以不再像以前那样命中一有就 return（那样反思永远轮不到）。
      // （extras 数组在上面「项目核心」那段之前就声明了 —— 项目核心现在也攒进来。）

      // ── 落档催办（pre-step 预制发送，不占用户一次点击）────────
      // auto-checkpoint 自带的催办走 sessionController.prompt，
      // 那是「插入」语义、要他点确定，因此从没真正生效过。这里改成直接注入。
      //
      // 🛑 2026-11-19 审计修（P1）：轮次锚点必须按会话隔离 —— 和 autoCapture、
      //    反思催办是**同一个根因的第三处**（前两处已修，这处漏了）。
      //    全局锚点下，会话 A 检查到 turn=100 后，新会话 B 的 `1 - 100 >= 15` 恒 false
      //    ⇒ B 永远不检查落档，日志里只能看到 lastCheck=100。
      const rfState = reflectStateOf(sessionId)
      // 🛑 2026-11-25：这条日志**无条件**打，而且把开关值一起打出来。
      //    原来只有开关为 true 时才打 `precompact check` —— 结果是：
      //    如果哪天开关变 false（或代码被前置 return 掉），日志里一片空白，
      //    「催办为什么不出」完全查不出原因（11-17 之后就断在这里，八天没人发现）。
      log(`precompact gate: enabled=${enablePrecompactNudge} turn=${turn} sid=${String(sessionId).slice(-8)}`)
      if (enablePrecompactNudge) {
        // ⚠️ `pressure` 必须先声明再打日志。2026-11-25 踩过：把测水位的代码放在
        //    日志后面，日志里引用 `pressure` ⇒ TDZ（Cannot access before initialization）
        //    ⇒ 抛异常被外层大 try 吞掉 ⇒ 整个催办块每轮静默死掉，只在日志里留下
        //    一行 `precompact gate`（因为那行在它前面）。看着像"代码没跑"。
        let pressure = null
        try {
          const sess = payload && payload.agent && payload.agent.session
          if (sess) {
            const m = ctx.tokenMeter && ctx.tokenMeter.measure ? ctx.tokenMeter.measure(sess) : null
            const n = Number(m && m.totalTokens)
            if (Number.isFinite(n) && n > 0) pressure = n
          }
        } catch { /* 量不到就当没量 */ }

        // 诊断：水位 + 阈值都摊开。放在测量之后，避免 TDZ。
        log(`precompact check: turn=${turn} everyTurns=${precompactEveryTurns} ` +
          `lastCheck=${rfState.lastPrecompactTurn} pressure=${pressure === null ? 'null' : Math.round(pressure)} ` +
          `threshold=${readRemindTokens()}`)
        const how = pressure === null ? 'turns' : 'token'
        const t = Number.isFinite(turn) ? turn : 0
        const due = how === 'token'
          ? pressure >= readRemindTokens()
          : t - rfState.lastPrecompactTurn >= precompactEveryTurns

        if (how === 'token' || due) {
          // 诊断：只在第一次 print 一次 payload 形状（看 agent 到底有没有）
          if (!precompactDiagDone) {
            precompactDiagDone = true
            const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(',') : '(none)'
            // 详细诊断：agent 有了但 pressure 拿不到，要看是缺 session、
            // 缺 tokenMeter，还是 measure 不吃这个 session。
            const ag = payload && payload.agent
            const agKeys = ag && typeof ag === 'object' ? Object.keys(ag).slice(0, 18).join(',') : '(none)'
            const sessObj = ag && ag.session
            const sessKeys = sessObj && typeof sessObj === 'object' ? Object.keys(sessObj).slice(0, 12).join(',') : '(none)'
            const tm = ctx && ctx.tokenMeter
            const tmInfo = tm ? (typeof tm.measure === 'function' ? 'measure()' : 'no-measure') : 'NO-tokenMeter'
            log(
              `payload diag: keys=${keys} agentKeys=${agKeys} hasSession=${sessObj ? 'Y' : 'N'} ` +
                `sessKeys=${sessKeys} tokenMeter=${tmInfo} pressure=${pressure === null ? 'null' : pressure} judge=${how}`
            )
          }
        }

        if (due) {
          rfState.lastPrecompactTurn = t
          saveReflectState()
          // 同样要按会话找 —— 否则 A 刚写完落档，B 的检查会看到 A 的文件、
          // 判定"我的落档是新的"⇒ B 永远不催。
          const found = findLatestPrecompact(workspace, sessionId)
          const stale = found === null || Date.now() - found.mtime > precompactFreshMs
          const sameStale = stale && found !== null && found.mtime === lastPrecompactNudgedMtime
          if (stale && !sameStale) {
            lastPrecompactNudgedMtime = found === null ? -1 : found.mtime
            const nudgeText = precompactNudgeText(workspace, found, sessionId)
            // 跟反思提醒一样：**排一个独立回合**，不混进当前回合。
            // 写落档是件完整的事，被当前任务打断只会两边都做不好。
            let pcDelivered = false
            if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
              try {
                // ⚠️ 必须用 snapshotMessage 构造。原来这里手搓了一条，把 `sections` 的
                //    name/text 位置跟 snapshotMessage 反过来了（name 放段名、text 放正文），
                //    于是任何按 `sections[0].text` 取段名的代码都会拿到整段正文
                //    （2026-11-21 审计发现，memory_context 差点被它坑到）。
                const nudgeMsg = snapshotMessage(nudgeText, '落档催办')
                agent.followup(nudgeMsg)
                pcDelivered = true
                // followup 是投递不是注入，但模型确实收到了 —— 记进 sideDelivered，
                // 最后跟 extras 合并成一份快照，否则这一段在 memory_context 里永远看不到。
                sideDelivered.push(nudgeMsg)
              } catch (e) {
                log(`precompact followup failed: ${e && e.message}`)
              }
            }
            if (!pcDelivered) extras.push(snapshotMessage(nudgeText, '落档催办'))
            log(
              `precompact nudge: judge=${how}${pressure === null ? '' : ' pressure=' + pressure} ` +
                `file=${found ? found.name : '(none)'} via=${pcDelivered ? 'followup' : 'inject'}`
            )
          }
        }
      }

      // 🛑 2026-11-25：压缩后的第一轮**不检索**。
      //    这一轮唯一的任务是读落档、把状态接回来（重注入里已经给了落档路径）。
      //    再叠两条关键词命中 / 项目降权，等于在一张已经皱掉的纸上再盖两个章。
      if (enableHit && !isAutoInjected && !isCompactionTurn && text.trim().length >= 4) {
        const seen = readSeenSet(workspace, sessionId)
        // v4：先算「这一轮在干什么」，再让命中按域降权（判不出来就不降权）。
        // 🛑 2026-11-20：**默认不判**（`domainDownweight` 默认关）。
        //    域降权只有一个用途：命中之后把不同域的条目排后面。但它从没验证过准不准，
        //    判错时会把该出现的记忆压到 0.15 倍、静默消失还不报错 ——
        //    这个代价换一个没验证的排序微调，不划算。见 enableDomain 的注释。
        //
        //    关掉时**连 take 都不做**：销账本身只服务域推断；
        //    反思那边用 peekDomainToolCount 正常读计数，不受影响。
        let turnDomains = null
        if (enableDomain) {
          const toolText = takeDomainToolText(sid).text
          const dom = domainOfTurn(decision.messages, toolText)
          turnDomains = dom && dom.list
          log(
            `域推断: ${turnDomains ? turnDomains.map((x) => `${x.d}=${x.s}`).join(' / ') : '判不出来'}` +
              ` | 原始 ${dom?.debug?.raw?.join(',') || '无'} | toolCalls=${dom?.debug?.toolCalls ?? 0}` +
              ` toolChars=${toolText.length}`,
          )
        }
        const hits = buildHitInjection(d, {
          userText: text,
          sessionId,
          currentProject: null,
          hitTopK,
          seen,
          turnDomains,
          // v5（2026-11-20）：按项目降权。
          // 「当前窗口在干的活」权重 1.0；别的项目除非**它的核心被激活过**
          // （readInjected = state.json 里这个会话的 injected 列表），否则压到 projDownweight。
          activeProjects: readInjected(sessionId),
          // 🛑 只对这些项目降权：`projects.json` 里配了核心的项目，通常远少于
          //    记忆库里出现过的项目名（有的两边写法还不一样，简称 ↔ 全名，对不上）。
          //    不传这道闸，那些没配核心的项目会被永久压，它们根本没有主次可言。
          //    见 inject.js 的护栏④。
          knownProjects: Object.keys(readProjectConfig().projects || {}),
          projectDownweight: projDownweight,
          log,
        })
        if (hits.length > 0) {
          markSeen(workspace, sessionId, 'injected', hits.map((h) => h.id))
          // 🛑 2026-11-20：日志必须记 id —— 只记"2 条"的话，
          //    降权到底压掉了哪一条、压得对不对，事后完全无从判断。
          log(
            `hit injection: ${hits.length} 条 ` +
              hits.map((h) => `[${h.level}/${h.category}] ${String(h.id).slice(0, 12)}`).join(' '),
          )
          extras.push(snapshotMessage(formatHitInjection(hits), '关键词命中'))
        }

        // 触及核心层的原则/禁令时单独再拎一次。
        // 常驻注入容易被当背景板忽略，所以命中时带 ⚠️ 再提醒一遍。
        try {
          const touched = findTouchedCore(d, text, 2)
          if (touched.length > 0) {
            markSeen(workspace, sessionId, 'injected', touched.map((h) => h.id))
            log(`core touch: ${touched.length} 条 (${touched.map((h) => h.category).join(',')})`)
            extras.push(snapshotMessage(formatCoreTouch(touched), '触及核心'))
          }
        } catch (e) {
          log(`core touch error: ${e && e.message}`)
        }
      } else if (enableHit && isAutoInjected) {
        // 不静默跳过：这一条要是哪天误判了（真人说的话被当成自动消息），
        // 日志里得能立刻看出来，否则表现就是"记忆突然不注入了"。
        log(`hit skip: auto-injected message（插件自己的话不去检索记忆）`)
      } else if (enableHit) {
        log(`hit skip: too short (${text.trim().length} chars)`)
      }

      // ── 自动反思 ────────────────────────
      // 只在「真在干活」（本步带工具结果）且「确实很久没写记忆」时提醒一次。
      // 纯聊天、刚写过、冷却期内都不吭声 —— 提醒太勤会变成噪音。


        // ── 自动反思（按加权轮次，不按时间）────────
        // 🛑 2026-11-20 修一个**死了很久的逻辑**：
        //    原来这里是 `if (hasMemoryWriteCall(decision.messages)) rfState.lastWriteTurn = turn`，
        //    但 pre-step 跑在**模型生成之前** —— 本轮的工具还没执行，消息里不会有
        //    `memory_remember` 的调用记录 ⇒ 条件恒 false ⇒ `lastWriteTurn` 永远不更新。
        //    真机证据：state.json 里 lastWriteTurn 与 turn 相差 42，
        //    也就是"42 轮没写记忆"，可实际上这一天写了十几次。
        //    ⇒ 改用**时间戳**：`memory_remember` 执行时已经把 `lastMemoryWriteAt` 推到现在，
        //      那才是真信号（同一进程内的内存变量，pre-step 直接读得到）。
        // reflectIdleMs === 0 是"关掉时间判据"的硬开关（测试/调试用），
        // 此时也当成"没写过"，否则测试里拿不到可催的状态。
        //
        // 🛑 2026-11-23：`wroteRecently` **不再参与 turnDue 判据**。
        //    它读的 `lastMemoryWriteAt` 是全局变量，任何窗口写记忆都会刷新 ⇒
        //    多窗口时"我这边勤写"会把"隔壁该催"永久顶掉（用户报的真事：
        //    「他跟了我这么久，全程都在干活，一次都没主动记过」）。
        //    现在改成：**谁写谁清零自己的权重**（noteMemoryWriteForCurrentSession），
        //    别的会话照常攒、照常催。这里保留这个变量只给 timeDue 那条兼容路径用。
        const wroteRecently =
          reflectIdleMs === 0 ? false : Date.now() - lastMemoryWriteAt < 30 * 60_000

        // ⚠️ 原来这里是 hasToolResult(decision.messages)，
        // 但 pre-step 跑在**生成之前**，decision.messages 只是本步认领的用户消息，
        // 工具还没跑、不会有 tool-result ⇒ 那个条件**永远 false**，reflect 一次都没触发过
        // （跟 turn-stopping 在 abort 时不触发是同一类错误：在错误时机检查错误信号）。
        // 纯按轮次判断，7 轮一次不算频繁，误打扰的代价远小于「一直不记」。
        // 🛑 2026-11-19：压缩后的那一轮不催，并把两个锚点推到现在。
        //    理由：压缩已经把前面几十轮折成摘要，那些轮次里"没写记忆"的东西我现在
        //    根本看不到了，拿它当欠账去催没有意义；而实测（同一天）
        //    催办就紧贴在压缩完成之后弹出，观感是「刚压完又催我记东西」。
        if (enableReflect && isCompactionTurn) {
          const tt = Number.isFinite(turn) ? turn : 0
          // 🛑 2026-11-19 审计修（P1）：turn 缺失/为 0 时**绝不写**。
          //    写了 0 之后每轮都会算成 `turnsSinceWrite = t - 0`，动辄几百 ⇒ 每轮都催。
          if (tt > 0) {
            rfState.lastTurn = tt
            rfState.lastWriteTurn = tt
            saveReflectState()
            log(`reflect: 压缩后重置计数 turn=${tt}（本轮不催）`)
          }
        }
        if (enableReflect && !isAutoInjected) {
          const t = Number.isFinite(turn) ? turn : 0
          // 懒初始化：第一次进来把两个锚点都推到当前轮，否则 -999 会让
          // 「第一条消息就催记记忆」（turn 是会话累计值，动辄几百）。
          // 🛑 但要区分「新会话」和「老会话重启」：
          //    - 新会话 turn 很小 → 从当前轮开始数，别一上来就催
          //    - 老会话 turn 已经很大（几百）→ 说明是重启把内存锚点弄丢了，
          //      这时**不该**再等满 7 轮，直接认定"确实很久没记了"立刻可催。
          //      否则重启越多、越永远催不到（就是 11-19 那次实测到的 bug）。
          const wasFresh = rfState.lastTurn === -999
          const stale = t > reflectEveryTurns * 3
          if (wasFresh) rfState.lastTurn = stale ? t - reflectEveryTurns : t
          if (rfState.lastWriteTurn === -999) {
            rfState.lastWriteTurn = stale ? t - reflectEveryTurns : t
          }
          if (!Number.isFinite(rfState.weightSinceNudge)) rfState.weightSinceNudge = 0
          // v5（2026-11-20）：**进入时完全没有状态（wasFresh）+ turn 已经很大** ⇒ 这是
          // 「重启后进来的老会话」，计数器丢了，不该再等攒满 18 轮，直接推到阈值立刻可催。
          //
          // 🛑 判据必须是 `wasFresh`，不能只看 turn 大不大：
          //    刚催完立刻重启（state 里 lastTurn=905、turn=906）也是"老会话"，
          //    那种情况下连着催两次才是 bug。
          if (wasFresh && stale && rfState.weightSinceNudge === 0) {
            rfState.weightSinceNudge = reflectWeight
          }
          // 🛑 钳制：`state.json` 被写坏、或者从别处恢复了脏值，可能是个天文数字
          //    （比如 1e9）。那样第一轮就 `>= 阈值`、催一次、清零 —— 反而自我修复了；
          //    真正要防的是**负数或非整数**让累加永远追不上。这里统一收进 [0, 3×阈值]。
          if (rfState.weightSinceNudge < 0) rfState.weightSinceNudge = 0
          if (rfState.weightSinceNudge > reflectWeight * 3) rfState.weightSinceNudge = reflectWeight
          // 加权轮次：数"上一轮干了多少事"，不是"说了几句话"。
          // 工具调用 0 个 +1（纯聊天）、1~5 个 +2、6 个以上 +3（重活）。
          // 攒到 reflectWeight（默认 18）就催一次并清零。
          // 🛑 这个数来自**工具执行时自己记的**（`peekDomainToolCount`，只读不销账）；
          //    以前数 assistant 消息里的 tool-call 块，而 pre-step 的 messages 是
          //    UserMessage[]、一条 assistant 都没有 ⇒ 永远 0 ⇒ 退化成"每轮固定 +1"。
          const toolCalls = lastToolCount
          const weight = toolCalls === 0 ? 1 : toolCalls <= 5 ? 2 : 3
          rfState.weightSinceNudge += weight
          const turnsSinceWrite = t - rfState.lastWriteTurn
          const turnsSinceNudge = t - rfState.lastTurn
          // 加权轮次攒够了、而且**最近 30 分钟没写过记忆**，才催。
          // 加权轮次攒够了就催。
          // 🛑 2026-11-23 去掉了 `&& !wroteRecently`：那个条件是**全局**的"最近有人写过"，
          //    多窗口时会把别的会话的催办永久顶掉。现在"刚写过"由
          //    noteMemoryWriteForCurrentSession 把**本会话**的 weightSinceNudge 清零表达。
          const turnDue = rfState.weightSinceNudge >= reflectWeight
          // 兼容：如果把 reflectIdleMs 设回非 0，时间判据照样生效（两者取或）
          const idle = Date.now() - lastMemoryWriteAt
          const timeDue = reflectIdleMs > 0 && idle >= reflectIdleMs && Date.now() - lastReflectAt >= reflectCooldownMs
          if (turnDue || timeDue) {
            lastReflectAt = Date.now()
            rfState.lastTurn = t
            rfState.weightSinceNudge = 0
            saveReflectState()
            log(
              `reflect nudge: turn=${t} weight=${rfState.weightSinceNudge === 0 ? 'reset' : ''}` +
                ` sinceWrite=${turnsSinceWrite} sinceNudge=${turnsSinceNudge} toolCalls=${toolCalls}${timeDue ? ' (time)' : ''}`,
            )
            // 拼上当前项目列表：让人一眼看到能往哪记。
            // 用 listProjectNames —— 它会同时扫 project/branch/detail 三张表。
            // （旧版这里查了两处：project 表只覆盖一部分，另一处查 fact 表 ——
            //  四层改造后 fact 表已经不存在，那段一直静默失败返回空。）
            let projList = ''
            try {
              const names = listProjectNames(d).slice(0, 12)
              if (names.length > 0) projList = `\n当前可归入的项目：${names.join(' / ')}`
            } catch {
              /* 查不到就不带 */
            }
        // ── 排一个独立回合，而不是注入当前回合 ──
        // 注入会让「干活」和「写记忆」挤在同一轮，两边都做不好
        //。
        // followup 把这条排进 next-turn 队列：当前回合照常干完，下一回合专门写记忆。
        // 📋 顺手查一下「积压的方案草稿」（2026-11-19）。
        //    为什么挂在催办这里：草稿是机器自动建的、标题带「草稿·待确认」、步骤是空的。
        //    没人补步骤它就永远躺在库里 —— 那正是「存了但没用」，也是这个插件一直在治的病。
        //    挂在这里的好处是不用另设定时器：7 轮一次，本来就该顺手清一清欠账。
        let draftHint = ''
        try {
          const rows = d
            .prepare(
              `SELECT id, title, updated_at FROM branch
               WHERE category = 'plan' AND status = 'active' AND title LIKE '（草稿·待确认）%'`
            )
            .all()
          const STALE_MS = 7 * 24 * 3600 * 1000
          const stale = rows.filter((r) => {
            const t = msOf(r.updated_at)
            return t > 0 && Date.now() - t > STALE_MS
          })
          if (stale.length > 0) {
            const lines = stale.slice(0, 3).map((r) => {
              const short = String(r.title).replace('（草稿·待确认）', '').slice(0, 24)
              return `  · ${short}（${String(r.id).slice(0, 10)}）`
            })
            draftHint =
              `\n\n📋 另外有 **${stale.length} 份方案草稿还欠步骤**（自动建的，放着超过 7 天了）：\n` +
              lines.join('\n') +
              '\n  要么用 memory_plan action=update 补步骤，要么删掉 —— 放着不管就是又一份"存了没用"。'
          }
        } catch (e) {
          log(`draft-hint 查询失败: ${e && e.message}`)
        }
        const noteText = reflectLead(reflectWeight) + projList + REFLECT_CHECKLIST + draftHint
        let delivered = false
        if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
          try {
            // 同 precompact 那条：统一用 snapshotMessage 构造（结构一致才好取段名），
            // 并且投递成功后记进 sideDelivered —— 否则 memory_context 里永远没有这一段。
            const noteMsg = snapshotMessage(noteText, '反思提醒')
            agent.followup(noteMsg)
            delivered = true
            sideDelivered.push(noteMsg)
            log(`reflect followup delivered: turn=${t}（排进下一回合）`)
          } catch (e) {
            log(`reflect followup failed: ${e && e.message}，回退为注入当前回合`)
          }
        }
        if (!delivered) {
          // 拿不到 agent 或投递失败 ⇒ 退回注入（至少不会完全失效）
          extras.push(snapshotMessage(noteText, '反思提醒'))
          log(`reflect 回退注入：turn=${t}`)
        }
          }
        }

      // 🔑 认领这次压缩：写进**持久账本**，下一轮就不会再当「刚压缩过」。
      //    为什么是持久账本而不是内存标记：压缩完成后插件会整个重载，
      //    内存里的标记活不到下一轮（这一版之前就死在这上面）。
      //    放在这里（re-anchor 之后、最后几条 return 之前）：
      //      · 早于这里时会把 re-anchor 自己的 `!compactions.includes(id)` 判据顶掉，它就不注入了
      //      · 首轮 / 早退两条路径会漏认领，最多多试一轮，下一轮照样会走到这里
      if (evCompactionId) {
        try {
          markSeen(workspace, sessionId, 'compactions', [evCompactionId])
          log(`压缩接棒：认领 ${String(evCompactionId).slice(0, 8)}（写进账本，下轮不再重复）`)
        } catch {
          /* 记不下就下一轮再认，重复一次无害 */
        }
      }

      // 📌 留一份「这一轮模型实际收到了什么」的快照，给 memory_context 导出来核对用。
      //    两条路都要算：extras（注入进上下文）+ sideDelivered（followup 投递的）。
      //    只记 extras 的话，反思提醒 / 落档催办在正常路径上永远看不到（它们走投递）。
      const deliveredAll = [...extras, ...sideDelivered]
      if (deliveredAll.length > 0) rememberInjection(sessionId, deliveredAll, { turn })
      if (extras.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...extras] }
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-memory] injection failed: ${e && e.message}`)
      return decision
    }
  })

  log('pre-step hook installed')

  // 🔬 一次性诊断（2026-11-19）：写「空转守卫」插件前，先确认这几件事，别靠猜：
  //    ① 插件根 ctx 上能不能直接 `ctx.on('assistant/message' | 'turn/end' | 'agent/created', …)`；
  //    ② `assistant/message` 的 payload 到底是 `{turn, step, message, usage, …}` 还是 `{data: {…}}`；
  //    ③ `message.content` 里 reasoning / text / tool-call 三种块的真实形状；
  //    ④ `agent/created` 的 payload 是 `{agent}` 还是裸 agent。
  //    打开方式：cordis.patch.yml 里 diagEvents: true。确认完就删掉这一段。
  if (config.diagEvents === true) {
    const names = ['assistant/message', 'turn/end', 'turn/start', 'agent/created', 'agent/turn-stopping']
    for (const evName of names) {
      try {
        ctx.on(evName, (payload) => {
          try {
            const isObj = payload && typeof payload === 'object'
            const keys = isObj ? Object.keys(payload).join(',') : typeof payload
            let msgInfo = ''
            const m = isObj ? (payload.message ?? payload.msg) : null
            if (m && Array.isArray(m.content)) {
              const kinds = m.content.map((b) => (b && b.type ? b.type : '?'))
              const textLen = m.content
                .filter((b) => b && b.type === 'text')
                .map((b) => String(b.text ?? '').length)
                .reduce((a, b) => a + b, 0)
              msgInfo = ` content=[${kinds.join(',')}] textLen=${textLen}`
            }
            const agentInfo = isObj && payload.agent
              ? ` agent=${String(payload.agent.id ?? '').slice(-12)}`
              : ''
            log(`DIAG ${evName}: keys=${keys}${msgInfo}${agentInfo} turn=${payload?.turn} step=${payload?.step}`)
          } catch (e) {
            log(`DIAG ${evName} 处理出错: ${e && e.message}`)
          }
        })
      } catch (e) {
        log(`DIAG 挂不上 ${evName}: ${e && e.message}`)
      }
    }
    log('DIAG 已挂上：assistant/message · turn/end · turn/start · agent/created · agent/turn-stopping')
  }

  // ---------------- 侧栏面板路由 ----------------

  // 记忆条目的增 / 改 / 删（前端）。用户要的：面板有搜索就顺手能改能删，不用叫我走工具。
  // 📄 面板 HTML 已迁到独立文件 panel.html（2026-11-18）。
  //    原因：长 JS 拼在字符串数组里，`\n`、`"` 的转义在编辑中会被吃掉，
  //    今晚连栽两次。独立文件后，改面板只碰 panel.html，index.js 不用动。
  const panelHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel.html')
  const readPanelHtml = () => {
    try {
      return fs.readFileSync(panelHtmlPath, 'utf8')
    } catch (e) {
      log(`panel.html 读不到: ${e && e.message}`)
      return '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px;color:#c9d5ee;background:#16182a">' +
        '<h3>面板文件缺失</h3><p>找不到 <code>' + panelHtmlPath + '</code></p>' +
        '<p>这是插件自带的 UI 文件，请重新安装 dsh-memory。</p></body>'
    }
  }

  // 信任围栏：只允许本机回环访问。
  // 不再用 ctx.connection.requestRejection —— 它要求 DSH 客户端自己的凭证，
  // 浏览器直接开面板（同一台机器、同一端口）也会被拒成 401。
  // 🛑 四道闸（2026-11-18 审计后加固）。
  //    原来只查 Host + 回环 IP，挡不住**浏览器发起的跨站请求**：
  //      · `<img src="http://127.0.0.1:端口/dsh-memory/projects/set?name=x&mode=off">`
  //        就能改 state.json（响应读不到无所谓，写已经发生了）；
  //      · text/plain 是 CORS 安全类型，跨站 POST 不必 preflight，请求照发。
  //    而 DSH 的 webServer 明确不负责认证/Origin 策略（只覆盖它自己的 /api 路由），
  //    所以这道围栏是唯一一堵墙。
  const trustOk = (req) => {
    const host = String(req.headers?.host ?? '')
    const ip = String(req.socket?.remoteAddress ?? '')
    // ① Host 必须存在且是回环 —— 原来 `if (host && ...)` 在 Host 缺失时
    //    整个检查被跳过（HTTP/1.0 或某些代理能把 Host 去掉）
    if (!host) return false
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    // ② TCP 对端必须是回环。IP 正则必须全锚定 —— 原来的 `^::1` 没锚尾，
    //    `::1234` 这种非回环地址也会匹配
    if (!/^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/.test(ip)) return false
    // ③ 浏览器自己会带 Sec-Fetch-Site / Origin，跨站的一律拒
    const site = String(req.headers?.['sec-fetch-site'] ?? '')
    if (site && site !== 'same-origin' && site !== 'none') return false
    const origin = String(req.headers?.origin ?? '')
    if (origin) {
      let ok = false
      try {
        ok = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(new URL(origin).hostname)
      } catch {
        ok = false
      }
      if (!ok) return false
    }
    // ④ 硬闸：自定义头属于"非简单头"，跨站带不上（带了就要 preflight，这里不应答 OPTIONS）。
    //    面板的 get/post 会自动加；命令行手测加 -H "x-dsh-memory-panel: 1"。
    return String(req.headers?.['x-dsh-memory-panel'] ?? '') === '1'
  }

  // 面板 HTML 专用：它走的是 iframe **页面导航**，浏览器给导航请求加不了自定义头
  // （自定义头是 fetch 才有的东西）⇒ 不能要求 x-dsh-memory-panel，否则面板直接 401。
  // 所以这里只过前三道闸（回环 host + 回环 IP + 同源），不要求自定义头。
  // 返回的只是静态 HTML，没有敏感数据；真正的读写接口仍然走 trustOk 的第四道闸。
  const trustPanel = (req) => {
    const host = String(req.headers?.host ?? '')
    const ip = String(req.socket?.remoteAddress ?? '')
    if (!host) return false
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    if (!/^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/.test(ip)) return false
    const site = String(req.headers?.['sec-fetch-site'] ?? '')
    if (site && site !== 'same-origin' && site !== 'none') return false
    const origin = String(req.headers?.origin ?? '')
    if (origin) {
      let ok = false
      try {
        ok = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(new URL(origin).hostname)
      } catch {
        ok = false
      }
      if (!ok) return false
    }
    return true
  }

  const sendJson = (res, obj) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
  }

  const statsHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    // 其它 handler 都包了 try/catch，只有这个没有 —— 库被锁 / 表被手删时
    // 异常会直接冒泡出 HTTP 回调，按 uncaughtException 处理，可能带走整个进程。
    try {
      const d = getDb()
      if (!d) return sendJson(res, { counts: {}, projects: 0, total: 0 })
      const counts = {}
      let total = 0
      for (const lv of LEVELS) {
        const n = d.prepare(`SELECT COUNT(*) AS n FROM ${lv} WHERE status = 'active'`).get().n
        counts[lv] = n
        total += n
      }
      sendJson(res, { counts, total, projects: listProjectNames(d).length })
    } catch (e) {
      try {
        res.statusCode = 500
        sendJson(res, { ok: false, error: String((e && e.message) || e) })
      } catch {}
    }
  }

  /**
   * 手动压缩按钮的后端。
   *
   * 走 `ctx.get('commands').execute(agent, '/compact')` —— 跟已归档的 auto-checkpoint
   * 原来那条路一样（`ctx.get()` 不需要在 inject 里声明，实测能拿到）。
   *
   * 为什么不用 `ctx.compaction`：`/compact` 命令自己会写 `command/run` 事件、
   * 走完整的准入检查（busy / 已经在压），直接调服务会绕过这些。
   *
   * 🛑 2026-11-25 审「降档应急版」时改的四处：
   *
   *   ① **不再同步等压缩完再回包**。`/compact` 实测 13 秒起（见过 59 秒），
   *      而压缩完成后 DSH 会把插件整个重载（19:33:56 压完 → 19:34:15 重载，22 个工具重注册）。
   *      重载会掐断这条 HTTP 请求 ⇒ 前端 fetch 抛异常 ⇒ 显示「❌ 出错」，
   *      而上下文其实**已经被压掉了** —— 报"失败"而实际成功，是最坏的一种谎报。
   *      ⇒ 改成 fire-and-forget：立刻回 `{ok:true, queued:true}`，真结果写日志。
   *
   *   ② **失败判定**。原判据 `kind === '' && !out.error` 把 `commands.execute` 返回
   *      `undefined`（命令没找到）也算成功 —— 最典型的假成功。
   *
   *   ③ **`sendJson` 不防重发**。原实现在 try 里发过、catch 又发一次时会抛
   *      `ERR_HTTP_HEADERS_SENT`，而这个抛点在一个 async IIFE 里，没人接。现在统一走 `reply()`。
   *
   *   ④ **agent 可能要等 idle**。直接 execute 会撞
   *      「Compaction is unavailable because … the agent is not idle」，所以后台先等它闲；
   *      但等待要有上限，否则 agent 一直忙就把这个后台任务挂死了。
   */
  const compactHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    let replied = false
    const reply = (obj) => {
      if (replied) return
      replied = true
      try {
        sendJson(res, obj)
      } catch {
        /* 连接已经断了（插件重载 / 宿主关闭）：只写日志 */
      }
    }
    try {
      // 🛑 2026-11-25：不再走 `commands.execute('/compact')`，直调压缩服务 ——
      //    `/compact` 命令本身就是 `ctx.compaction.compactNow(...)` 的一行包装，
      //    多绕一层只会多一个「命令没注册」的失败面。理由见 tCompact 上面那段注释。
      const compaction = ctx.get('compaction')
      if (!compaction || typeof compaction.compactNow !== 'function') {
        reply({ ok: false, error: 'compaction 服务拿不到（宿主没加载压缩实现：dsh-compaction-basic）' })
        return
      }
      const seen = lastAgentSeen
      const agent = seen && seen.agent
      if (!agent) {
        reply({ ok: false, error: '还没有任何会话结束过回合，不知道压哪个（先去某个窗口发一句话）' })
        return
      }
      const sid = (agent.session && agent.session.id) || agent.id || ''
      const sid8 = String(sid).replace(/^session-/, '').slice(0, 8) || '(未知)'
      if (typeof agent.runMaintenance !== 'function') {
        reply({ ok: false, error: '这个 agent 没有 runMaintenance（不是 Agent 实例），压缩走不了' })
        return
      }
      log(`[手动压缩] 发起：session=${sid8}`)
      // 先回包，压缩挪到后台 —— 理由见上面 ①
      reply({ ok: true, queued: true, sessionId: sid, sid8 })
      void (async () => {
        try {
          if (typeof agent.whenIdle === 'function') {
            await Promise.race([
              agent.whenIdle(),
              new Promise((r) => setTimeout(r, 30000)), // 上限：别被"永远忙"挂死
            ])
          }
          // 让 phase 真正落回 idle 再进 maintenance（差几毫秒也会撞 busy）
          await new Promise((r) => setTimeout(r, 300))
          log(`[手动压缩] 开始压缩 session=${sid8}`)
          const r = await compaction.compactNow(agent, new AbortController().signal)
          if (r === null) {
            log(`[手动压缩] 没压（没有可安全折掉的历史）session=${sid8}`)
            return
          }
          lastCompactDoneAt = Date.now()
          log(
            `[手动压缩] 完成 session=${sid8} 折掉 ${r.shadowedSeqs.length} 条` +
              ` ~${r.shadowedTokenCount} tokens`,
          )
        } catch (e) {
          // ManualCompactionError 的 code：busy / cancelled / changed / summary / commit / persistence
          const code = e && e.code ? ` [${e.code}]` : ''
          log(`[手动压缩] 失败${code} session=${sid8}：${e && e.message}`)
        }
      })()
    } catch (e) {
      log(`[手动压缩] 处理失败：${e && e.message}`)
      reply({ ok: false, error: String((e && e.message) || e) })
    }
  }

  const searchHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const q = u.searchParams.get('q') ?? ''
      const k = Math.max(1, Math.min(50, Number(u.searchParams.get('k')) || 15))
      const d = getDb()
      if (!d) return sendJson(res, { hits: [] })
      // 状态：默认 noarchived（在役 + 完结留档），和工具层保持一致。
      // 面板勾「含已归档」时传 status=all。
      const statusParam = String(u.searchParams.get('status') ?? 'noarchived').trim() || 'noarchived'
      const keepStatus = (s) => {
        if (statusParam === 'all') return true
        if (statusParam === 'noarchived') return s !== 'archived'
        return statusParam
          .split(',')
          .map((x) => x.trim())
          .includes(s)
      }
      const pool = []
      for (const lv of SEARCH_LEVELS) {
        for (const raw of list(d, lv, {})) {
          const doc = toDoc(raw, lv)
          if (!keepStatus(doc.status)) continue
          pool.push(doc)
        }
      }
      // ⚠️ 这里**故意**不按 reference 分流（跟 memory_search 不一样，别当成漏了）。
      //    两个入口的读者不同：模型看到一段资料会直接当结论用，所以要把它挡在主排序外；
      //    人在面板里搜东西，本来就想把「所有沾边的」一次看全，藏起来反而碍事。
      //    面板已经在分类名上标了「参考资料」（见 panel.html 的 CAT_CN），一眼能认出。
      const hits = bm25Search(q, pool, { k }).map((h) => ({
        id: h.id,
        level: h.level,
        // 🛑 分类/项目/时间必须一起返回：只给 id + 分数 + 摘要的话，
        //    想筛出「某个项目里的 lesson」得把每条都 memory_read 一次
        //    （一个项目里几十条 lesson 就是几十次调用，2026-11-19 实测确认）。
        category: h.category ?? '',
        project: h.project ?? '',
        status: h.status ?? 'active',
        at: h.at ?? 0, // happened_at 优先，没填退回 created_at
        updated_at: h.updated_at ?? 0,
        score: Number(h.score.toFixed(2)),
        // v3：原文出处，面板上直接显示成可点的标签
        source_ref: h.source_ref ?? '',
        content: String(h.title ? h.title + '：' : '') + String(h.content ?? '').replace(/\s+/g, ' ').slice(0, 220),
      }))
      sendJson(res, { hits })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { hits: [], error: e && e.message })
    }
  }

  const recentHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const n = Math.max(1, Math.min(100, Math.trunc(Number(u.searchParams.get('n')) || 15)))
      const d = getDb()
      if (!d) return sendJson(res, { hits: [] })
      const all = []
      for (const lv of LEVELS) {
        for (const r of d.prepare(`SELECT * FROM ${lv} ORDER BY updated_at DESC LIMIT ?`).all(n)) {
          all.push({ lv, r })
        }
      }
      all.sort((a, b2) => msOf(b2.r.updated_at) - msOf(a.r.updated_at))
      const hits = all.slice(0, n).map(({ lv, r }) => ({
        id: r.id,
        level: lv,
        category: r.category ?? '',
        project: r.project ?? '',
        status: r.status ?? 'active',
        at: r.happened_at ?? r.created_at ?? 0,
        updated_at: r.updated_at ?? 0,
        score: null,
        content: String(r.title ? r.title + '：' : '') + String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 200),
      }))
      sendJson(res, { hits })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { hits: [], error: e && e.message })
    }
  }

  const panelHandler = (req, res) => {
    // 用 trustPanel 而不是 trustOk：iframe 导航带不了自定义头
    if (!trustPanel(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(readPanelHtml())
  }

  // ── 项目核心：面板读写（2026-11-18）────────────────────────
  // 用户要的"手动选择 / 去除项目核心记忆"就在这两个接口上：
  // 只控制"注不注入"，**不删任何记忆**。
  // 面板用 `?session=<sessionId>` 指定"看哪个窗口"。
  // 不传时**挑最近活跃的真实会话**（不传 'global' —— 那玩意在刚重启时是空的，
  // 面板会显示"没有加载任何项目核心"，用户要的是"打开就能看见我的对话"）。
  const sessionFromReq = (req) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const s = u.searchParams.get('session')
      if (s && s.trim()) return s.trim()
    } catch {}
    const first = listSessionChoices().find((x) => x.id !== 'global')
    return first ? first.id : 'global'
  }

  const projectsHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const snap = projectCoreSnapshot(sessionFromReq(req))
      // 📌 附带「有记忆但没建核心」的项目清单 —— 面板要用它显示一行提示，
      //    否则这些项目的记忆对用户等于不存在（它们点不到、也看不到）。
      let orphans = []
      try {
        const d = getDb()
        if (d) orphans = listOrphanProjects(d)
      } catch {
        orphans = []
      }
      sendJson(res, { ...snap, orphans })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { error: e && e.message })
    }
  }

  const projectsSetHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const name = u.searchParams.get('name') || ''
      const mode = u.searchParams.get('mode') || 'auto'
      if (!name) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '缺 name 参数' })
        return
      }
      const sid = sessionFromReq(req)
      const r = setOverride(name, mode, sid)
      log(`project-core: [${sid.slice(-8)}] ${name} -> ${mode} (${r.ok ? 'ok' : r.error})`)
      sendJson(res, { ...r, snapshot: projectCoreSnapshot(sid) })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  // 锁定：冻结当前状态（不再按关键词自动增减），点项目仍可手动改。
  const projectsLockHandler = (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const on = u.searchParams.get('on') === '1'
      const sid2 = sessionFromReq(req)
      const r = setLocked(on, sid2)
      log(`project-core: [${sid2.slice(-8)}] locked -> ${on} (${r.ok ? 'ok' : r.error})`)
      sendJson(res, { ...r, snapshot: projectCoreSnapshot(sid2) })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  // ── 面板上的"增 / 改 / 删"（2026-11-18）────────────────────────
  // 用户要的：面板既然有搜索，就顺手能加、能改、能删，给他自己用手点，
  // 不必每次都叫我走工具（也就省了工具调用的 token）。
  //
  // 🔑 取舍：删除**默认软删**（status='archived'），真要抹掉才传 hard:true。
  //   理由：记忆里写着「只归档不删除」的教训，而面板是鼠标点的，
  //   误点一次就把东西弄没了不划算；archived 在检索里不返回，效果等同删除。
  // 🛑 2026-11-18 审计修：原来超限只 req.destroy()，而 destroy() 既不触发 end
  //    也不触发 error（只触发 close）⇒ **Promise 永远不 settle**，await 之后
  //    的 500 兜底和 res.end() 全到不了，那条请求一直挂着。
  //    「往编辑器里粘一份大文档」这种正常操作就会踩到，不只是攻击。
  //    顺带修三处：① 看 content-length 提前拒；② 存 Buffer 不存字符串
  //    （分块边界切在多字节字符中间会把中文切坏）；③ close 兜底。
  const MAX_BODY = 2 * 1024 * 1024
  const readJsonBody = (req, res) =>
    new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        resolve(v)
      }
      const tooBig = () => {
        if (done) return
        try {
          res.statusCode = 413
          sendJson(res, { ok: false, error: `请求体超过 ${MAX_BODY} 字节` })
        } catch {}
        try {
          req.resume() // 把剩下的读掉丢弃，别让连接半死
        } catch {}
        // 用 null 而不是 {}：调用方要能分清"超限"和"空 body"
        finish(null)
      }
      const len = Number(req.headers?.['content-length'])
      if (Number.isFinite(len) && len > MAX_BODY) return tooBig()

      const chunks = []
      let size = 0
      req.on('data', (c) => {
        if (done) return
        size += c.length
        if (size > MAX_BODY) return tooBig()
        chunks.push(c)
      })
      req.on('end', () => {
        if (done) return
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          // 解析失败也返回 null：让 handler 早退，别拿空对象往下跑
          try {
            res.statusCode = 400
            sendJson(res, { ok: false, error: '请求体不是合法 JSON' })
          } catch {}
          finish(null)
        }
      })
      req.on('error', () => finish(null))
      req.on('close', () => finish(null))
    })

  const kwOf = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
    return String(v || '')
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  }

  const itemAddHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      // 🛑 null = 请求体超限/读失败，413 已经发过了。
      //    原来失败也 resolve({})，handler 把空对象当正常 body 继续跑，
      //    接着又 setHeader/sendJson ⇒ ERR_HTTP_HEADERS_SENT 抛两次，
      //    async handler reject 后按 uncaughtException 处理，可能直接带走主进程。
      if (b === null) return
      const d = getDb()
      if (!d) {
        sendJson(res, { ok: false, error: '数据库没打开' })
        return
      }
      const layer = LEVELS.includes(b.level) ? b.level : 'detail'
      const content = String(b.content || '').trim()
      if (!content) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '内容不能为空' })
        return
      }
      // 🛑 标题长度上限：不拦的话 1MB 标题能存进去（压力测试实测 200），
      //    它不会崩，但会污染列表渲染、搜索摘要和首轮注入。
      const titleStr = String(b.title || '')
      if (titleStr.trim().length > MAX_TITLE) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: `标题太长（上限 ${MAX_TITLE} 字）` })
        return
      }
      // 🛑 正文也要掐（2026-11-20 复审）：长度闸下沉到 insertPlan 后，这里不拦
      //    就会把异常变成 500。同一把尺子 MAX_CONTENT，超了回 400 而不是崩。
      if (content.length > MAX_CONTENT) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: `正文太长（上限 ${MAX_CONTENT} 字）` })
        return
      }
      const args = {
        level: layer,
        category: b.category,
        project: String(b.project || '全局'),
        title: titleStr,
        content,
        keywords: kwOf(b.keywords),
        importance: Number.isFinite(Number(b.importance)) ? Number(b.importance) : 2,
        force: b.force === true,
        // 🛑 2026-11-19 补：工具层（memory_remember）早就能收这三样，面板一直没暴露，
        //    于是"从面板手动补一条"永远拿不到时间/情境/情绪，时间轴上全是记录时间。
        //    insertPlan 内部会走 normalizeTime / normalizeContext / normalizeMood，
        //    这里原样透传即可（undefined 会被规范成 null）。
        happened_at: b.happened_at,
        context: b.context,
        mood: b.mood,
      }
      if (!args.force) {
        const near = findNearDuplicate(d, { title: args.title, content, keywords: args.keywords }, dedupeJaccard)
        if (near.duplicate !== null) {
          sendJson(res, {
            ok: false,
            duplicate: near.duplicate.doc.id,
            error: `和 ${near.duplicate.doc.id} 很像；确认要另存一条就把「强制」勾上`,
          })
          return
        }
      }
      const id = 'mem-' + randomUUID().slice(0, 18)
      const { cols, vals } = insertPlan(args, layer, id, content, Date.now())
      d.prepare(`INSERT INTO ${layer} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
      try {
        lastMemoryWriteAt = Date.now()
        noteMemoryWriteForCurrentSession()
      } catch {}
      log(`panel: add ${layer} ${id}`)
      sendJson(res, { ok: true, id, level: layer })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  const itemUpdateHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      // 🛑 null = 请求体超限/读失败，413 已经发过了。
      //    原来失败也 resolve({})，handler 把空对象当正常 body 继续跑，
      //    接着又 setHeader/sendJson ⇒ ERR_HTTP_HEADERS_SENT 抛两次，
      //    async handler reject 后按 uncaughtException 处理，可能直接带走主进程。
      if (b === null) return
      const d = getDb()
      const id = String(b.id || '')
      const layer = LEVELS.includes(b.level) ? b.level : ''
      if (!id || !layer) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '需要 id 和 level' })
        return
      }
      if (!d) {
        sendJson(res, { ok: false, error: '数据库没打开' })
        return
      }
      const before = d.prepare(`SELECT * FROM ${layer} WHERE id = ?`).get(id)
      if (!before) {
        res.statusCode = 404
        sendJson(res, { ok: false, error: '没找到这条记忆' })
        return
      }
      const sets = []
      const vals = []
      // 不允许把正文改成空：NOT NULL 拦不住空串，而 add 那边有非空校验。
      // 两边不对称的话，面板能造出「没有正文」的记忆（2026-11-19 审计发现）。
      if (b.content !== undefined) {
        const c = String(b.content)
        if (!c.trim()) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: '正文不能改成空' })
          return
        }
        // 🛑 和工具层同一把尺子（MAX_CONTENT）。这里必须显式挡并回 400 ——
        //    长度闸下沉到 insertPlan 之后，handler 不拦的话异常会变成 500
        //    （2026-11-20 复审：stress-panel 的「1.8MB body」用例就撞成了 500）。
        if (c.length > MAX_CONTENT) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: `正文太长（上限 ${MAX_CONTENT} 字）` })
          return
        }
        sets.push('content = ?')
        vals.push(c)
      }
      if (b.title !== undefined) {
        const ti = String(b.title)
        // 和 add 对齐：标题掐长度，正文也掐（同一把 MAX_TITLE / MAX_CONTENT 尺子）
        if (ti.trim().length > MAX_TITLE) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: `标题太长（上限 ${MAX_TITLE} 字）` })
          return
        }
        sets.push('title = ?')
        vals.push(ti)
      }
      if (b.keywords !== undefined) {
        sets.push('keywords = ?')
        vals.push(JSON.stringify(kwOf(b.keywords)))
      }
      // 🛑 core 表没有 project 列 —— 直连接口不受面板保护，core + project 必定
      //    `no such column: project` 500。这里明确拒绝，别让它变成一个看不懂的 500。
      if (b.project !== undefined) {
        if (layer === 'core') {
          res.statusCode = 400
          sendJson(res, { ok: false, error: 'core 层没有「项目」归属，不能设置 project' })
          return
        }
        sets.push('project = ?')
        vals.push(String(b.project))
      }
      // 分类要走白名单收敛：写进该层不存在的分类，这条会在分组视图里直接消失
      if (b.category !== undefined) {
        sets.push('category = ?')
        vals.push(resolveCategory(layer, b.category))
      }
      if (b.importance !== undefined) {
        sets.push('importance = ?')
        vals.push(Math.round(Number(b.importance)))
      }
      // status 只认三值：写错（比如 deleted）会让这条在所有查询里都不可见
      if (b.status !== undefined) {
        const st = String(b.status)
        if (!['active', 'stale', 'archived'].includes(st)) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: 'status 只能是 active / stale / archived' })
          return
        }
        sets.push('status = ?')
        vals.push(st)
      }
      // 🛑 2026-11-19 补：这三个字段面板一直改不了。
      //    注意用 normalize* 而不是直接 String()：前端传的是「2026-11-18」这种
      //    可读字符串，直接入库会得到一列字符串混着毫秒数的脏数据，
      //    时间轴 COALESCE(happened_at, created_at) 排序立刻乱掉。
      //    传空串表示**清空该字段**（normalize* 会把 '' 规范成 null）。
      if (b.happened_at !== undefined) {
        sets.push('happened_at = ?')
        vals.push(normalizeTime(b.happened_at))
      }
      if (b.context !== undefined) {
        sets.push('context = ?')
        vals.push(normalizeContext(b.context))
      }
      if (b.mood !== undefined) {
        sets.push('mood = ?')
        vals.push(normalizeMood(b.mood))
      }
      if (!sets.length) {
        sendJson(res, { ok: false, error: '没有要改的字段' })
        return
      }
      sets.push('updated_at = ?')
      vals.push(Date.now())
      vals.push(id)
      d.prepare(`UPDATE ${layer} SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      try {
        recordHistory(d, layer, id, before)
      } catch {}
      try {
        lastMemoryWriteAt = Date.now()
        noteMemoryWriteForCurrentSession()
      } catch {}
      log(`panel: update ${layer} ${id}`)
      sendJson(res, { ok: true, id, level: layer })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  const itemDeleteHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      // 🛑 null = 请求体超限/读失败，413 已经发过了。
      //    原来失败也 resolve({})，handler 把空对象当正常 body 继续跑，
      //    接着又 setHeader/sendJson ⇒ ERR_HTTP_HEADERS_SENT 抛两次，
      //    async handler reject 后按 uncaughtException 处理，可能直接带走主进程。
      if (b === null) return
      const d = getDb()
      const id = String(b.id || '')
      const layer = LEVELS.includes(b.level) ? b.level : ''
      if (!id || !layer) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '需要 id 和 level' })
        return
      }
      if (!d) {
        sendJson(res, { ok: false, error: '数据库没打开' })
        return
      }
      const before = d.prepare(`SELECT * FROM ${layer} WHERE id = ?`).get(id)
      if (!before) {
        res.statusCode = 404
        sendJson(res, { ok: false, error: '没找到这条记忆' })
        return
      }
      if (b.hard === true) {
        // 🛑 硬删也要先留快照：软删（archived）有 recordHistory，硬删原来什么都不留，
        //    面板点错一次这条记忆就永久消失，事后连"它曾经存在"都查不到。
        try {
          recordHistory(d, layer, id, before)
        } catch {}
        d.prepare(`DELETE FROM ${layer} WHERE id = ?`).run(id)
        log(`panel: HARD delete ${layer} ${id}（快照已留）`)
        sendJson(res, { ok: true, hard: true })
        return
      }
      d.prepare(`UPDATE ${layer} SET status = ?, updated_at = ? WHERE id = ?`).run('archived', Date.now(), id)
      try {
        recordHistory(d, layer, id, before)
      } catch {}
      log(`panel: archive ${layer} ${id}`)
      sendJson(res, { ok: true, hard: false })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  // ── 项目核心正文的读写（面板里直接改）──────────────────
  // 🛑 2026-11-18 审计修：GET 和 POST 必须用**同一套**路径校验。
  //    原来只有 POST 做了 basename，GET 直接拿 projects.json 里的 file 拼路径 ⇒
  //    配置里写 `"file": "../../Users/x/.ssh/id_rsa"` 就能把任意文件读出来。
  //    两边不对称还有个纯功能 bug：GET 读 sub/x.md，POST 却 basename 成 x.md
  //    写到根目录 ⇒ 保存后回读还是旧内容（表现为"保存了但没变"）。
  const CORE_ROOT = path.resolve(PROJECT_CORE_ROOT)
  /** 把配置里的相对文件名钉死在这个目录里；越界或不是 .md 就返回 '' */
  const resolveCoreFile = (file) => {
    if (!file) return ''
    const p = path.resolve(CORE_ROOT, String(file))
    const rel = path.relative(CORE_ROOT, p)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
    if (!p.toLowerCase().endsWith('.md')) return ''
    return p
  }
  const projectFileHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const cfg = readProjectConfig()
      if (req.method === 'GET') {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const name = u.searchParams.get('name') || ''
        const def = cfg.projects[name]
        if (!def || !def.file) {
          res.statusCode = 404
          sendJson(res, { ok: false, error: '没有这个项目，或它没配 file' })
          return
        }
        const p = resolveCoreFile(def.file)
        if (!p) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: 'file 配置越界，或不是 .md' })
          return
        }
        let content = ''
        try {
          content = fs.readFileSync(p, 'utf8')
        } catch {
          content = ''
        }
        sendJson(res, {
          ok: true,
          name,
          file: def.file,
          content,
          // 把上限一起给前端，面板才能边打字边报"还剩多少 / 超了多少"。
          limit: Number.isFinite(cfg.maxCharsPerProject) ? cfg.maxCharsPerProject : DEFAULT_MAX_CHARS,
        })
        return
      }
      if (req.method === 'POST') {
        const b = await readJsonBody(req, res)
        // 🛑 null = 请求体超限/读失败，413 已经发过了。
        //    原来失败也 resolve({})，handler 把空对象当正常 body 继续跑，
        //    接着又 setHeader/sendJson ⇒ ERR_HTTP_HEADERS_SENT 抛两次，
        //    async handler reject 后按 uncaughtException 处理，可能直接带走主进程。
        if (b === null) return
        const name = String(b.name || '')
        const def = cfg.projects[name]
        if (!def || !def.file) {
          res.statusCode = 404
          sendJson(res, { ok: false, error: '没有这个项目，或它没配 file' })
          return
        }
        // 和 GET 用同一套校验（越界 / 非 .md 一律拒），不再单靠 basename
        const p = resolveCoreFile(def.file)
        if (!p) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: 'file 配置越界，或不是 .md' })
          return
        }
        fs.mkdirSync(path.dirname(p), { recursive: true })
        // content 缺字段直接拒：以前 `b.content ?? ''` 会把整份项目正文写成 0 字节，
        // 面板误点一次保存或者前端漏传字段，规则就没了（空串是用户主动清空，允许）
        if (b.content === undefined) {
          res.statusCode = 400
          sendJson(res, { ok: false, error: '缺 content 字段（要清空就传空串）' })
          return
        }
        const body = String(b.content)
        writeFileAtomic(p, body)
        // 超限不拦（拦住就等于不给改），但必须当场说清：注入时只取前 limit 个字符。
        const limit = Number.isFinite(cfg.maxCharsPerProject) ? cfg.maxCharsPerProject : DEFAULT_MAX_CHARS
        const chars = body.length
        let warn = ''
        if (chars > limit) {
          warn = `已保存，但 ${chars} 字符超了上限 ${limit}：注入时只给前 ${limit} 个字符，后面读不到。`
        } else if (chars >= Math.floor(limit * 0.85)) {
          warn = `已保存。快到上限了（${chars}/${limit}），再往里加该先压缩了。`
        }
        log(`panel: write project core ${name} -> ${path.basename(p)} (${chars}/${limit} 字)`)
        sendJson(res, { ok: true, name, file: def.file, chars, limit, warn })
        return
      }
      res.statusCode = 405
      sendJson(res, { ok: false, error: 'method not allowed' })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: e && e.message })
    }
  }

  // ── 新建一个项目核心（面板里手建入口）────────────────────────
  // 发布版默认 projects.json 是空的，别人要用就得能自己加 —— 这是闭环的一环。
  /**
   * 项目重命名（2026-11-21）。
   *
   * 为什么要这个：改一个项目名，要同时改 **5 个地方**，漏一处就是孤儿条目
   * （记忆还挂着旧名、永远搜不到，而且不报错）：
   *   ① projects.json 的 key + file 字段
   *   ② 所有项目的 parent（数组）和 linked 里的引用
   *   ③ <项目>.md 的文件名
   *   ④ state.json 里 overrides 的键、injected 数组里的名字
   *   ⑤ 记忆库三张表的 project 字段（要处理 `父/子` 和逗号多值里的那一段）
   */
  const projectRenameHandler = async (req, res) => {
    if (!trustOk(req)) { res.statusCode = 401; res.end('unauthorized'); return }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      if (b === null) return
      const from = String(b.from || '').trim()
      const to = String(b.to || '').trim()
      if (!from || !to) { sendJson(res, { ok: false, error: 'from 和 to 都要给' }); return }
      if (from === to) { sendJson(res, { ok: false, error: '新名字和老名字一样' }); return }
      if (/[\\/:*?"<>|]/.test(to) || to.includes('..')) {
        sendJson(res, { ok: false, error: '新名字里不能有 \\ / : * ? " < > | 这些字符' }); return
      }
      if (to.length > 40) { sendJson(res, { ok: false, error: '项目名最多 40 个字' }); return }

      const cfgPath = path.join(PROJECT_CORE_ROOT, 'projects.json')
      let j = {}
      try { j = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { j = {} }
      if (!j.projects || !j.projects[from]) {
        sendJson(res, { ok: false, error: `没有项目「${from}」` }); return
      }
      if (j.projects[to]) { sendJson(res, { ok: false, error: `已经有一个叫「${to}」的项目了` }); return }

      // ① key + file
      const oldDef = j.projects[from]
      const oldFile = path.basename(String(oldDef.file || `${from}.md`))
      delete j.projects[from]
      j.projects[to] = { ...oldDef, file: `${to}.md` }
      // ② parent / linked 里的引用
      // 🛑 2026-11-21：必须走 parentsOf 归一，不能只看 Array.isArray。
      //    老数据的 parent 是**字符串**（`"父项目"`），`Array.isArray` 判不进去 ⇒
      //    改名之后引用就地断掉：项目还在、名字也对，但挂不回父下面了（静默失效）。
      for (const def of Object.values(j.projects)) {
        const ps = parentsOf(def)
        if (ps.length) def.parent = ps.map((p) => (p === from ? to : p))
        if (def && Array.isArray(def.linked)) def.linked = def.linked.map((p) => (p === from ? to : p))
      }
      fs.mkdirSync(PROJECT_CORE_ROOT, { recursive: true })
      writeFileAtomic(cfgPath, JSON.stringify(j, null, 2) + '\n')

      // ③ md 文件名
      try {
        const oldMd = path.join(PROJECT_CORE_ROOT, oldFile)
        const newMd = path.join(PROJECT_CORE_ROOT, `${to}.md`)
        if (fs.existsSync(oldMd) && !fs.existsSync(newMd)) fs.renameSync(oldMd, newMd)
      } catch { /* 文件改名失败不影响主要流程 */ }

      // ④ state.json
      try {
        const stPath = path.join(PROJECT_CORE_ROOT, 'state.json')
        if (fs.existsSync(stPath)) {
          const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
          for (const slot of Object.values((st && st.sessions) || {})) {
            if (!slot || typeof slot !== 'object') continue
            if (slot.overrides && Object.prototype.hasOwnProperty.call(slot.overrides, from)) {
              slot.overrides[to] = slot.overrides[from]
              delete slot.overrides[from]
            }
            if (Array.isArray(slot.injected)) slot.injected = slot.injected.map((x) => (x === from ? to : x))
          }
          writeFileAtomic(stPath, JSON.stringify(st, null, 2) + '\n')
        }
      } catch { /* state.json 坏了不影响改名本身 */ }

      // ⑤ 记忆库三张表的 project —— 要处理三种形态：
      //    '旧名' / '父/旧名' / '旧名,别的' / '父/旧名,别的'
      const d = getDb()
      let touched = 0
      if (d) {
        const rewrite = (s) =>
          String(s)
            .split(',')
            .map((seg) => {
              const t = seg.trim()
              if (!t) return t
              if (t === from) return to
              if (t.startsWith(from + '/')) return to + t.slice(from.length)
              const cut = t.lastIndexOf('/')
              if (cut > 0 && t.slice(cut + 1) === from) return t.slice(0, cut + 1) + to
              return t
            })
            .join(',')
        for (const lv of ['project', 'branch', 'detail']) {
          try {
            const rows = d
              .prepare(`SELECT id, project FROM ${lv} WHERE project LIKE ? OR project LIKE ? OR project LIKE ? OR project LIKE ?`)
              .all(`${from}%`, `%,${from},%`, `%,${from}/%`, `%,${from}`)
            for (const r of rows) {
              const next = rewrite(r.project)
              if (next === r.project) continue
              d.prepare(`UPDATE ${lv} SET project = ?, updated_at = ? WHERE id = ?`).run(next, Date.now(), r.id)
              touched += 1
            }
          } catch { /* 某张表结构不对就跳过 */ }
        }
      }
      sendJson(res, { ok: true, from, to, memoriesTouched: touched })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: String((e && e.message) || e) })
    }
  }

  /**
   * 合并两个项目核心（2026-11-21）：`from` 并入 `to`。
   *
   * 跟「删除」的关键区别：**记忆归属是改过去、不是清掉** —— 合并的语义是
   * 「from 变成 to 的一部分」，所以 from 的记忆、关键词、联动关系全部搬到 to 名下。
   *
   * `body` 决定正文怎么办：
   *   · `append`（默认）：from 的正文追加到 to 后面，中间加一条分隔线
   *   · `keep`：from 的正文只留底成 `.merged`，**不**追加
   *
   * 为什么留 `keep`：两个项目的正文常常是不同角度写的（一个写"现在有什么功能"，
   * 一个写"踩过哪些坑"），硬拼在一起会变成两套互相打架的规范。先留底、要的时候
   * 手动挑，比自动拼安全。
   */
  const projectMergeHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      if (b === null) return
      const from = String(b.from || '').trim()
      const to = String(b.to || '').trim()
      const bodyMode = String(b.body || 'append').trim()
      if (!from || !to) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: 'from 和 to 都要给' })
        return
      }
      if (from === to) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: 'from 和 to 是同一个项目' })
        return
      }
      if (!['append', 'keep'].includes(bodyMode)) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: 'body 只能是 append 或 keep' })
        return
      }

      const cfgPath = path.join(PROJECT_CORE_ROOT, 'projects.json')
      let j = {}
      try {
        j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      } catch {
        j = {}
      }
      if (!j.projects || !j.projects[from]) {
        res.statusCode = 404
        sendJson(res, { ok: false, error: `没有项目「${from}」` })
        return
      }
      if (!j.projects[to]) {
        res.statusCode = 404
        sendJson(res, { ok: false, error: `没有项目「${to}」` })
        return
      }

      const fromDef = j.projects[from]
      const toDef = j.projects[to]
      // 🛑 用 resolveCoreFile 而不是 path.basename（2026-11-21 审计实测）：
      //    `file: "sub/戊.md"` 是**合法配置**（resolveCoreFile / buildProjectCoreSection 都支持子目录）。
      //    按 basename 拼会去根目录找一个不存在的文件 ⇒ 正文既不并进去、也不留底，
      //    但项目名已经从清单删了 —— 用户看到的是"正文凭空消失"，实际文件还在 sub/ 下面。
      //    rename 那边同一个坑，一起改。
      const fromPath = resolveCoreFile(fromDef.file || `${from}.md`)
      const toPath = resolveCoreFile(toDef.file || `${to}.md`)

      // ① 正文
      let bodyWarn = ''
      let fromBody = ''
      try {
        if (fromPath && fs.existsSync(fromPath)) fromBody = fs.readFileSync(fromPath, 'utf8')
      } catch {
        /* 读不到就当空的 */
      }
      const limit = Number.isFinite(j.maxCharsPerProject) ? j.maxCharsPerProject : DEFAULT_MAX_CHARS
      if (bodyMode === 'append' && fromBody.trim()) {
        try {
          if (!toPath) {
            bodyWarn = `目标项目的 file 配置不合法（${toDef.file || '空'}），正文没并进去`
          } else {
            const toBody = fs.existsSync(toPath) ? fs.readFileSync(toPath, 'utf8') : ''
            const merged = toBody.trimEnd()
              ? `${toBody.trimEnd()}\n\n---\n\n> 以下来自合并前的「${from}」\n\n${fromBody.trim()}\n`
              : `${fromBody.trim()}\n`
            // 🛑 超上限只警告不截断 —— 截掉的是用户自己写的内容，而且他看不见少了哪段。
            if (merged.length > limit) {
              bodyWarn = `合并后正文 ${merged.length} 字，超过上限 ${limit}，注入时会被截断；建议手动压一压`
            }
            writeFileAtomic(toPath, merged)
          }
        } catch (e) {
          bodyWarn = `写目标正文失败：${e && e.message}`
        }
      }
      // from 的正文一律留底（合并完还可能要翻回来看它原来写的是什么）
      try {
        if (fromPath && fs.existsSync(fromPath)) {
          // 🛑 留底文件名要避开已存在的：同名项目再合并一次时，固定叫 `.merged`
          //    会把上一次的留底覆盖掉 —— 而 `keep` 模式的全部意义就是"还能翻回来看"。
          let kept = fromPath + '.merged'
          let n = 2
          while (fs.existsSync(kept) && n < 100) {
            kept = `${fromPath}.merged${n}`
            n += 1
          }
          writeFileAtomic(kept, fromBody || fs.readFileSync(fromPath, 'utf8'))
          fs.unlinkSync(fromPath)
          // keep 模式没并正文，至少要告诉用户留底在哪（否则看着像"内容丢了"）
          if (bodyMode === 'keep') bodyWarn = bodyWarn || `正文留底在：${kept}`
        }
      } catch {
        /* 留底失败不影响合并本身 */
      }

      // ② projects.json：删 from，关键词/联动并进 to
      delete j.projects[from]
      const listOf = (v) =>
        Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []
      const toKws = [...new Set([...listOf(toDef.keywords), ...listOf(fromDef.keywords)])]
      const toLinked = [...new Set([...listOf(toDef.linked), ...listOf(fromDef.linked)])].filter(
        (l) => l !== from && l !== to && j.projects[l]
      )
      // 🛑 必须给 `file` 一个兜底值（2026-11-21 审计实测）：`to` 的 file 若是空的，
      //    正文虽然写到根目录了，但注入和面板都按 `def.file` 拼路径 ⇒
      //    「合并成功」但规则一条都进不了上下文 —— 典型静默失效。
      j.projects[to] = {
        ...toDef,
        file: String(toDef.file || '').trim() || `${to}.md`,
        keywords: toKws,
        linked: toLinked,
      }
      // 别的项目里指向 from 的 parent/linked 引用改成 to，并清掉自指与悬空
      // 🛑 2026-11-21 审计修：原来这里有一句 `if (nm === to) continue`，
      //    目标项目**自己的 parent 没被处理**。`from` 恰好是 `to` 的父时
      //    （`to.parent = ['from']`），合并后 from 已被删、parent 还指着它 ⇒ 悬空引用：
      //    面板上不长子项、注入也不触发，而且完全没提示。
      //    现在不跳过 to，改完统一过滤「自己」和「已不存在的项目」。
      for (const [nm, def] of Object.entries(j.projects)) {
        const ps = parentsOf(def)
        if (ps.length) {
          def.parent = [...new Set(ps.map((p) => (p === from ? to : p)))].filter(
            (p) => p !== nm && Object.prototype.hasOwnProperty.call(j.projects, p)
          )
        }
        if (Array.isArray(def.linked)) {
          def.linked = [...new Set(def.linked.map((p) => (p === from ? to : p)))].filter(
            (p) => p !== nm && Object.prototype.hasOwnProperty.call(j.projects, p)
          )
        }
      }
      writeFileAtomic(cfgPath, JSON.stringify(j, null, 2) + '\n')

      // ③ state.json：from 的锁定跟着到 to（to 本来就有覆盖的，保留 to 的）
      try {
        const stPath = path.join(PROJECT_CORE_ROOT, 'state.json')
        if (fs.existsSync(stPath)) {
          const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
          for (const slot of Object.values((st && st.sessions) || {})) {
            if (!slot || typeof slot !== 'object') continue
            if (slot.overrides && Object.prototype.hasOwnProperty.call(slot.overrides, from)) {
              if (!Object.prototype.hasOwnProperty.call(slot.overrides, to)) {
                slot.overrides[to] = slot.overrides[from]
              }
              delete slot.overrides[from]
            }
            if (Array.isArray(slot.injected)) {
              slot.injected = [...new Set(slot.injected.map((x) => (x === from ? to : x)))]
            }
          }
          writeFileAtomic(stPath, JSON.stringify(st, null, 2) + '\n')
        }
      } catch {
        /* state.json 坏了不影响合并 */
      }

      // ④ 记忆的 project：from → to（含 `from/子` 和逗号多值里的那一段），并去重
      const d = getDb()
      let touched = 0
      if (d) {
        const rewrite = (s) => {
          const segs = String(s)
            .split(',')
            .map((seg) => {
              const t = seg.trim()
              if (!t) return ''
              if (t === from) return to
              if (t.startsWith(from + '/')) return to + t.slice(from.length)
              return t
            })
            .filter(Boolean)
          // 🛑 必须去重：一条记忆本来就同时属于 from 和 to 时（`from,to`），
          //    不去重会变成 `to,to`，之后按项目查会重复命中同一条。
          return [...new Set(segs)].join(',')
        }
        for (const lv of ['project', 'branch', 'detail']) {
          try {
            const rows = d
              .prepare(
                `SELECT id, project FROM ${lv} WHERE project LIKE ? OR project LIKE ? OR project LIKE ? OR project LIKE ?`
              )
              .all(`${from}%`, `%,${from},%`, `%,${from}/%`, `%,${from}`)
            for (const r of rows) {
              const next = rewrite(r.project)
              if (next === r.project) continue
              d.prepare(`UPDATE ${lv} SET project = ?, updated_at = ? WHERE id = ?`).run(
                next || to,
                Date.now(),
                r.id
              )
              touched += 1
            }
          } catch {
            /* 某张表结构不对就跳过 */
          }
        }
      }

      sendJson(res, {
        ok: true,
        from,
        to,
        bodyMode,
        keywords: toKws.length,
        memoriesTouched: touched,
        warn: bodyWarn || undefined,
      })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: String((e && e.message) || e) })
    }
  }

  /**
   * 删除一个项目核心（2026-11-21）。
   *
   * 关键不替用户决定：**记忆怎么办**由 `memoryAction` 指定 ——
   *   · `keep`（默认）：记忆原样留着，只是项目没了 ⇒ 变孤儿，按项目查不到但搜得到
   *   · `global`：把 `project` 改成「全局」，记忆还能搜到、但失去归属
   *   · `stale`：把记忆标 stale（完结留档，检索仍能命中）
   * 不默认帮用户抹数据，是因为"删项目"和"删记忆"是两件事。
   */
  const projectDeleteHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      if (b === null) return
      const name = String(b.name || '').trim()
      const action = String(b.memoryAction || 'keep').trim()
      if (!name) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '缺 name' })
        return
      }
      if (!['keep', 'global', 'stale'].includes(action)) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: 'memoryAction 只能是 keep / global / stale' })
        return
      }
      const cfgPath = path.join(PROJECT_CORE_ROOT, 'projects.json')
      let j = {}
      try {
        j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      } catch {
        res.statusCode = 404
        sendJson(res, { ok: false, error: '读不到 projects.json' })
        return
      }
      if (!j || !j.projects || !Object.prototype.hasOwnProperty.call(j.projects, name)) {
        res.statusCode = 404
        sendJson(res, { ok: false, error: `没有项目「${name}」` })
        return
      }
      const def = j.projects[name]
      // ① 从清单里删掉
      delete j.projects[name]
      // ② 别的项目里对它的引用（parent / linked）直接去掉，不是改
      // 🛑 同样要走 parentsOf：老数据的 parent 是字符串，只判 Array.isArray
      //    会留下一条指向已删项目的引用（面板上不显示，但数据是脏的）。
      for (const d of Object.values(j.projects)) {
        const ps = parentsOf(d)
        if (ps.length) d.parent = ps.filter((p) => p !== name)
        if (d && Array.isArray(d.linked)) d.linked = d.linked.filter((p) => p !== name)
      }
      writeFileAtomic(cfgPath, JSON.stringify(j, null, 2) + '\n')
      // ③ .md 不删，改名留底（删项目 ≠ 删内容，用户可能想翻回去看）
      let bodyKept = ''
      try {
        const oldMd = path.join(PROJECT_CORE_ROOT, String(def && def.file ? def.file : `${name}.md`))
        if (fs.existsSync(oldMd)) {
          bodyKept = oldMd + '.deleted'
          writeFileAtomic(bodyKept, fs.readFileSync(oldMd, 'utf8'))
          fs.unlinkSync(oldMd)
        }
      } catch {
        /* 留底失败不影响清单删除 */
      }
      // ④ state.json 里去掉它的 overrides 与 injected
      try {
        const stPath = path.join(PROJECT_CORE_ROOT, 'state.json')
        if (fs.existsSync(stPath)) {
          const st = JSON.parse(fs.readFileSync(stPath, 'utf8'))
          for (const slot of Object.values((st && st.sessions) || {})) {
            if (!slot || typeof slot !== 'object') continue
            if (slot.overrides) delete slot.overrides[name]
            if (Array.isArray(slot.injected)) slot.injected = slot.injected.filter((x) => x !== name)
          }
          writeFileAtomic(stPath, JSON.stringify(st, null, 2) + '\n')
        }
      } catch {
        /* state.json 坏了不影响删除本身 */
      }
      // ⑤ 记忆怎么处理，看 memoryAction
      let touched = 0
      if (action !== 'keep') {
        const d = getDb()
        if (d) {
          for (const lv of ['project', 'branch', 'detail']) {
            try {
              const rows = d.prepare(`SELECT id, project FROM ${lv}`).all()
              for (const r of rows) {
                const list = String(r.project || '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                // 精确命中该项目名，或者它的子项目（`该项目/xxx`）
                const hit = list.some((p) => p === name || p.startsWith(name + '/'))
                if (!hit) continue
                if (action === 'global') {
                  const next = list.filter((p) => !(p === name || p.startsWith(name + '/')))
                  d.prepare(`UPDATE ${lv} SET project = ?, updated_at = ? WHERE id = ?`).run(
                    next.length ? next.join(',') : '全局',
                    Date.now(),
                    r.id,
                  )
                } else {
                  d.prepare(`UPDATE ${lv} SET status = 'stale', updated_at = ? WHERE id = ?`).run(
                    Date.now(),
                    r.id,
                  )
                }
                touched += 1
              }
            } catch {
              /* 某张表结构不对就跳过 */
            }
          }
        }
      }
      sendJson(res, { ok: true, name, memoryAction: action, memoriesTouched: touched, bodyKept })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: String((e && e.message) || e) })
    }
  }

  const projectCreateHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const b = await readJsonBody(req, res)
      // 🛑 null = 请求体超限/读失败，413 已经发过了。
      //    原来失败也 resolve({})，handler 把空对象当正常 body 继续跑，
      //    接着又 setHeader/sendJson ⇒ ERR_HTTP_HEADERS_SENT 抛两次，
      //    async handler reject 后按 uncaughtException 处理，可能直接带走主进程。
      if (b === null) return
      const name = String(b.name || '').trim()
      if (!name) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '项目名不能为空' })
        return
      }
      // 🛑 项目名会进 JSON key 和文件名，挡掉路径分隔符和 Windows 非法字符
      if (/[\\/:*?"<>|]/.test(name) || name.includes('..')) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '项目名里不能有 \\ / : * ? " < > | 这些字符' })
        return
      }
      // 🛑 名字会变成 `<name>.md`：太长会撞 ENAMETOOLONG（500），限制到 40 字
      if (name.length > 40) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '项目名最多 40 个字' })
        return
      }
      const cfgPath = path.join(PROJECT_CORE_ROOT, 'projects.json')
      const kw = kwOf(b.keywords)
      // 🛑 2026-11-19 审计修：读-改-写必须紧挨着，中间不能有别的 IO。
      //    原来是「先读盘做重名检查 → 在内存里塞新项目 → 几十行之后再写回」，
      //    这期间只要别的进程（第二个 DSH 实例）或用户手改过 projects.json，
      //    写回就会拿旧副本覆盖，对方刚加的项目整条消失。
      //    现在一次做完：读 → 查重 → 合并 → 原子写。
      // ⚠️ 文件存在但解析失败时**不能**当成空对象继续写 —— 那等于把人家配置清空。
      //    （只有"存在且内容空白"才算空配置：0 字节文件是常见状态。）
      let j = {}
      let rawText = ''
      try {
        rawText = fs.readFileSync(cfgPath, 'utf8')
      } catch {
        rawText = null
      }
      if (rawText === null) {
        j = {} // 文件不存在：全新开始
      } else if (rawText.trim() === '') {
        j = {} // 存在但是空文件（0 字节）：当空配置，不是"坏了"
      } else {
        try {
          j = JSON.parse(rawText)
        } catch {
          res.statusCode = 500
          sendJson(res, { ok: false, error: 'projects.json 解析失败，先把配置文件修好' })
          return
        }
      }
      // 🛑 「能 parse 但不是对象」（`"abc"` / `[1,2]` / `null`）不能当空配置往下走 ——
      //    那样会把人家原有的配置整份写回空对象。只有"内容为空"才算空配置。
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: 'projects.json 顶层不是对象，先把配置文件修好' })
        return
      }
      if (!j.projects || typeof j.projects !== 'object' || Array.isArray(j.projects)) j.projects = {}
      // 🛑 必须用 hasOwnProperty：项目名填 `__proto__` / `constructor` / `toString`
      //    会走原型链拿到真值，被误判成"已经有这个项目了"（409）。
      if (Object.prototype.hasOwnProperty.call(j.projects, name)) {
        res.statusCode = 409
        sendJson(res, { ok: false, error: `已经有一个叫「${name}」的项目了` })
        return
      }
      // 🛑 父项目必须**已经存在**。原来是把不存在的父名静默过滤掉，
      //    用户填错一个字就变成"项目建好了但没挂上"：不缩进、不跟着父注入，
      //    而且全程没有任何提示（查起来很费劲）。现在直接拒绝并点名是谁不存在。
      const wantParents = parentsOf({ parent: b.parent }).filter((p) => p !== name)
      {
        const missing = wantParents.filter((p) => !Object.prototype.hasOwnProperty.call(j.projects, p))
        if (missing.length) {
          res.statusCode = 400
          sendJson(res, {
            ok: false,
            error: `父项目不存在：${missing.join('、')}（要挂到父下面，先把父项目建好）`,
          })
          return
        }
      }
      j.projects[name] = {
        file: `${name}.md`,
        keywords: kw,
        linked: [],
        // 2026-11-21：支持多父。传数组或逗号分隔的字符串都行，
        // 归一后只保留**已存在**的项目名（防手滑写错父名后永远挂不上）。
        // 🛑 但"名字不存在"不能静默丢掉 —— 用户会以为挂上了，实际没挂：
        //    面板上不缩进、注入也不带进来，而且完全没有任何提示。
        //    上面先查一遍，有不存在的就明确报错。
        parent: wantParents,
      }
      fs.mkdirSync(PROJECT_CORE_ROOT, { recursive: true })
      writeFileAtomic(cfgPath, JSON.stringify(j, null, 2) + '\n')
      // 🆕 2026-11-22：**只登记层级、不写核心正文**（面板上勾「只挂层级」）。
      //
      // 动机：「有时候其实没必要写核心」—— 一个项目可能只想挂到父下面
      // （为了归属、层级、跟着父一起被带出来），但它本身没什么「不看就会做错」的东西。
      // 这时写一个**空文件**就对了：`fileOk` 是按「正文非空」判的
      // （project-core.js 里 `fileOk = s.trim().length > 0`），空文件 ⇒
      // 面板显示「没写文件」、注入时也不带任何内容 —— 正是想要的效果。
      //
      // 🛑 不能走下面那条「content 为空就填骨架」的分支：那是给**真想写核心**的人
      //    准备的兜底，而这里要的恰恰是「空着」。所以用 `empty: true` 显式区分，
      //    不靠 content 是不是空串 —— 否则用户手抖清空 textarea 也会变成一个空壳，
      //    而他自己以为是"创建失败"。
      const shellOnly = b.empty === true
      const body = shellOnly
        ? ''
        : String(b.content || '').trim() ||
          `# ${name} · 项目核心

> 只写「不知道就会做错」的东西。背景、历史、代码说明不要放这里。

## 坑
- （这一条不看会怎么出错？）
`
      writeFileAtomic(path.join(PROJECT_CORE_ROOT, `${name}.md`), body)
      log(`panel: create project ${name} (${kw.length} keywords)${shellOnly ? ' [只挂层级，没写正文]' : ''}`)
      sendJson(res, { ok: true, name, keywords: kw.length, shellOnly })
    } catch (e) {
      // 🛑 已经发过响应就不要再发：二次 setHeader/end 会抛
      //    ERR_HTTP_HEADERS_SENT，async handler 里抛出会被当成 unhandledRejection。
      if (!res.headersSent) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      } else {
        log(`panel: create project 失败（响应已发）: ${e && e.message}`)
      }
    }
  }

  // ── 历史对话检索（面板用）────────────────────────
  // 和 memory_search 的 includeConversations 共用同一套索引，区别只是返回 JSON。
  // ⚠️ 索引过期时这里会重建（分片让出事件循环，界面不会僵住，面板照样显示"正在建索引"）。
  const convSearchHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const q = (u.searchParams.get('q') || '').trim()
      const k = Math.max(1, Math.min(50, Number(u.searchParams.get('k')) || 12))
      if (!q) {
        sendJson(res, { ok: true, hits: [], stats: null })
        return
      }
      const { rows, stats } = await convSearchRows(q, k)
      sendJson(res, {
        ok: true,
        stats,
        hits: rows.map((r) => ({
          sid: r.sid,
          seq: r.seq,
          role: r.role,
          time: r.time,
          text: String(r.text).replace(/\s+/g, ' ').slice(0, 400),
        })),
      })
    } catch (e) {
      // 🛑 已经发过响应（或连接已断）就不要再发：二次 setHeader/end 会抛
      //    ERR_HTTP_HEADERS_SENT，async handler 里抛出会被宿主 catch 成 res.destroy()，
      //    客户端看到的是网络错误而不是 500。
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      }
    }
  }

  // 按 sid + seq 读原文（v3，面板用）：点历史对话的某一条，或者直接填会话+序号跳过去。
  // 为什么不复用 conv-search：那个是全文搜，按不了序号；要翻「确定的某一条」只能走这里。
  const convReadHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const sid = (u.searchParams.get('sid') || '').trim()
      const seq = Number(u.searchParams.get('seq')) || 0
      const before = Math.max(0, Math.min(20, Number(u.searchParams.get('before')) || 2))
      const after = Math.max(0, Math.min(20, Number(u.searchParams.get('after')) || 2))
      if (!sid || !seq) {
        sendJson(res, { ok: false, error: '需要 sid 和 seq' })
        return
      }
      const r = sessionMessageAt(sid, seq, { before, after })
      if (!r) {
        sendJson(res, { ok: false, error: '取不到会话存档' })
        return
      }
      // 🛑 2026-11-20 修：`found:false` 时**不能**再回 `ok:true`。
      //    `sessionMessageAt` 的约定是 `found:false` ⇒ 没有 `window` 字段（会话不存在、
      //    或该 seq 不在这个会话里），而面板前端是这么判的：
      //       if (!d || !d.ok) { 显示「取不到：…」; return }
      //    回 true 的话前端会继续往下读 `d.window`（undefined）⇒ 弹出一个**空白的展开框**，
      //    用户看到的是"点了没反应"，而不是那句很有用的提示
      //    （`这个会话里没有 seq=N；最近几条是 12, 13, 14` —— 本来就是留给人换 seq 再试的）。
      if (r.found === false) {
        sendJson(res, { ok: false, error: r.message || '取不到这条', sid: r.sid, total: r.total })
        return
      }
      sendJson(res, { ok: true, ...r })
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      }
    }
  }

  // 强制重建会话索引（面板上的按钮；平时靠 30 分钟过期自动重建）
  const convRebuildHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      if (!convDb) convDb = openSessionIndex(convDbPath)
      const r = await ensureConvIndex()
      const stats = sessionIndexStats(convDb)
      log(
        `面板触发重建会话索引: ${r.scanned} 文件 / ${r.msgs} 条 / ${r.ms}ms` +
          (r.errors && r.errors.length ? `，⚠️ ${r.errors.length} 个文件失败` : ''),
      )
      // 🛑 errors 必须回给前端：原来只取前 5 条存在返回值里、两个调用方都不看，
      //    用户点完「重建」只看到"更新 N 个"，永远不知道有几个会话没进索引。
      sendJson(res, {
        ok: true,
        scanned: r.scanned,
        updated: r.updated,
        skipped: r.skipped,
        msgs: r.msgs,
        ms: r.ms,
        errors: r.errors,
        stats,
      })
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      }
    }
  }

  // ── 方案列表（面板用）────────────────────────
  // 只返回 active 的 plan，带上勾选进度和「没做完的第一项」——
  // 一眼看到卡在哪，不用逐份点开。
  const plansHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const d = getDb()
      if (!d) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: '记忆库没打开' })
        return
      }
      const rows = d
        .prepare(
          `SELECT id, project, title, content, updated_at FROM branch
           WHERE category = 'plan' AND status = 'active' ORDER BY updated_at DESC`,
        )
        .all()
      const plans = rows.map((r) => {
        const pg = planProgress(r.content)
        return {
          id: r.id,
          project: r.project,
          title: r.title,
          updated_at: r.updated_at,
          done: pg.done,
          todo: pg.todo,
          total: pg.total,
          left: planLeftItems(r.content, 8),
        }
      })
      sendJson(res, { ok: true, plans })
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      }
    }
  }

  // ── 时间轴（面板用）────────────────────────
  // 把四层的新增条目按天铺开。为什么要它：一千多条教训/事实摊平了看不出
  // 先后和因果，拼不成执行方案 —— 上了时间轴才能看出"哪一批是同一阶段的产物、
  // 后来被什么推翻了"。
  // ⚠️ 排序用 `COALESCE(happened_at, created_at)`：**发生时间优先，没有才退回
  //    记录时间**。（这段注释原来写的是"现在用的是 created_at，不是 happened_at，
  //    先看效果再说"—— 那是加字段之前的过渡状态，代码早就改了，注释没跟着改。
  //    2026-11-19 审计挑出来：留着会把下一个人带回去改错。）
  //    两者语义不同：created_at 是"什么时候写进库的"，happened_at 是"这件事
  //    什么时候发生的"——今天补记上周的事，两者差好几天。
  const timelineHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      const d = getDb()
      if (!d) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: '记忆库没打开' })
        return
      }
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const days = clamp(Number(u.searchParams.get('days') ?? 30), 1, 3650)
      const proj = String(u.searchParams.get('project') || '').trim()
      // 层筛选支持逗号多选（pickLayers 只认单层、非法还返回 null，这里不能用它）
      const layerParam = String(u.searchParams.get('layers') || '').trim()
      const wantLayers = layerParam
        ? layerParam
            .split(',')
            .map((s) => s.trim())
            .filter((s) => LEVELS.includes(s))
        : []
      const onlyEdited = u.searchParams.get('only') === 'edit'
      const since = Date.now() - days * 864e5
      const rows = []
      for (const layer of LEVELS) {
        if (wantLayers.length > 0 && !wantLayers.includes(layer)) continue
        // 🛑 core 表**没有 project 列**（核心记忆是跨项目的）。
        //    原来统一 SELECT project，core 那层一查就抛 no such column，
        //    被 catch 静默跳过 ⇒ 时间轴上永远看不到核心层的改动。
        //    所以 core 单独处理：查的时候补一个 NULL AS project，
        //    按项目筛时直接跳过它（核心不属于任何项目）。
        const isCore = layer === 'core'
        if (isCore && proj) continue
        // 「这条记忆属于什么时候」= 事件发生时间优先，没填就退回记录时间。
        // 包 B 后半加的 happened_at 就是为这个：今天补记上周的事，
        // 只按 created_at 排会把它堆到今天，看不出真实时间线。
        const T = `COALESCE(happened_at, created_at)`
        const colList = isCore
          ? `id, title, content, NULL AS project, category, created_at, updated_at, happened_at, ${T} AS at_time`
          : `id, title, content, project, category, created_at, updated_at, happened_at, ${T} AS at_time`
        // 🛑 新增和**修改**都要上轴：一条 10 月写的规则今天改了，如果只看 created_at，
        //    它还停在 10 月，看着像"一直没变过"。而"记忆会变"正是包 C 要做的。
        //    所以条件放成「创建或更新落在窗口内」，kind 区分是新增还是改动。
        try {
          const rs = proj
            ? d
                .prepare(
                  `SELECT ${colList} FROM ${layer}
                   WHERE (${T} >= ? OR updated_at >= ?) AND status = 'active' AND project LIKE ?
                   ORDER BY MAX(${T}, updated_at) DESC LIMIT 400`,
                )
                .all(since, since, '%' + proj + '%')
            : d
                .prepare(
                  `SELECT ${colList} FROM ${layer}
                   WHERE (${T} >= ? OR updated_at >= ?) AND status = 'active'
                   ORDER BY MAX(${T}, updated_at) DESC LIMIT 400`,
                )
                .all(since, since)
          for (const r of rs) {
            const isNew = (r.at_time || 0) >= since
            // 排序和分组都用"这件事落在哪一天"：新增看事件时间，改动看更新时间
            const at = isNew ? r.at_time || 0 : r.updated_at || 0
            if (onlyEdited && isNew) continue
            rows.push({ ...r, layer, kind: isNew ? 'new' : 'edit', at })
          }
        } catch {
          /* 某层的表结构不对就跳过，不影响别的层 */
        }
      }
      rows.sort((a, b) => (b.at || 0) - (a.at || 0))
      // 按天分组（本地时区，不用 toISOString —— 那是 UTC，会把凌晨的算到前一天）
      const groups = []
      const idx = new Map()
      for (const r of rows) {
        const dt = new Date(r.at || 0)
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        let g = idx.get(key)
        if (!g) {
          g = { date: key, items: [] }
          idx.set(key, g)
          groups.push(g)
        }
        g.items.push({
          id: r.id,
          layer: r.layer,
          category: r.category,
          kind: r.kind,
          title: r.title || '',
          project: r.project || '',
          snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 90),
          created_at: r.created_at || 0,
          updated_at: r.updated_at || 0,
        })
      }
      sendJson(res, { ok: true, days, total: rows.length, layers: wantLayers, groups })
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: e && e.message })
      }
    }
  }

  // 读单条完整数据（面板编辑器专用）。
  // 为什么必须单独开一个：/search 和 /recent 返回的是**搜索结果片段**
  // （content 截到 220 字、没有 title/keywords/project 字段）。
  // 面板拿它去填编辑器再保存，就会把标题清空、关键词清空、项目改成「全局」、
  // 正文变成截断版 —— 正常操作点一下就丢数据，不需要任何恶意输入。
  const entryHandler = async (req, res) => {
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    try {
      res.setHeader('cache-control', 'no-store')
      // 🛑 必须先拿连接：漏这行会让整个接口恒 500「d is not defined」，
      //    面板「改」100% 打不开（2026-11-18 加这个路由时漏的）。
      const d = getDb()
      if (!d) {
        res.statusCode = 500
        sendJson(res, { ok: false, error: '记忆库没打开' })
        return
      }
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const id = String(u.searchParams.get('id') || '').trim()
      const lv = String(u.searchParams.get('level') || '').trim()
      if (!id) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: '缺 id' })
        return
      }
      const layers = pickLayers(lv)
      if (!layers) {
        res.statusCode = 400
        sendJson(res, { ok: false, error: `level 只能是 ${LEVELS.join(' / ')}` })
        return
      }
      for (const layer of layers) {
        const row = d.prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ? ESCAPE '\\'`).get(id, idPrefix(id))
        if (!row) continue
        // 显式列而不是 {...row}：source_session / hit_count 是内部字段，面板用不到；
        // 摊平 SELECT * 的话，以后加内部列会自动出到前端。
        sendJson(res, {
          ok: true,
          entry: {
            id: row.id,
            level: layer,
            category: row.category,
            project: row.project,
            title: row.title,
            content: row.content,
            importance: row.importance,
            keywords: row.keywords,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
            // 面板编辑器要回填这三样（2026-11-19 补）。happened_at 是毫秒数，
            // 前端自己格式化成 YYYY-MM-DD 填进 date 控件。
            happened_at: row.happened_at,
            context: row.context,
            mood: row.mood,
          },
        })
        return
      }
      res.statusCode = 404
      sendJson(res, { ok: false, error: '没找到这条记忆' })
    } catch (e) {
      res.statusCode = 500
      sendJson(res, { ok: false, error: String((e && e.message) || e) })
    }
  }

  try {
    const routes = [
      { kind: 'exact', path: '/dsh-memory/panel', handler: panelHandler },
      { kind: 'exact', path: '/dsh-memory/stats', handler: statsHandler },
      // 2026-11-25：手动压缩按钮（auto-checkpoint 归档后，把那个「冲水键」搬回来）
      { kind: 'exact', path: '/dsh-memory/compact', handler: compactHandler },
      { kind: 'exact', path: '/dsh-memory/search', handler: searchHandler },
      { kind: 'exact', path: '/dsh-memory/recent', handler: recentHandler },
      { kind: 'exact', path: '/dsh-memory/projects', handler: projectsHandler },
      { kind: 'exact', path: '/dsh-memory/projects/set', handler: projectsSetHandler },
      { kind: 'exact', path: '/dsh-memory/projects/lock', handler: projectsLockHandler },
      { kind: 'exact', path: '/dsh-memory/projects/file', handler: projectFileHandler },
      { kind: 'exact', path: '/dsh-memory/projects/create', handler: projectCreateHandler },
      // 2026-11-21：项目重命名（连带改 parent/linked/.md/state.json/记忆的 project 字段）
      { kind: 'exact', path: '/dsh-memory/projects/rename', handler: projectRenameHandler },
      // 2026-11-21：项目删除（记忆怎么处理由 memoryAction 决定：keep / global / stale）
      { kind: 'exact', path: '/dsh-memory/projects/delete', handler: projectDeleteHandler },
      // 2026-11-21：项目合并（from 并入 to；记忆归属改过去，正文 append 或只留底）
      { kind: 'exact', path: '/dsh-memory/projects/merge', handler: projectMergeHandler },
      { kind: 'exact', path: '/dsh-memory/conv-search', handler: convSearchHandler },
      { kind: 'exact', path: '/dsh-memory/conv-read', handler: convReadHandler },
      { kind: 'exact', path: '/dsh-memory/conv/rebuild', handler: convRebuildHandler },
      { kind: 'exact', path: '/dsh-memory/item/add', handler: itemAddHandler },
      { kind: 'exact', path: '/dsh-memory/plans', handler: plansHandler },
      { kind: 'exact', path: '/dsh-memory/timeline', handler: timelineHandler },
      { kind: 'exact', path: '/dsh-memory/entry', handler: entryHandler },
      { kind: 'exact', path: '/dsh-memory/item/update', handler: itemUpdateHandler },
      { kind: 'exact', path: '/dsh-memory/item/delete', handler: itemDeleteHandler },
    ]
    // 🛑 2026-11-18 审计修：逐个注册、边注册边收集 disposer。
    //    原来 `routes.map(register)` 里第 N 个抛错时，前面 N-1 个已经注册了
    //    但 disposers 数组还没建起来、ctx.effect 也没注册 ⇒ 这批路由永远不会被释放，
    //    下次热重载继续冲突。
    const disposers = []
    try {
      for (const r of routes) disposers.push(ctx.webServer.register(r))
    } catch (e) {
      for (const dsp of disposers) {
        try {
          dsp?.()
        } catch {}
      }
      log(`route registration FAILED: ${e && e.message}`)
      return
    }
    ctx.effect(
      () => () => {
        for (const dsp of disposers) {
          try {
            dsp?.()
          } catch {}
        }
      },
      'dsh-memory: routes'
    )
    log(`routes ready: ${routes.map((r) => r.path).join(' · ')}`)
  } catch (e) {
    log(`route registration FAILED: ${e && e.message}`)
  }
}
