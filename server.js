require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const db = require('./db');
const { getSetting, setSetting, getAllSettings } = require('./settings');
const { getAvailableSlots, isWithinBookingWindow, timeToMinutes } = require('./availability');
const mailer = require('./mailer');
const googleCalendar = require('./googleCalendar');
const reminderScheduler = require('./reminderScheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 簡易 Admin Token 驗證（單一使用者後台，不需要完整帳號系統）
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiresAt

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 12); // 12 小時
  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expires = token && sessions.get(token);
  if (!token || !expires || expires < Date.now()) {
    return res.status(401).json({ error: '未登入或登入已過期' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  const s = getAllSettings();
  const questions = db.prepare('SELECT * FROM questions ORDER BY sort_order ASC').all();
  res.json({
    businessName: s.business_name,
    slotDurationMin: parseInt(s.slot_duration_min, 10),
    bookingWindowDays: parseInt(s.booking_window_days, 10),
    timezone: s.timezone,
    questions: questions.map((q) => ({ id: q.id, label: q.label, required: !!q.required })),
    googleMeetEnabled: googleCalendar.isConfigured(),
  });
});

app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date || !dayjs(date, 'YYYY-MM-DD', true).isValid()) {
    return res.status(400).json({ error: '日期格式錯誤' });
  }
  if (!isWithinBookingWindow(date)) {
    return res.json({ slots: [] });
  }
  const slots = getAvailableSlots(date);
  res.json({ slots });
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { date, start_time, name, email, answers } = req.body || {};

    if (!date || !start_time || !name || !email) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email 格式錯誤' });
    }
    if (!isWithinBookingWindow(date)) {
      return res.status(400).json({ error: '此日期不開放預約' });
    }

    // 檢查此時段是否仍然可預約（避免併發搶單）
    const available = getAvailableSlots(date);
    if (!available.includes(start_time)) {
      return res.status(409).json({ error: '此時段已被預約或不可預約，請重新選擇' });
    }

    const duration = parseInt(getSetting('slot_duration_min') || '30', 10);
    const endTime = dayjs(`${date} ${start_time}`, 'YYYY-MM-DD HH:mm')
      .add(duration, 'minute')
      .format('HH:mm');

    // 檢查必填自訂問題
    const questions = db.prepare('SELECT * FROM questions ORDER BY sort_order ASC').all();
    const answerMap = new Map((answers || []).map((a) => [a.id, a.answer]));
    for (const q of questions) {
      if (q.required && !String(answerMap.get(q.id) || '').trim()) {
        return res.status(400).json({ error: `請填寫：${q.label}` });
      }
    }
    const answersOut = questions.map((q) => ({
      label: q.label,
      answer: answerMap.get(q.id) || '',
    }));

    const timezone = getSetting('timezone') || 'Asia/Taipei';
    const businessName = getSetting('business_name') || '預約';

    // 嘗試建立 Google Meet 會議（若未設定 Google 授權則跳過，不影響預約流程）
    let meetLink = null;
    let calendarEventId = null;
    try {
      const startDateTime = dayjs(`${date} ${start_time}`, 'YYYY-MM-DD HH:mm').toISOString();
      const endDateTime = dayjs(`${date} ${endTime}`, 'YYYY-MM-DD HH:mm').toISOString();
      const result = await googleCalendar.createMeetEvent({
        summary: `${businessName} - ${name}`,
        description: '透過線上預約系統建立',
        startDateTime,
        endDateTime,
        timezone,
        attendeeEmail: email,
        organizerEmail: process.env.ADMIN_NOTIFY_EMAIL,
      });
      meetLink = result.meetLink;
      calendarEventId = result.eventId;
    } catch (err) {
      console.error('建立 Google Meet 會議失敗（預約仍會照常成立）:', err.message);
    }

    const info = db
      .prepare(
        `INSERT INTO bookings (date, start_time, end_time, name, email, answers, meet_link, calendar_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        date,
        start_time,
        endTime,
        name.trim(),
        email.trim(),
        JSON.stringify(answersOut),
        meetLink,
        calendarEventId
      );

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
    booking.answers = answersOut;

    mailer.sendBookingConfirmation(booking).catch((err) => {
      console.error('寄送確認信失敗:', err.message);
    });

    res.json({
      ok: true,
      booking: {
        id: booking.id,
        date: booking.date,
        start_time: booking.start_time,
        end_time: booking.end_time,
        meet_link: booking.meet_link,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const adminPassword = getSetting('admin_password') || 'changeme';
  if (password !== adminPassword) {
    return res.status(401).json({ error: '密碼錯誤' });
  }
  res.json({ token: issueToken() });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY date DESC, start_time DESC').all();
  const bookings = rows.map((b) => ({ ...b, answers: b.answers ? JSON.parse(b.answers) : [] }));
  res.json({ bookings });
});

app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: '找不到此預約' });

  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);

  if (booking.calendar_event_id) {
    googleCalendar.deleteEvent(booking.calendar_event_id).catch(() => {});
  }
  const parsedAnswers = booking.answers ? JSON.parse(booking.answers) : [];
  mailer.sendCancellation({ ...booking, answers: parsedAnswers }).catch(() => {});

  res.json({ ok: true });
});

app.get('/api/admin/rules', requireAdmin, (req, res) => {
  const rules = db.prepare('SELECT * FROM availability_rules ORDER BY weekday ASC, start_time ASC').all();
  res.json({ rules });
});

app.post('/api/admin/rules', requireAdmin, (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: '格式錯誤' });

  const tx = db.transaction((rulesList) => {
    db.prepare('DELETE FROM availability_rules').run();
    const insert = db.prepare(
      'INSERT INTO availability_rules (weekday, start_time, end_time) VALUES (?, ?, ?)'
    );
    for (const r of rulesList) {
      if (
        typeof r.weekday !== 'number' ||
        r.weekday < 0 ||
        r.weekday > 6 ||
        !r.start_time ||
        !r.end_time ||
        timeToMinutes(r.start_time) >= timeToMinutes(r.end_time)
      ) {
        throw new Error('時段規則格式錯誤');
      }
      insert.run(r.weekday, r.start_time, r.end_time);
    }
  });

  try {
    tx(rules);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/blocked-dates', requireAdmin, (req, res) => {
  const dates = db.prepare('SELECT * FROM blocked_dates ORDER BY date ASC').all();
  res.json({ dates });
});

app.post('/api/admin/blocked-dates', requireAdmin, (req, res) => {
  const { date } = req.body || {};
  if (!date || !dayjs(date, 'YYYY-MM-DD', true).isValid()) {
    return res.status(400).json({ error: '日期格式錯誤' });
  }
  db.prepare('INSERT INTO blocked_dates (date) VALUES (?)').run(date);
  res.json({ ok: true });
});

app.delete('/api/admin/blocked-dates/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blocked_dates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  const questions = db.prepare('SELECT * FROM questions ORDER BY sort_order ASC').all();
  res.json({ questions });
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { questions } = req.body || {};
  if (!Array.isArray(questions)) return res.status(400).json({ error: '格式錯誤' });

  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM questions').run();
    const insert = db.prepare(
      'INSERT INTO questions (label, required, sort_order) VALUES (?, ?, ?)'
    );
    list.forEach((q, i) => {
      if (!q.label || !q.label.trim()) throw new Error('問題內容不可為空');
      insert.run(q.label.trim(), q.required ? 1 : 0, i);
    });
  });

  try {
    tx(questions);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const s = getAllSettings();
  delete s.admin_password;
  res.json({ settings: s });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = [
    'business_name',
    'slot_duration_min',
    'buffer_min',
    'timezone',
    'booking_window_days',
  ];
  const body = req.body || {};
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== '') {
      setSetting(key, body[key]);
    }
  }
  res.json({ ok: true });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密碼至少需要 4 個字元' });
  }
  setSetting('admin_password', newPassword);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`預約系統已啟動： http://localhost:${PORT}`);
  console.log(`管理後台： http://localhost:${PORT}/admin`);
  if (!mailer.isConfigured()) {
    console.log('[提醒] 尚未設定 SMTP，確認信/提醒信將不會實際寄出（見 .env）');
  }
  if (!googleCalendar.isConfigured()) {
    console.log('[提醒] 尚未設定 Google 授權，將不會產生 Google Meet 連結（見 README）');
  }
  reminderScheduler.start();
});
