/**
 * 数据库访问层：包一层 node:sqlite，屏蔽表结构细节。
 *
 * 库位置：<workspace>/.dsh-memory/memory.db
 *
 * 四层：core / project / branch / detail，每层带 `category` 做层内分类。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 四层，作用域从大到小 */
export const LEVELS = ['core', 'project', 'branch', 'detail']

/** 每层允许的 category（null 表示不限制，用于将来扩展） */
export const CATEGORIES = {
  core: ['identity', 'preference', 'principle', 'rule'],
  // project 层回答"这个项目是什么"，**只放短的画像**：
  //   overview 概览 / structure 结构 / features 功能清单（有哪些功能、边界在哪）/
  //   history 历史年表（什么时候、按什么顺序变成现在这样）。
  // 🛑 功能清单是改代码前必看的东西 —— 不知道原本有什么，就会把两个功能合成一个、
  //    或者重造已经有的轮子（2026-11-18 真踩过）。
  //    "每个功能具体怎么实现"太长了，放 detail 层的 impl，需要时再搜。
  // 🛑 history 的边界（2026-11-18 定）：
  //    · 只写**变化点**，不写现状（现状归 features）
  //    · 只写**为什么转向**，机制归 detail/impl
  //    · 每行必须指向一条 detail 条目，年表自己不展开正文
  //    · 判据：**删掉时间就不成立的**才归 history
  project: ['overview', 'structure', 'features', 'history'],
  branch: ['decision', 'ops', 'todo', 'quote', 'plan'],
  // detail 层：fact 事实 / lesson 教训 / topic 专题 / procedure 规程 /
  //   impl 实现细节（某个功能怎么做的、为什么这么定 —— 可以很长，不主动查）
  detail: ['fact', 'lesson', 'topic', 'procedure', 'impl'],
}

/** 各层的默认 category（不传时用） */
export const DEFAULT_CATEGORY = {
  core: 'preference',
  project: 'overview',
  branch: 'ops',
  detail: 'fact',
}

/**
 * 检索默认查哪几层。
 *
 * 不含 core —— 核心记忆是每会话常驻注入的，不需要靠检索捞；
 * 真要搜核心层，显式传 `level: 'core'`。
 */
export const SEARCH_LEVELS = ['detail', 'branch', 'project']

export function dbPathFor(workspace) {
  return path.join(workspace, '.dsh-memory', 'memory.db')
}

export function openFor(workspace) {
  const p = dbPathFor(workspace)
  if (!fs.existsSync(p)) return null
  return new DatabaseSync(p)
}

/** keywords 列存的是 JSON 字符串 */
export function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function isGlobalProject(p) {
  if (p === null || p === undefined || p === '') return true
  return /^(全局|global)$/i.test(String(p).trim())
}

