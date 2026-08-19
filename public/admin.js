(function () {
  const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const app = document.getElementById('app');

  let token = localStorage.getItem('admin_token') || null;
  let activeTab = 'bookings';

  function authHeaders() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), ...authHeaders() },
    });
    if (res.status === 401) {
      token = null;
      localStorage.removeItem('admin_token');
      renderLogin();
      throw new Error('登入已過期');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '發生錯誤');
    return data;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Login -----------------------------------------------------------------

  function renderLogin() {
    app.innerHTML = `
      <div class="login-wrap card">
        <h2 style="margin-top:0;">管理後台登入</h2>
        <div id="login-error"></div>
        <div class="form-group">
          <label>密碼</label>
          <input type="password" id="login-password" />
        </div>
        <button class="btn" id="login-btn" style="width:100%;">登入</button>
      </div>
    `;
    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
  }

  async function doLogin() {
    const password = document.getElementById('login-password').value;
    const errorBox = document.getElementById('login-error');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorBox.innerHTML = `<div class="error-box">${escapeHtml(data.error)}</div>`;
        return;
      }
      token = data.token;
      localStorage.setItem('admin_token', token);
      renderApp();
    } catch (err) {
      errorBox.innerHTML = `<div class="error-box">網路錯誤</div>`;
    }
  }

  function logout() {
    token = null;
    localStorage.removeItem('admin_token');
    renderLogin();
  }

  // --- App shell ---------------------------------------------------------------

  function renderApp() {
    app.innerHTML = `
      <div class="admin-header">
        <h1 style="margin:0;font-size:20px;">管理後台</h1>
        <button class="btn secondary" id="logout-btn">登出</button>
      </div>
      <div class="tabs">
        <button class="tab-btn" data-tab="bookings">預約清單</button>
        <button class="tab-btn" data-tab="rules">可預約時段</button>
        <button class="tab-btn" data-tab="blocked">封鎖日期</button>
        <button class="tab-btn" data-tab="questions">預約問題</button>
        <button class="tab-btn" data-tab="settings">基本設定</button>
      </div>
      <div class="card" id="tab-content"></div>
    `;
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        renderTabContent();
      });
    });
    renderTabs();
    renderTabContent();
  }

  function renderTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
  }

  function renderTabContent() {
    const map = {
      bookings: renderBookingsTab,
      rules: renderRulesTab,
      blocked: renderBlockedTab,
      questions: renderQuestionsTab,
      settings: renderSettingsTab,
    };
    map[activeTab]();
  }

  // --- Bookings tab --------------------------------------------------------------

  async function renderBookingsTab() {
    const content = document.getElementById('tab-content');
    content.innerHTML = '載入中…';
    try {
      const { bookings } = await api('/api/admin/bookings');
      if (bookings.length === 0) {
        content.innerHTML = `<p class="empty-hint">目前沒有任何預約。</p>`;
        return;
      }
      content.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>日期</th><th>時間</th><th>姓名</th><th>Email</th><th>回覆內容</th><th>狀態</th><th>會議連結</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${bookings
              .map(
                (b) => `
              <tr>
                <td>${b.date}</td>
                <td>${b.start_time}-${b.end_time}</td>
                <td>${escapeHtml(b.name)}</td>
                <td>${escapeHtml(b.email)}</td>
                <td>${(b.answers || [])
                  .map((a) => `<div><strong>${escapeHtml(a.label)}：</strong>${escapeHtml(a.answer)}</div>`)
                  .join('')}</td>
                <td><span class="badge ${b.status}">${b.status === 'confirmed' ? '已確認' : '已取消'}</span></td>
                <td>${b.meet_link ? `<a href="${b.meet_link}" target="_blank">連結</a>` : '-'}</td>
                <td>${
                  b.status === 'confirmed'
                    ? `<button class="btn danger" data-cancel="${b.id}" style="padding:6px 10px;font-size:12px;">取消預約</button>`
                    : ''
                }</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `;
      content.querySelectorAll('[data-cancel]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('確定要取消這筆預約嗎？將會寄送取消通知信給客戶。')) return;
          await api(`/api/admin/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST' });
          renderBookingsTab();
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // --- Rules tab -------------------------------------------------------------------

  async function renderRulesTab() {
    const content = document.getElementById('tab-content');
    content.innerHTML = '載入中…';
    try {
      const { rules } = await api('/api/admin/rules');
      renderRulesForm(rules);
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderRulesForm(rules) {
    const content = document.getElementById('tab-content');
    const rows = rules.length
      ? rules
      : [];

    content.innerHTML = `
      <p class="hint">設定每週固定可預約的時間範圍，例如「週一 09:00-12:00」。同一天可新增多個時段範圍。</p>
      <div id="rules-list"></div>
      <button class="btn secondary" id="add-rule" style="margin-top:8px;">+ 新增時段</button>
      <div style="margin-top:20px;">
        <button class="btn" id="save-rules">儲存設定</button>
        <span id="rules-msg" style="margin-left:10px;font-size:13px;"></span>
      </div>
    `;

    const list = document.getElementById('rules-list');

    function addRow(rule) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      const weekdayOptions = WEEKDAYS.map(
        (w, i) => `<option value="${i}" ${rule && rule.weekday === i ? 'selected' : ''}>${w}</option>`
      ).join('');
      row.innerHTML = `
        <select class="r-weekday">${weekdayOptions}</select>
        <input type="time" class="r-start" value="${rule ? rule.start_time : '09:00'}" />
        <span>至</span>
        <input type="time" class="r-end" value="${rule ? rule.end_time : '18:00'}" />
        <button class="icon-btn" title="刪除">✕</button>
      `;
      row.querySelector('.icon-btn').addEventListener('click', () => row.remove());
      list.appendChild(row);
    }

    if (rows.length === 0) {
      addRow(null);
    } else {
      rows.forEach(addRow);
    }

    document.getElementById('add-rule').addEventListener('click', () => addRow(null));

    document.getElementById('save-rules').addEventListener('click', async () => {
      const newRules = Array.from(list.querySelectorAll('.rule-row')).map((row) => ({
        weekday: parseInt(row.querySelector('.r-weekday').value, 10),
        start_time: row.querySelector('.r-start').value,
        end_time: row.querySelector('.r-end').value,
      }));
      const msg = document.getElementById('rules-msg');
      try {
        await api('/api/admin/rules', { method: 'POST', body: JSON.stringify({ rules: newRules }) });
        msg.textContent = '已儲存';
        msg.style.color = '#16a34a';
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = '#dc2626';
      }
    });
  }

  // --- Blocked dates tab -------------------------------------------------------------

  async function renderBlockedTab() {
    const content = document.getElementById('tab-content');
    content.innerHTML = '載入中…';
    try {
      const { dates } = await api('/api/admin/blocked-dates');
      content.innerHTML = `
        <p class="hint">封鎖特定日期（例如休假），該天將不開放預約。</p>
        <div style="display:flex; gap:8px; margin-bottom:16px;">
          <input type="date" id="block-date-input" />
          <button class="btn" id="add-block">封鎖此日期</button>
        </div>
        <div id="blocked-list"></div>
      `;
      const list = document.getElementById('blocked-list');
      if (dates.length === 0) {
        list.innerHTML = `<p class="empty-hint">目前沒有封鎖任何日期。</p>`;
      } else {
        list.innerHTML = dates
          .map(
            (d) => `<div class="rule-row"><span style="flex:1;">${d.date}</span><button class="icon-btn" data-del="${d.id}">✕</button></div>`
          )
          .join('');
        list.querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api(`/api/admin/blocked-dates/${btn.dataset.del}`, { method: 'DELETE' });
            renderBlockedTab();
          });
        });
      }
      document.getElementById('add-block').addEventListener('click', async () => {
        const date = document.getElementById('block-date-input').value;
        if (!date) return;
        await api('/api/admin/blocked-dates', { method: 'POST', body: JSON.stringify({ date }) });
        renderBlockedTab();
      });
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // --- Questions tab -------------------------------------------------------------------

  async function renderQuestionsTab() {
    const content = document.getElementById('tab-content');
    content.innerHTML = '載入中…';
    try {
      const { questions } = await api('/api/admin/questions');
      content.innerHTML = `
        <p class="hint">設定客戶預約時需要額外回答的問題。建議大部分問題設為「選擇題（單選）」方便客戶快速勾選、也方便您篩選客戶；只留「最關鍵」的一題設為「文字回答」讓客戶自行輸入。</p>
        <div id="questions-list"></div>
        <button class="btn secondary" id="add-question" style="margin-top:8px;">+ 新增問題</button>
        <div style="margin-top:20px;">
          <button class="btn" id="save-questions">儲存設定</button>
          <span id="questions-msg" style="margin-left:10px;font-size:13px;"></span>
        </div>
      `;
      const list = document.getElementById('questions-list');

      function addRow(q) {
        const row = document.createElement('div');
        row.className = 'question-row';
        row.style.cssText = 'display:flex; gap:8px; align-items:flex-start; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--border);';
        const type = q && q.type === 'text' ? 'text' : 'choice';
        const optionsStr = q && Array.isArray(q.options) ? q.options.join('\n') : '';
        row.innerHTML = `
          <div style="flex:1;">
            <input type="text" class="q-label" placeholder="問題內容" value="${escapeHtml(q ? q.label : '')}" style="width:100%;margin-bottom:6px;" />
            <textarea class="q-options" placeholder="每行一個選項，例如：\n每月10萬以下\n每月10-30萬\n每月30萬以上" rows="3" style="width:100%; ${type === 'choice' ? '' : 'display:none;'}">${escapeHtml(optionsStr)}</textarea>
          </div>
          <select class="q-type" style="min-width:130px;">
            <option value="choice" ${type === 'choice' ? 'selected' : ''}>選擇題（單選）</option>
            <option value="text" ${type === 'text' ? 'selected' : ''}>文字回答</option>
          </select>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap;padding-top:8px;"><input type="checkbox" class="q-required" ${!q || q.required ? 'checked' : ''}/> 必填</label>
          <button class="icon-btn">✕</button>
        `;
        row.querySelector('.icon-btn').addEventListener('click', () => row.remove());
        const typeSelect = row.querySelector('.q-type');
        const optionsBox = row.querySelector('.q-options');
        typeSelect.addEventListener('change', () => {
          optionsBox.style.display = typeSelect.value === 'choice' ? '' : 'none';
        });
        list.appendChild(row);
      }

      questions.forEach(addRow);
      document.getElementById('add-question').addEventListener('click', () => addRow(null));

      document.getElementById('save-questions').addEventListener('click', async () => {
        const newQuestions = Array.from(list.querySelectorAll('.question-row'))
          .map((row) => {
            const type = row.querySelector('.q-type').value === 'text' ? 'text' : 'choice';
            const options = row
              .querySelector('.q-options')
              .value.split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
            return {
              label: row.querySelector('.q-label').value.trim(),
              type,
              options,
              required: row.querySelector('.q-required').checked,
            };
          })
          .filter((q) => q.label);
        const msg = document.getElementById('questions-msg');
        const bad = newQuestions.find((q) => q.type === 'choice' && q.options.length < 2);
        if (bad) {
          msg.textContent = `「${bad.label}」選擇題至少需要 2 個選項（每行一個）`;
          msg.style.color = '#dc2626';
          return;
        }
        try {
          await api('/api/admin/questions', { method: 'POST', body: JSON.stringify({ questions: newQuestions }) });
          msg.textContent = '已儲存';
          msg.style.color = '#16a34a';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#dc2626';
        }
      });
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // --- Settings tab -------------------------------------------------------------------

  async function renderSettingsTab() {
    const content = document.getElementById('tab-content');
    content.innerHTML = '載入中…';
    try {
      const { settings } = await api('/api/admin/settings');
      content.innerHTML = `
        <div class="form-group">
          <label>頁面標題 / 業務名稱</label>
          <input type="text" id="s-business-name" value="${escapeHtml(settings.business_name)}" />
        </div>
        <div class="form-group">
          <label>每次預約時長（分鐘）</label>
          <input type="text" id="s-duration" value="${escapeHtml(settings.slot_duration_min)}" />
        </div>
        <div class="form-group">
          <label>每個時段間的緩衝時間（分鐘）</label>
          <input type="text" id="s-buffer" value="${escapeHtml(settings.buffer_min)}" />
        </div>
        <div class="form-group">
          <label>時區</label>
          <input type="text" id="s-timezone" value="${escapeHtml(settings.timezone)}" />
        </div>
        <div class="form-group">
          <label>開放預約天數（未來幾天內可預約）</label>
          <input type="text" id="s-window" value="${escapeHtml(settings.booking_window_days)}" />
        </div>
        <button class="btn" id="save-settings">儲存設定</button>
        <span id="settings-msg" style="margin-left:10px;font-size:13px;"></span>

        <hr style="margin:28px 0;border:none;border-top:1px solid var(--border);" />

        <h3>變更管理密碼</h3>
        <div class="form-group">
          <label>新密碼</label>
          <input type="password" id="new-password" />
        </div>
        <button class="btn secondary" id="change-password">變更密碼</button>
        <span id="password-msg" style="margin-left:10px;font-size:13px;"></span>
      `;

      document.getElementById('save-settings').addEventListener('click', async () => {
        const msg = document.getElementById('settings-msg');
        try {
          await api('/api/admin/settings', {
            method: 'POST',
            body: JSON.stringify({
              business_name: document.getElementById('s-business-name').value,
              slot_duration_min: document.getElementById('s-duration').value,
              buffer_min: document.getElementById('s-buffer').value,
              timezone: document.getElementById('s-timezone').value,
              booking_window_days: document.getElementById('s-window').value,
            }),
          });
          msg.textContent = '已儲存';
          msg.style.color = '#16a34a';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#dc2626';
        }
      });

      document.getElementById('change-password').addEventListener('click', async () => {
        const msg = document.getElementById('password-msg');
        const newPassword = document.getElementById('new-password').value;
        try {
          await api('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
          msg.textContent = '已變更';
          msg.style.color = '#16a34a';
          document.getElementById('new-password').value = '';
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = '#dc2626';
        }
      });
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // --- Boot -------------------------------------------------------------------

  if (token) {
    renderApp();
  } else {
    renderLogin();
  }
})();
