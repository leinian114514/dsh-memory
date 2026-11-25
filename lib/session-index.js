/**
 * 会话索引：把历史对话建成可全文检索的库，供 memory_search 一起查。
 *
 * 数据源：`~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`
 *   · 每个文件是「一条记录一个 zstd 帧」的追加日志；
 *   · Node 内置 zstd **只解第一帧**（实测几十 MB 的文件只解出 1 行），
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
const INDEX_VERSION = 4
// 2026-11-25 v3 → v4：`listSessionFiles` 改成按目录名挡子智能体（纯 uuid 目录不收）。
// 版本不匹配会清空索引全量重建，正好把此前可能已经被索引进去的子会话内容清掉。

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
/**
 * 解压的分步版：**每帧 yield 一次**。
 * 🛑 为什么拆：几十 MB 的会话，一次性解压要一秒 —— 是"卡住事件循环"里
 *    最长的一段，光靠"文件之间让出"挡不住（单个文件就够卡）。
 *    会话存档是一帧一条记录，逐帧解压天然可切，切完最大阻塞降到几十毫秒。
 */
export function* decompressSessionFileSteps(buf) {
  // 🛑 版本闸（2026-11-20）：`zlib.zstdDecompressSync` 是 Node **22.15+** 才有的。
  //    低于这个版本它 undefined，逐帧解压全部失败，最后抛的是「解压结果为空」——
  //    把用户/模型引向"文件坏了"这个**错误方向**，实际是环境不满足。
  //    这里提前喊清楚，并说明是哪一步、需要什么。
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      `当前 Node ${process.versions.node} 没有 zstd 解压（zlib.zstdDecompressSync 需要 Node 22.15+）` +
        `，历史对话索引不可用。升级 Node 后重试即可；记忆库本身的读写不受影响。`,
    )
  }
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
    yield k
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

export function decompressSessionFile(buf) {
  const g = decompressSessionFileSteps(buf)
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value
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
  const head = text.trimStart()
  // 插件注入的提示统一用 ⟪…⟫ 包起来，前缀判断就够（用户自己不会这么打）
  if (head.startsWith('⟪')) return true
  // auto-checkpoint 的催办与压缩告知同样是注入，一律不算"谁说过的话"。
  // 🛑 压缩告知尤其要挡：它被当成原文放回「最近几轮」，下一轮 pre-step 的
  //    looksCompaction 判据又会命中（前缀原样匹配），于是再压缩、再放回 —— 滚成循环。
  if (head.startsWith('[auto-checkpoint]')) return true
  for (const m of INJECT_MARKS) if (text.includes(m)) return true
  return false
}

/**
 * **一遍过**：同时判子智能体 + 提消息。
 *
 * 🛑 2026-11-19 审计修：原来 detectSubagent 把全部行 parse 一遍、
 *    extractMessages 再 parse 一遍 —— 几十 MB 的会话几千行，白干半秒。
 *    现在一次遍历：先按"前两条 user/message"判身份（判据不变），
 *    判成子智能体就立刻停，否则顺手把消息收集完。
 *    另外产出 yielded 计数点，供上层分片让出事件循环。
 */
export function* scanSessionLines(lines, opts = {}) {
  const skipSubagent = opts && opts.skipSubagent === true
  const out = []
  let seenUser = 0
  let isSub = false
  let n = 0
  for (const line of lines) {
    // 每 300 行让一次 —— JSON.parse 大行（单行上 MB）本身也要几十毫秒
    if (++n % 300 === 0) yield n
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || !o.type) continue
    // 判身份：只认开头两条 user/message（判据见 detectSubagentFromParsed 的注释）
    if (!skipSubagent && !isSub && seenUser < 2 && o.type === 'user/message') {
      if (textOf(o.data).includes(SUBAGENT_MARK)) {
        isSub = true
        break
      }
      seenUser++
    }
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
  return { isSubagent: isSub, list: isSub ? [] : out, scanned: n }
}

/**
 * 从解压后的行里提消息。
 * 返回 [{seq, role, time, text}]，已过滤注入块与子智能体会话。
 */
export function extractMessages(lines, opts = {}) {
  const g = scanSessionLines(lines, opts)
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value.list
}

