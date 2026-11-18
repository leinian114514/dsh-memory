/**
 * 项目核心：给每个项目一份专属规则，只在该项目活跃时注入。
 *
 * 数据全在磁盘上，改内容不用重启：
 *   <root>/projects.json   项目清单（关键词 / 联动 / 父子 / 文件名）
 *   <root>/<项目>.md       该项目核心正文
 *
 * 激活状态每轮按关键词实时判断；挂上之后按轮次衰减，连续几轮不提就摘掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 项目核心根目录，默认 `<workspace>/_项目核心`。
 *
 * 取值优先级：`setProjectCoreRoot()` ＞ 环境变量 `DSH_PROJECT_CORE` ＞ `process.cwd()/_项目核心`。
 *
 * 用 `export let` 是为了拿到 ESM 的 live binding —— setter 一改，
 * 各处 import 进来的 `PROJECT_CORE_ROOT` 跟着变，不用把几十处引用改成函数调用。
 */
export let PROJECT_CORE_ROOT =
  (process.env.DSH_PROJECT_CORE || '').trim() || path.join(process.cwd(), '_项目核心')

/** 设置项目核心目录（index.js 在 apply 里调；传空就忽略，保留当前值）。 */
export function setProjectCoreRoot(p) {
  if (typeof p === 'string' && p.trim()) PROJECT_CORE_ROOT = p.trim()
}

/**
 *
 * 为什么必须分：用户要「自选窗口然后调整」——不同对话窗口挂的项目核心要能各自不同。
 * 之前用全局 Map，是因为当时以为 pre-step 拿不到 sessionId；现在能拿到了。
 * 拿不到时（老版本/异常）统一落到 'global'，行为和以前一致，不会崩。
 *
 *   active      : 项目名 → 已经连续几轮没被提到（按轮次衰减，不用时间）
 */
const sessions = new Map()

function stOf(sessionId) {
  const k = String(sessionId || 'global')
  let s = sessions.get(k)
  if (!s) {
    // 首次见到这个会话：从 state.json 恢复"已注入"记录。
    //
    // `active` 是"当前还挂着的项目"：项目名 → 已经连续几轮没被提到。
    //    「时间这个东西是最不靠谱的」—— 中间去泡碗面回来还在干同一件事，
    //    按时间算就误摘了；按轮次算才知道"你还在这件事上"。
    const slot = slotOf(k)
    s = {
      active: new Map(),
      lastInjected: new Set(k === 'global' ? [] : slot.injected),
      lastTurn: null,
    }
    sessions.set(k, s)
  } else {
    // LRU：每次访问都挪到末尾 ⇒ `listSessions()` 的**最后一个**就是最近活跃的会话。
    // 面板靠这个猜"当前窗口"，省得用户每次手动选。
    sessions.delete(k)
    sessions.set(k, s)
  }
  return s
}

/** 列出内存里出现过的会话（面板选窗口用）。 */
export function listSessions() {
  return [...sessions.keys()]
}

export function touchSession(sessionId) {
  if (!sessionId || sessionId === 'global') return
  // 这里**不要**顺手 stOf('global')：'global' 会被挪到 LRU 末尾，
  //    面板"默认选最近会话"就永远选中 global 了。
  stOf(sessionId)
}

/**
 * 会话标题（面板上给人看的）。
 *
 * 光有 `session-abc123...` 用户认不出是哪个窗口 —— 要的是"当前在哪个对话里"。
 * 标题直接读 DSH 的投影缓存，一次一问，量很小。
 */
function sessionTitleOf(sid) {
  try {
    const p = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', String(sid) + '.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const t = j?.record?.rows?.title?.val
    const title = typeof t === 'string' ? t : t && t.title ? t.title : ''
    return String(title || '').slice(0, 40)
  } catch {
    return ''
  }
}

