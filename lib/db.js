/**
 * 数据库访问层：包一层 node:sqlite，屏蔽表结构细节。
 *
 * 库位置：<workspace>/.dsh-memory/memory.db
 * 结构与 meow-memory 完全一致（7 层 + _hist + 系统表），所以迁移时零转换。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
/** 可以在检索里出现的层（与 memory_search 的默认值一致） */
export const SEARCH_LEVELS = ['fact', 'lesson', 'topic', 'rules']

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
  return projectListOf(field).includes(name)
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
 * - 一般层 = active
 * - project 层额外包含「已完结的 todo」（status=stale 且 subcategory=todo），
 *   因为完结的待办本身是项目记事的结论，仍值得被检索到。
 */
export function listSearchable(db, layer) {
  const live = list(db, layer, { status: 'active' })
  if (layer !== 'project') return live
  // 已完结的待办本身是项目记事的结论，仍值得被检索到
  const finishedTodo = db
    .prepare('SELECT * FROM project WHERE subcategory = ? AND status = ?')
    .all('todo', 'stale')
  return [...live, ...finishedTodo]
}

export function listProjectNames(db) {
  const rows = db.prepare('SELECT DISTINCT project FROM project').all()
  const names = new Set()
  for (const r of rows) {
    for (const n of projectListOf(r.project)) {
      if (!isGlobalProject(n)) names.add(n)
    }
  }
  return Array.from(names).sort((x, y) => x.localeCompare(y, 'zh'))
}

/**
 * 记一次「这条记忆被真正用过了」。
 *
 * ⚠️ 语义是刻意选的（2026-11-12）：只在 `memory_read` 真读了它、
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
    title: row.title || '',
    content: row.content || '',
    keywords: parseKeywords(row.keywords),
    importance: row.importance ?? 1,
    status: row.status,
    project: row.project || '',
    updated_at: row.updated_at || 0,
    created_at: row.created_at || 0,
    source_session: row.source_session || null,
    // 命中计数只作**同分时的平局决胜**（见 search.js）：
    // 乘进分数会形成"越搜越靠前"的正反馈，老条目会垄断前排。
    hit_count: row.hit_count || 0,
  }
}

export function loadSearchPool(db, levels = SEARCH_LEVELS) {
  const pool = []
  for (const lv of levels) {
    for (const row of listSearchable(db, lv)) pool.push(toDoc(row, lv))
  }
  return pool
}
