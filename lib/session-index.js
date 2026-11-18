/**
 * 会话索引：把历史对话建成可全文检索的库，供 memory_search 一起查。
 *
 * 数据源：`~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`
 *   · 每个文件是「一条记录一个 zstd 帧」的追加日志；
 *   · Node 内置 zstd **只解第一帧**（实测 49.7MB 的文件只解出 1 行），
 *     所以要按帧魔数 `28 B5 2F FD` 切开、逐帧解压再拼起来。
 *
 * 索引放独立文件 `<workspace>/.dsh-memory/sessions.db`，不碰主记忆库。
 * 增量：按源文件的 mtime + size 判断，没变就跳过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { tokenize } from './search.js'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const FTS_TOKENIZE = 'unicode61 remove_diacritics 0'

/**
 * 这些是被插件灌进对话的内容，不是用户真正说的话 —— 建索引时要跳过，
 * 否则搜"项目核心"会命中每一轮注入的提示词，把真正说过的话淹掉。
 */
const INJECT_MARKS = [
  '===== 长期记忆 =====',
  '[meow-memory-reflect]',
  '【meow-memory',
  '可能相关的记忆，仅供参考',
  '[auto-checkpoint] 上下文即将压缩',
]

/** 子智能体的会话不算"以前说过的话"，默认跳过。 */
const SUBAGENT_MARK = '你在 Windows 主机上工作'

/**
 * 索引格式版本。**改了过滤规则 / 表结构就 +1** ——
 * 增量是靠 mtime+size 判断的，规则变了但文件没变的话那些老会话不会被重新清洗，
 * 旧注入块会一直留在索引里（实测：加了新过滤词，旧会话照样能搜出注入提示）。
 * 版本不匹配时会清空索引，下次 build 全量重来。
 */