/** project 字段可能是逗号分隔的多项目 */
export function projectListOf(p) {
  if (p === null || p === undefined) return []
  return String(p)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function projectCovers(field, name) {
  if (field === null || field === undefined || field === '') return true
  if (isGlobalProject(field)) return true
  const want = String(name ?? '').trim()
  if (!want) return false
  // 🛑 2026-11-20：支持「子项目」（两级，用 `/` 分）。
  //    一条记忆可以归属 `父项目/子板块`：
  //      · 查父 `父项目` → **命中**（向下覆盖，查整个工作台能看到所有板块）
  //      · 查子 `父项目/子板块` → 只命中子级，**不**命中父级那批
  //        （否则查一个子板块会把整个项目的记忆全捞出来，等于没分）
  //    现有纯名字的条目（占绝大多数）行为不变。
  return projectListOf(field).some((p) => p === want || p.startsWith(want + '/'))
}

/** 按条件取一张表的行（内部只有两三个调用点，够用就好） */
export function list(db, layer, filter = {}) {
  const clauses = []
  const values = []
  for (const key of Object.keys(filter)) {
    const value = filter[key]
    if (value === undefined || value === null || value === '') continue
    clauses.push(`${key} = ?`)
    values.push(value)
  }
  const tail = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const statement = `SELECT * FROM ${layer}${tail} ORDER BY created_at DESC`
  return db.prepare(statement).all(...values)
}

/**
 * 可检索集合：
 * - 一般 = active
 * - branch 层额外包含「已完结的 todo」（status=stale 且 category=todo），
 *   因为完结的待办本身是项目的结论，仍值得被检索到。
 */
export function listSearchable(db, layer) {
  const live = list(db, layer, { status: 'active' })
  if (layer !== 'branch') return live
  const finishedTodo = db
    .prepare('SELECT * FROM branch WHERE category = ? AND status = ?')
    .all('todo', 'stale')
  return [...live, ...finishedTodo]
}

/** 所有出现过的项目名（project / branch / detail 三张表都收） */
export function listProjectNames(db) {
  const names = new Set()
  for (const table of ['project', 'branch', 'detail']) {
    let rows
    try {
      rows = db.prepare(`SELECT DISTINCT project FROM ${table}`).all()
    } catch {
      continue
    }
    for (const r of rows) {
      for (const n of projectListOf(r.project)) {
        if (!isGlobalProject(n)) names.add(n)
      }
    }
  }
  return Array.from(names).sort((x, y) => x.localeCompare(y, 'zh'))
}

/**
 * 记一次「这条记忆被真正用过了」。
 *
 * ⚠️ 语义是刻意选的：只在 `memory_read` 真读了它、
 * 或 `memory_update` 真改了它时才 +1；**检索命中和注入都不加**。
 *
 * 为什么：如果"被搜到一次就 +1"，热门条目会靠曝光率滚雪球，越搜越靠前。
 * 记成"被打开/被维护过几次"才有信息量 —— 那代表有人真的看过它。
 * 这个数只在检索结果**同分**时做平局决胜（见 search.js），不进分数。
 */
export function bumpHit(db, layer, id) {
  try {
    // 先写时间戳再增计数：行为等价，只是语句成形顺序换成我们的习惯
    db.prepare(`UPDATE ${layer} SET last_accessed_at = ?, hit_count = hit_count + 1 WHERE id = ?`).run(
      Date.now(),
      id
    )
  } catch {
    /* 计数器失败不该影响主流程 */
  }
}

/** 统一成检索用的 doc 形状 */
export function toDoc(row, layer) {
  return {
    id: row.id,
    level: layer,
    category: row.category || DEFAULT_CATEGORY[layer] || '',
    title: row.title || '',
    content: row.content || '',
    keywords: parseKeywords(row.keywords),
    importance: row.importance ?? 1,
    status: row.status,
    project: row.project || '',
    updated_at: row.updated_at || 0,
    created_at: row.created_at || 0,
    source_session: row.source_session || null,
    // v3（2026-11-20）：原文出处 `sid#seq,sid#seq`。老库可能没这列，取不到就是 null。
    source_ref: row.source_ref || null,
    // v4（2026-11-20）：域（自由文本，逗号分隔多条）。
    domain: row.domain || null,
    // 命中计数只作**同分时的平局决胜**（见 search.js）：
    // 乘进分数会形成"越搜越靠前"的正反馈，老条目会垄断前排。
    hit_count: row.hit_count || 0,
    // 包 B 后半 + 包 D（老库可能没有这三列，取不到就是 null）
    happened_at: row.happened_at ?? null,
    context: row.context ?? null,
    mood: row.mood ?? null,
    // 「这条记忆属于什么时候」：优先事件发生时间，没填就退回记录时间。
    // 🛑 0 必须当「没填」：写入端 normalizeTime 已经把 0/负数规范成 null，
    //    但**修复之前写进去的老数据可能就是 0**。`??` 只跳过 NULL、不跳过 0，
    //    所以这里得显式判 > 0 —— 否则这些条目在 `since` 筛选里
    //    （`(doc.at||0) < sinceMs`）会被永久漏掉，时间轴上还会被当成「改」。
    at: (Number(row.happened_at) > 0 ? row.happened_at : null) ?? row.created_at ?? 0,
  }
}

export function loadSearchPool(db, levels = SEARCH_LEVELS) {
  const pool = []
  for (const lv of levels) {
    if (!LEVELS.includes(lv)) continue
    for (const row of listSearchable(db, lv)) pool.push(toDoc(row, lv))
  }
  return pool
}

/**
 * 数方案里的勾选进度：`- [x]` 算完成，`- [ ]` 算未完成。
 *
 * 放在这里（而不是 index.js）是因为两处都要用：
 * 工具 `memory_plan` 数进度，注入侧也要数（没做完的方案要提醒）。
 * 两份实现一定会分叉，所以只留一份。
 */
export function planProgress(text) {
  const t = String(text || '')
  const done = (t.match(/^[ \t]*[-*][ \t]*\[[xX]\][ \t]*\S/gm) || []).length
  const todo = (t.match(/^[ \t]*[-*][ \t]*\[[ \t]\][ \t]*\S/gm) || []).length
  return { done, todo, total: done + todo }
}

/** 方案里还没勾的项（取前 n 条正文，用于注入提醒） */
export function planLeftItems(text, n = 1) {
  return String(text || '')
    .split('\n')
    .map((l) => l.match(/^[ \t]*[-*][ \t]*\[[ \t]\][ \t]*(\S.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .slice(0, n)
}