/**
 * 只解尾部若干帧，取最近的对话消息（已滤掉插件注入块）。
 *
 * 为什么不直接 `decompressSessionFile` + `extractMessages`：
 *   · 它解压**整个**文件再拼接 —— 实测大一点的会话要几秒；
 *   · 调用方是「压缩后补最近几轮原话」，跑在 pre-step 上、同步执行，4 秒会把界面卡僵；
 *   · 存档是一帧一条记录，天然可以从尾部切。
 *
 * 子智能体判定在这条路径上跳过：调用方已经用 sid 精确指定了会话，
 * 不该再靠「头两条 user 消息里有没有标记」去猜 —— 尾部本来就拿不到开头。
 *
 * @returns {Array<{seq:number, role:string, time:number, text:string}>} 时间正序
 */
export function recentSessionMessages(buf, opts = {}) {
  const maxFrames = Number.isFinite(opts.maxFrames) ? opts.maxFrames : 800
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
  if (starts.length === 0) return []
  const from = Math.max(0, starts.length - maxFrames)
  const parts = []
  for (let k = from; k < starts.length; k++) {
    const a = starts[k]
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(a, b)))
    } catch {
      // 数据里碰巧出现魔数会切错帧，跳过这一段即可
    }
  }
  if (parts.length === 0) return []
  return extractMessages(Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean), { skipSubagent: true })
}

/**
 * 按 `sid` + `seq` 取一条原文，带前后几轮。
 *
 * 为什么不能复用 `recentSessionMessages`：它只解尾部 800 帧，而想翻的 seq
 * 可能很早（压缩之前的、几个月前的）。这里只能全量解 —— 几十 MB 的会话约 4 秒，
 * 但这是「用户/模型明确要翻某一条」的场景，一次换一条确定的原文，值。
 *
 * `sid` 允许只给前 8 位：`session-01234567-89ab-...` 记成 `01234567` 也认。
 *
 * @returns {null | {sid:string, found:boolean, target?:object, window?:object[], total:number, message?:string}}
 */
