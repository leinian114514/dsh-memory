/**
 * 注入层：两条路径。
 *
 * A. 首轮注入（会话第一条真人消息前）——不检索，按结构搬：
 *    soul 全量 + user 全量 + 全局 rules(importance>=2) + 项目名清单
 *    因为 user 有上百条，必须分级截断，否则一次就把上下文塞满。
 *
 * B. 每条消息命中（pre-step，取最后一条真人消息）——
 *    候选限 active 的 fact/lesson/rules/topic，范围限「全局 ∪ 当前项目」，
 *    排除本会话自己写进去的条目，按 keywordHitScore 打分取前 hitTopK 条。
 */
import fs from 'node:fs'
import path from 'node:path'
import { bm25Search, keywordHitScore } from './search.js'
import {
  isGlobalProject,
  list,
  listProjectNames,
  projectCovers,
  toDoc,
} from './db.js'

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  return t.slice(0, n) + '…'
}

/**
 * 首轮注入正文。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{maxChars?:number, perEntry?:number}} [opts]
 */
export function buildInjectionBody(db, opts = {}) {
  const maxChars = opts.maxChars ?? 8000
  const perEntry = opts.perEntry ?? 120
  const parts = []
  let total = 0

  const add = (heading, rows, { full = false } = {}) => {
    if (!rows || rows.length === 0) return
    const lines = [heading]
    for (const r of rows) {
      const body = full ? String(r.content ?? '') : truncate(r.content, perEntry)
      const title = String(r.title ?? '').trim()
      const line = `- ${title ? title + '：' : ''}${body}`
      if (total + line.length > maxChars) {
        lines.push(`- （余下 ${rows.length - lines.length + 1} 条因长度省略）`)
        break
      }
      lines.push(line)
      total += line.length
    }
    if (lines.length > 1) parts.push(lines.join('\n'))
  }

  add('## 关于你', list(db, 'soul', { status: 'active' }), { full: true })
  add('## 关于用户', list(db, 'user', { status: 'active' }))

  const globalRules = list(db, 'rules', { status: 'active' }).filter(
    (r) => isGlobalProject(r.project) && (r.importance ?? 1) >= 2
  )
  add('## 规则（全局、重要性>=2）', globalRules)

  const projects = listProjectNames(db)
  if (projects.length > 0 && total + projects.length * 12 < maxChars) {
    parts.push('## 项目\n' + projects.map((p) => `- ${p}`).join('\n'))
  }

  return parts.join('\n\n')
}

// ---------- 从用户口语里提核心词 ----------
// 自动命中的 query 是整句口语，直接分词会出大量噪音 bigram（「缩了」「了几」）。
// 这版提取器在 dsh-mem-tools 里实测有效：按标点切小句 → 去停用词 → 取 2~6 字连续段
// → 去尾部虚词 → 只保留信息量最大的一个词（多词 AND 会互相拖死）。
const STOP =
  /(你|我|他|她|它|的|了|吗|呢|吧|啊|呀|哦|嗯|这个|那个|一下|一条|一段|一点|能不能|可以|是不是|有没有|怎么|什么|哪个|哪些|找|说说|说过|说话|内容|东西|事情|时候|需要|只是|就行|帮我|给我|早期|以前|之前|记得|还记|上次|我们|聊过|小段|几|次|个|里|中|上|下|在|干|嘛|呗|弄|搞|用|把|被|让|给|对|和|跟|从|到|还|都|也|就|才|再|又|很|太|最|更|没|不|要|会|能|说|看|想|知道|告诉|问|啥|咋|为什么|什么样|怎么样|是多少|是什么)/g