/** 所有"有状态"的会话 + 标题，给面板的下拉用。 */
export function listSessionChoices() {
  const out = [{ id: 'global', title: '（默认 / 无会话）' }]
  const seen = new Set()
  //    stOf() 每次访问都 delete+set，所以 sessions.keys() 的顺序是
  //    「最久没碰的 → 最近活跃的」，最后一个是最近活跃。
  //    面板默认打开就落到最旧的窗口上，点开关改的还是那个窗口 —— 跟"打开就看见当前对话"正好相反。
  for (const sid of [...sessions.keys()].reverse()) {
    if (sid === 'global') continue
    seen.add(sid)
    out.push({ id: sid, title: sessionTitleOf(sid) || String(sid).slice(-12) })
  }
  // 以前只列 runtime 里出现过的 ⇒ 刚重启时下拉里只有「默认」，
  // 得等你说一句话才冒出来，体验很差。这里直接扫 DSH 的投影缓存。
  for (const it of scanRecentSessions(30)) {
    if (seen.has(it.id)) continue
    out.push({ id: it.id, title: it.title })
  }
  return out
}

/**
 * 已被 DSH 归档的会话 id 集合。
 *
 * 归档是 `dsh-session-manager` 自带的功能（侧栏那个「归档会话」），
 * 状态存在 `~/.dsh/dsh-session-manager/workspace-archives.v1.json`：
 *   { workspaces: { <wsId>: { archived, archivedAt, sessionIds: [...] } } }
 * 设计意图：归档掉的会话不该再出现在下拉里。
 */
function archivedSessionIds() {
  const out = new Set()
  try {
    const p = path.join(os.homedir(), '.dsh', 'dsh-session-manager', 'workspace-archives.v1.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    for (const rec of Object.values(j.workspaces || {})) {
      if (!rec || !Array.isArray(rec.sessionIds)) continue
      for (const sid of rec.sessionIds) {
        const s = String(sid)
        out.add(s)
        out.add(s.startsWith('session-') ? s.slice(8) : 'session-' + s)
      }
    }
  } catch {}
  return out
}

/**
 * DSH 认为"还在列表里"的会话 id 集合。
 *
 *    那其实是**工作区归档**（还是空的），跟侧栏那个"归档会话"完全不是一回事。
 *    真正的会话归档在 `~/.dsh/storages/workspace.json`：
 *      global.pinnedSessionIds   （置顶，0 条）
 *      tables.workspaces[*].sessionIds （三个工作区共 111 条）
 *    ⇒ 未归档 = sessionIds − archivedSessionIds。
 * 返回 null 表示读失败（调用方退回"扫目录"）。
 */
function aliveSessionIds() {
  try {
    const p = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const archived = new Set((j?.global?.archivedSessionIds || []).map(String))
    // 归档列表里可能是裸 id 也可能是带前缀，两种都塞进去
    for (const s of [...archived]) {
      archived.add(s.startsWith('session-') ? s.slice(8) : 'session-' + s)
    }
    const all = new Set()
    for (const w of Object.values(j?.tables?.workspaces || {})) {
      for (const sid of w?.sessionIds || []) {
        const s = String(sid)
        if (!archived.has(s)) all.add(s)
      }
    }
    return all
  } catch {
    return null
  }
}

