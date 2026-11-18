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
  projectListOf,
  toDoc,
  SEARCH_LEVELS,
} from './db.js'
import { bm25Search, hasPhonetic, tokenize } from './search.js'
import {
  buildSessionIndexAsync,
  openSessionIndex,
  searchConversations,
  sessionIndexStats,
} from './session-index.js'
import { ensureSchema } from './schema.js'
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
  PROJECT_CORE_ROOT,
  projectCoreSnapshot,
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
 * 已经为哪个 compactionId 清过「项目核心已注入」记录（按会话）。
 * 为什么需要：同一个 compactionId 会在连续几个 step 里都出现在 messages 里，
 * 每步都清一次的话，项目核心会被反复重灌（一次 900~1500 字）。
 */
const lastCompactionReset = new Map()

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
  // 「改代码前」几个字就匹配不上，所以放宽到 15 字窗口。
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

/**
 * 疑似敏感内容 —— 命中的话**自动捕获不落库**。
 *
 *    用户经常在对话里贴 token / 密钥 / 连接串 / 身份证号（排障、让助手改配置），
 *    同一句话里再说「以后都别把这东西贴出来」就会命中捕获规则。
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

function insertPlan(args, layer, id, body, now) {
  const cols = ['id', 'category', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at']
  const vals = [
    id,
    resolveCategory(layer, args.category),
    args.title || null,
    body,
    clamp(args.importance ?? 1, 1, 4),
    JSON.stringify(Array.isArray(args.keywords) ? args.keywords : []),
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
  ]
  // core 没有 project（核心记忆是跨项目的）；另外三层都有
  if (layer !== 'core') {
    cols.splice(2, 0, 'project')
    vals.splice(2, 0, String(args.project || '全局'))
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
 * 反思提醒的固定开头。后面会拼上「当前有哪些项目」——
 * 光说「该记了」没用，得让人看到**现在能往哪儿记**。
 */
const REFLECT_LEAD =
  '⟪记忆反思⟫ 已经 7 轮没往长期记忆里写东西了，而这几轮在干实事。\n' +
  '压缩一旦触发，这些细节就只剩摘要 —— 现在花 10 秒记几条，比之后重新摸索便宜得多。\n'

