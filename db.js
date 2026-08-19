const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// 本地備援用（沒有設定 Turso 環境變數時，退回本地檔案 SQLite，行為與之前相同）
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'booking.db');

// 若有設定 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN，就會連線到 Turso 雲端資料庫
// （資料永久保存，不會因為 Render 重新部署或休眠而消失）。
// 若沒有設定，則退回使用本機檔案（僅適合本地開發測試）。
const url = process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient(authToken ? { url, authToken } : { url });

// --- Schema -----------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // 每週可預約規則：星期幾、開始時間、結束時間（每次預約時長由 settings.slot_duration_min 決定）
  `CREATE TABLE IF NOT EXISTS availability_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    weekday INTEGER NOT NULL,      -- 0=週日 ... 6=週六
    start_time TEXT NOT NULL,      -- 'HH:mm'
    end_time TEXT NOT NULL         -- 'HH:mm'
  )`,

  // 管理者手動封鎖的日期（例如請假）
  `CREATE TABLE IF NOT EXISTS blocked_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL             -- 'YYYY-MM-DD'
  )`,

  // 自訂預約問題：type='text' 為文字輸入，type='choice' 為單選（options 為 JSON 陣列）
  `CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS bookings (
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
  )`,
];

const DEFAULT_SETTINGS = {
  slot_duration_min: '30',
  buffer_min: '0',
  timezone: 'Asia/Taipei',
  business_name: '我的預約頁面',
  admin_password: 'changeme',
  booking_window_days: '30',
};

async function columnExists(table, column) {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return res.rows.some((r) => r.name === column);
}

async function init() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await client.execute(stmt);
  }

  // 升級舊資料庫（若 questions 表格是舊版、還沒有 type/options 欄位）
  if (!(await columnExists('questions', 'type'))) {
    await client.execute("ALTER TABLE questions ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
  }
  if (!(await columnExists('questions', 'options'))) {
    await client.execute('ALTER TABLE questions ADD COLUMN options TEXT');
  }

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      args: [k, v],
    });
  }
}

const ready = init();

module.exports = { client, ready };