/** 扫描 DSH 投影缓存里的最近会话（带 30 秒缓存，避免每次点面板都全盘解析）。 */
let scanCache = { at: 0, list: [] }
function scanRecentSessions(limit) {
  const now = Date.now()
  if (now - scanCache.at < 30_000 && scanCache.list.length) return scanCache.list
  const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return scanCache.list
  }
  // 先用 workspace.json 筛一遍：只留未归档的（111 → 21），顺带把已归档的挡掉
  const alive = aliveSessionIds()
  if (alive) {
    files = files.filter((f) => alive.has(f.replace(/\.json$/, '')))
  }
  const archivedFallback = archivedSessionIds()
  const items = []
  for (const f of files) {
    try {
      items.push({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })
    } catch {}
  }
  items.sort((a, b) => b.m - a.m)
  const out = []
  // 先过滤再数，不能先 slice(0,limit) 再过滤 ——
  //    那个目录里大半是子智能体会话，先截断会把真实对话挤出榜外
  for (const it of items) {
    if (out.length >= limit) break
    const id = it.f.replace(/\.json$/, '')
    if (!id || archivedFallback.has(id)) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, it.f), 'utf8'))
      const rows = j?.record?.rows || {}
      //    标记：`rows.subagent.val.identity`（有 mode/label/seq）。
      if (rows.subagent?.val?.identity) continue
      const t = rows.title?.val
      const title = typeof t === 'string' ? t : t && t.title ? t.title : ''
      // DSH 内部的系统会话：`Generate session title`（自动起标题用，turns=1/steps=1）。
      if (/^\s*generate session title\s*$/i.test(title)) continue
      const st = rows.sessionStats?.val || {}
      // 单轮单步的也当成系统调用跳过（真聊天至少有几轮）。
      if (Number(st.turns) <= 1 && Number(st.steps) <= 1) continue
      const blank = rows.sessionListMetadata?.val?.blank === true
      if (blank) continue // 空会话没有内容，列出来只会添乱
      out.push({
        id,
        // 没标题的是真会话（比如 turns=1/steps=39 那种跑了一大轮的），只是 DSH 没给它起名。
        // 显示成"（未命名）后 8 位"总比一串 UUID 好认。
        title: String(title || '').slice(0, 40) || `（未命名）${id.slice(-8)}`,
        updatedAt: it.m,
      })
    } catch {}
  }
  scanCache = { at: now, list: out }
  return out
}

/** 配置缓存：按内容做粗缓存，改 projects.json 立刻生效。 */
let cfgCache = { text: '', data: null }

/**
 * 上一次写 state.json 失败的信息（成功时置 null），会随面板快照带出去。
 */
let persistFailed = null

/**
 * 手动开关（覆盖自动判定）。存在独立文件里，不动 projects.json。
 * 值是 'on'（强制挂，不管提没提）或 'off'（强制不挂）。
 * 没出现在这里的项目 = 'auto'（按关键词）。
 *
 * 而不是只能靠模型猜关键词（也不是删记忆，只是控制注入）。
 */
const OVERRIDES_PATH = path.join(PROJECT_CORE_ROOT, 'state.json')

/**
 *   { "sessions": { "<sessionId>": { "overrides": {"MMD":"on"}, "locked": false } } }
 * 拿不到 sessionId 的调用方传 'global'，行为和以前完全一样。
 */
/** 严格读：文件坏了会抛错，让调用方能区分「文件不存在」和「文件坏了」。 */
function readStateRawStrict() {
  const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8')
  const j = JSON.parse(raw)
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('state.json 结构不对')
  return j
}

/** 宽松读：读不到/坏了就当空（面板展示用，不关心错误）。 */
function readStateRaw() {
  try {
    return readStateRawStrict()
  } catch {
    return {}
  }
}

function slotOf(sessionId) {
  const st = readStateRaw()
  const all = st && typeof st.sessions === 'object' && st.sessions ? st.sessions : {}
  const one = all[String(sessionId || 'global')]
  if (!one || typeof one !== 'object') return { overrides: {}, locked: false, injected: [] }
  const ov = {}
  for (const [p, v] of Object.entries(one.overrides || {})) if (v === 'on' || v === 'off') ov[p] = v
  return {
    overrides: ov,
    locked: one.locked === true,
    injected: Array.isArray(one.injected) ? one.injected.filter((x) => typeof x === 'string') : [],
  }
}

function writeSlot(sessionId, slot) {
  //      ① readStateRaw 把所有失败（半截 JSON / 权限 / 句柄占用）都返回 {}，
  //         调用方分不清"文件不存在"和"文件坏了"；
  //      ② writeFileSync 是"先截断再写"，写到一半失败就留个 0 字节文件。
  //    ⇒ 一次写失败 → 下次读到 {} → 再写就把别的会话全抹了，而且全程无提示。
  let st
  try {
    st = readStateRawStrict()
  } catch (e) {
    if (e && e.code === 'ENOENT') st = {}   // 真没有 → 新建
    else return false                        // 坏了 → 这次不写，别覆盖别人的
  }
  if (!st.sessions || typeof st.sessions !== 'object' || Array.isArray(st.sessions)) st.sessions = {}
  st.sessions[String(sessionId || 'global')] = {
    overrides: slot.overrides || {},
    locked: slot.locked === true,
    injected: Array.isArray(slot.injected) ? slot.injected : [],
  }
  // 先写临时文件再 rename —— 同一分区上是原子替换，不会留下半截文件
  const tmp = OVERRIDES_PATH + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
    fs.renameSync(tmp, OVERRIDES_PATH)
    persistFailed = null
    return true
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    // 写不进去要留痕，别静默（否则面板显示"已加载"、重启后变"未加载"，没人知道为什么）
    persistFailed = { at: Date.now(), sessionId: String(sessionId || 'global'), error: e && e.message }
    return false
  }
}

