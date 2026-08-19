const nodemailer = require('nodemailer');
const { getSetting } = require('./settings');

const LINE_OA_URL = 'https://lin.ee/tJhE64S';

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendMail({ to, subject, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[mailer] 尚未設定 SMTP，略過寄信給 ${to}：${subject}`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({ from, to, subject, html });
    console.log(`[mailer] 已寄信給 ${to}：${subject}`);
  } catch (err) {
    console.error(`[mailer] 寄信失敗（${to}）:`, err.message);
  }
}

function formatAnswers(answers) {
  if (!answers || answers.length === 0) return '';
  return (
    '<p><strong>預約資訊：</strong></p><ul>' +
    answers.map((a) => `<li>${a.label}：${escapeHtml(a.answer || '(未填)')}</li>`).join('') +
    '</ul>'
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendBookingConfirmation(booking) {
  const businessName = getSetting('business_name') || '預約系統';
  const meetHtml = booking.meet_link
    ? `<p><strong>視訊會議連結：</strong> <a href="${booking.meet_link}">${booking.meet_link}</a></p>`
    : '';

  const clientHtml = `
    <p>您好 ${escapeHtml(booking.name)}，</p>
    <p>您已成功預約「${escapeHtml(businessName)}」，詳細資訊如下：</p>
    <p><strong>日期：</strong> ${booking.date}<br/>
       <strong>時間：</strong> ${booking.start_time} - ${booking.end_time}</p>
    ${meetHtml}
    ${formatAnswers(booking.answers)}
    <p>若需取消或更改時間，請直接回覆此信與我們聯繫。</p>
    <p><a href="${LINE_OA_URL}">👉 點我加入官方 LINE 好友</a>，隨時掌握最新消息與提醒。</p>
    <p>期待與您見面！</p>
  `;
  await sendMail({
    to: booking.email,
    subject: `預約確認：${booking.date} ${booking.start_time}`,
    html: clientHtml,
  });

  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (adminEmail) {
    const adminHtml = `
      <p>有一筆新預約：</p>
      <p><strong>姓名：</strong> ${escapeHtml(booking.name)}<br/>
         <strong>Email：</strong> ${escapeHtml(booking.email)}<br/>
         <strong>日期：</strong> ${booking.date}<br/>
         <strong>時間：</strong> ${booking.start_time} - ${booking.end_time}</p>
      ${meetHtml}
      ${formatAnswers(booking.answers)}
    `;
    await sendMail({
      to: adminEmail,
      subject: `[新預約] ${booking.date} ${booking.start_time} - ${booking.name}`,
      html: adminHtml,
    });
  }
}

async function sendReminder(booking) {
  const businessName = getSetting('business_name') || '預約系統';
  const meetHtml = booking.meet_link
    ? `<p><strong>視訊會議連結：</strong> <a href="${booking.meet_link}">${booking.meet_link}</a></p>`
    : '';
  const html = `
    <p>您好 ${escapeHtml(booking.name)}，</p>
    <p>提醒您，「${escapeHtml(businessName)}」的預約將於 1 小時後開始：</p>
    <p><strong>日期：</strong> ${booking.date}<br/>
       <strong>時間：</strong> ${booking.start_time} - ${booking.end_time}</p>
    ${meetHtml}
    <p>期待與您見面！</p>
  `;
  await sendMail({
    to: booking.email,
    subject: `會議提醒：1 小時後 ${booking.start_time} 開始`,
    html,
  });
}

async function sendCancellation(booking) {
  const businessName = getSetting('business_name') || '預約系統';
  const html = `
    <p>您好 ${escapeHtml(booking.name)}，</p>
    <p>您在「${escapeHtml(businessName)}」於 ${booking.date} ${booking.start_time} 的預約已被取消。</p>
    <p>若有任何疑問，請直接回覆此信。</p>
  `;
  await sendMail({
    to: booking.email,
    subject: `預約已取消：${booking.date} ${booking.start_time}`,
    html,
  });
}

module.exports = {
  isConfigured,
  sendMail,
  sendBookingConfirmation,
  sendReminder,
  sendCancellation,
};
