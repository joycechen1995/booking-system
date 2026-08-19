const dayjs = require('dayjs');
const { client } = require('./db');
const { getSetting } = require('./settings');

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  const h = Math.floor(min / 60)
    .toString()
    .padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 回傳指定日期的可預約時段陣列，例如 ['09:00','09:30',...]
 * 會排除：已被預約的時段、封鎖日期、已過去的時間（若為今天）
 */
async function getAvailableSlots(dateStr) {
  const date = dayjs(dateStr, 'YYYY-MM-DD', true);
  if (!date.isValid()) return [];

  const blockedRes = await client.execute({
    sql: 'SELECT 1 FROM blocked_dates WHERE date = ?',
    args: [dateStr],
  });
  if (blockedRes.rows.length > 0) return [];

  const weekday = date.day();
  const rulesRes = await client.execute({
    sql: 'SELECT * FROM availability_rules WHERE weekday = ?',
    args: [weekday],
  });
  const rules = rulesRes.rows;
  if (rules.length === 0) return [];

  const duration = parseInt((await getSetting('slot_duration_min')) || '30', 10);
  const buffer = parseInt((await getSetting('buffer_min')) || '0', 10);
  const step = duration + buffer;

  // 已被預約（未取消）的時段
  const existingRes = await client.execute({
    sql: "SELECT start_time, end_time FROM bookings WHERE date = ? AND status = 'confirmed'",
    args: [dateStr],
  });
  const existing = existingRes.rows;

  const slots = [];
  for (const rule of rules) {
    let cursor = timeToMinutes(rule.start_time);
    const end = timeToMinutes(rule.end_time);
    while (cursor + duration <= end) {
      const slotStart = cursor;
      const slotEnd = cursor + duration;
      const overlaps = existing.some((b) => {
        const bStart = timeToMinutes(b.start_time);
        const bEnd = timeToMinutes(b.end_time);
        return slotStart < bEnd && bStart < slotEnd;
      });
      if (!overlaps) {
        slots.push(minutesToTime(slotStart));
      }
      cursor += step;
    }
  }

  // 若日期是今天，過濾掉已經過去的時段
  const now = dayjs();
  if (date.isSame(now, 'day')) {
    const nowMin = now.hour() * 60 + now.minute();
    return slots.filter((s) => timeToMinutes(s) > nowMin);
  }

  return slots;
}

async function isWithinBookingWindow(dateStr) {
  const windowDays = parseInt((await getSetting('booking_window_days')) || '30', 10);
  const date = dayjs(dateStr, 'YYYY-MM-DD', true);
  const today = dayjs().startOf('day');
  if (!date.isValid()) return false;
  if (date.isBefore(today)) return false;
  if (date.diff(today, 'day') > windowDays) return false;
  return true;
}

module.exports = { getAvailableSlots, isWithinBookingWindow, timeToMinutes, minutesToTime };
