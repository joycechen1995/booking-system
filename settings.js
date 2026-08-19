const { client } = require('./db');

async function getSetting(key) {
  const res = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return res.rows[0] ? res.rows[0].value : undefined;
}

async function setSetting(key, value) {
  await client.execute({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, String(value)],
  });
}

async function getAllSettings() {
  const res = await client.execute('SELECT key, value FROM settings');
  const out = {};
  for (const r of res.rows) out[r.key] = r.value;
  return out;
}

module.exports = { getSetting, setSetting, getAllSettings };
