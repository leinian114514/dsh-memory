/**
 * dsh-memory — 独立记忆系统插件。
 *
 * 设计目标是**自己掌控**：不依赖 meow-memory 的代码与更新节奏，
 * 数据放在 <workspace>/.dsh-memory/memory.db（schema 与它一致，迁移零转换）。
 *
 * 两条注入路径照搬成熟设计：
 *   首轮 —— soul 全量 + user 全量 + 全局 rules(重要性>=2) + 项目名
 *   每条 —— fact/lesson/rules/topic 里按关键词打分取前 hitTopK 条
 *
 * 安全边界：只往 messages 追加一条 user 消息，从不 reject、从不改用户输入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  bumpHit,
  isGlobalProject,
  LEVELS,
  list,
  listProjectNames,
  openFor,
  parseKeywords,
  projectListOf,
  toDoc,
  SEARCH_LEVELS,
} from './db.js'
import { bm25Search, hasPhonetic, tokenize } from './search.js'
import { ensureSchema } from './schema.js'
import {
  buildHitInjection,
  buildInjectionBody,
  formatHitInjection,
  markSeen,
  readSeen,
  readSeenSet,
} from './inject.js'

export const name = 'dsh-memory'
// webServer 用于侧栏面板的两个 HTTP 路由；connection 只在运行时探测（拿它做信任围栏）
// tokenMeter 是 2026-11-14 加的：落档催办要按真实 token 判断水位，
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
 * 本步消息里有没有「刚压缩完」的标记。
 *
 * 压缩完成后 DSH 会插一条 `source.kind === 'compact-checkpoint'` 的用户消息，
 * 里面带着 `compactionId`。这是 pre-step 里**唯一**能判断"刚压过"的信号 ——
 * 我们拿不到 agent/session，没法像 auto-checkpoint 那样倒扫 `session.eventAt(seq)` 找
 * `compaction/end`。同一个 compactionId 只补注入一次，避免连续几步反复灌。
 */
function findCompactionId(messages) {
  if (!Array.isArray(messages)) return ''
  for (const m of messages) {
    const src = m && m.source
    if (src && src.kind === 'compact-checkpoint') {
      const id = String(src.compactionId ?? '')
      if (id) return id
    }
  }
  return ''
}

/**
 * 两组 token 的 Jaccard 相似度（交集 / 并集）。
 *
 * 为什么查重要用它、而不是 BM25 分数：实测拿条目自己的内容去检索，
 * 「最像的另一条」BM25 分数中位就有 1356（长文本天然匹配多），
 * 完全无法区分"同一条写了两遍"和"讲同一件事的两条"。
 * 换成 Jaccard 后分界很干净（本库 1994 条、400 对候选实测）：
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
function findNearDuplicate(db, draft, threshold, relatedFloor = 0.3) {
  const pool = []
  for (const layer of LEVELS) {
    for (const raw of list(db, layer, { status: 'active' })) pool.push(toDoc(raw, layer))
  }
  const none = { duplicate: null, related: null }
  if (pool.length === 0) return none

  const keywords = Array.isArray(draft.keywords) ? draft.keywords : []
  const probe = `${draft.title || ''} ${draft.content} ${keywords.join(' ')}`
  const candidates = bm25Search(probe, pool, { k: 8 })
  if (candidates.length === 0) return none

  const mine = new Set(tokenize(`${draft.title || ''} ${draft.content}`))
  let best = null
  let related = null
  for (const c of candidates) {
    const j = jaccardOf(mine, new Set(tokenize(`${c.title || ''} ${c.content || ''}`)))
    if (best === null || j > best.j) best = { j, doc: c }
    if (j >= relatedFloor && j < threshold && (related === null || j > related.j)) {
      related = { j, doc: c }
    }
  }
  return {
    duplicate: best !== null && best.j >= threshold ? best : null,
    related,
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
 * 各层要写的列不完全一样（project 有 subcategory、topic 有 goal）。
 * 抽成一个纯函数，省得在工具里堆 if 链。
 */
/**
 * 自动捕获规则：把明确的长期偏好/规则直接落库，不用等我动手。
 *
 * 判据宁缺毋滥 —— 抓错会污染库，比漏记更糟。所以只认「带时间副词」或「明说记住」
 * 或「明确好恶」或「带对象的禁令」，纯当轮指令（"我不要这个"）一律不抓。
 */
/**
 * 落档催办（pre-step 预制发送，2026-11-14 加）。
 *
 * 为什么不用 auto-checkpoint 自己的催办：它走 `sessionController.prompt()`，那是「插入」语义
 * —— 消息进输入框等用户点确定。用户在干活时根本不会注意到，于是每次都是「突然压缩」。
 * 用户原话：「那个是预制发送，不是真正的插入」。
 */
const PRECOMPACT_NUDGE_LEAD = '[auto-checkpoint] 上下文即将压缩（当前 '
const PRECOMPACT_FILE_RE = /^precompact-.*\.md$/i

/**
 * 扫工作区找最新的 precompact-*.md，返回 { path, mtime } 或 null。
 * 只看工作区根目录，不递归 —— 落档按约定就在根上。
 */
function findLatestPrecompact(workspace) {
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true })
    let best = null
    for (const e of entries) {
      if (!e.isFile() || !PRECOMPACT_FILE_RE.test(e.name)) continue
      const p = path.join(workspace, e.name)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (best === null || st.mtimeMs > best.mtime) {
        best = { path: p, mtime: st.mtimeMs, name: e.name }
      }
    }
    return best
  } catch {
    return null
  }
}

/**
 * 落档催办文案。开头用 PRECOMPACT_NUDGE_LEAD，好让 auto-checkpoint 的自检也认出它。
 */
/**
 * 读 auto-checkpoint 的 remindTokens（压缩提醒水位）。
 * 读到就用它当判据 —— 这是「跟压缩插件用同一个水位」的唯一正确做法。
 */
