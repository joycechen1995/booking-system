// 使用 Google Calendar API 建立行事曆活動並自動產生 Google Meet 連結。
// 需要在 .env 設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
// （執行 `node authorize-google.js` 依畫面指示取得）。
// 若未設定，系統仍可正常運作，只是不會產生 Google Meet 連結。

const { google } = require('googleapis');

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

/**
 * 建立一個附帶 Google Meet 的行事曆活動。
 * @returns {Promise<{meetLink: string|null, eventId: string|null}>}
 */
async function createMeetEvent({
  summary,
  description,
  startDateTime, // ISO string
  endDateTime, // ISO string
  timezone,
  attendeeEmail,
  organizerEmail,
}) {
  if (!isConfigured()) {
    return { meetLink: null, eventId: null };
  }

  const auth = getOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const requestId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const event = {
    summary,
    description,
    start: { dateTime: startDateTime, timeZone: timezone },
    end: { dateTime: endDateTime, timeZone: timezone },
    attendees: [
      { email: attendeeEmail },
      ...(organizerEmail ? [{ email: organizerEmail }] : []),
    ],
    conferenceData: {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: { useDefault: true },
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
  });

  const meetLink =
    res.data.hangoutLink ||
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
      ?.uri ||
    null;

  return { meetLink, eventId: res.data.id || null };
}

async function deleteEvent(eventId) {
  if (!isConfigured() || !eventId) return;
  const auth = getOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
    });
  } catch (err) {
    console.error('取消 Google 行事曆活動失敗:', err.message);
  }
}

module.exports = { isConfigured, createMeetEvent, deleteEvent };
