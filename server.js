require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const { client, ready } = require('./db');
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

function mapQuestionRow(q) {
  return {
    id: q.id,
    label: q.label,
    type: q.type === 'choice' ? 'choice' : 'text',
    options: q.options ? JSON.parse(q.options) : [],
    required: !!q.required,
  };
}

async function getQuestions() {
  const res = await client.execute('SELECT * FROM questions ORDER BY sort_order ASC');
  return res.rows.map(mapQuestionRow);
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

app.get('/api/config', async (req, res) => {
  try {
    const s = await getAllSettings();
    const questions = await getQuestions();
    res.json({
      businessName: s.business_name,
      slotDurationMin: parseInt(s.slot_duration_min, 10),
      bookingWindowDays: parseInt(s.booking_window_days, 10),
      timezone: s.timezone,
      questions,
      googleMeetEnabled: googleCalendar.isConfigured(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.get('/api/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !dayjs(date, 'YYYY-MM-DD', true).isValid()) {
      return res.status(400).json({ error: '日期格式錯誤' });
    }
    if (!(await isWithinBookingWindow(date))) {
      return res.json({ slots: [] });
    }
    const slots = await getAvailableSlots(date);
    res.json({ slots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

// 一次回傳整個月「每一天是否還有可預約時段」，讓前台日曆能把沒有開放的日期
// （例如沒有設定營業時段的星期幾、已被完全約滿的日子、超出預約視窗的日子）
// 直接顯示為不可點選，避免使用者點進去才發現是空的、造成誤會。
app.get('/api/availability/month', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: '年份或月份格式錯誤' });
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    const days = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!(await isWithinBookingWindow(dateStr))) {
        days[dateStr] = false;
        continue;
      }
      const slots = await getAvailableSlots(dateStr);
      days[dateStr] = slots.length > 0;
    }
    res.json({ days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
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
    if (!(await isWithinBookingWindow(date))) {
      return res.status(400).json({ error: '此日期不開放預約' });
    }

    // 檢查此時段是否仍然可預約（避免併發搶單）
    const available = await getAvailableSlots(date);
    if (!available.includes(start_time)) {
      return res.status(409).json({ error: '此時段已被預約或不可預約，請重新選擇' });
    }

    const duration = parseInt((await getSetting('slot_duration_min')) || '30', 10);
    const endTime = dayjs(`${date} ${start_time}`, 'YYYY-MM-DD HH:mm')
      .add(duration, 'minute')
      .format('HH:mm');

    // 檢查必填自訂問題（選擇題答案須為選項之一）
    const questions = await getQuestions();
    const answerMap = new Map((answers || []).map((a) => [a.id, a.answer]));
    for (const q of questions) {
      const ans = String(answerMap.get(q.id) || '').trim();
      if (q.required && !ans) {
        return res.status(400).json({ error: `請填寫：${q.label}` });
      }
      if (q.type === 'choice' && ans && !q.options.includes(ans)) {
        return res.status(400).json({ error: `「${q.label}」的回答不是有效選項` });
      }
    }
    const answersOut = questions.map((q) => ({
      label: q.label,
      answer: answerMap.get(q.id) || '',
    }));

    const timezone = (await getSetting('timezone')) || 'Asia/Taipei';
    const businessName = (await getSetting('business_name')) || '預約';

    // 嘗試建立 Google Meet 會議（若未設定 Google 授權則跳過，不影響預約流程）
    let meetLink = null;
    let calendarEventId = null;
    try {
      // 注意：不能用 .toISOString()，那會把「台北時間的數字」誤標成 UTC，
      // 導致 Google 日曆上的時間整整差 8 小時（甚至跨到隔天）。
      // 這裡改成不帶時區的純本地時間字串，交給下面的 timeZone 欄位正確轉換。
      const startDateTime = dayjs(`${date} ${start_time}`, 'YYYY-MM-DD HH:mm').format('YYYY-MM-DDTHH:mm:ss');
      const endDateTime = dayjs(`${date} ${endTime}`, 'YYYY-MM-DD HH:mm').format('YYYY-MM-DDTHH:mm:ss');
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

    const insertRes = await client.execute({
      sql: `INSERT INTO bookings (date, start_time, end_time, name, email, answers, meet_link, calendar_event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        date,
        start_time,
        endTime,
        name.trim(),
        email.trim(),
        JSON.stringify(answersOut),
        meetLink,
        calendarEventId,
      ],
    });

    const bookingId = Number(insertRes.lastInsertRowid);
    const bookingRes = await client.execute({
      sql: 'SELECT * FROM bookings WHERE id = ?',
      args: [bookingId],
    });
    const booking = bookingRes.rows[0];
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

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const adminPassword = (await getSetting('admin_password')) || 'changeme';
    if (password !== adminPassword) {
      return res.status(401).json({ error: '密碼錯誤' });
    }
    res.json({ token: issueToken() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const result = await client.execute('SELECT * FROM bookings ORDER BY date DESC, start_time DESC');
    const bookings = result.rows.map((b) => ({ ...b, answers: b.answers ? JSON.parse(b.answers) : [] }));
    res.json({ bookings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const bookingRes = await client.execute({
      sql: 'SELECT * FROM bookings WHERE id = ?',
      args: [req.params.id],
    });
    const booking = bookingRes.rows[0];
    if (!booking) return res.status(404).json({ error: '找不到此預約' });

    await client.execute({
      sql: "UPDATE bookings SET status = 'cancelled' WHERE id = ?",
      args: [booking.id],
    });

    if (booking.calendar_event_id) {
      googleCalendar.deleteEvent(booking.calendar_event_id).catch(() => {});
    }
    const parsedAnswers = booking.answers ? JSON.parse(booking.answers) : [];
    mailer.sendCancellation({ ...booking, answers: parsedAnswers }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.get('/api/admin/rules', requireAdmin, async (req, res) => {
  try {
    const result = await client.execute('SELECT * FROM availability_rules ORDER BY weekday ASC, start_time ASC');
    res.json({ rules: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/rules', requireAdmin, async (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: '格式錯誤' });

  for (const r of rules) {
    if (
      typeof r.weekday !== 'number' ||
      r.weekday < 0 ||
      r.weekday > 6 ||
      !r.start_time ||
      !r.end_time ||
      timeToMinutes(r.start_time) >= timeToMinutes(r.end_time)
    ) {
      return res.status(400).json({ error: '時段規則格式錯誤' });
    }
  }

  try {
    const stmts = [{ sql: 'DELETE FROM availability_rules', args: [] }];
    for (const r of rules) {
      stmts.push({
        sql: 'INSERT INTO availability_rules (weekday, start_time, end_time) VALUES (?, ?, ?)',
        args: [r.weekday, r.start_time, r.end_time],
      });
    }
    await client.batch(stmts, 'write');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  try {
    const result = await client.execute('SELECT * FROM blocked_dates ORDER BY date ASC');
    res.json({ dates: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  try {
    const { date } = req.body || {};
    if (!date || !dayjs(date, 'YYYY-MM-DD', true).isValid()) {
      return res.status(400).json({ error: '日期格式錯誤' });
    }
    await client.execute({ sql: 'INSERT INTO blocked_dates (date) VALUES (?)', args: [date] });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.delete('/api/admin/blocked-dates/:id', requireAdmin, async (req, res) => {
  try {
    await client.execute({ sql: 'DELETE FROM blocked_dates WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const questions = await getQuestions();
    res.json({ questions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  const { questions } = req.body || {};
  if (!Array.isArray(questions)) return res.status(400).json({ error: '格式錯誤' });

  const normalized = [];
  for (const q of questions) {
    if (!q.label || !q.label.trim()) return res.status(400).json({ error: '問題內容不可為空' });
    const type = q.type === 'choice' ? 'choice' : 'text';
    let options = [];
    if (type === 'choice') {
      options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
      if (options.length < 2) {
        return res.status(400).json({ error: `「${q.label}」選擇題至少需要 2 個選項` });
      }
    }
    normalized.push({ label: q.label.trim(), type, options, required: !!q.required });
  }

  try {
    const stmts = [{ sql: 'DELETE FROM questions', args: [] }];
    normalized.forEach((q, i) => {
      stmts.push({
        sql: 'INSERT INTO questions (label, type, options, required, sort_order) VALUES (?, ?, ?, ?, ?)',
        args: [q.label, q.type, q.type === 'choice' ? JSON.stringify(q.options) : null, q.required ? 1 : 0, i],
      });
    });
    await client.batch(stmts, 'write');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const s = await getAllSettings();
    delete s.admin_password;
    res.json({ settings: s });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
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
        await setSetting(key, body[key]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: '新密碼至少需要 4 個字元' });
    }
    await setSetting('admin_password', newPassword);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;

ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`預約系統已啟動： http://localhost:${PORT}`);
      console.log(`管理後台： http://localhost:${PORT}/admin`);
      console.log(
        process.env.TURSO_DATABASE_URL
          ? '[資料庫] 使用 Turso 雲端資料庫（資料永久保存）'
          : '[資料庫] 使用本機檔案資料庫（僅供本地開發測試，正式環境請設定 TURSO_DATABASE_URL）'
      );
      if (!mailer.isConfigured()) {
        console.log('[提醒] 尚未設定 SMTP，確認信/提醒信將不會實際寄出（見 .env）');
      }
      if (!googleCalendar.isConfigured()) {
        console.log('[提醒] 尚未設定 Google 授權，將不會產生 Google Meet 連結（見 README）');
      }
      reminderScheduler.start();
    });
  })
  .catch((err) => {
    console.error('資料庫初始化失敗，伺服器無法啟動:', err);
    process.exit(1);
  });