let cachedRemindTokens = null
function readRemindTokens() {
  if (cachedRemindTokens !== null) return cachedRemindTokens
  try {
    const p = path.join(os.homedir(), '.dsh', 'auto-checkpoint.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const n = Number(j.remindTokens)
    cachedRemindTokens = Number.isFinite(n) && n > 0 ? n : 700000
  } catch {
    cachedRemindTokens = 700000
  }
  return cachedRemindTokens
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

function precompactNudgeText(workspace, found) {
  const abs = found ? found.path : path.join(workspace, 'precompact-<session>.md')
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


const AUTO_CAPTURE_RULES = [
  // 「以后/今后/下次」+ 15 字内出现规则词。
  // 原来要求「以后」紧跟动作词，像「以后改代码前都先备份」这种自然说法中间隔了
  // 「改代码前」几个字就匹配不上 —— 2026-11-13 实测暴露，放宽到 15 字窗口。
  { name: '未来规则', re: /(以后|今后|从现在起|下次).{0,15}(都|要|别|不|必须|一律|统一|先|少|多)/ },
  { name: '记忆指令', re: /^(记住|记一下|记着|别忘了)[:：,，\s]/ },
  { name: '好恶', re: /(我|咱)(很|挺|有点|最|特别)?\s*(喜欢|不喜欢|讨厌|受不了|爱看|不爱看|习惯|一般会)/ },
  { name: '禁令', re: /(不要|别再|不许|不准)(再)?\s*(给我|跟我|帮我|让我)/ },
]

/** 命中返回规则名，否则 null。 */
function matchAutoCapture(text) {
  const s = String(text || '').trim()
  if (s.length < 6 || s.length > 400) return null
  for (const r of AUTO_CAPTURE_RULES) {
    if (r.re.test(s)) return r.name
  }
  return null
}


function insertPlan(args, layer, id, body, now) {
  const cols = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at']
  const vals = [
    id,
    args.title || null,
    body,
    clamp(args.importance ?? 1, 1, 4),
    JSON.stringify(Array.isArray(args.keywords) ? args.keywords : []),
    'active',
    'dsh-memory',
    0,
    now,
    now,
    null,
  ]
  const project = String(args.project || '全局')
  if (layer === 'project') {
    cols.push('project', 'subcategory')
    vals.push(project, args.subcategory || null)
  } else if (layer === 'topic') {
    cols.push('goal', 'project')
    vals.push(null, project)
  } else if (layer === 'rules' || layer === 'fact') {
    cols.push('project')
    vals.push(project)
  }
  return { cols, vals }
}

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
 * 否则客户端的折叠逻辑和"这是插件说的不是用户说的"判断都会乱。
 */
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

/** 自动反思的提醒文案。刻意写成"可以不理"的语气 —— 提醒不是命令。 */
/**
 * 反思提醒的固定开头。后面会拼上「当前有哪些项目」—— 照 meow-memory 的
 * `resolveSlotText("reflect", { projectList })`：光说「该记了」没用，
 * 得让人看到**现在能往哪儿记**（2026-11-14 改）。
 */
const REFLECT_LEAD =
  '⟪记忆反思⟫ 已经 7 轮没往长期记忆里写东西了，而这几轮在干实事。\n' +
  '压缩一旦触发，这些细节就只剩摘要 —— 现在花 10 秒记几条，比之后重新摸索便宜得多。\n'

/** 反思提醒的清单部分（不含项目列表）。 */
const REFLECT_CHECKLIST =
  '\n先扫一遍，命中哪条就记哪条（一条 memory_remember，一句话 + 8~13 个关键词）：\n' +
  '· 定下了方案/取舍 → project 层（subcategory: decisions）\n' +
  '· 踩了坑、发现某个做法行不通 → lesson 层\n' +
  '· 摸清了某个机制/API 的因果 → topic 层\n' +
  '· 用户提了新偏好或禁令 → user 层\n' +
  '· 一条客观事实（版本号、路径、端口） → fact 层\n' +
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
 *   ② 各层列不一样（project 有 subcategory、topic 有 goal），触发器要写七份；
 *   ③ 我们的写入都走工具，工具层记就够了。
 * 库里的历史数据格式（hid/src_id/op/old_json/changed_at）与旧记录完全兼容。
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
 * 本步消息里出现了几次工具调用。
 * assistant 消息的 content 里 `{type:'tool-call', name}` 就是一次调用。
 */
function countToolCalls(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block && block.type === 'tool-call') n += 1
    }
  }
  return n
}

/** 本步有没有往记忆里写过东西（写过就不该再提醒他记） */
function wroteMemoryThisStep(messages) {
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (!block || block.type !== 'tool-call') continue
      const name = String(block.name || block.toolName || '')
      if (name === 'memory_remember' || name === 'memory_update') return true
    }
  }
  return false
}

/** 本步消息里有没有工具结果（有 = 正在干活，不是纯聊天） */
function hasToolResult(messages) {
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (!m) continue
    if (m.role === 'tool') return true
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block && (block.type === 'tool-result' || block.type === 'tool_result')) return true
    }
  }
  return false
}

/**
 * 本步有没有「写记忆」的工具调用（memory_remember / memory_update）。
 * 用来把 lastMemoryWriteTurn 推到当前轮 —— 按轮次算的反思靠它判断「最近写过没」。
 */
