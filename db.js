const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'booking.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Schema ---------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 每週可預約規則：星期幾、開始時間、結束時間（每次預約時長由 settings.slot_duration_min 決定）
CREATE TABLE IF NOT EXISTS availability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL,      -- 0=週日 ... 6=週六
  start_time TEXT NOT NULL,      -- 'HH:mm'
  end_time TEXT NOT NULL         -- 'HH:mm'
);

-- 管理者手動封鎖的日期／時段（例如請假）
CREATE TABLE IF NOT EXISTS blocked_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL             -- 'YYYY-MM-DD'
);

-- 自訂預約問題
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,            -- 'YYYY-MM-DD'
  start_time TEXT NOT NULL,      -- 'HH:mm'
  end_time TEXT NOT NULL,        -- 'HH:mm'
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  answers TEXT,                  -- JSON: [{label, answer}]
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  meet_link TEXT,
  calendar_event_id TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Default settings -------------------------------------------------------

const defaults = {
  slot_duration_min: '30',
  buffer_min: '0',
  timezone: 'Asia/Taipei',
  business_name: '我的預約頁面',
  admin_password: 'changeme',
  booking_window_days: '30',
};

const insertDefault = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(defaults)) {
  insertDefault.run(k, v);
}

module.exports = db;
