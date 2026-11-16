/**
 * 内置表结构 —— 让「库不存在」时能自动建起来。
 *
 * 为什么需要它：插件第一次运行时工作区里还没有 memory.db。
 * 原先只在文件已存在时打开，结果就是「工具都在、但一条也写不进去」——
 * 对别人第一次安装来说等于完全不可用。
 *
 * 四层：core / project / branch / detail，每层多一个 `category` 列做层内分类：
 *   core    : identity 身份 / preference 偏好 / principle 原则 / rule 禁令
 *   project : overview 概览 / structure 结构
 *   branch  : decision 决策 / ops 现状 / todo 待办 / quote 金句
 *   detail  : fact 事实 / lesson 教训 / topic 专题 / procedure 规程
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
  last_accessed_at INTEGER
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
  last_accessed_at INTEGER
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
  last_accessed_at INTEGER
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
  last_accessed_at INTEGER
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
}

export default ensureSchema