export function pickTerms(text) {
  const out = []
  const chunks = String(text || '')
    .split(/[，。！？、；：,.!?;:\s"""'（）()\[\]【】《》]+/)
    .filter(Boolean)
  for (const ch of chunks) {
    const seg = ch.replace(STOP, ' ').trim()
    for (const piece of seg.split(/\s+/)) {
      const runs = piece.match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9_]{2,}/g) || []
      for (const r of runs) {
        if (r.length <= 6) out.push(r)
        else out.push(r.slice(0, 4))
      }
    }
  }
  const seen = new Set()
  const uniq = []
  for (let w of out) {
    w = w.replace(/(叫|是|有|在|和|的|了|吧|吗|呢|着|过)$/, '')
    if (w.length < 2 || seen.has(w)) continue
    seen.add(w)
    uniq.push(w)
  }
  uniq.sort((a, b) => b.length - a.length)
  return uniq.slice(0, 2)
}

/**
 * 每条消息命中：返回被选中的条目（已排序、已去重已见）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{userText:string, sessionId?:string, currentProject?:string|null,
 *          hitTopK?:number, seen?:Set<string>}} opts
 */
export function buildHitInjection(db, opts = {}) {
  const userText = String(opts.userText ?? '')
  if (!userText.trim()) return []

  const hitTopK = Math.max(0, Math.min(10, opts.hitTopK ?? 2))
  if (hitTopK === 0) return []

  const sessionId = opts.sessionId ?? null
  const currentProject = opts.currentProject ?? null
  const seen = opts.seen ?? new Set()

  // 检索词：先提核心词；提不出来才退回原句
  const terms = pickTerms(userText)
  const query = terms.length > 0 ? terms.join(' ') : userText.slice(0, 200)
  if (!query.trim()) return []

  const rows = []
  for (const lv of ['fact', 'lesson', 'rules', 'topic']) {
    for (const raw of list(db, lv, { status: 'active' })) {
      const d = toDoc(raw, lv)
      // ⚠️ 当前项目未知时**不要按项目过滤**（2026-11-12 修的真 bug）。
      //
      // agent/pre-step 的 waterfall 参数里没有 agent，拿不到会话当前项目，
      // 所以 currentProject 一直是 null。而原来的判据是
      //   isGlobalProject(d.project) || (currentProject && projectCovers(...))
      // null 让后半段恒为 false ⇒ 只有「全局」条目能命中。
      // 实测本库挂项目的条目占 79.8%（fact 277 / lesson 860 / topic 45 / rules 38），
      // 于是每消息命中只能看见那 20.2%，表现出来就是**反复注入同样几条全局条目**。
      // 宁可多命中几条，也不能让五分之四的记忆永远进不来。
      const inScope =
        currentProject === null || currentProject === undefined
          ? true
          : isGlobalProject(d.project) || projectCovers(d.project, currentProject)
      if (!inScope) continue
      // 本会话自己刚写进去的，没必要再回注给它
      if (sessionId && d.source_session === sessionId) continue
      rows.push(d)
    }
  }
  if (rows.length === 0) return []

  // 匹配面回到「标题 + 关键词」：关键词是人工提炼过的，信号强噪音低；
  // 用全文会让长 lesson 的分数被长度归一化吃掉，短条目反而占便宜（实测过）。
  const docs = rows.map((d) => {
    const face = d.keywords.length ? d.keywords.join(' ') : String(d.content).slice(0, 100)
    return { ...d, content: face }
  })

  const ranked = bm25Search(query, docs, { k: Math.max(hitTopK * 4, 8), b: 0 })

  const picked = []
  for (const h of ranked) {
    if (seen.has(h.id)) continue
    picked.push(h)
    if (picked.length >= hitTopK) break
  }
  return picked
}

/** 把命中条目格式化成注入文本 */
export function formatHitInjection(hits, opts = {}) {
  if (!hits || hits.length === 0) return ''
  const perEntry = opts.perEntry ?? 240
  const lines = ['⟪记忆命中 · dsh-memory⟫ 下面几条跟本轮消息相关，参考用，不必逐条复述：']
  for (const h of hits) {
    const title = String(h.title ?? '').trim()
    lines.push(`- [${h.level}] ${title ? title + '：' : ''}${truncate(h.content, perEntry)}`)
  }
  return lines.join('\n')
}

// ---------- 会话已见记录 ----------

function sessionFile(workspace, sessionId) {
  return path.join(workspace, '.dsh-memory', 'sessions', `${sessionId || 'unknown'}.json`)
}

/** 空账本（每次新建，避免调用方改到同一份对象）。字段顺序无所谓，按属性名取值。 */
function emptyLedger() {
  // injected/searched/accessed = 已见过的记忆 id；compactions = 已经补注入过的压缩 id
  return { searched: [], accessed: [], injected: [], compactions: [] }
}

export function readSeen(workspace, sessionId) {
  try {
    const p = sessionFile(workspace, sessionId)
    if (!fs.existsSync(p)) return emptyLedger()
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return {
      injected: Array.isArray(j.injected) ? j.injected : [],
      searched: Array.isArray(j.searched) ? j.searched : [],
      accessed: Array.isArray(j.accessed) ? j.accessed : [],
      compactions: Array.isArray(j.compactions) ? j.compactions : [],
    }
  } catch {
    return emptyLedger()
  }
}

export function markSeen(workspace, sessionId, key, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  try {
    const p = sessionFile(workspace, sessionId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const cur = readSeen(workspace, sessionId)
    const set = new Set(cur[key] ?? [])
    for (const id of ids) set.add(id)
    cur[key] = [...set].slice(-500)
    fs.writeFileSync(p, JSON.stringify(cur))
  } catch {
    /* 记账失败不影响注入 */
  }
}

/** 已见集合（三个来源合并） */
export function readSeenSet(workspace, sessionId) {
  const ledger = readSeen(workspace, sessionId)
  const merged = new Set()
  for (const bucket of [ledger.injected, ledger.searched, ledger.accessed]) {
    for (const id of bucket) merged.add(id)
  }
  return merged
}
