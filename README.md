# 線上預約系統

一個類似 Calendly 的個人接案／諮詢預約系統。功能包含：

- 客戶自助選日期、選時段預約
- 你在後台設定每週可預約時段、封鎖日期
- 預約時可自訂要詢問客戶的問題（例如「諮詢主題」「電話」）
- 預約成立後自動用 Google Calendar 建立活動、產生 **Google Meet** 連結
- 自動寄送確認信（含會議連結）給客戶與你自己
- **會議開始前 1 小時自動寄送提醒信**
- 後台可查看所有預約、取消預約

技術：Node.js + Express + SQLite（資料存在本機檔案，不需要額外資料庫服務）。

---

## 1. 本機安裝與啟動

```bash
npm install
cp .env.example .env
```

打開 `.env`，先填好下方「2. 設定寄信」的內容，Google Meet 的部分可以先跳過（不影響其他功能）。

```bash
npm start
```

啟動後：

- 客戶預約頁面： http://localhost:3000
- 管理後台： http://localhost:3000/admin （**預設密碼是 `changeme`，登入後請務必到「基本設定」分頁更改密碼**）

---

## 2. 設定寄信（Email 確認信 / 提醒信）

系統用 SMTP 寄信，最簡單是直接用你的 Gmail：

1. 到 Google 帳號 → 安全性 → 開啟「兩步驟驗證」
2. 安全性 → 「應用程式密碼」，建立一組給這個系統用的密碼（16 碼英數字）
3. 在 `.env` 填入：

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=你的Gmail帳號@gmail.com
SMTP_PASS=剛剛產生的16碼應用程式密碼
SMTP_FROM=你的Gmail帳號@gmail.com
ADMIN_NOTIFY_EMAIL=你的Gmail帳號@gmail.com
```

如果你的信箱不是 Gmail（例如公司信箱），把 `SMTP_HOST` / `SMTP_PORT` 換成你信箱服務商提供的 SMTP 設定即可。

若這段沒設定，系統仍可正常運作，只是不會真的寄出信件（後台仍看得到預約紀錄）。

---

## 3. 設定 Google Meet 自動產生會議連結（選填但建議設定）

這一步會讓「客戶預約成功」自動建立一個 Google 日曆活動並附上 Google Meet 連結，寫進確認信裡。

### 3.1 建立 Google Cloud 專案與憑證

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)，建立一個新專案（或使用現有的）
2. 左側選單「API 和服務」→「已啟用的 API 和服務」→「啟用 API 和服務」，搜尋並啟用 **Google Calendar API**
3. 「API 和服務」→「OAuth 同意畫面」：
   - 使用者類型選「外部」，填基本資訊即可（測試模式不需要送審）
   - 在「測試使用者」加入你自己的 Google 帳號 email
4. 「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」：
   - 應用程式類型選「電腦版應用程式」（Desktop app）
   - 建立後會拿到一組 **用戶端 ID（Client ID）** 和 **用戶端密鑰（Client Secret）**

### 3.2 把憑證填入 `.env`

```
GOOGLE_CLIENT_ID=剛剛拿到的 Client ID
GOOGLE_CLIENT_SECRET=剛剛拿到的 Client Secret
```

### 3.3 執行授權小工具，取得 Refresh Token

```bash
node authorize-google.js
```

依畫面指示，用瀏覽器打開出現的網址，用「你要拿來寄邀請、建立會議的那個 Google 帳號」登入並同意授權，把畫面上顯示的驗證碼貼回終端機。程式會印出一行：

```
GOOGLE_REFRESH_TOKEN=xxxxxxxxxx
```

把這行加進 `.env`，然後重新啟動伺服器（`npm start`）。之後每筆新預約都會自動產生 Google Meet 連結。

> 這個步驟只需要做一次。Refresh Token 長期有效，除非你自己到 Google 帳號的「第三方應用程式存取權」中撤銷。

---

## 4. 後台設定教學

登入 http://localhost:3000/admin 後：

- **可預約時段**：設定每週固定開放的時間（例如週一到週五 09:00-18:00）
- **封鎖日期**：臨時休假或滿檔的日子，設定後那天不開放預約
- **預約問題**：新增/刪除客戶預約時要填的問題，可設為必填
- **基本設定**：頁面標題、每次預約時長（分鐘）、時區、開放預約的天數（例如只開放未來 30 天內）
- **變更密碼**：務必把預設密碼 `changeme` 改掉

---

## 5. 部署到正式網址（讓客戶真的能上網預約）

本機測試沒問題後，需要把它部署到一個有公開網址、且能長時間運作的主機上（因為要跑「每分鐘檢查提醒信」的排程，不適合用純靜態網站託管）。推薦：

### 選項 A：Render（最簡單，有免費額度）

1. 把這個資料夾上傳到一個 GitHub repo
2. 到 [render.com](https://render.com) → New → Web Service → 連接你的 repo
3. Build Command：`npm install`；Start Command：`npm start`
4. 在 Render 的 Environment 頁籤，把 `.env` 裡的變數一個個加進去
5. **重要**：Render 的免費方案容器重啟後檔案會消失，SQLite 資料庫會不見。到 Settings → Disks，掛載一個 Persistent Disk（例如掛在 `/opt/render/project/src/data`），資料才會保留

### 選項 B：Railway / Fly.io

作法類似 Render：連接 repo、設定環境變數、記得掛載一個持久化磁碟（volume）給 `data/` 資料夾，否則重新部署會遺失預約紀錄。

### 部署後

- 把 `.env` 裡不用的話可以留空，例如尚未申請 Google Meet 就先不填
- 記得把公開網址分享給客戶（例如 `https://your-app.onrender.com`），管理後台則是 `https://your-app.onrender.com/admin`
- 建議申請一個自訂網域，並在部署平台設定 HTTPS（大部分平台如 Render/Railway 會自動處理）

---

## 6. 常見問題

**Q: 客戶取消預約後，時段有釋出嗎？**
目前取消功能只在管理後台（你幫客戶取消時會寄送取消通知信、釋出時段）。若要開放客戶自行取消，可以之後再擴充一個「用預約 ID 查詢/取消」的頁面。

**Q: 可以串接 Outlook / iCloud 行事曆嗎？**
目前只做了 Google Calendar／Meet。如需要 Outlook 版本（Microsoft Graph API + Teams 會議連結），架構類似，可以再另外開發 `microsoftCalendar.js` 取代 `googleCalendar.js`。

**Q: 資料存在哪裡？**
存在 `data/booking.db`（SQLite 檔案）。部署到雲端主機時務必確認這個資料夾有掛載持久化儲存空間，否則重啟會遺失資料。

**Q: 忘記管理密碼怎麼辦？**
直接修改 `data/booking.db` 裡 `settings` 表的 `admin_password` 欄位，或刪除該筆設定讓系統下次啟動還原成預設值 `changeme`（需要重新啟動伺服器並清空該資料庫的 settings 表對應列）。
