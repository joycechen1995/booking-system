// 一次性小工具：取得 Google Refresh Token，讓伺服器可以用你的 Google 帳號
// 建立行事曆活動並產生 Google Meet 連結。
//
// 使用方式：
//   1. 先在 .env 填好 GOOGLE_CLIENT_ID 與 GOOGLE_CLIENT_SECRET（見 README）
//   2. 執行：node authorize-google.js
//   3. 依畫面提示，用瀏覽器開啟出現的網址，用你要拿來寄送邀請的 Google 帳號登入並同意授權
//   4. 把網址列上 code= 後面那串貼回終端機
//   5. 程式會印出 GOOGLE_REFRESH_TOKEN=xxxx，複製貼到 .env 裡

require('dotenv').config();
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('請先在 .env 設定 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET');
    process.exit(1);
  }

  const oAuth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n請用瀏覽器開啟以下網址並登入你要用來建立會議的 Google 帳號：\n');
  console.log(authUrl);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('授權完成後，請貼上畫面顯示的驗證碼：', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      console.log('\n授權成功！請把下面這行加到 .env 檔案中：\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('');
    } catch (err) {
      console.error('取得 token 失敗：', err.message);
      process.exit(1);
    }
  });
}

main();
