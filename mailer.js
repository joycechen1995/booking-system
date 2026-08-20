const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { getSetting } = require('./settings');

const LINE_OA_URL = 'https://lin.ee/tJhE64S';

// --- 寄信方式一：Gmail API（推薦，走 HTTPS，不受 Render 免費方案封鎖 SMTP 連接埠影響）---
// 需要 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN，且該 refresh token
// 的授權範圍必須包含 https://www.googleapis.com/auth/gmail.send（跟 Calendar 那組可以共用同一個
// OAuth 用戶端，但 refresh token 要重新產生一次，把兩個 scope 都選進去）。
function isGmailApiConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getGmailClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

function encodeSubject(subject) {
  // 中文主旨需要用 MIME encoded-word 格式，否則收件軟體可能顯示亂碼
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

function buildRawMessage({ from, to, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ];
  const message = messageParts.join('\r\n');
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendViaGmailApi({ to, subject, html }) {
  const gmail = getGmailClient();
  const from = process.env.SMTP_FROM || process.env.GOOGLE_SENDER_EMAIL || 'me';
  const raw = buildRawMessage({ from, to, subject, html });
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

// --- 寄信方式二：傳統 SMTP（僅在 Render 付費方案，或非 Render 環境下可用）---
function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isSmtpConfigured()) return null;
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

async function sendViaSmtp({ to, subject, html }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, html });
}

function isConfigured() {
  return isGmailApiConfigured() || isSmtpConfigured();
}

async function sendMail({ to, subject, html }) {
  if (!isConfigured()) {
    console.log(`[mailer] 尚未設定寄信方式，略過寄信給 ${to}：${subject}`);
    return;
  }
  try {
    if (isGmailApiConfigured()) {
      await sendViaGmailApi({ to, subject, html });
    } else {
      await sendViaSmtp({ to, subject, html });
    }
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
       <strong>時間：</strong> ${booking.start_time} - ${booking.end_time}（台北時間 Taipei Time, GMT+8）</p>
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
       <strong>時間：</strong> ${booking.start_time} - ${booking.end_time}（台北時間 Taipei Time, GMT+8）</p>
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
    <p>您在「${escapeHtml(businessName)}」於 ${booking.date} ${booking.start_time}（台北時間 GMT+8）的預約已被取消。</p>
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