function hasMemoryWriteCall(messages) {
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (!b) continue
      const t = b.type
      if (t !== 'tool-call' && t !== 'tool_call' && t !== 'tool-use') continue
      const name = String(b.name || b.toolName || '')
      if (name === 'memory_remember' || name === 'memory_update') return true
    }
  }
  return false
}


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
  const lines = [`[${doc.level}] ${label}`]
  if (title) lines.push(title)
  if (body) lines.push(body)
  if (opts.withMeta === true) {
    lines.push(`keywords: ${(doc.keywords || []).join(', ')}`)
    lines.push(`project: ${doc.project || '（全局）'}`)
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
  const enableFirstTurn = config.firstTurn !== false
  const enableHit = config.hit !== false
  // 压缩后重注入：上下文被压成摘要时，把长期记忆快照再灌一遍。
  // 这是"压缩之后忘得太狠"的直接对策（对齐 meow-memory 的 post-compaction re-anchor）。
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
  let lastPrecompactCheckTurn = -999
  /** 上次催的时候那份落档的 mtime —— 同一份旧档只催一次 */
  /** 落档写完就自己按冲水键压缩（用户 2026-11-14 设计） */
  const autoCompactAfterPrecompact = config.autoCompactAfterPrecompact !== false
  /** 落档「刚写完」的判定窗口 */
  const precompactJustWrittenMs = Number.isFinite(config.precompactJustWrittenMs)
    ? Number(config.precompactJustWrittenMs)
    : 10 * 60 * 1000
  /** 上次压缩时的那份落档 mtime —— 同一份只压一次 */
  let lastCompactedPrecompactMtime = -1
  let lastPrecompactNudgedMtime = -1
  /** 诊断只打一次，看 pre-step 的 payload 到底有没有 agent */
  let precompactDiagDone = false


  // ── 自动捕获 ────────────────────────
  // 用户要求：**按轮次节流，不按时间**（「要不不要按时间，按轮次？按对话次数」）。
  // 理由：短时间里连说好几轮时，按时间会漏；按轮次才跟对话进度对齐。
  const enableAutoCapture = config.autoCapture !== false
  /** 每隔几轮允许捕获一次 */
  const autoCaptureEveryTurns = Number.isFinite(config.autoCaptureEveryTurns)
    ? Number(config.autoCaptureEveryTurns)
    : 2
  /** 每次会话最多写几条，防刷 */
  const autoCaptureMaxPerSession = Number.isFinite(config.autoCaptureMaxPerSession)
    ? Number(config.autoCaptureMaxPerSession)
    : 12
  let lastAutoCaptureTurn = -999
  let autoCaptureCount = 0
  /** 最近写过的话头，挡「同一句反复说」 */
  const autoCaptureSeen = new Set()

  /** 轮次闸：够轮数 + 没超上限 + 不是同一句。 */
  function autoCaptureAllowed(turnNo, text) {
    const t = Number.isFinite(turnNo) ? turnNo : 0
    if (autoCaptureCount >= autoCaptureMaxPerSession) return false
    if (t - lastAutoCaptureTurn < autoCaptureEveryTurns) return false
    if (autoCaptureSeen.has(text.slice(0, 80))) return false
    return true
  }


  const enableReflect = config.reflect !== false
    // ⚠️ 2026-11-13 改：时间判据默认**关掉**（设 0），改按轮次算。
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
  /** 最后一次提醒时的轮次 */
  let lastReflectTurn = -999
  /** 最后一次写记忆时的轮次（-999 = 本轮会话还没写过） */
  let lastMemoryWriteTurn = -999
  const hitTopK = Number.isFinite(config.hitTopK) ? Number(config.hitTopK) : 2
  const firstTurnMaxChars = Number.isFinite(config.firstTurnMaxChars)
    ? Number(config.firstTurnMaxChars)
    : 8000
  const debugFile = typeof config.debugFile === 'string' ? config.debugFile : ''
  // 过渡期用：跟 meow-memory 的 memory_* 同名的工具会被 DSH 拒绝注册，
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
      try {
        // 新旧库都跑一遍：语句全是 IF NOT EXISTS，对已有库只补缺的表，不碰数据
        ensureSchema(db)
        log(isNew ? `created db ${dbPath}` : `opened db ${dbPath}`)
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

  const mk = (toolName, description, props, exec, meta = {}) => ({
    name: toolName,
    description,
    parameters: { type: 'object', properties: props, additionalProperties: false },
    execute: async (args) => {
      const d = getDb()
      if (!d) return { text: `⚠️ 记忆库不存在：${dbPath}` }
      try {
        return await exec(d, args || {})
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

  // ① 检索
  const tSearch = mk(
    'memory_search',
    '按关键词找记忆，相关度从高到低排（不是按时间）。' +
        '默认查 fact/lesson/topic/rules/user 五层 —— user 层放的是用户的偏好与习惯，' +
        '漏掉它就会出现「搜胡桃却搜不到游戏习惯」这种结果。' +
        '⚠️ 默认五层**不含 project**：项目事实与决策必须显式传 project 参数才查得到，' +
        '不带就该用 memory_project(项目名)。不知道有这个参数时最容易犯的判断错误是「搜不到 = 没记过」。' +
        '用户说「我以前说过」「你找一下」「记得吗」「难道真没有」时，先查这里再回答：' +
        '不要凭印象，也不要说「你没说过」。',
    {
      query: { type: 'string', description: '检索关键词，多个词用空格分隔（AND）' },
      level: { type: 'string', description: '逗号多选：soul,user,project,fact,lesson,topic,rules' },
      project: { type: 'string', description: '项目名，逗号多选；全局条目永远通过' },
      status: { type: 'string', description: 'active（默认）/ stale / archived / all' },
      days: { type: 'number', description: '只看最近 N 天创建的' },
      k: { type: 'number', description: '条数上限，默认 10，最大 50' },
      content_max: { type: 'number', description: '每条正文截断字符数，默认 300；0 = 不截断' },
    },
    async (d, a) => {
      const limit = clamp(a.k ?? 10, 1, 50)
      const contentMax = clamp(a.content_max ?? 300, 0, 5000)

      // 默认不带 soul（只有 3 条长期设定）和 project（900+ 条，另有 memory_project）。
      // 必须带 user —— 用户的偏好与习惯都记在那层。
      const wanted = a.level
        ? splitCsv(a.level).filter((s) => LEVELS.includes(s))
        : [...SEARCH_LEVELS, 'user']
      if (wanted.length === 0) {
        return { text: '（没有合法的 level。可选：' + LEVELS.join(', ') + '）' }
      }

      const projects = splitCsv(a.project)
      const statuses = splitCsv(a.status).filter((s) => s !== 'all')
      const daysBack = Number(a.days)
      const cutoff = Number.isFinite(daysBack) && daysBack > 0 ? Date.now() - daysBack * 864e5 : null

      const pool = []
      for (const layer of wanted) {
        for (const raw of list(d, layer, {})) {
          const doc = toDoc(raw, layer)
          if (statuses.length && !statuses.includes(doc.status)) continue
          if (
            projects.length > 0 &&
            !projects.some((p) => isGlobalProject(doc.project) || projectListOf(doc.project).includes(p))
          ) {
            continue
          }
          if (cutoff !== null && doc.created_at < cutoff) continue
          pool.push(doc)
        }
      }
      if (pool.length === 0) return { text: '（这个筛选范围里没有记忆）' }

      const hits = bm25Search(String(a.query ?? ''), pool, { k: limit })
      if (hits.length === 0) return { text: '（没有命中）' }

      return {
        text: hits
          .map((h) => renderRecord(h, { contentMax, withMeta: true, score: h.score }))
          .join('\n\n---\n\n'),
      }
    },
    { isConcurrencySafe: () => true }
  )

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
      const layers = a.level ? [String(a.level)] : LEVELS
      const stamp = (v) => (v ? new Date(v).toISOString() : '（无）')
      for (const layer of layers) {
        const row = d.prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ?`).get(want, want + '%')
        if (!row) continue
        // 真被读了才算「用过」（注入/检索都不算，避免曝光率刷分）
        bumpHit(d, layer, row.id)
        return {
          text: [
            `id: ${row.id}`,
            `层级: ${layer}`,
            `标题: ${row.title || '（无）'}`,
            `子类: ${row.subcategory || '（无）'}`,
            `项目: ${row.project || '（全局）'}`,
            `状态: ${row.status}`,
            `重要性: ${row.importance}`,
            `关键词: ${row.keywords}`,
            `来源会话: ${row.source_session || '（未记录）'}`,
            `建立: ${stamp(row.created_at)}`,
            `更新: ${stamp(row.updated_at)}`,
            `上次命中: ${
              row.last_accessed_at
                ? `${new Date(row.last_accessed_at).toISOString()}（累计 ${row.hit_count} 次）`
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
    '记一条新的长期记忆。先想清楚放哪层 —— level 决定它以后在什么场合被翻出来：' +
      'soul = 极少量长期设定；user = 用户的偏好与习惯；' +
      'project = 项目事实与决策（要带 subcategory）；fact = 单个客观事实；' +
      'lesson = 一条可复用的经验或纠正；topic = 成题的知识块；rules = 行为准则。' +
      'fact/lesson 一句话写完（≤60 字），topic ≤300 字，关键词给 8-13 个。' +
      '写入前会自动查重：与已有条目高度重合就不写，返回那条的 id 让你决定合并还是另立。',
    {
      content: { type: 'string', description: '内容' },
      level: { type: 'string', description: '放哪一层：' + LEVELS.join('、') },
      project: { type: 'string', description: '归属项目名；全局填「全局」' },
      keywords: { type: 'array', items: { type: 'string' }, description: '关键词 8-13 个' },
      importance: { type: 'number', description: '重要性 1-4' },
      subcategory: { type: 'string', description: 'project 层专用：overview/structure/decisions/quotes/ops/todo' },
      title: { type: 'string', description: '标题（可选）' },
      force: {
        type: 'boolean',
        description: 'true = 跳过查重直接写。确认和已有条目确实是两件事时才用',
      },
      long: {
        type: 'boolean',
        description: 'true = 允许往 fact/lesson 写超过 200 字的长内容（一般应该改用 topic）',
      },
    },
    async (d, a) => {
      const layer = String(a.level ?? 'fact')
      if (!LEVELS.includes(layer)) {
        return { text: `（非法 level：${layer}。可选：${LEVELS.join('、')}）` }
      }
      const body = String(a.content ?? '').trim()
      if (!body) return { text: '（内容为空）' }

      // fact / lesson 设计上是一句话（≤60 字）。实测这两层平均已经 496 / 584 字 ——
      // 全库 40% 的条目挤在 lesson，因为「经验或纠正」什么都能装。
      // 不硬拦（确实有正当的长 lesson），但拦一次让人想清楚该放哪层。
      if ((layer === 'fact' || layer === 'lesson') && body.length > 200 && a.long !== true) {
        return {
          text:
            `⚠️ 没有写入：${layer} 层是「一句话结论」用的，而这条有 ${body.length} 字。\n` +
            '更合适的位置：\n' +
            '  · topic —— 成题的知识块（≤300 字，适合一个完整的小专题）\n' +
            '  · project —— 项目事实与决策（带 subcategory）\n' +
            '换个 level 再写一次；确实要放这里就加 long: true。',
        }
      }

      // 查重（除明确 force）。只提示、不静默改写：合并成什么样必须由调用方决定。
      // 两档结果：duplicate 拦下；related 放行但附一句近邻提示。
      let related = null
      if (a.force !== true) {
        const near = findNearDuplicate(
          d,
          { title: a.title, content: body, keywords: a.keywords },
          dedupeJaccard
        )
        if (near.duplicate !== null) return { text: nearDuplicateHint(near.duplicate, dedupeJaccard) }
        related = near.related
      }

      const id = 'mem-' + randomUUID().slice(0, 18)
      const { cols, vals } = insertPlan(a, layer, id, body, Date.now())
      const marks = cols.map(() => '?').join(',')
      d.prepare(`INSERT INTO ${layer} (${cols.join(',')}) VALUES (${marks})`).run(...vals)
      lastMemoryWriteAt = Date.now()
      return {
        text: `已写入 ${layer} id=${id}` + (related !== null ? relatedHint(related) : ''),
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ④ 项目全景
  const tProject = mk(
    'memory_project',
    '把一个项目的记忆全部取出来，按子类分组（overview/structure/decisions/quotes/ops/todo）。' +
      '动手改某个项目之前先读它 —— 省得把已经定过的结论推翻重来。' +
      '注意这里只列 project 层：同一个项目的事实与经验还散在 fact/lesson 里，' +
      '末尾会报个数量，要查全部就用 memory_search 带上 project 参数。',
    { project: { type: 'string', description: '项目名' } },
    async (d, a) => {
      const name = String(a.project ?? '').trim()
      if (!name) return { text: `（缺 project。现有项目：${listProjectNames(d).join(' / ')}）` }

      const rows = d
        .prepare("SELECT * FROM project WHERE project = ? AND status != 'archived' ORDER BY subcategory, updated_at")
        .all(name)
      if (rows.length === 0) {
        return { text: `（没有项目「${name}」）\n现有项目：${listProjectNames(d).join(' / ')}` }
      }

      const grouped = new Map()
      for (const row of rows) {
        const key = row.subcategory || '（无子类）'
        if (!grouped.has(key)) grouped.set(key, [])
        grouped.get(key).push(row)
      }

      const out = [`# 项目：${name}（project 层 ${rows.length} 条）`]
      for (const [sub, items] of grouped) {
        out.push(`\n## ${sub}（${items.length}）`)
        for (const r of items) {
          const title = String(r.title || '').trim()
          const flag = r.status === 'active' ? '' : `〔${r.status}〕`
          out.push(`- ${r.id}${flag} ${title ? title + '：' : ''}${String(r.content || '').slice(0, 200)}`)
        }
      }

      // 同项目的事实与经验散在别的层；不报数会让人以为「就这几十条」
      const spill = []
      for (const layer of ['fact', 'lesson', 'topic', 'rules', 'user']) {
        try {
          const n = d
            .prepare(`SELECT COUNT(*) AS n FROM ${layer} WHERE project LIKE ? AND status = 'active'`)
            .get('%' + name + '%').n
          if (n > 0) spill.push(`${layer} ${n}`)
        } catch {
          /* 表不存在就跳过 */
        }
      }
      if (spill.length > 0) {
        out.push(`\n---\n其他层同项目：${spill.join(' / ')}`)
        out.push(`（这里只列 project 层；要查全部用 memory_search 并传 project=${name}）`)
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
      content: { type: 'string', description: '新内容' },
      keywords: { type: 'array', items: { type: 'string' }, description: '新关键词' },
      importance: { type: 'number', description: '新重要性' },
      status: { type: 'string', description: 'active / stale / archived' },
      project: { type: 'string', description: '新归属项目' },
      title: { type: 'string', description: '新标题' },
    },
    async (d, a) => {
      const id = String(a.id ?? '').trim()
      if (!id) return { text: '（缺 id）' }
      const levels = LEVELS
      let found = null
      for (const lv of levels) {
        const row = d.prepare(`SELECT id FROM ${lv} WHERE id = ? OR id LIKE ?`).get(id, id + '%')
        if (row) {
          found = { lv, realId: row.id }
          break
        }
      }
      if (!found) return { text: `（没找到 ${id}）` }
      const sets = []
      const vals = []
      if (a.content !== undefined) {
        sets.push('content = ?')
        vals.push(String(a.content))
      }
      if (Array.isArray(a.keywords)) {
        sets.push('keywords = ?')
        vals.push(JSON.stringify(a.keywords))
      }
      if (a.importance !== undefined) {
        sets.push('importance = ?')
        vals.push(Math.round(Number(a.importance)))
      }
      if (a.status !== undefined) {
        sets.push('status = ?')
        vals.push(String(a.status))
      }
      if (a.project !== undefined) {
        sets.push('project = ?')
        vals.push(String(a.project))
      }
      if (a.title !== undefined) {
        sets.push('title = ?')
        vals.push(String(a.title))
      }
      if (sets.length === 0) return { text: '（没有要改的字段）' }
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
      return {
        text:
          `已更新 ${found.lv} ${found.realId}` +
          (touched.length > 0 ? `\n改动字段：${touched.join(', ')}` : '') +
          (touched.length > 0 ? '\n（改前快照已进版本历史，可用 memory_timeline 回看）' : ''),
      }
    },
    { isConcurrencySafe: () => false }
  )

  // ⑥ 最近改动
  const tRecent = mk(
    'memory_recent',
    '最近写入或改过的记忆，跨全部七层，按更新时间倒序。' +
      '想快速知道「库里最近多了什么」用它；要按天分组看改动清单用 memory_dream。',
    {
      n: { type: 'number', description: '条数，默认 12' },
      level: { type: 'string', description: '只查某层，如 lesson' },
      project: { type: 'string', description: '只看某项目' },
    },
    async (d, a) => {
      const n = Math.max(1, Math.min(100, Math.round(a.n ?? 12)))
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
      all.sort((x, y) => (y.row.updated_at ?? 0) - (x.row.updated_at ?? 0))
      const picked = all
        .filter(({ row }) => !a.project || String(row.project ?? '') === String(a.project))
        .slice(0, n)
      if (picked.length === 0) return { text: '（没有记录）' }
      const lines = picked.map(({ lv, row }) => {
        const t = new Date(row.updated_at ?? 0).toISOString().slice(0, 16).replace('T', ' ')
        const head = String(row.title ?? row.content ?? '').replace(/\s+/g, ' ').slice(0, 70)
        return `${t}  [${lv}] ${row.id.slice(0, 20)}  ${head}`
      })
      return { text: lines.join('\n') }
    },
    { isConcurrencySafe: () => true }
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
      fs.writeFileSync(coreMemoryPath, next, 'utf8')
      return { text: `已${action === 'remove' ? '删除' : action === 'replace' ? '替换' : '追加'}分节「${section}」，MEMORY.md 现在 ${next.length} 字符` }
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
      for (const lv of ['fact', 'lesson', 'rules', 'topic', 'project', 'user', 'soul']) {
        const rows = d
          .prepare(`SELECT * FROM ${lv} WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
          .all(since, n)
        if (rows.length === 0) continue
        byLevel.set(lv, rows)
        for (const r of rows) out.push({ lv, r })
      }
      if (out.length === 0) return { text: `（最近 ${days} 天没有新增或更新的记忆）` }
      out.sort((x, y) => (y.r.updated_at ?? 0) - (x.r.updated_at ?? 0))
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
  // 为什么补这个（2026-11-12）：meow-memory 原本有 memory_find_similar，我重写时漏了。
  // 没有它，写新记忆前只能凭印象判断「这条是不是记过了」——正是重复副本的来源
  //（2026-11-12 清掉过 9 组重复副本，全都是同一条被记了两遍）。
  const tFindSimilar = mk(
    'memory_find_similar',
    '给一条已有记忆的 id，找出库里跟它最相似的 k 条（跨全部 7 层、用同一套 BM25 含拼音与首字母层，不含自己）。' +
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
        const row = d.prepare(`SELECT * FROM ${lv} WHERE id = ? OR id LIKE ?`).get(id, id + '%')
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
  // 为什么补这个：meow-memory 原本有 memory_home，我重写时漏了。
  // memory_recent 只看"最近 N 条"、memory_dream 只看"最近 N 天改动"，
  // 都回答不了「库里现在到底有多少、哪层最胖、有哪些项目」。
  const tHome = mk(
    'memory_home',
    '记忆库总览：库路径与体积、七层各自的 active/stale/archived 分布、项目清单、最近写入 5 条。' +
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
      parts.push(`\n## 七层（合计 ${total} 条）\n${rows.join('\n')}`)

      const names = listProjectNames(d)
      if (names.length > 0) {
        parts.push(`\n## 项目（${names.length} 个）\n${names.join(' / ')}`)
      }

      // 最近写入：先从每层取前 3 条，再合并排序取 5 条（避免全表扫描）
      const recent = []
      for (const lv of LEVELS) {
        for (const r of list(d, lv, { status: 'active' }).slice(0, 3)) recent.push({ lv, r })
      }
      recent.sort((x, y) => (y.r.updated_at ?? 0) - (x.r.updated_at ?? 0))
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

  // ⚠️ tFindSimilar / tHome 已实现但**故意不注册**。
  //
  // 这两个能力与已有工具重复，注册进来纯属浪费每轮的 token：
  //   · memory_find_similar(id) = memory_read 读出那条 → 用内容当 query 去 memory_search，
  //     只是把两步并成一步；真要查重时直接搜关键词更快，也不必先有 id。
  //   · memory_home = memory_project（各层/项目统计）+ memory_recent（最近写入）的组合，
  //     库体积一条 ls -la 就有。
  //
  // 每个注册的工具都会在每轮工具目录里占一份 description，用不上的工具既烧 token
  // 又干扰模型挑工具。判断是否新增工具的标准是**有没有独占能力**，不是名字齐不齐。
  const tTimeline = mk(
    'memory_timeline',
    '看一条记忆被改过几次、每次改了什么。数据来自 *_hist 版本表（每次 memory_update 都会留快照）。' +
      '想知道「这条结论以前是怎么写的、哪次变了」时用它 —— 排查「结论被改歪了」特别有用。',
    {
      id: { type: 'string', description: '记忆 id（前 12 位即可）' },
      level: { type: 'string', description: '已知在哪层就传，能少查几张表' },
      limit: { type: 'number', description: '最多显示几个版本，默认 20（取最近的）' },
    },
    async (d, a) => {
      const want = String(a.id ?? '').trim()
      if (!want) return { text: '（缺 id）' }
      const layers = a.level ? [String(a.level)] : LEVELS

      for (const layer of layers) {
        let row
        try {
          row = d.prepare(`SELECT * FROM ${layer} WHERE id = ? OR id LIKE ?`).get(want, want + '%')
        } catch {
          continue
        }
        if (!row) continue

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
          const when = new Date(v.at).toISOString().replace('T', ' ').slice(0, 19)
          const touched = changedFieldsOf(prev.snap, v.snap)
          const tag = v.latest ? '（当前）' : ''
          out.push(`${i + 1}. ${when}${tag}  改了：${touched.join(', ') || '（无实质变化）'}`)
          for (const field of touched.slice(0, 3)) {
            const before = String(prev.snap[field] ?? '').replace(/\s+/g, ' ').slice(0, 60)
            const after = String(v.snap[field] ?? '').replace(/\s+/g, ' ').slice(0, 60)
            out.push(`   ${field}: 「${before}」→「${after}」`)
          }
        }
        out.push('', `（最早那条是「第一次被改动之前」的快照，不是条目的诞生时刻）`)
        return { text: out.join('\n') }
      }
      return { text: `（没找到 ${want}）` }
    },
    { isConcurrencySafe: () => true }
  )

  // ⑩ 记忆体检
  const tHealth = mk(
    'memory_health',
    '记忆库体检：一次列出「没关键词 / 超长 / 沉底没被读过 / 缺项目归属 / 项目名不规范」的条目。' +
      '库用久了会脏，隔一阵跑一次，按提示用 memory_update 收拾。只报告，不改数据。',
    {
      stale_days: { type: 'number', description: '多久没被读过算「沉底」，默认 90 天' },
      sample: { type: 'number', description: '每类最多列几条，默认 8' },
    },
    async (d, a) => {
      const staleDays = clamp(a.stale_days ?? 90, 7, 3650)
      const sample = clamp(a.sample ?? 8, 1, 50)
      const now = Date.now()
      const staleCut = now - staleDays * 864e5

      const buckets = { noKeywords: [], tooLong: [], stale: [], malformed: [] }
      const projectNames = new Set()

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
          if ((r.hit_count ?? 0) === 0 && (r.updated_at ?? now) < staleCut) buckets.stale.push({ layer, r })
          // project 为空才是「没归属」；「全局」是明确填过的，不算
          const proj = r.project === null || r.project === undefined ? null : String(r.project)
          if (proj !== null && proj.trim() === '') buckets.malformed.push({ layer, r })
          for (const name of projectListOf(r.project)) {
            if (isGlobalProject(name)) continue
            projectNames.add(name)
            if (name !== name.trim()) buckets.malformed.push({ layer, r })
          }
        }
      }

      const out = [
        `# 记忆体检（active 条目，沉底阈值 ${staleDays} 天）`,
        '',
        `- 没关键词：**${buckets.noKeywords.length}** 条（没有关键词就几乎搜不到）`,
        `- 超长（>1200 字）：**${buckets.tooLong.length}** 条（检索时会被长度归一化压分）`,
        `- 沉底：**${buckets.stale.length}** 条（${staleDays} 天没被读过一次）`,
        `- 归属异常：**${buckets.malformed.length}** 条`,
      ]

      const render = (title, list) => {
        if (list.length === 0) return
        out.push('', `## ${title}（${list.length}）`)
        for (const item of list.slice(0, sample)) {
          const head = String(item.r.title || item.r.content || '').replace(/\s+/g, ' ').slice(0, 60)
          out.push(`- [${item.layer}] ${String(item.r.id).slice(0, 20)}  ${head}`)
        }
        if (list.length > sample) out.push(`- …另有 ${list.length - sample} 条`)
      }
      render('没关键词', buckets.noKeywords)
      render('超长', buckets.tooLong)
      render('沉底', buckets.stale)
      render('归属异常', buckets.malformed)

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
        out.push('（确认不再需要的可以直接删；只是暂时不用的留着就行）')
      }

      if (buckets.noKeywords.length + buckets.tooLong.length + buckets.stale.length + buckets.malformed.length === 0) {
        out.push('', '库里很干净，没什么要收拾的。')
      } else {
        out.push('', '（要改就用 memory_update；改前快照会自动进版本历史）')
      }
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
      level: { type: 'string', description: '只导某一层（默认七层全导）' },
      project: { type: 'string', description: '只导某个项目（含全局条目）' },
      status: { type: 'string', description: '默认 active；可传 all' },
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
          if (wantStatus === 'active' && r.status !== 'active') return false
          if (wantProject) {
            const proj = r.project
            if (isGlobalProject(proj)) {
              // 全局条目：默认带上（和检索口径一致 —— 全局记忆对所有项目都适用），
              // 但 allow 关掉时不要，否则「只导某个项目」会被全局条目灌满。
              if (!includeGlobal) return false
            } else if (!projectListOf(proj).includes(wantProject)) {
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
              (r.subcategory ? ` · 子类: ${r.subcategory}` : '')
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
      const target =
        typeof a.out_path === 'string' && a.out_path.trim()
          ? a.out_path.trim()
          : path.join(workspace, `记忆导出-${stamp}.md`)

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
        fs.writeFileSync(target, `${header}\n${sections.join('\n---\n\n')}\n`, 'utf8')
      } catch (e) {
        return { text: `写文件失败：${e && e.message}` }
      }
      const bytes = fs.statSync(target).size
      return { text: `已导出 ${count} 条到：${target}\n（${(bytes / 1024).toFixed(1)} KB）` }
    },
    { isConcurrencySafe: () => true }
  )

  // 同类前例：tCore（memory_core）默认也**不注册** —— dsh-core-memory 已经提供了同名的
  // 「编辑 MEMORY.md」工具，我们再去占这个名字会撞车（去掉 toolPrefix 正式切换时尤其明显）。
  // 想让记忆功能完全自足（不再依赖官方那套）时，把配置 `coreTool` 设 true
  // 并禁用 dsh-core-memory，否则同名注册会失败。
  const toolsToRegister = [
    tSearch,
    tRead,
    tRemember,
    tProject,
    tUpdate,
    tRecent,
    tDream,
    tTimeline,
    tHealth,
    tExport,
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
      '\n  解法一：禁用占名的插件（常见是 meow-memory，它注册同名 memory_*）；' +
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
      const found = findLatestPrecompact(workspace)
      if (found === null) return
      if (found.mtime === lastCompactedPrecompactMtime) return
      if (Date.now() - found.mtime > precompactJustWrittenMs) return
      if (!hasConclusionSection(found.path)) return

      // ④ 触发压缩
      const commands = ctx.get('commands')
      if (typeof commands?.execute !== 'function') {
        log('auto-compact skipped: commands.execute unavailable')
        return
      }
      lastCompactedPrecompactMtime = found.mtime
      log(`auto-compact START: pressure=${pressure} file=${found.name}`)
      const outcome = await commands.execute(agent, '/compact', [], new AbortController().signal)
      const result = outcome?.result ?? outcome
      if (result?.kind === 'error') {
        log(`auto-compact FAILED: ${String(result.text ?? '').slice(0, 120)}`)
      } else if (outcome === undefined) {
        log('auto-compact FAILED: command did not resolve')
      } else {
        log(`auto-compact DONE: ${String(result?.text ?? 'ok').slice(0, 80)}`)
      }
    } catch (e) {
      log(`auto-compact error: ${e && e.message}`)
    }
  })

  ctx.on('agent/pre-step', async (payload, proceed) => {
    const decision = await proceed()
    const { step, turn, messages, agent } = payload || {}
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const d = getDb()
      if (!d) return decision

      const text = lastUserText(decision.messages) || lastUserText(messages)
      if (!text) return decision

      // ⚠️ agent/pre-step 的 waterfall 参数里**没有 agent**（只有 messages/position/signal/
      //    modelSelection），所以拿不到真正的 sessionId。用固定 key 当"已见"账本的名字：
      //    代价是本会话自己写的条目也会被注入回来（source_session 抓不到），影响很小。
      const sessionId = 'global'
      // ⚠️ 不能用「messages 里有几条用户消息」判断首轮 —— pre-step 收到的 messages
      //    只是本步新认领的那一条，永远 =1，会让每条消息都走首轮分支、每轮注入
      //    8000 多字符。真正的首轮信号是 turn（每条新消息 turn+1）。
      // 真正的首轮信号是 turn（每条新消息 turn+1）。turn 的起始值是 0 还是 1 不确定，
      // 所以两个都认；turn 为 undefined 时**不**当首轮（宁可漏注入一次，也不能每轮灌 8000 字符）。
      const isFirstTurn = step === 1 && (turn === 1 || turn === 0)
      log(
        `pre-step: turn=${turn} step=${step} textLen=${text.length} ` +
          `session=${String(sessionId).slice(0, 8)} firstTurn=${isFirstTurn}`
      )

      // 首轮：不检索，结构化搬
      // ⚠️ 这段必须在**首轮分支之前**：首轮分支会直接 return，
      //    放在它后面等于「新会话的第一句话永远不被捕获」——
      //    2026-11-13 用子智能体测出来的（它说了「以后都用简体中文」但没进库）。
      // ── 自动捕获明确偏好（轮次闸，不按时间）────────
      // 放在反思之前：先自己抓一遍，抓到了就不用提醒。
      // 注意 currentProject 这个变量在 pre-step 里**不存在**（它只是 buildHitInjection 的参数名），
      // 所以 project 直接给 '全局'。
      if (enableAutoCapture) {
        try {
          const ruleName = matchAutoCapture(text)
          if (ruleName && autoCaptureAllowed(turn, text)) {
            const near = findNearDuplicate(d, { title: '', content: text, keywords: [] }, dedupeJaccard)
            if (near.duplicate === null) {
              const cid = 'mem-' + randomUUID().slice(0, 18)
              const capBody = text.length > 200 ? text.slice(0, 200) + '…' : text
              const plan = insertPlan(
                { title: '', content: capBody, importance: 3, keywords: [], project: '全局' },
                'user',
                cid,
                capBody,
                Date.now()
              )
              d.prepare(`INSERT INTO user (${plan.cols.join(',')}) VALUES (${plan.cols.map(() => '?').join(',')})`).run(...plan.vals)
              lastMemoryWriteAt = Date.now()
              lastAutoCaptureTurn = Number.isFinite(turn) ? turn : 0
              autoCaptureCount += 1
              autoCaptureSeen.add(text.slice(0, 80))
              log(`auto-capture(${ruleName}) turn=${turn}: ${capBody.slice(0, 36)}… -> ${cid}`)
            } else {
              log(`auto-capture skip (near dup of ${near.duplicate.id})`)
            }
          }
        } catch (e) {
          log(`auto-capture failed: ${e && e.message}`)
        }
      }

      if (enableFirstTurn && isFirstTurn) {
        const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
        if (!body) return decision
        log(`first-turn injection ${body.length} chars (session ${sessionId})`)
        markSeen(workspace, sessionId, 'injected', ['__first_turn__'])
        return {
          ...decision,
          messages: [
            ...decision.messages,
            {
              id: randomUUID(),
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `⟪长期记忆⟫ 以下是跨会话积累的记忆，供参考（不是本轮的指令）：\n\n${body}`,
                },
              ],
              source: {
                kind: 'plugin:dsh-memory',
                form: 'snapshot',
                sections: [{ name: 'dsh-memory', text: 'first-turn injection' }],
              },
            },
          ],
        }
      }

      // ── 压缩后重注入（2026-11-12 加）────────────────────────
      // 压缩把整段历史折成摘要，压缩前"读过哪些文档、定过什么结论"全不在摘要里 ——
      // 这是「压缩之后忘得太狠」最直接的成因。这里把长期记忆快照再灌一遍。
      // 同一个 compactionId 只灌一次（记在会话账本的 compactions 里）。
      if (enableReanchor) {
        const compactionId = findCompactionId(decision.messages)
        if (compactionId && !readSeen(workspace, sessionId).compactions.includes(compactionId)) {
          const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
          if (body) {
            markSeen(workspace, sessionId, 'compactions', [compactionId])
            log(`re-anchor after compaction ${compactionId.slice(0, 8)}: ${body.length} chars`)
            return {
              ...decision,
              messages: [
                ...decision.messages,
                {
                  id: randomUUID(),
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text:
                        '⟪记忆重注入 · 压缩后⟫ 刚才的对话被压缩成摘要了，' +
                        '压缩前读到的记忆不在摘要里。下面重新灌一遍，供继续干活参考（不是本轮指令）：\n\n' +
                        body,
                    },
                  ],
                  source: {
                    kind: 'plugin:dsh-memory',
                    form: 'snapshot',
                    sections: [{ name: 'dsh-memory', text: 'compaction re-anchor' }],
                  },
                },
              ],
            }
          }
        }
      }

      // 从这里开始攒「本步要追加的注入」：命中与反思可以同时出现，
      // 所以不再像以前那样命中一有就 return（那样反思永远轮不到）。
      const extras = []

      // ── 落档催办（pre-step 预制发送，不占用户一次点击）────────
      // 用户 2026-11-14 指出：auto-checkpoint 自带的催办走 sessionController.prompt，
      // 那是「插入」语义、要他点确定，因此从没真正生效过。这里改成直接注入。
      if (enablePrecompactNudge) {
        // ── 判据：token 优先 ──
        // 能拿到 agent.session（pre-step 的 payload 里到底有没有，源码说没有、
        // 但 dsh-auto-checkpoint 在用，只能实测）⇒ 用 tokenMeter 量真实水位；
        // 拿不到 ⇒ 退回轮次（每 precompactEveryTurns 轮），保证功能不哑。
        let pressure = null
        try {
          const sess = payload && payload.agent && payload.agent.session
          if (sess) {
            const m = ctx.tokenMeter && ctx.tokenMeter.measure ? ctx.tokenMeter.measure(sess) : null
            const n = Number(m && m.totalTokens)
            if (Number.isFinite(n) && n > 0) pressure = n
          }
        } catch { /* 量不到就当没量 */ }

        const how = pressure === null ? 'turns' : 'token'
        const t = Number.isFinite(turn) ? turn : 0
        const due = how === 'token'
          ? pressure >= readRemindTokens()
          : t - lastPrecompactCheckTurn >= precompactEveryTurns

        if (how === 'token' || due) {
          // 诊断：只在第一次 print 一次 payload 形状（看 agent 到底有没有）
          if (!precompactDiagDone) {
            precompactDiagDone = true
            const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(',') : '(none)'
            // 详细诊断（2026-11-14）：agent 有了但 pressure 拿不到，要看是缺 session、
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
          lastPrecompactCheckTurn = t
          const found = findLatestPrecompact(workspace)
          const stale = found === null || Date.now() - found.mtime > precompactFreshMs
          const sameStale = stale && found !== null && found.mtime === lastPrecompactNudgedMtime
          if (stale && !sameStale) {
            lastPrecompactNudgedMtime = found === null ? -1 : found.mtime
            const nudgeText = precompactNudgeText(workspace, found)
            // 跟反思提醒一样：**排一个独立回合**，不混进当前回合。
            // 写落档是件完整的事，被当前任务打断只会两边都做不好（2026-11-14 用户提出）。
            let pcDelivered = false
            if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
              try {
                agent.followup({
                  id: randomUUID(),
                  role: 'user',
                  content: [{ type: 'text', text: nudgeText }],
                  source: {
                    kind: 'plugin:dsh-memory',
                    form: 'snapshot',
                    sections: [{ name: 'precompact nudge', text: nudgeText }],
                  },
                })
                pcDelivered = true
              } catch (e) {
                log(`precompact followup failed: ${e && e.message}`)
              }
            }
            if (!pcDelivered) extras.push(snapshotMessage(nudgeText, 'precompact nudge'))
            log(
              `precompact nudge: judge=${how}${pressure === null ? '' : ' pressure=' + pressure} ` +
                `file=${found ? found.name : '(none)'} via=${pcDelivered ? 'followup' : 'inject'}`
            )
          }
        }
      }

      if (enableHit && text.trim().length >= 4) {
        const seen = readSeenSet(workspace, sessionId)
        const hits = buildHitInjection(d, {
          userText: text,
          sessionId,
          currentProject: null,
          hitTopK,
          seen,
        })
        if (hits.length > 0) {
          markSeen(workspace, sessionId, 'injected', hits.map((h) => h.id))
          log(`hit injection: ${hits.length} 条 (${hits.map((h) => h.level).join(',')})`)
          extras.push(snapshotMessage(formatHitInjection(hits), 'keyword hit'))
        }
      } else if (enableHit) {
        log(`hit skip: too short (${text.trim().length} chars)`)
      }

      // ── 自动反思 ────────────────────────
      // 只在「真在干活」（本步带工具结果）且「确实很久没写记忆」时提醒一次。
      // 纯聊天、刚写过、冷却期内都不吭声 —— 提醒太勤会变成噪音。


        // ── 自动反思（按轮次，不按时间）────────
        // 检测本步有没有「写记忆」的工具调用，有就把 lastMemoryWriteTurn 推到当前轮。
        if (hasMemoryWriteCall(decision.messages) || hasMemoryWriteCall(messages)) {
          lastMemoryWriteTurn = Number.isFinite(turn) ? turn : 0
          lastMemoryWriteAt = Date.now()
        }

        // ⚠️ 2026-11-14 修：原来这里是 hasToolResult(decision.messages)，
        // 但 pre-step 跑在**生成之前**，decision.messages 只是本步认领的用户消息，
        // 工具还没跑、不会有 tool-result ⇒ 那个条件**永远 false**，reflect 一次都没触发过
        // （跟 turn-stopping 在 abort 时不触发是同一类错误：在错误时机检查错误信号）。
        // 纯按轮次判断，7 轮一次不算频繁，误打扰的代价远小于「一直不记」。
        if (enableReflect) {
          const t = Number.isFinite(turn) ? turn : 0
          // 懒初始化：第一次进来把两个锚点都推到当前轮，否则 -999 会让
          // 「第一条消息就催记记忆」（turn 是会话累计值，动辄几百）。
          if (lastReflectTurn === -999) lastReflectTurn = t
          if (lastMemoryWriteTurn === -999) lastMemoryWriteTurn = t
          // 轮次判据：距上次提醒够 reflectEveryTurns，且距上次写记忆也够
          const turnsSinceWrite = t - lastMemoryWriteTurn
          const turnsSinceNudge = t - lastReflectTurn
          const turnDue = turnsSinceWrite >= reflectEveryTurns && turnsSinceNudge >= reflectEveryTurns
          // 兼容：如果把 reflectIdleMs 设回非 0，时间判据照样生效（两者取或）
          const idle = Date.now() - lastMemoryWriteAt
          const timeDue = reflectIdleMs > 0 && idle >= reflectIdleMs && Date.now() - lastReflectAt >= reflectCooldownMs
          if (turnDue || timeDue) {
            lastReflectAt = Date.now()
            lastReflectTurn = t
            log(`reflect nudge: turn=${t} sinceWrite=${turnsSinceWrite} sinceNudge=${turnsSinceNudge}${timeDue ? ' (time)' : ''}`)
            // 拼上当前项目列表（照 meow-memory 的 projectList 做法）：让人一眼看到能往哪记。
        let projList = ''
        try {
          const rs = d.prepare(
            "SELECT project, COUNT(*) AS n FROM project WHERE status = 'active' GROUP BY project ORDER BY n DESC LIMIT 12"
          ).all()
          const names = rs.map((r) => r.project).filter(Boolean)
          if (names.length > 0) projList = `\n当前可归入的项目：${names.join(' / ')}`
        } catch { /* 查不到就不带 */ }
        const projProjects = (() => {
          try {
            const rs = d.prepare(
              "SELECT DISTINCT project FROM fact WHERE status = 'active' AND project IS NOT NULL LIMIT 8"
            ).all()
            return rs.map((r) => r.project).filter((n) => n && n !== '全局')
          } catch { return [] }
        })()
        if (projProjects.length > 0 && projList === '') {
          projList = `\n当前有内容的项目：${projProjects.join(' / ')}`
        }
        // ── 排一个独立回合，而不是注入当前回合 ──
        // 注入会让「干用户的活」和「写记忆」挤在同一轮，两边都做不好
        // （2026-11-14 实测：用户只发「1」，我一收到提醒就去写了三条记忆）。
        // followup 把这条排进 next-turn 队列：当前回合照常干完，下一回合专门写记忆。
        const noteText = REFLECT_LEAD + projList + REFLECT_CHECKLIST
        let delivered = false
        if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
          try {
            agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: noteText }],
              source: { kind: 'plugin:dsh-memory', form: 'snapshot', sections: [{ name: 'memory reflect nudge', text: noteText }] },
            })
            delivered = true
            log(`reflect followup delivered: turn=${t}（排进下一回合）`)
          } catch (e) {
            log(`reflect followup failed: ${e && e.message}，回退为注入当前回合`)
          }
        }
        if (!delivered) {
          // 拿不到 agent 或投递失败 ⇒ 退回注入（至少不会完全失效）
          extras.push(snapshotMessage(noteText, 'memory reflect nudge'))
          log(`reflect 回退注入：turn=${t}`)
        }
          }
        }

      if (extras.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...extras] }
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-memory] injection failed: ${e && e.message}`)
      return decision
    }
  })

  log('pre-step hook installed')

  // ---------------- 侧栏面板路由 ----------------

  const PANEL_HTML = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>记忆中心</title><style>',
    '*{box-sizing:border-box}body{margin:0;padding:16px 18px;background:#14161b;color:#dfe3ea;',
    "font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei UI',sans-serif}",
    'h1{font-size:15px;font-weight:600;margin:0 0 12px;letter-spacing:.02em}',
    '.muted{color:#8b93a3;font-size:12px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-bottom:16px}',
    '.cell{background:#1c1f26;border:1px solid #262a33;border-radius:6px;padding:8px 10px}',
    '.cell b{display:block;font-size:18px;font-weight:600;line-height:1.2}',
    '.cell span{font-size:11px;color:#8b93a3}',
    '.row{display:flex;gap:8px;margin-bottom:14px}',
    'input{flex:1;background:#1c1f26;border:1px solid #2b303b;border-radius:6px;color:#dfe3ea;',
    'padding:8px 10px;font-size:13px;outline:none}input:focus{border-color:#4a5568}',
    'button{background:#2b303b;border:1px solid #39404e;border-radius:6px;color:#dfe3ea;',
    'padding:8px 14px;font-size:13px;cursor:pointer}button:hover{background:#39404e}',
    '.hit{border-bottom:1px solid #242831;padding:10px 0}',
    '.hit .top{display:flex;gap:8px;align-items:baseline;margin-bottom:4px}',
    '.tag{background:#252a34;border-radius:3px;padding:1px 6px;font-size:11px;color:#8fb3ff}',
    '.score{font-size:11px;color:#6b7280;font-family:ui-monospace,monospace}',
    '.hit .body{color:#b9c1cf;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
    '.err{color:#ff9a9a;font-size:12px;white-space:pre-wrap}',
    '</style></head><body>',
    '<h1>🧠 记忆中心</h1>',
    '<div id="stats" class="grid"></div>',
    '<div class="row"><input id="q" placeholder="搜记忆…（回车）" autocomplete="off"><button id="go">搜</button></div>',
    '<div id="out"><div class="muted">上方输入关键词检索；不输入则看最近改动。</div></div>',
    '<script>',
    'var $=function(s){return document.querySelector(s)};',
    'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){',
    'return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"})}',
    'function get(u){return fetch(u,{credentials:"same-origin"}).then(function(r){',
    'if(!r.ok)throw new Error("HTTP "+r.status);return r.json()})}',
    'function renderStats(d){var g=$("#stats"),h="";',
    'var order=["soul","user","rules","fact","lesson","topic","project"];',
    'for(var i=0;i<order.length;i++){var k=order[i];',
    'h+=\'<div class="cell"><b>\'+(d.counts[k]||0)+\'</b><span>\'+esc(k)+\'</span></div>\'}',
    'h+=\'<div class="cell"><b>\'+d.projects+\'</b><span>项目</span></div>\';',
    'h+=\'<div class="cell"><b>\'+d.total+\'</b><span>合计</span></div>\';',
    'g.innerHTML=h}',
    'function renderHits(list){var o=$("#out");if(!list.length){o.innerHTML=\'<div class="muted">没有命中</div>\';return}',
    'var h="";for(var i=0;i<list.length;i++){var it=list[i];',
    'h+=\'<div class="hit"><div class="top"><span class="tag">\'+esc(it.level)+\'</span>\'+',
    '\'<span class="muted">\'+esc(it.id)+\'</span>\'+',
    '(it.score!=null?\'<span class="score">\'+it.score.toFixed(2)+\'</span>\':"")+\'</div>\'+',
    '\'<div class="body">\'+esc(it.content)+\'</div></div>\'}',
    'o.innerHTML=h}',
    'function load(){get("/dsh-memory/stats").then(renderStats).catch(function(e){',
    '$("#stats").innerHTML=\'<div class="err">统计失败：\'+esc(e.message)+\'</div>\'})}',
    'function search(){var q=$("#q").value.trim();',
    'var u=q?"/dsh-memory/search?q="+encodeURIComponent(q)+"&k=15":"/dsh-memory/recent?n=15";',
    'get(u).then(function(d){renderHits(d.hits)}).catch(function(e){',
    '$("#out").innerHTML=\'<div class="err">检索失败：\'+esc(e.message)+\'</div>\'})}',
    '$("#go").onclick=search;$("#q").onkeydown=function(e){if(e.key==="Enter")search()};',
    'load();search();',
    '</scr' + 'ipt></body></html>',
  ].join('\n')

  // 信任围栏：只允许本机回环访问。
  // 不再用 ctx.connection.requestRejection —— 它要求 DSH 客户端自己的凭证，
  // 浏览器直接开面板（同一台机器、同一端口）也会被拒成 401。
  const trustOk = (req) => {
    const host = String(req.headers?.host ?? '')
    const ip = String(req.socket?.remoteAddress ?? '')
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    if (ip && !/^(::1|::ffff:127\.|127\.)/.test(ip)) return false
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
    const d = getDb()
    if (!d) return sendJson(res, { counts: {}, projects: 0, total: 0 })
    const counts = {}
    let total = 0
    for (const [lv, key] of [
      ['soul', 'soul'],
      ['user', 'user'],
      ['rules', 'rules'],
      ['fact', 'fact'],
      ['lesson', 'lesson'],
      ['topic', 'topic'],
      ['project', 'project'],
    ]) {
      const n = d.prepare(`SELECT COUNT(*) AS n FROM ${lv} WHERE status = 'active'`).get().n
      counts[key] = n
      total += n
    }
    sendJson(res, { counts, total, projects: listProjectNames(d).length })
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
      const pool = []
      for (const lv of ['fact', 'lesson', 'topic', 'rules', 'project']) {
        for (const raw of list(d, lv, { status: 'active' })) pool.push(toDoc(raw, lv))
      }
      const hits = bm25Search(q, pool, { k }).map((h) => ({
        id: h.id.slice(0, 24),
        level: h.level,
        score: Number(h.score.toFixed(2)),
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
      const n = Math.max(1, Math.min(100, Number(u.searchParams.get('n')) || 15))
      const d = getDb()
      if (!d) return sendJson(res, { hits: [] })
      const all = []
      for (const lv of ['fact', 'lesson', 'rules', 'topic', 'project', 'user', 'soul']) {
        for (const r of d.prepare(`SELECT * FROM ${lv} ORDER BY updated_at DESC LIMIT ?`).all(n)) {
          all.push({ lv, r })
        }
      }
      all.sort((a, b2) => (b2.r.updated_at ?? 0) - (a.r.updated_at ?? 0))
      const hits = all.slice(0, n).map(({ lv, r }) => ({
        id: r.id.slice(0, 24),
        level: lv,
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
    if (!trustOk(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PANEL_HTML)
  }

  try {
    const routes = [
      { kind: 'exact', path: '/dsh-memory/panel', handler: panelHandler },
      { kind: 'exact', path: '/dsh-memory/stats', handler: statsHandler },
      { kind: 'exact', path: '/dsh-memory/search', handler: searchHandler },
      { kind: 'exact', path: '/dsh-memory/recent', handler: recentHandler },
    ]
    const disposers = routes.map((r) => ctx.webServer.register(r))
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