/** 把当前会话"已注入"的集合写回磁盘（重启后恢复用）。 */
export function persistInjected(sessionId) {
  const k = String(sessionId || 'global')
  // global 是共享槽，不存 injected（理由见 stOf 里的注释）
  if (k === 'global') return false
  const st = sessions.get(k)
  if (!st) return false
  const cur = slotOf(sessionId)
  cur.injected = [...st.lastInjected]
  return writeSlot(sessionId, cur)
}

export function resetInjected(sessionId) {
  const st = stOf(sessionId)
  st.lastInjected.clear()
  return persistInjected(sessionId)
}

export function readOverrides(sessionId) {
  return slotOf(sessionId).overrides
}

export function readLocked(sessionId) {
  return slotOf(sessionId).locked
}

export function setLocked(on, sessionId) {
  const cur = slotOf(sessionId)
  cur.locked = on === true
  if (!writeSlot(sessionId, cur)) return { ok: false, error: '写 state.json 失败' }
  return { ok: true, locked: cur.locked }
}

/** 改一个项目的开关。mode 传 'auto' 就是删掉覆盖。 */
export function setOverride(project, mode, sessionId) {
  const cur = slotOf(sessionId)
  const o = cur.overrides
  if (mode === 'auto' || mode == null) delete o[project]
  else if (mode === 'on' || mode === 'off') o[project] = mode
  else return { ok: false, error: 'mode 只能是 on / off / auto' }
  if (!writeSlot(sessionId, cur)) return { ok: false, error: '写 state.json 失败' }
  // 状态变了要允许重新注入：清掉"已注入"记录，下一次就会带出去
  const st = stOf(sessionId)
  st.lastInjected.delete(project)
  if (mode === 'off') st.active.delete(project)
  return { ok: true, overrides: o }
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** 读项目清单。配置写坏了就返回空配置（降级为不注入，不抛错）。 */
export function readProjectConfig() {
  const p = path.join(PROJECT_CORE_ROOT, 'projects.json')
  const raw = readFileOrNull(p)
  if (raw === null) return { projects: {}, maxMiss: 3, maxCharsPerProject: 900, recentWindowMin: 30 }
  if (cfgCache.text === raw && cfgCache.data) return cfgCache.data
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    return { projects: {}, maxMiss: 3, maxCharsPerProject: 900, recentWindowMin: 30 }
  }
  const data = {
    projects: j && typeof j.projects === 'object' && j.projects ? j.projects : {},
    maxMiss: Number.isFinite(j?.maxMiss) ? j.maxMiss : 3,
    maxCharsPerProject: Number.isFinite(j?.maxCharsPerProject) ? j.maxCharsPerProject : 900,
    recentWindowMin: Number.isFinite(j?.recentWindowMin) ? j.recentWindowMin : 30,
  }
  cfgCache = { text: raw, data }
  return data
}

/** 把联动项目一起展开（A 挂了，linked 里的一起挂；父项目挂了，子项目一起挂）。 */
function withLinked(names, projects, banned) {
  const out = new Set()
  const stack = [...names]
  while (stack.length) {
    const n = stack.pop()
    if (out.has(n)) continue
    //    但它的子项目 / 联动项目已经在展开时被 push 进去了 ⇒ 关掉一个项目，
    //    它的下游照样注入（比如关掉父项目，子项目还在）。
    if (banned && banned.has(n)) continue
    out.add(n)
    const def = projects[n]
    if (def && Array.isArray(def.linked)) for (const l of def.linked) if (projects[l]) stack.push(l)
    //    （设计意图：子项目要跟着父项目一起挂上）。
    for (const [name, d] of Object.entries(projects)) {
      if (d && d.parent === n) stack.push(name)
    }
  }
  return out
}