export function sessionMessageAt(sid, seq, opts = {}) {
  const root = opts.root || path.join(os.homedir(), '.dsh', 'sessions')
  const want = String(sid || '').trim()
  if (!want) return null
  const files = listSessionFiles(root)
  // 🛑 2026-11-20 真 bug：会话目录有**两种命名** ——
  //    `session-01234567-89ab-…`（带前缀）和 `abcdef01-2345-…`（不带）。
  //    而调用方（memory_source）常常先拼好 `session-<sid>` 再传进来，
  //    于是跟不带前缀的 `f.sid` 精确匹配、startsWith、includes **三种都比不上** ⇒
  //    报"找不到这个会话的存档文件"，可文件明明就在那儿。
  //    两边都去掉 `session-` 前缀再比。
  const normSid = (s) => String(s || '').trim().replace(/^session-/, '')
  const w = normSid(want)
  const hit =
    files.find((f) => normSid(f.sid) === w) ||
    files.find((f) => normSid(f.sid).startsWith(w)) ||
    files.find((f) => normSid(f.sid).includes(w))
  if (!hit) return { sid: want, found: false, total: 0, message: '找不到这个会话的存档文件' }

  const raw = decompressSessionFile(fs.readFileSync(hit.path))
  const msgs = extractMessages(raw.toString('utf8').split('\n').filter(Boolean), { skipSubagent: true })
  const n = Number(seq)
  const idx = msgs.findIndex((m) => Number(m.seq) === n)
  if (idx < 0) {
    // 找不到就给最近的那几条序号，方便换个 seq 再试，别让人干瞪眼
    const near = msgs.slice(-5).map((m) => m.seq)
    return { sid: hit.sid, found: false, total: msgs.length, message: `这个会话里没有 seq=${seq}；最近几条是 ${near.join(', ')}` }
  }
  const before = Number.isFinite(opts.before) ? opts.before : 2
  const after = Number.isFinite(opts.after) ? opts.after : 2
  const from = Math.max(0, idx - before)
  const to = Math.min(msgs.length, idx + after + 1)
  return {
    sid: hit.sid,
    found: true,
    target: msgs[idx],
    window: msgs.slice(from, to),
    total: msgs.length,
  }
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
    //    实测最大的那个主会话就因此被判成子智能体，整份历史被跳过。
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
/**
 * 子智能体会话的 sid 形状：**纯 uuid，没有 `session-` 前缀**。
 *
 * 2026-11-25 实测 `~/.dsh/sessions/--D-B2--/` 的 235 个目录：
 * 103 个 `session-*`（主会话 + 子智能体父会话）、132 个纯 uuid（子会话），**零例外**。
 */
const SUBAGENT_SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 出口清理：把索引里「纯 uuid 的 sid」（子智能体会话）连消息一起删掉。
 *
 * 🛑 为什么入口挡了（`listSessionFiles` 里 `if (!m) continue`）还要出口再挡一次：
 *   入口判据靠的是**目录名**。哪天 DSH 改了命名（比如主会话也改成纯 uuid），
 *   入口判据会**静默失效** —— 不报错，只是子会话又混进来。
 *   而子智能体常被派去探路、读来源不明的外部内容，它存档里的脏东西一旦进索引，
 *   `memory_search(includeConversations=true)` 就能把它捞回主会话上下文，
 *   前端所有防护都绕过去了（2026-11-25 主人原话：「如果搜索到了，那不就完蛋了？」）。
 *
 * 所以出口按 sid **形状**再清一遍，并把清掉的条数返回给调用方打日志 ——
 * 让「判据失效」这件事本身也看得见，而不是悄悄地又开始漏。
 *
 * 只删严格 uuid 形状的 sid：主会话一律 `session-` 开头，不会误伤（187/187 实测）。
 * 不包事务：build 全程在事务里，嵌套 BEGIN 会报错；单条 DELETE 自带原子性。
 *
 * @returns {number} 清掉的 sid 数；-1 = 出错（不影响构建本身）
 */
function purgeSubagentRows(db) {
  try {
    const all = db.prepare('SELECT sid FROM conv_file').all()
    const bad = all.map((r) => String(r.sid)).filter((s) => SUBAGENT_SID_RE.test(s))
    if (bad.length === 0) return 0
    const delFile = db.prepare('DELETE FROM conv_file WHERE sid = ?')
    const delMsg = db.prepare('DELETE FROM conv_msg WHERE sid = ?')
    const delFts = db.prepare('DELETE FROM conv_fts WHERE sid = ?')
    for (const s of bad) {
      delFile.run(s)
      delMsg.run(s)
      delFts.run(s)
    }
    return bad.length
  } catch {
    return -1
  }
}

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
        // 🛑 2026-11-25 修：子智能体会话的目录是**纯 uuid**（没有 `session-` 前缀，
        //    例如 `...\--D-B2--\e9d4c8d1-d563-4730-8831-704a94e9e4e3\session.v4.jsonl.zstd`）。
        //    原来这里 fallback 成 `path.basename(dirname)`，于是子会话被当成正常会话索引进去；
        //    而 SUBAGENT_MARK（'你在 Windows 主机上工作'）实测在子会话前几条 user 消息里**不出现**，
        //    ⇒ 靠文本判身份的 `scanSessionLines` 对它是漏的。
        //    子智能体被派去探路（读来源不明的外部内容）时可能撞上毒源，它的存档里带着毒内容；
        //    一旦进索引，以后 `includeConversations` 搜到就等于把毒搬回上下文。
        //    所以这里直接按**目录名**挡掉：没有 `session-` 前缀的一律不收（子会话、被隔离改名的 `.quarantine` 都在这一类）。
        if (!m) continue
        const sid = m[1]
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
/**
 * 索引重建的**分步版**：每处理一个会话文件就 yield 一次。
 *
 * 🛑 2026-11-19 审计修：原来是整段同步循环（几百个 zstd 文件逐个读→解压→切开→
 *    切词→写库），实测卡住事件循环 2.4 秒 —— 这期间 DSH 界面、别的插件全僵住。
 *    现在拆成生成器，同步/异步两个包装共用同一份逻辑，不会走岔。
 *    （事务不跨 yield：每个文件的 BEGIN..COMMIT 都在同一个 yield 间隔内走完。）
 */
function* buildSessionIndexSteps(db, sessionsRoot) {
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
    yield f.sid
    const k = known.get(f.sid)
    if (k && k.mtime === f.mtime && k.size === f.size) {
      skipped++
      continue
    }
    try {
      // 🛑 大文件的每一步之间都要 yield 一次（2026-11-19 实测）：
      //    大一点的会话拆开是 解压占七成 + 切行一成多 + 判子智能体近两成 +
      //    提取 470 + 切词 101 —— 一共 2.3 秒。只在"文件之间"让出没用，
      //    单个文件就能卡住事件循环。这些点之间最长的一段是解压（1 秒，
      //    单次同步调用，拆不开），其余都不足半秒。
      const buf = fs.readFileSync(f.path)
      yield 'read'
      const raw = yield* decompressSessionFileSteps(buf)
      // 🛑 2026-11-19 审计修（P1）：解压全失败时**必须抛错**，不能当"这个会话 0 条消息"。
      //    否则会 del + 插 0 条 + 写 conv_file 的 mtime/size ⇒ 该会话全部历史从索引里
      //    消失，而且此后永不重扫（mtime/size 已记下），面板上 msgs 计数看着还正常。
      //    这正是上面子智能体那段注释里专门诅咒过的形态 —— 只是入口不止子智能体一个。
      if (!raw || raw.length === 0) {
        throw new Error('解压结果为空（文件损坏，或读到正在写入的半截文件）')
      }
      yield 'unzstd'
      const lines = raw.toString('utf8').split('\n').filter(Boolean)
      yield 'split'
      // 🛑 一次遍历：判子智能体 + 提消息一起做（原来分两遍，各 parse 全量行）。
      //    判成子智能体就**只跳过**：不删已有索引、不写 conv_file 的已处理标记。
      const scan = yield* scanSessionLines(lines)
      yield 'scan'
      if (scan.isSubagent) {
        skipped++
        continue
      }
      const list = scan.list
      // 🛑 解压成功、但一条真消息都没提到时，**不能**写"已处理 0 条" ——
      //    和上面解压为空是同一个坑的第二个入口：del + 插 0 条 + 记 mtime/size
      //    ⇒ 该会话历史从索引里消失且永不重扫。
      //    但空会话是**合法**的（刚开、没对话），不能一律当损坏报错，
      //    不然每次重建都刷一堆假错误。用解压后的字节量区分：
      //    小 = 真空白会话；大却提不出消息 = 可疑（格式变了 / 内容全是注入块）。
      if (list.length === 0) {
        if (raw.length > 200 * 1024) {
          errors.push(`${f.sid}: 解压出 ${raw.length} 字节却提到 0 条消息（可疑）`)
        }
        skipped++
        continue
      }

      // 🛑 tokenize 在事务**外面**做（这里可以 yield），事务里只留纯写入。
      //    原因：事务跨 `await` 会让**另一个 DSH 窗口**的连接撞上写锁 ——
      //    实测最坏同步阻塞 5.48 秒，比同步版卡的 2.4 秒还糟。
      //    拆开之后事务时长重新由 CPU 决定（单文件最坏约 95ms），不再受事件循环调度影响。
      const prepared = []
      let nTk = 0
      for (const m of list) {
        prepared.push({ m, big: tokenize(m.text).join(' ') })
        if (++nTk % 400 === 0) yield 'tokenize'
      }
      yield 'tokenize-done'

      // 删除和插入放在同一个事务里：不然插入失败 ROLLBACK 时旧消息已经被删掉，
      // 那段时间搜不到这个会话（虽然下次因 mtime 不等会补回，但中间是空的）
      // ⚠️ 这个事务里**不许有 yield**（见上）。
      db.exec('BEGIN')
      try {
        del.run(f.sid)
        delFts.run(f.sid)
        for (const { m, big } of prepared) {
          insMsg.run(f.sid, m.seq, m.role, m.time, m.text)
          if (big) insFts.run(f.sid, m.seq, m.role, big)
        }
        upsert.run(f.sid, f.path, f.mtime, f.size, list.length, Date.now())
        db.exec('COMMIT')
      } catch (e) {
        // 🛑 ROLLBACK 自己也会抛（事务可能已被别处干掉，报 "no transaction is active"），
        //    let 它盖掉原始错误就没法查了。
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务已经不在了，忽略 */
        }
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
    // 出口自检：入口判据若失效（目录命名变了），这里把纯 uuid 的 sid 清掉并报数。
    // 调用方（插件）据此打一行日志 —— 有数就说明入口漏了，该回头查 listSessionFiles。
    purgedSubagents: purgeSubagentRows(db),
  }
}

/** 同步版：一次跑完（脚本、测试用；在事件循环里跑会卡住，插件里别用）。 */
export function buildSessionIndex(db, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  const g = buildSessionIndexSteps(db, sessionsRoot)
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value
}

/**
 * 异步版：**按时间片**让出事件循环（不是"每 N 个文件"——
 * 单个大文件就能卡 2 秒，按文件数算根本挡不住）。
 * 生成器在每一步之间都有 yield，所以只要这一片干满了就交还控制权。
 * 插件里的所有调用点都应该用这个。
 */
export async function buildSessionIndexAsync(
  db,
  sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions'),
  budgetMs = 8,
) {
  const g = buildSessionIndexSteps(db, sessionsRoot)
  let r = g.next()
  let lastYield = Date.now()
  while (!r.done) {
    if (Date.now() - lastYield >= budgetMs) {
      await new Promise((res) => setImmediate(res))
      lastYield = Date.now()
    }
    r = g.next()
  }
  return r.value
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
