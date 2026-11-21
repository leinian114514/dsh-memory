/**
 * 内置表结构 —— 让「库不存在」时能自动建起来。
 *
 * 为什么需要它：插件第一次运行时工作区里还没有 memory.db。
 * 原先只在文件已存在时打开，结果就是「工具都在、但一条也写不进去」——
 * 对别人第一次安装来说等于完全不可用。
 *
 * 四层：core / project / branch / detail，每层多一个 `category` 列做层内分类：
 *   core    : identity 身份 / preference 偏好 / principle 原则 / rule 禁令
 *   project : overview 概览 / structure 结构 / features 功能清单 / history 历史年表
 *   branch  : decision 决策 / ops 现状 / todo 待办 / quote 金句 / plan 方案
 *   detail  : fact 事实 / lesson 教训 / topic 专题 / procedure 规程 /
 *             impl 实现细节 / reference 参考资料
 * ⚠️ 这份列表是注释，真正的白名单在 `db.js` 的 `CATEGORIES` —— 加分类改那边，
 *    这里只是给人看的（2026-11-21 复查发现这里落后了四个分类）。
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at INTEGER NOT NULL,
      summary TEXT,
      changes TEXT,
      note TEXT
    );
CREATE TABLE IF NOT EXISTS dream_meta (
      key TEXT PRIMARY KEY,
      value INTEGER
    );
CREATE TABLE IF NOT EXISTS dream_skip (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      skip_dream INTEGER NOT NULL DEFAULT 1,
      skip_inject INTEGER NOT NULL DEFAULT 0,
      skip_write INTEGER NOT NULL DEFAULT 0
    );
CREATE TABLE IF NOT EXISTS core (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'preference',
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  happened_at INTEGER,
  context TEXT,
  mood TEXT
);
CREATE TABLE IF NOT EXISTS core_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'overview',
  project TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  happened_at INTEGER,
  context TEXT,
  mood TEXT
);
CREATE TABLE IF NOT EXISTS project_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS branch (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'ops',
  project TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  happened_at INTEGER,
  context TEXT,
  mood TEXT
);
CREATE TABLE IF NOT EXISTS branch_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS detail (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'fact',
  project TEXT,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  happened_at INTEGER,
  context TEXT,
  mood TEXT
);
CREATE TABLE IF NOT EXISTS detail_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS windows (
      session_id TEXT PRIMARY KEY,
      workspace TEXT,
      last_event_time INTEGER,
      last_dream_time INTEGER,
      dream_owner TEXT,
      dream_started_at INTEGER,
      dream_progress_at INTEGER,
      dream_group_idx INTEGER,
      dream_T INTEGER
    );
CREATE INDEX IF NOT EXISTS idx_core_hist_src ON core_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_project_hist_src ON project_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_branch_hist_src ON branch_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_detail_hist_src ON detail_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_core_cat ON core(category, status);
CREATE INDEX IF NOT EXISTS idx_project_cat ON project(category, status);
CREATE INDEX IF NOT EXISTS idx_branch_cat ON branch(category, status);
CREATE INDEX IF NOT EXISTS idx_detail_cat ON detail(category, status);
`

/**
 * 把 schema 应用到连接上。
 * 用的是 IF NOT EXISTS，所以对已有库调用是安全的（只补缺的，不动数据）。
 */
export function ensureSchema(db) {
  db.exec(SCHEMA_SQL)
  let info = { added: [], errors: [], version: 0 }
  try {
    info = migrate(db)
  } catch (e) {
    // 迁移整体崩了也不能让插件起不来（老代码不认新列也照常能用），
    // 但**必须把错误带出去**：原来是个空 catch，ALTER 半途失败之后
    // 该进程每次写入都会 `no such column`，而日志里一个字都没有
    // （2026-11-19 数据层审计发现，多窗口同时启动能稳定复现）。
    info = { added: [], errors: [String((e && e.message) || e)], version: 0 }
  }
  return info
}

