/**
 * 内置表结构 —— 让「库不存在」时能自动建起来。
 *
 * 为什么需要它：插件第一次运行时工作区里还没有 memory.db。
 * 原先只在文件已存在时打开，结果就是「工具都在、但一条也写不进去」——
 * 对别人第一次安装来说等于完全不可用。
 *
 * 这份 SQL 从一个跑了一个多月的真实库导出，并统一加了 IF NOT EXISTS：
 * 所以同一套语句既能**建新库**，也能**给旧库补缺表**。
 * 表结构与 meow-memory 系列兼容，旧库无需迁移。
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
CREATE TABLE IF NOT EXISTS fact (
  id TEXT PRIMARY KEY,
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
,
    project TEXT);
CREATE TABLE IF NOT EXISTS fact_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lesson (
  id TEXT PRIMARY KEY,
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
,
    corrected INTEGER NOT NULL DEFAULT 0,
    project TEXT);
CREATE TABLE IF NOT EXISTS lesson_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
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
,
    project TEXT NOT NULL,
    subcategory TEXT);
CREATE TABLE IF NOT EXISTS project_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
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
,
    project TEXT);
CREATE TABLE IF NOT EXISTS rules_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS soul (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS soul_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topic (
  id TEXT PRIMARY KEY,
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
,
    goal TEXT,
    project TEXT);
CREATE TABLE IF NOT EXISTS topic_hist (
  hid INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id TEXT NOT NULL,
  op TEXT NOT NULL,
  old_json TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS user_hist (
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
CREATE INDEX IF NOT EXISTS idx_fact_hist_src ON fact_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_lesson_hist_src ON lesson_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_project_hist_src ON project_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_rules_hist_src ON rules_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_soul_hist_src ON soul_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_topic_hist_src ON topic_hist(src_id, hid);
CREATE INDEX IF NOT EXISTS idx_user_hist_src ON user_hist(src_id, hid);
`

/**
 * 把 schema 应用到连接上。
 * 用的是 IF NOT EXISTS，所以对已有库调用是安全的（只补缺的，不动数据）。
 */
export function ensureSchema(db) {
  db.exec(SCHEMA_SQL)
}

export default ensureSchema