/**
 * 按一条用户消息算出该注入的项目核心文本。
 * 没命中、或者"这次没有新项目进来"就返回空串（调用方据此决定要不要追加消息）。
 *
 * @param userText 用户这轮说的话
 * @param opts.force 首轮/强制注入时传 true，跳过"只注入新增项目"的节流
 */
export function buildProjectCoreSection(userText, opts = {}) {
  const text = String(userText || '')
  if (!text.trim() && !opts.force) return ''
  const st = stOf(opts.sessionId)
  // 会话锁 = **冻结当前集合**：不再按关键词加、也不再按轮次摘，
  //    "界面看到什么就注入什么"。
  //       连面板上「常驻」的项目也一起失效 —— 跟"冻结当前状态"的设计意图相反。
  //       现在改成：冻结集合但仍照常注入。
  const locked = readLocked(opts.sessionId)
  const cfg = readProjectConfig()
  const names = Object.keys(cfg.projects)
  if (names.length === 0) return ''

  const lower = text.toLowerCase()
  const now = Date.now()

  // ⓪ 手动开关优先（面板上点的 on/off 盖掉关键词判定）——按会话取
  const ov = readOverrides(opts.sessionId)
  const offSet = new Set(Object.keys(ov).filter((n) => ov[n] === 'off'))
  const onSet = new Set(Object.keys(ov).filter((n) => ov[n] === 'on' && cfg.projects[n]))
  for (const n of offSet) {
    st.active.delete(n)
    st.lastInjected.delete(n)
  }

  // ① 这条消息命中的项目
  const hit = []
  for (const name of names) {
    if (offSet.has(name)) continue
    const def = cfg.projects[name]
    const kws = Array.isArray(def?.keywords) ? def.keywords : []
    if (kws.some((k) => k && lower.includes(String(k).toLowerCase()))) hit.push(name)
  }

  //    一轮里提到了 ⇒ miss 归零；没提到 ⇒ miss+1；连续 maxMiss 轮没提到就摘。
  //    只在"换了一轮"时计数：同一个 turn 内会跑多个 step，每 step 都算会把
  //    会话锁定时整段跳过 —— 集合冻结，不涨也不摘。
  const maxMiss = Number.isFinite(cfg.maxMiss) ? cfg.maxMiss : 3
  const turnNow = Number.isFinite(opts.turn) ? opts.turn : null
  let newTurn
  if (turnNow !== null) {
    newTurn = turnNow !== st.lastTurn
    if (newTurn) st.lastTurn = turnNow
  } else {
    st.stepCount = (Number.isFinite(st.stepCount) ? st.stepCount : 0) + 1
    newTurn = opts.step === 1 || st.stepCount % 20 === 0
  }

  if (newTurn && !locked) {
    const hitSet = new Set(hit)
    for (const name of hitSet) st.active.set(name, 0)
    for (const [name, miss] of [...st.active]) {
      if (hitSet.has(name)) continue
      const m = miss + 1
      if (m > maxMiss) st.active.delete(name)
      else st.active.set(name, m)
    }
  }

  const still = [...st.active.keys()]
  if (locked) {
    for (const n of st.lastInjected) if (cfg.projects[n] && !still.includes(n)) still.push(n)
  }

  const active = withLinked([...(locked ? [] : hit), ...still, ...onSet], cfg.projects, offSet)
  // 联动可能把手动关掉的项目又带进来 ⇒ 最后再剔一遍
  for (const n of offSet) active.delete(n)

  //    旧逻辑："项目掉出活跃集就从 lastInjected 里删掉，否则以后提到它不再注入。"
  //    听着合理，实际会误伤：
  //      · 重启后 st.active 是空的 ⇒ 所有项目都被判成"掉出" ⇒ lastInjected 被清光；
  //      · 面板显示全变"未加载"（其实是假象，内容还在上下文里）；
  //      · 下次提到关键词又重复灌一遍，白烧 token。
  //    真相：lastInjected 记的是"内容已经进过上下文"，而上下文本身是持久的。
  //    项目掉出活跃集**不等于**内容从对话历史里消失，不需要重灌。
  //    该清的场合只有两个，别的一律不动：
  //      · 上下文被压缩（内容真的没了）→ resetInjected()
  //      · 用户手动改开关（想立刻生效）→ setOverride() 里已经清了

  if (active.size === 0) return ''

  // ④ 先把"真的有文件、真的能注入"的项目挑出来。
  // 必须先过滤再判节流：没写项目核心文件的项目（比如只配了关键词的）
  //    永远进不了 lastInjected，如果拿整个 active 去比，它每轮都会被算成"新增"，
  const bodies = new Map()
  for (const name of active) {
    const def = cfg.projects[name]
    if (!def || !def.file) continue
    const body = readFileOrNull(path.join(PROJECT_CORE_ROOT, def.file))
    if (!body || !body.trim()) continue
    bodies.set(name, body.trim())
  }
  if (bodies.size === 0) return ''

  // ⑤ 节流：只注入"有文件且没注入过"的项目。
  //    已经注入过的还在历史消息里，模型照样看得见，再带一遍就是纯烧 token
  const added = [...bodies.keys()].filter((x) => opts.force || !st.lastInjected.has(x))
  if (added.length === 0) return ''

  const parts = added.map((name) => {
    let t = bodies.get(name)
    if (t.length > cfg.maxCharsPerProject) t = t.slice(0, cfg.maxCharsPerProject) + '\n（已截断）'
    return `### ${name}\n${t}`
  })

  for (const name of bodies.keys()) st.lastInjected.add(name)
  // 落盘：重启后面板还能显示"已加载"，不用重新触发一遍
  try {
    persistInjected(opts.sessionId)
  } catch {}

  return [
    '⟪项目核心⟫ 以下是当前活跃项目的专属规则（这个项目里"不看就会踩坑"的东西）。',
    '它和通用习惯冲突时，**以用户当下说的为准**；没有明确说法时按这里做。',
    '',
    ...parts,
  ].join('\n')
}