/**
 * 加列式迁移：**只做加法**。
 *
 * 为什么不用「重建表 + 搬数据」：那要重写 2800 多行，中断就两头不靠。
 * `ALTER TABLE ADD COLUMN` 是 O(1)（只改元数据），老数据自动为 NULL，
 * 一行都不用动，老代码读不到新列也照常工作。
 *
 * 三个新列（包 B 后半 + 包 D）：
 *   happened_at  事件发生时间 —— 和 created_at（写进库的时间）不是一回事。
 *                今天补记上周的事，两者差好几天。
 *   context      场景 / 任务 / 参与者 —— 回答"这话在什么情况下说的"。
 *   mood         情绪 JSON：{label, intensity, confidence, source}
 *                source 必须是 explicit（他明说）/ inferred（我推断），
 *                推断的不能当事实用（时间相关 ≠ 因果）。
 */
const MIGRATE_COLS = [
  ['happened_at', 'INTEGER'],
  ['context', 'TEXT'],
  ['mood', 'TEXT'],
  // v3（2026-11-20）：原文出处。格式 `sid#seq`，多条用逗号分隔（`sid#seq,sid#seq`）。
  // 为什么存一列字符串、不拆成 sid/seq 两列：一条记忆可能挂多个出处，拆列就得建关联表，
  // 而实际查询只需要「有没有出处」和「LIKE 某个 sid」，单列够用。
  ['source_ref', 'TEXT'],
  // v4（2026-11-20）：域（这件事的性质，如 编程/创作/生活/系统）。
  // 🛑 **自由文本，不是枚举** —— 硬限定五个等于替别人决定他能干什么；
  //    域是「谁写谁判断」，同一个 agent 自己前后一致就够，不需要跨人统一。
  //    多条用逗号分隔。没标的**不参与降权**（漏标 ≠ 不相关）。
  ['domain', 'TEXT'],
]

/** 结构版本号。以后每改一次结构就 +1，migrate 开头先读它做快速返回。
 *  v2（2026-11-19）：清洗历史数据 —— 老条目的 updated_at 存成了字符串。
 *  v3（2026-11-20）：加 source_ref（原文出处）。
 *  v4（2026-11-20）：加 domain（域，自由文本）。 */
const SCHEMA_VERSION = 4

/**
 * 建/换索引。**每次启动都跑**，不受版本号影响。
 *
 * 为什么：查询全都走 `COALESCE(happened_at, created_at)`，建在 happened_at
 * 单列上的普通索引完全用不上（EXPLAIN 实测是 SCAN + TEMP B-TREE FOR ORDER BY），
 * 只剩写入负担。换成表达式索引，并清掉旧的那个。
 * `IF NOT EXISTS` / `IF EXISTS` 都是幂等的，索引已就绪时几乎不花时间，
 * 所以不需要版本号守门 —— 否则老库（版本号已经是 1）永远换不到新索引。
 */
