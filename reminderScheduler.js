const cron = require('node-cron');
const dayjs = require('dayjs');
const { client } = require('./db');
const { sendReminder } = require('./mailer');

// 每分鐘檢查一次，找出「即將在 55~65 分鐘後開始」且尚未寄送提醒的預約。
// 用一個區間而不是精準 60 分鐘，是為了避免因排程誤差而漏寄。
async function checkAndSendReminders() {
  const now = dayjs();
  const res = await client.execute(
    "SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent = 0"
  );
  const bookings = res.rows;

  for (const booking of bookings) {
    const start = dayjs(`${booking.date} ${booking.start_time}`, 'YYYY-MM-DD HH:mm');
    const diffMin = start.diff(now, 'minute');
    if (diffMin <= 60 && diffMin >= 50) {
      const parsedAnswers = booking.answers ? JSON.parse(booking.answers) : [];
      sendReminder({ ...booking, answers: parsedAnswers })
        .then(async () => {
          await client.execute({
            sql: 'UPDATE bookings SET reminder_sent = 1 WHERE id = ?',
            args: [booking.id],
          });
        })
        .catch((err) => {
          console.error(`[reminder] 寄送失敗 booking#${booking.id}:`, err.message);
        });
    }
  }
}

function start() {
  // 每分鐘執行一次
  cron.schedule('* * * * *', () => {
    checkAndSendReminders().catch((err) => {
      console.error('[reminder] 檢查提醒時發生錯誤:', err.message);
    });
  });
  console.log('[reminder] 提醒排程已啟動（每分鐘檢查一次）');
}

module.exports = { start, checkAndSendReminders };