const INDEX_VERSION = 3

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conv_meta(k TEXT PRIMARY KEY, v INTEGER);
    CREATE TABLE IF NOT EXISTS conv_file(
      sid TEXT PRIMARY KEY, path TEXT, mtime INTEGER, size INTEGER,
      msgs INTEGER, scanned_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS conv_msg(
      sid TEXT, seq INTEGER, role TEXT, time INTEGER, text TEXT
    );
    CREATE INDEX IF NOT EXISTS conv_msg_sid ON conv_msg(sid);
    CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(
      sid UNINDEXED, seq UNINDEXED, role UNINDEXED, big,
      tokenize='${FTS_TOKENIZE}'
    );
  `)
}

/** 打开（必要时创建）会话索引库。版本变了会自动清空，等下次 build 全量重建。 */
export function openSessionIndex(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=5000')
  } catch {}
  schema(db)
  try {
    const row = db.prepare("SELECT v FROM conv_meta WHERE k='ver'").get()
    if (!row || Number(row.v) !== INDEX_VERSION) {
      db.exec('DELETE FROM conv_file; DELETE FROM conv_msg; DELETE FROM conv_fts;')
      db.prepare(
        "INSERT INTO conv_meta(k,v) VALUES('ver',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      ).run(INDEX_VERSION)
    }
  } catch {}
  return db
}

/** 按帧魔数切开、逐帧解压，返回拼好的 Buffer。 */
export function decompressSessionFile(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
      i += 3
    }
  }
  if (starts.length === 0) return Buffer.alloc(0)
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k]
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(a, b)))
    } catch {
      // 数据里碰巧出现魔数会切错帧，跳过这一段即可
    }
  }
  return Buffer.concat(parts)
}

/** 从一条消息的 content 里取纯文本（不取 reasoning）。 */
function textOf(message) {
  const c = message && message.content
  if (!Array.isArray(c)) return ''
  const out = []
  for (const part of c) {
    if (!part || part.type !== 'text') continue
    if (typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n')
}

function isInjected(text) {
  // 插件注入的提示统一用 ⟪…⟫ 包起来，前缀判断就够（用户自己不会这么打）
  if (text.trimStart().startsWith('⟪')) return true
  for (const m of INJECT_MARKS) if (text.includes(m)) return true
  return false
}

/**
 * 从解压后的行里提消息。
 * 返回 [{seq, role, time, text}]，已过滤注入块与子智能体会话。
 */
export function extractMessages(lines) {
  const out = []
  const parsed = []
  for (const line of lines) {
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    parsed.push(o)
  }
  if (detectSubagentFromParsed(parsed)) return out

  for (const o of parsed) {
    if (!o || !o.type) continue
    if (o.type !== 'user/message' && o.type !== 'assistant/message') continue
    const seq = Number(o.seq)
    const time = Number(o.time)
    if (!Number.isFinite(seq)) continue
    const msg = o.type === 'user/message' ? o.data : o.data && o.data.message
    const text = textOf(msg)
    if (!text.trim()) continue
    if (isInjected(text)) continue
    const role = o.type === 'user/message' ? 'user' : 'assistant'
    out.push({ seq, role, time: Number.isFinite(time) ? time : 0, text })
  }
  return out
}

/**
 * 这份会话是不是子智能体。
 * 🛑 单独抽出来，是为了让调用方能「跳过它」而不是「当成空会话处理」——
 * 原来 extractMessages 判成子智能体就 return 空数组，buildSessionIndex 接着
 * 删光消息 + 插 0 条 + 写 conv_file 已处理标记 ⇒ 该会话的全部历史从索引里消失，
 * 而且 mtime/size 已记下，此后永不重扫，面板上 msgs 计数看着还正常。
 * 判据是文本里出现 SUBAGENT_MARK，而主会话讨论子智能体 prompt 时必然引用它。
 */
function detectSubagentFromParsed(parsed) {
  if (!Array.isArray(parsed)) return false
  let seen = 0
  for (const o of parsed) {
    if (!o || o.type !== 'user/message') continue
    const t = textOf(o.data)
    if (t.includes(SUBAGENT_MARK)) return true
    // 🛑 子智能体的**第一条** user 消息就是身份说明，只看开头两条就够。
    //    放宽到"全文任意位置"会误判 —— 主会话里讨论子智能体 prompt 时必然引用这句话，
    //    实测本机最大的那个主会话（55MB）就因此被判成子智能体，整份历史被跳过。
    if (++seen >= 2) return false
  }
  return false
}

export function detectSubagent(lines) {
  if (!Array.isArray(lines)) return false
  const parsed = []
  for (const line of lines) {
    if (!line) continue
    try {
      parsed.push(JSON.parse(line))
    } catch {}
  }
  return detectSubagentFromParsed(parsed)
}

/** 列出所有会话存档文件。 */
export function listSessionFiles(root) {
  const out = []
  ;(function walk(dir, depth) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1)
      } else if (e.name.endsWith('.zstd')) {
        const m = p.match(/[\\/](session-[^\\/]+)[\\/]/)
        const sid = m ? m[1] : path.basename(path.dirname(p))
        let st
        try {
          st = fs.statSync(p)
        } catch {
          continue
        }
        out.push({ sid, path: p, mtime: Math.round(st.mtimeMs), size: st.size })
      }
    }
  })(root, 0)
  return out
}

/**
 * 建/更新索引。增量：mtime + size 都没变的文件直接跳过。
 * @returns {{scanned, updated, skipped, msgs, ms, errors}}
 */
export function buildSessionIndex(db, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  const t0 = Date.now()
  const files = listSessionFiles(sessionsRoot)
  let updated = 0
  let skipped = 0
  let msgs = 0
  const errors = []

  const known = new Map()
  for (const r of db.prepare('SELECT sid, mtime, size FROM conv_file').all()) {
    known.set(r.sid, r)
  }

  const del = db.prepare('DELETE FROM conv_msg WHERE sid = ?')
  const delFts = db.prepare('DELETE FROM conv_fts WHERE sid = ?')
  const insMsg = db.prepare('INSERT INTO conv_msg(sid, seq, role, time, text) VALUES (?, ?, ?, ?, ?)')
  const insFts = db.prepare('INSERT INTO conv_fts(sid, seq, role, big) VALUES (?, ?, ?, ?)')
  const upsert = db.prepare(
    `INSERT INTO conv_file(sid, path, mtime, size, msgs, scanned_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET mtime=excluded.mtime, size=excluded.size,
       msgs=excluded.msgs, scanned_at=excluded.scanned_at, path=excluded.path`,
  )

  for (const f of files) {
    const k = known.get(f.sid)
    if (k && k.mtime === f.mtime && k.size === f.size) {
      skipped++
      continue
    }
    try {
      const buf = fs.readFileSync(f.path)
      const raw = decompressSessionFile(buf)
      const lines = raw.toString('utf8').split('\n').filter(Boolean)
      // 🛑 先判子智能体，**只跳过**：不删已有索引、不写 conv_file 的已处理标记。
      //    （判据是文本包含子智能体 prompt 的标记句，主会话引用这句话就会命中，
      //     所以绝不能让它触发"删光这个会话的索引"。）
      if (detectSubagent(lines)) {
        skipped++
        continue
      }
      const list = extractMessages(lines)

      // 删除和插入放在同一个事务里：不然插入失败 ROLLBACK 时旧消息已经被删掉，
      // 那段时间搜不到这个会话（虽然下次因 mtime 不等会补回，但中间是空的）
      db.exec('BEGIN')
      try {
        del.run(f.sid)
        delFts.run(f.sid)
        for (const m of list) {
          insMsg.run(f.sid, m.seq, m.role, m.time, m.text)
          const big = tokenize(m.text).join(' ')
          if (big) insFts.run(f.sid, m.seq, m.role, big)
        }
        upsert.run(f.sid, f.path, f.mtime, f.size, list.length, Date.now())
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      updated++
      msgs += list.length
    } catch (e) {
      errors.push(`${f.sid}: ${e && e.message}`)
    }
  }

  return {
    scanned: files.length,
    updated,
    skipped,
    msgs,
    ms: Date.now() - t0,
    errors: errors.slice(0, 5),
  }
}

/**
 * 搜历史对话。
 * @param q 关键词（中文按 bigram 切，英文按词）
 * @returns [{sid, seq, role, time, text, score}]
 */
export function searchConversations(db, q, opts = {}) {
  const k = Math.max(1, Math.min(50, Number(opts.k) || 10))
  const toks = tokenize(q)
  if (toks.length === 0) return []
  // FTS5 的查询语法：每个 token 加引号再 AND，避免被当运算符
  const expr = toks.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ')
  let rows
  try {
    rows = db
      .prepare(
        `SELECT f.sid, f.seq, f.role, m.time, m.text, bm25(conv_fts) AS score
         FROM conv_fts f LEFT JOIN conv_msg m ON m.sid = f.sid AND m.seq = f.seq
         WHERE conv_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(expr, k)
  } catch {
    return []
  }
  return rows.map((r) => ({
    sid: r.sid,
    seq: r.seq,
    role: r.role,
    time: r.time,
    text: String(r.text || ''),
    score: Number.isFinite(r.score) ? r.score : 0,
  }))
}

/** 索引现状（面板/工具展示用）。 */
export function sessionIndexStats(db) {
  const files = db.prepare('SELECT COUNT(*) AS n FROM conv_file').get().n
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM conv_msg').get().n
  const last = db.prepare('SELECT MAX(scanned_at) AS t FROM conv_file').get().t
  return { files, msgs, lastScannedAt: last || 0 }
}