function ensureIndexes(db, LAYERS) {
  const errors = []
  for (const t of LAYERS) {
    try {
      db.exec(`DROP INDEX IF EXISTS idx_${t}_time`)
    } catch (e) {
      // 删旧索引失败不影响正确性，记一笔就够
      errors.push(`drop idx_${t}_time: ${String((e && e.message) || e)}`)
    }
    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${t}_at ON ${t}(COALESCE(happened_at, created_at))`,
      )
    } catch (e) {
      // 🛑 这里不能吞。索引建失败如果被咽下去，migrate 会照常打版本号 1，
      //    下次启动走快速路径**再也不会重试建索引**，而日志里一个字都没有
      //    （2026-11-19 复审发现原来的空 catch 有这个坑）。
      errors.push(`idx_${t}_at: ${String((e && e.message) || e)}`)
    }
  }
  return errors
}

/** 三列是否真的齐了 —— 快速路径的廉价守卫 */
function colsComplete(db, LAYERS) {
  for (const t of LAYERS) {
    let cols = []
    try {
      cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    } catch {
      return false
    }
    if (cols.length === 0) continue // 表不存在，交给下面的建表路径
    for (const [name] of MIGRATE_COLS) if (!cols.includes(name)) return false
  }
  return true
}

export function migrate(db) {
  const LAYERS = ['core', 'project', 'branch', 'detail']
  // 先读版本号：已经是最新的就只补索引（省掉每层一次 PRAGMA table_info）
  let current = 0
  try {
    current = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0
  } catch {}
  const added = []
  const errors = []
  let wroteVersion = current

  // 快速路径：版本号已是最新**并且**三列真的在，才敢跳。
  // 只看版本号不安全 —— user_version 是整个 db 文件共享的，
  // 别的工具/插件把它写成 1，我们就会永久跳过 ALTER，而列其实还缺着。
  if (current >= SCHEMA_VERSION && colsComplete(db, LAYERS)) {
    return { added, errors: ensureIndexes(db, LAYERS), version: current }
  }

  for (const t of LAYERS) {
    let cols = []
    try {
      cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    } catch {
      continue
    }
    if (cols.length === 0) continue // 表还不存在（新库走建表路径），跳过

    for (const [name, type] of MIGRATE_COLS) {
      if (cols.includes(name)) continue
      try {
        db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${type}`)
        added.push(`${t}.${name}`)
      } catch (e) {
        const msg = String((e && e.message) || e)
        // 🛑 多窗口（另一窗口 / 另开的会话）同时启动时，两个进程会同时判断
        //    "这列不存在"，然后都去 ALTER，第二个必定撞 `duplicate column name`。
        //    这种**不算失败** —— 列已经是我们要的样子了。
        //    其他错误（磁盘满、库损坏）必须记进 errors 往外报：否则后面
        //    每次写入都是 no such column，而日志里一个字都没有。
        if (/duplicate column name/i.test(msg)) continue
        errors.push(`${t}.${name}: ${msg}`)
      }
    }
  }

  // 顺手清历史脏数据：修复前 normalizeTime 会把 0 当合法值写进去，
  // 而读取端（db.js 的 at）现在把 0 当「未填」。不清的话这些条目
  // 永远排在时间轴的 1970、`since` 筛选也永远漏掉它们。
  // 只在完整迁移路径里跑一次（版本号到 1 之后就走快速路径了）。
  for (const t of LAYERS) {
    try {
      db.exec(
        `UPDATE ${t} SET happened_at = NULL WHERE happened_at IS NOT NULL AND happened_at <= 0`,
      )
    } catch {}
  }

  // 🛑 2026-11-19 修：老条目的 `updated_at` 存成了**字符串**（`'2026-10-27 12:14:00'`），
  //    来自七层库迁移那次的批量写入，全都是同一个时刻 —— 不是真实的修改时间。
  //    后果特别隐蔽：
  //      ① SQLite 的 ORDER BY 按类型排序（NULL < INTEGER < TEXT），`DESC` 时这些
  //         text 永远排最前 ⇒ `memory_recent` 前十几条永远是它们；
  //      ② JS 里 `y.updated_at - x.updated_at` 碰到字符串得到 NaN ⇒ 排序彻底失效，
  //         数组保持插入顺序 ⇒ 又变成"前 n 条永远是第一层"。
  //    这些条目建立后确实没被改过，所以用 created_at 填最诚实。
  for (const t of LAYERS) {
    try {
      db.exec(
        `UPDATE ${t} SET updated_at = created_at WHERE typeof(updated_at) = 'text' AND created_at IS NOT NULL`,
      )
    } catch {}
  }

  errors.push(...ensureIndexes(db, LAYERS))

  // 版本号**无条件写**。原来只在 `added > 0` 时才写，而新库走建表路径时
  // 三列本来就在、added=0，于是 user_version 永远是 0 —— 版本机制等于空转。
  // 有错误就不打版本号，下次启动会重试。
  if (errors.length === 0) {
    try {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      wroteVersion = SCHEMA_VERSION
    } catch {}
  }
  // 返回**真正写进去**的版本号。有错没写成就报旧值 ——
  // 否则日志会打「schema v1」而库里其实是 0，看日志的人会被骗。
  return { added, errors, version: wroteVersion }
}

export default ensureSchema