/** 反思提醒的清单部分（不含项目列表）。 */
const REFLECT_CHECKLIST =
  '\n先扫一遍，命中哪条就记哪条（一条 memory_remember，提炼成祈使句 + 8~13 个关键词）：\n' +
  '· **这个项目有哪些功能 / 各自的边界** → project 层（category: features，要短）\n' +
  '· **某个功能怎么实现的、当初为什么这么定** → detail 层（category: impl，可以长）\n' +
  '· **项目走到今天分了哪几个阶段**（只写变化点，删掉时间就不成立的那种）→ project 层（category: history）\n' +
  '· 某个阶段的具体经过（试了几版、哪版被推翻）→ detail 层，标题带「史·」前缀\n' +
  '· 定下了方案/取舍 → branch 层（category: decision）\n' +
  '· 某个项目的现状/怎么跑起来 → branch 层（category: ops）\n' +
  '· 还没做的事 → branch 层（category: todo）\n' +
  '· 踩了坑、摸清了机制 → detail 层（category: lesson）\n' +
  '· 一套能照着执行的操作流程 → detail 层（category: procedure）\n' +
  '· 他提了新偏好或禁令 → core 层（category: preference / rule）\n' +
  '· 一条客观事实（版本号、路径、端口） → detail 层（category: fact）\n' +
  '\n⚠️ 加/改功能时优先补 features 和 impl —— 缺了这两层，下次改同一个项目会不知道原来有什么，\n' +
  '   于是把两个功能合成一个、或者重造已经有的轮子（2026-11-18 真踩过）。\n' +
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
  // 按轮次节流，不按时间 —— 短时间连说几轮时按时间会漏。
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
    const st = { lastTurn: -999, lastWriteTurn: -999, lastPrecompactTurn: -999 }
    reflectStateBySession.set(k, st)
    return st
  }
  const hitTopK = Number.isFinite(config.hitTopK) ? Number(config.hitTopK) : 2
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
      convBuild = buildSessionIndexAsync(convDb).finally(() => {
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
      const t = r.time ? new Date(r.time).toISOString().slice(0, 16).replace('T', ' ') : ''
      const body = String(r.text).replace(/\s+/g, ' ').slice(0, 260)
      return `[历史对话] ${r.sid.slice(-12)} · seq=${r.seq} · ${r.role} · ${t}\n  ${body}`
    })
    return { text: lines.join('\n\n') + tail }
  }

  // ① 检索
  const tSearch = mk(
    'memory_search',
    '按关键词找记忆，相关度从高到低排（不是按时间）。' +
        '默认查细节层（事实/教训/专题/规程）和分支层（决策/现状/待办/金句），外加项目层（概览/结构）。' +
        '**不含核心层** —— 核心记忆是每会话常驻注入的，不用靠检索捞；要搜它显式传 level=core。' +
        '⚠️ 项目相关的东西必须显式传 project 参数才查得全，' +
        '不带就该用 memory_project(项目名)。不知道有这个参数时最容易犯的判断错误是「搜不到 = 没记过」。' +
        '遇到「我以前说过」「你找一下」「记得吗」「难道真没有」这类问法时，先查这里再回答：' +
        '不要凭印象，也不要说「你没说过」。',
    {
      query: { type: 'string', description: '检索关键词，多个词用空格分隔（AND）' },
      level: { type: 'string', description: '逗号多选：core,project,branch,detail' },
      project: { type: 'string', description: '项目名，逗号多选；全局条目永远通过' },
      status: { type: 'string', description: 'active（默认）/ stale / archived / all' },
      days: { type: 'number', description: '只看最近 N 天创建的' },
      k: { type: 'number', description: '条数上限，默认 10，最大 50' },
      content_max: { type: 'number', description: '每条正文截断字符数，默认 300；0 = 不截断' },
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
      const limit = clamp(a.k ?? 10, 1, 50)
      const contentMax = clamp(a.content_max ?? 300, 0, 5000)

      // 默认查 detail + branch + project（SEARCH_LEVELS）。
      // 不含 core —— 核心记忆是每会话常驻注入的，不用靠检索捞；要搜显式传 level=core。
      const wanted = a.level
        ? splitCsv(a.level).filter((s) => LEVELS.includes(s))
        : SEARCH_LEVELS.slice()
      if (wanted.length === 0) {
        return { text: '（没有合法的 level。可选：' + LEVELS.join(', ') + '）' }
      }

      const projects = splitCsv(a.project)
      // 🛑 默认只搜「在役」条目 —— 工具描述写的就是 active 默认。
      //    原来 splitCsv(undefined) 得空数组 ⇒ 不加状态过滤 ⇒ archived 全进池，
      //    与描述完全相反（已经封存的条目照样冒出来）。要全量得显式传 all。
      const rawStatus = String(a.status ?? '').trim()
      const statuses =
        rawStatus === ''
          ? ['active']
          : rawStatus === 'all'
            ? []
            : splitCsv(rawStatus).filter((s) => s !== 'all')
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

      if (pool.length === 0) {
        if (convPart) return { text: convPart }
        return { text: '（这个筛选范围里没有记忆）' }
      }

      const hits = bm25Search(String(a.query ?? ''), pool, { k: limit })
      const memPart = hits.length
        ? hits.map((h) => renderRecord(h, { contentMax, withMeta: true, score: h.score })).join('\n\n---\n\n')
        : ''
      if (!memPart && !convPart) return { text: '（没有命中）' }

      if (memPart && convPart) {
        return { text: memPart + '\n\n===== 历史对话 =====\n\n' + convPart }
      }
      return { text: memPart || convPart }
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
      const stamp = (v) => (v ? new Date(v).toISOString() : '（无）')
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
      '    category: overview 概览 / structure 结构（路径、端口、模块怎么组织）\n' +
      '· **branch 分支** —— 某个项目里进行中的事，会过时会变。\n' +
      '    category: decision 决策 / ops 现状 / todo 待办 / quote 金句\n' +
      '· **detail 细节** —— 最小颗粒的积累，挂在项目上的具体东西。\n' +
      '    category: fact 事实 / lesson 教训 / topic 专题 / procedure 规程\n' +
      '\n' +
      '**detail 的四种要分清**（这里最容易混）：\n' +
      '· **fact** —— 一句话的客观事实（版本号、路径、端口、某个数值）\n' +
      '· **lesson** —— 现象 + 原因 + 做法。**中文记忆的默认形态**：踩过的坑、摸到的规律都放这。\n' +
      '  不要把一条硬拆成「知识」和「教训」两半，中文记忆是三段一体的，拆不开。\n' +
      '· **topic** —— 一个完整的小专题，可到 3000 字（机制 + 判据 + 反例 + 出处）\n' +
      '· **procedure** —— **能照着执行的操作规程**：步骤 + 命令 + 检查清单。\n' +
      '  区别：topic 回答「为什么会这样」，procedure 回答「我该按什么顺序做」。\n' +
      '  当出现「这件事又是零零散散几条、拼不出完整流程」的情况，就是缺 procedure。\n' +
      '\n' +
      '关键词给 8-13 个。写入前会自动查重：与已有条目高度重合就不写，返回那条的 id 让你决定合并还是另立。',
    {
      content: { type: 'string', description: '内容' },
      level: { type: 'string', description: '放哪一层：' + LEVELS.join('、') },
      category: {
        type: 'string',
        description:
          '层内分类。core: identity/preference/principle/rule · ' +
          'project: overview/structure/features/history · ' +
          'branch: decision/ops/todo/quote · detail: fact/lesson/topic/procedure/impl。不传用该层默认值。\n' +
          '⚠️ project 层的 **features = 这个项目有哪些功能**（边界、谁跟谁能组合，要短）。' +
          '某个功能**怎么实现的**放 detail 层的 **impl**（可以长，需要时再搜）。' +
          '改一个项目之前先 memory_project 看 features，否则会不知道原来有什么。\n' +
          '⚠️ project 层的 **history = 历史年表**：只记"什么时候、按什么顺序变成现在这样"，' +
          '只写变化点（现状归 features、机制归 impl），每行指向一条 detail 条目。' +
          '判据：**删掉时间就不成立**的才归 history。',
      },
      project: { type: 'string', description: '归属项目名；全局填「全局」（core 层不用传）' },
      keywords: { type: 'array', items: { type: 'string' }, description: '关键词 8-13 个' },
      importance: { type: 'number', description: '重要性 1-4' },
      title: { type: 'string', description: '标题（可选）' },
      force: {
        type: 'boolean',
        description: 'true = 跳过查重直接写。确认和已有条目确实是两件事时才用',
      },
    },
    async (d, a) => {
      const layer = String(a.level ?? 'detail')
      if (!LEVELS.includes(layer)) {
        return { text: `（非法 level：${layer}。可选：${LEVELS.join('、')}）` }
      }
      const body = String(a.content ?? '').trim()
      if (!body) return { text: '（内容为空）' }

      // 注意：**这里不再硬拦截**。
      // 原来的「超 200 字拒绝写入」有两个问题：
      //   ① 真有一句话说不完的经验，被拦了只能加 long:true 或硬塞 topic，反而更乱
      //   ② 实测 lesson 层会越堆越多（占全库过半）、topic 层反而很空 ——
      //      硬拦没纠正倾斜，只是让人绕过它
      // 现在改为写入后附一句「这类东西下次放哪层更合适」（见下面的 layerHint）。

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
      }

      const id = 'mem-' + randomUUID().slice(0, 18)
      const { cols, vals } = insertPlan(a, layer, id, body, Date.now())
      const marks = cols.map(() => '?').join(',')
      d.prepare(`INSERT INTO ${layer} (${cols.join(',')}) VALUES (${marks})`).run(...vals)
      lastMemoryWriteAt = Date.now()
      return {
        text:
          `已写入 ${layer}/${resolveCategory(layer, a.category)} id=${id}` +
          (related !== null ? relatedHint(related) : '') +
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
    { project: { type: 'string', description: '项目名' } },
    async (d, a) => {
      const name = String(a.project ?? '').trim()
      if (!name) return { text: `（缺 project。现有项目：${listProjectNames(d).join(' / ')}）` }

      const pick = (table) => {
        try {
          return d.prepare(`SELECT * FROM ${table} WHERE project = ? AND status != 'archived'`).all(name)
        } catch {
          return []
        }
      }
      const rowsOf = [
        ['project', pick('project')],
        ['branch', pick('branch')],
      ]
      const total = rowsOf.reduce((n, [, rs]) => n + rs.length, 0)
      if (total === 0) {
        return { text: `（没有项目「${name}」）\n现有项目：${listProjectNames(d).join(' / ')}` }
      }

      const out = [`# 项目：${name}`]
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
      let n = 0
      try {
        // instr 而不是 LIKE：项目名里带 _ 或 % 会被当通配符，
        // 实测项目名「审_测试」会多计、名字「%%」能数出全表。
        n = d
          .prepare("SELECT COUNT(*) AS n FROM detail WHERE instr(project, ?) > 0 AND status = 'active'")
          .get(name).n
      } catch {
        /* 表不存在就跳过 */
      }
      if (n > 0) {
        out.push(`\n---\n另有 detail 层 ${n} 条（事实/教训/专题/规程）`)
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
      content: { type: 'string', description: '新内容' },
      keywords: { type: 'array', items: { type: 'string' }, description: '新关键词' },
      importance: { type: 'number', description: '新重要性' },
      status: { type: 'string', description: 'active / stale / archived' },
      project: { type: 'string', description: '新归属项目' },
      title: { type: 'string', description: '新标题' },
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
    '最近写入或改过的记忆，跨全部四层，按更新时间倒序。' +
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
      level: { type: 'string', description: '只导某一层（默认四层全导）' },
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
    tProjCore,
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
      // ⚠️ 不能在 turn-stopping 里直接调 —— 实测报
      //   「Compaction is unavailable because this process has an active compaction,
      //     or the agent is not idle」
      // 因为 turn-stopping 是回合**收尾中**触发的，那时 agent 还没转 idle。
      // dsh-auto-checkpoint 的解法是先 `await agent.whenIdle?.()` 再等一小段，
      // 但那不能写在 turn-stopping 里（等自己 idle 会死锁），所以这里 fire-and-forget：
      // 开一个后台任务，等 idle 了再压。失败只记日志。
      const commands = ctx.get('commands')
      if (typeof commands?.execute !== 'function') {
        log('auto-compact skipped: commands.execute unavailable')
        return
      }
      lastCompactedPrecompactMtime = found.mtime
      const fileMtime = found.mtime
      const fileName = found.name
      void (async () => {
        try {
          // 等 agent 空闲（它可能还在这轮收尾）
          if (typeof agent.whenIdle === 'function') await agent.whenIdle()
          // 再等一拍，让宿主的 phase 真正切到 idle
          await new Promise((r) => setTimeout(r, 1500))
          log(`auto-compact START: pressure=${pressure} file=${fileName}`)
          const outcome = await commands.execute(agent, '/compact', [], new AbortController().signal)
          const result = outcome?.result ?? outcome
          if (result?.kind === 'error') {
            lastCompactedPrecompactMtime = -1 // 失败就允许下次重试
            log(`auto-compact FAILED: ${String(result.text ?? '').slice(0, 160)}`)
          } else if (outcome === undefined) {
            lastCompactedPrecompactMtime = -1
            log('auto-compact FAILED: command did not resolve')
          } else {
            log(`auto-compact DONE: ${String(result?.text ?? 'ok').slice(0, 120)}`)
          }
        } catch (e) {
          lastCompactedPrecompactMtime = -1
          log(`auto-compact error: ${e && e.message}`)
        }
      })()
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
        const cid = findCompactionId(decision.messages)
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
      if (enableAutoCapture) {
        try {
          const ruleName = matchAutoCapture(text)
          if (ruleName && autoCaptureAllowed(sessionId, turn, text)) {
            const near = findNearDuplicate(d, { title: '', content: text, keywords: [] }, dedupeJaccard)
            if (near.duplicate === null) {
              // 🛑 2026-11-19 审计修（P0）：**绝不能落 core**。
              //    core 是每个会话都常驻注入的（inject.js 的「关于用户」「原则与禁令」段），
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
                    title: `（自动捕获·${ruleName}）${capBody.slice(0, 20)}`,
                    content: capBody,
                    importance: 2,
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

      // ── 项目核心（2026-11-18 并入）────────────────────────────
      // 按关键词实时判断"当前活跃项目"，把该项目的专属规则注入进来。
      // 节流在 project-core.js 里（只注入新进来的项目）。
      //
      // 🛑 2026-11-18 审计修：extras 提到这里声明。
      //    原来项目核心命中就 `return`，同一 step 里后面三段（关键词命中 /
      //    压缩后重注入 / 反思催办）全都轮不到。压缩后重注入尤其致命 ——
      //    compact-checkpoint 那条消息只出现一次，被吃掉就永久丢了。
      const extras = []
      let projSection = ''
      try {
        projSection = buildProjectCoreSection(text, { force: isFirstTurn, sessionId, turn, step })
      } catch (e) {
        log(`project-core failed: ${e && e.message}`)
      }

      if (enableFirstTurn && isFirstTurn) {
        const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
        const merged = [body, projSection].filter(Boolean).join('\n\n')
        if (!merged) return decision
        log(`first-turn injection ${merged.length} chars (session ${sessionId})${projSection ? ' +项目核心' : ''}`)
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
                  text: `⟪长期记忆⟫ 以下是跨会话积累的记忆，供参考（不是本轮的指令）：\n\n${merged}`,
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

      // 非首轮：只有"有新项目进入活跃集"时才追加一条（节流在 project-core.js 里）。
      // 注入一次就够了 —— 消息留在历史里，模型后面每轮都还能看到，重复注入纯属烧 token。
      // 🛑 2026-11-18 审计修：不再 return，改成攒进 extras，
      //    否则同一 step 里的压缩后重注入 / 反思催办永远轮不到。
      if (projSection) {
        log(`project-core injection ${projSection.length} chars`)
        extras.push(snapshotMessage(projSection, 'active project rules'))
      }

      // ── 压缩后重注入────────────────────────
      // 压缩把整段历史折成摘要，压缩前"读过哪些文档、定过什么结论"全不在摘要里 ——
      // 这是「压缩之后忘得太狠」最直接的成因。这里把长期记忆快照再灌一遍。
      // 同一个 compactionId 只灌一次（记在会话账本的 compactions 里）。
      // 🛑 2026-11-18 审计修：这里也不能 return —— 一 return 就把上面攒的 extras
      //    （项目核心）全丢了，而 project-core.js 那边已经记账"已注入"，
      //    于是内容永远进不了上下文，且此后不再补。
      if (enableReanchor) {
        const compactionId = findCompactionId(decision.messages)
        if (compactionId && !readSeen(workspace, sessionId).compactions.includes(compactionId)) {
          const body = buildInjectionBody(d, { maxChars: firstTurnMaxChars })
          if (body) {
            markSeen(workspace, sessionId, 'compactions', [compactionId])
            log(`re-anchor after compaction ${compactionId.slice(0, 8)}: ${body.length} chars`)
            extras.push(
              snapshotMessage(
                '⟪记忆重注入 · 压缩后⟫ 刚才的对话被压缩成摘要了，' +
                  '压缩前读到的记忆不在摘要里。下面重新灌一遍，供继续干活参考（不是本轮指令）：\n\n' +
                  body,
                'compaction re-anchor',
              ),
            )
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
      if (enablePrecompactNudge) {
        // 无条件诊断：这块从没出过日志，先确认它到底有没有被执行。
        log(`precompact check: turn=${turn} everyTurns=${precompactEveryTurns} lastCheck=${rfState.lastPrecompactTurn}`)
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
          const found = findLatestPrecompact(workspace)
          const stale = found === null || Date.now() - found.mtime > precompactFreshMs
          const sameStale = stale && found !== null && found.mtime === lastPrecompactNudgedMtime
          if (stale && !sameStale) {
            lastPrecompactNudgedMtime = found === null ? -1 : found.mtime
            const nudgeText = precompactNudgeText(workspace, found)
            // 跟反思提醒一样：**排一个独立回合**，不混进当前回合。
            // 写落档是件完整的事，被当前任务打断只会两边都做不好。
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
          log(`hit injection: ${hits.length} 条 (${hits.map((h) => h.level + '/' + h.category).join(',')})`)
          extras.push(snapshotMessage(formatHitInjection(hits), 'keyword hit'))
        }

        // 触及核心层的原则/禁令时单独再拎一次。
        // 常驻注入容易被当背景板忽略，所以命中时带 ⚠️ 再提醒一遍。
        try {
          const touched = findTouchedCore(d, text, 2)
          if (touched.length > 0) {
            markSeen(workspace, sessionId, 'injected', touched.map((h) => h.id))
            log(`core touch: ${touched.length} 条 (${touched.map((h) => h.category).join(',')})`)
            extras.push(snapshotMessage(formatCoreTouch(touched), 'core touch'))
          }
        } catch (e) {
          log(`core touch error: ${e && e.message}`)
        }
      } else if (enableHit) {
        log(`hit skip: too short (${text.trim().length} chars)`)
      }

      // ── 自动反思 ────────────────────────
      // 只在「真在干活」（本步带工具结果）且「确实很久没写记忆」时提醒一次。
      // 纯聊天、刚写过、冷却期内都不吭声 —— 提醒太勤会变成噪音。


        // ── 自动反思（按轮次，不按时间）────────
        // 检测本步有没有「写记忆」的工具调用，有就把 lastMemoryWriteTurn 推到当前轮。
        // rfState 已在上面「落档催办」之前取过（reflectStateOf(sessionId)），这里直接复用
        if (hasMemoryWriteCall(decision.messages) || hasMemoryWriteCall(messages)) {
          rfState.lastWriteTurn = Number.isFinite(turn) ? turn : 0
          lastMemoryWriteAt = Date.now()
        }

        // ⚠️ 原来这里是 hasToolResult(decision.messages)，
        // 但 pre-step 跑在**生成之前**，decision.messages 只是本步认领的用户消息，
        // 工具还没跑、不会有 tool-result ⇒ 那个条件**永远 false**，reflect 一次都没触发过
        // （跟 turn-stopping 在 abort 时不触发是同一类错误：在错误时机检查错误信号）。
        // 纯按轮次判断，7 轮一次不算频繁，误打扰的代价远小于「一直不记」。
        if (enableReflect) {
          const t = Number.isFinite(turn) ? turn : 0
          // 懒初始化：第一次进来把两个锚点都推到当前轮，否则 -999 会让
          // 「第一条消息就催记记忆」（turn 是会话累计值，动辄几百）。
          if (rfState.lastTurn === -999) rfState.lastTurn = t
          if (rfState.lastWriteTurn === -999) rfState.lastWriteTurn = t
          // 轮次判据：距上次提醒够 reflectEveryTurns，且距上次写记忆也够
          const turnsSinceWrite = t - rfState.lastWriteTurn
          const turnsSinceNudge = t - rfState.lastTurn
          const turnDue = turnsSinceWrite >= reflectEveryTurns && turnsSinceNudge >= reflectEveryTurns
          // 兼容：如果把 reflectIdleMs 设回非 0，时间判据照样生效（两者取或）
          const idle = Date.now() - lastMemoryWriteAt
          const timeDue = reflectIdleMs > 0 && idle >= reflectIdleMs && Date.now() - lastReflectAt >= reflectCooldownMs
          if (turnDue || timeDue) {
            lastReflectAt = Date.now()
            rfState.lastTurn = t
            log(`reflect nudge: turn=${t} sinceWrite=${turnsSinceWrite} sinceNudge=${turnsSinceNudge}${timeDue ? ' (time)' : ''}`)
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
      for (const lv of SEARCH_LEVELS) {
        for (const raw of list(d, lv, { status: 'active' })) pool.push(toDoc(raw, lv))
      }
      const hits = bm25Search(q, pool, { k }).map((h) => ({
        id: h.id,
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
      const n = Math.max(1, Math.min(100, Math.trunc(Number(u.searchParams.get('n')) || 15)))
      const d = getDb()
      if (!d) return sendJson(res, { hits: [] })
      const all = []
      for (const lv of LEVELS) {
        for (const r of d.prepare(`SELECT * FROM ${lv} ORDER BY updated_at DESC LIMIT ?`).all(n)) {
          all.push({ lv, r })
        }
      }
      all.sort((a, b2) => (b2.r.updated_at ?? 0) - (a.r.updated_at ?? 0))
      const hits = all.slice(0, n).map(({ lv, r }) => ({
        id: r.id,
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
    // 用 trustPanel 而不是 trustOk：iframe 导航带不了自定义头
    if (!trustPanel(req)) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(readPanelHtml())
  }

  // ── 项目核心：面板读写（2026-11-18）────────────────────
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
      sendJson(res, projectCoreSnapshot(sessionFromReq(req)))
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

  // ── 面板上的"增 / 改 / 删"（2026-11-18）────────────────────
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
      const args = {
        level: layer,
        category: b.category,
        project: String(b.project || '全局'),
        title: String(b.title || ''),
        content,
        keywords: kwOf(b.keywords),
        importance: Number.isFinite(Number(b.importance)) ? Number(b.importance) : 2,
        force: b.force === true,
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
      if (b.content !== undefined) {
        sets.push('content = ?')
        vals.push(String(b.content))
      }
      if (b.title !== undefined) {
        sets.push('title = ?')
        vals.push(String(b.title))
      }
      if (b.keywords !== undefined) {
        sets.push('keywords = ?')
        vals.push(JSON.stringify(kwOf(b.keywords)))
      }
      if (b.project !== undefined) {
        sets.push('project = ?')
        vals.push(String(b.project))
      }
      if (b.category !== undefined) {
        sets.push('category = ?')
        vals.push(String(b.category))
      }
      if (b.importance !== undefined) {
        sets.push('importance = ?')
        vals.push(Math.round(Number(b.importance)))
      }
      if (b.status !== undefined) {
        sets.push('status = ?')
        vals.push(String(b.status))
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

  // ── 新建一个项目核心（面板里手建入口）────────────────────
  // 发布版默认 projects.json 是空的，别人要用就得能自己加 —— 这是闭环的一环。
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
      j.projects[name] = {
        file: `${name}.md`,
        keywords: kw,
        linked: [],
      }
      fs.mkdirSync(PROJECT_CORE_ROOT, { recursive: true })
      writeFileAtomic(cfgPath, JSON.stringify(j, null, 2) + '\n')
      // 初始正文：给个骨架，别留空文件（空文件等于没写，不会被注入）
      const body =
        String(b.content || '').trim() ||
        `# ${name} · 项目核心

> 只写「不知道就会做错」的东西。背景、历史、代码说明不要放这里。

## 坑
- （这一条不看会怎么出错？）
`
      writeFileAtomic(path.join(PROJECT_CORE_ROOT, `${name}.md`), body)
      log(`panel: create project ${name} (${kw.length} keywords)`)
      sendJson(res, { ok: true, name, keywords: kw.length })
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
      { kind: 'exact', path: '/dsh-memory/search', handler: searchHandler },
      { kind: 'exact', path: '/dsh-memory/recent', handler: recentHandler },
      { kind: 'exact', path: '/dsh-memory/projects', handler: projectsHandler },
      { kind: 'exact', path: '/dsh-memory/projects/set', handler: projectsSetHandler },
      { kind: 'exact', path: '/dsh-memory/projects/lock', handler: projectsLockHandler },
      { kind: 'exact', path: '/dsh-memory/projects/file', handler: projectFileHandler },
      { kind: 'exact', path: '/dsh-memory/projects/create', handler: projectCreateHandler },
      { kind: 'exact', path: '/dsh-memory/conv-search', handler: convSearchHandler },
      { kind: 'exact', path: '/dsh-memory/conv/rebuild', handler: convRebuildHandler },
      { kind: 'exact', path: '/dsh-memory/item/add', handler: itemAddHandler },
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