/** 供面板/调试用：项目清单 + 每个项目的当前状态（**按会话**）。 */
export function projectCoreSnapshot(sessionId) {
  const cfg = readProjectConfig()
  const ov = readOverrides(sessionId)
  const st = stOf(sessionId)
  const projects = Object.keys(cfg.projects).map((name) => {
    const def = cfg.projects[name]
    let fileOk = false
    let size = 0
    try {
      const p = path.join(PROJECT_CORE_ROOT, def.file || '')
      const s = fs.readFileSync(p, 'utf8')
      fileOk = s.trim().length > 0
      size = s.length
    } catch {
      fileOk = false
    }
    return {
      name,
      mode: ov[name] || 'auto',
      file: def.file || '',
      fileOk,
      size,
      keywords: Array.isArray(def.keywords) ? def.keywords.length : 0,
      linked: Array.isArray(def.linked) ? def.linked : [],
      parent: typeof def.parent === 'string' ? def.parent : '',
      // 连续几轮没被提到（0 = 这一轮刚提到过）
      missRounds: st.active.has(name) ? st.active.get(name) : null,
      injected: st.lastInjected.has(name),
    }
  })
  return {
    root: PROJECT_CORE_ROOT,
    sessionId: String(sessionId || 'global'),
    sessions: listSessionChoices(),
    maxMissTurns: Number.isFinite(cfg.maxMiss) ? cfg.maxMiss : 3,
    maxCharsPerProject: cfg.maxCharsPerProject,
    locked: readLocked(sessionId),
    // 上一次写 state.json 失败的信息（null = 一切正常）。面板可据此显一行红字，
    // 免得"写不进去"变成完全静默。
    persistFailed,
    projects,
  }
}
