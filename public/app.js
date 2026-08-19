(function () {
  const state = {
    config: null,
    viewMonth: dayjsLite(new Date()).startOf('month'),
    selectedDate: null,
    selectedSlot: null,
  };

  // --- 極簡日期工具（避免額外引入 dayjs CDN 相依）---------------------------
  function dayjsLite(d) {
    const date = new Date(d);
    return {
      raw: date,
      year: () => date.getFullYear(),
      month: () => date.getMonth(),
      date: () => date.getDate(),
      day: () => date.getDay(),
      startOf: function (unit) {
        if (unit === 'month') return dayjsLite(new Date(date.getFullYear(), date.getMonth(), 1));
        if (unit === 'day') return dayjsLite(new Date(date.getFullYear(), date.getMonth(), date.getDate()));
        return dayjsLite(date);
      },
      add: function (n, unit) {
        const d2 = new Date(date);
        if (unit === 'month') d2.setMonth(d2.getMonth() + n);
        if (unit === 'day') d2.setDate(d2.getDate() + n);
        return dayjsLite(d2);
      },
      diffDays: function (other) {
        const ms = date.setHours(0, 0, 0, 0) - new Date(other.raw).setHours(0, 0, 0, 0);
        return Math.round(ms / 86400000);
      },
      format: function (fmt) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        if (fmt === 'YYYY-MM-DD') return `${y}-${m}-${d}`;
        if (fmt === 'YYYY年MM月') return `${y}年${m}月`;
        return `${y}-${m}-${d}`;
      },
    };
  }

  const el = {
    businessName: document.getElementById('business-name'),
    monthLabel: document.getElementById('month-label'),
    calendarGrid: document.getElementById('calendar-grid'),
    prevMonth: document.getElementById('prev-month'),
    nextMonth: document.getElementById('next-month'),
    slotsTitle: document.getElementById('slots-title'),
    slotList: document.getElementById('slot-list'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalBody: document.getElementById('modal-body'),
  };

  async function init() {
    const res = await fetch('/api/config');
    state.config = await res.json();
    el.businessName.textContent = state.config.businessName || '線上預約';
    document.title = state.config.businessName || '線上預約';

    el.prevMonth.addEventListener('click', () => {
      state.viewMonth = state.viewMonth.add(-1, 'month');
      renderCalendar();
    });
    el.nextMonth.addEventListener('click', () => {
      state.viewMonth = state.viewMonth.add(1, 'month');
      renderCalendar();
    });

    renderCalendar();
  }

  function renderCalendar() {
    const month = state.viewMonth;
    el.monthLabel.textContent = month.format('YYYY年MM月');

    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    let html = weekdays.map((w) => `<div class="weekday">${w}</div>`).join('');

    const firstDay = month.day();
    const daysInMonth = new Date(month.year(), month.month() + 1, 0).getDate();
    const today = dayjsLite(new Date()).startOf('day');
    const maxDays = state.config.bookingWindowDays || 30;

    for (let i = 0; i < firstDay; i++) {
      html += `<div class="day-cell empty"></div>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = dayjsLite(new Date(month.year(), month.month(), d));
      const dateStr = cellDate.format('YYYY-MM-DD');
      const diff = cellDate.diffDays(today);
      const inWindow = diff >= 0 && diff <= maxDays;
      const isSelected = state.selectedDate === dateStr;
      const cls = ['day-cell'];
      if (!inWindow) cls.push('disabled');
      else cls.push('available');
      if (isSelected) cls.push('selected');

      html += `<div class="${cls.join(' ')}" data-date="${inWindow ? dateStr : ''}">${d}</div>`;
    }

    el.calendarGrid.innerHTML = html;

    el.calendarGrid.querySelectorAll('.day-cell.available').forEach((cell) => {
      cell.addEventListener('click', () => selectDate(cell.dataset.date));
    });
  }

  async function selectDate(dateStr) {
    state.selectedDate = dateStr;
    state.selectedSlot = null;
    renderCalendar();
    el.slotsTitle.textContent = `${dateStr} 可預約時段（台北時間）`;
    el.slotList.innerHTML = `<div class="empty-hint">載入中…</div>`;

    const res = await fetch(`/api/availability?date=${dateStr}`);
    const data = await res.json();

    if (!data.slots || data.slots.length === 0) {
      el.slotList.innerHTML = `<div class="empty-hint">這天沒有可預約的時段，請選擇其他日期。</div>`;
      return;
    }

    el.slotList.innerHTML = data.slots
      .map((s) => `<button class="slot-btn" data-slot="${s}">${s}</button>`)
      .join('');

    el.slotList.querySelectorAll('.slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => openBookingModal(dateStr, btn.dataset.slot));
    });
  }

  function openBookingModal(dateStr, slot) {
    const questions = state.config.questions || [];
    const questionsHtml = questions
      .map(
        (q) => `
      <div class="form-group">
        <label>${escapeHtml(q.label)} ${q.required ? '<span style="color:#dc2626">*</span>' : ''}</label>
        <textarea data-qid="${q.id}" ${q.required ? 'required' : ''}></textarea>
      </div>`
      )
      .join('');

    el.modalBody.innerHTML = `
      <h2>確認預約</h2>
      <p style="color:#6b7280;font-size:14px;">${dateStr} ${slot} - ${addMinutesStr(slot, state.config.slotDurationMin)}（台北時間 GMT+8）</p>
      <div id="modal-error"></div>
      <div class="form-group">
        <label>姓名 <span style="color:#dc2626">*</span></label>
        <input type="text" id="f-name" required />
      </div>
      <div class="form-group">
        <label>Email <span style="color:#dc2626">*</span></label>
        <input type="email" id="f-email" required />
      </div>
      ${questionsHtml}
      <div style="display:flex; gap:10px; margin-top:20px;">
        <button class="btn secondary" id="modal-cancel">取消</button>
        <button class="btn" id="modal-submit">送出預約</button>
      </div>
    `;

    el.modalOverlay.style.display = 'flex';
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('modal-submit').addEventListener('click', () =>
      submitBooking(dateStr, slot)
    );
  }

  function addMinutesStr(time, minutes) {
    const [h, m] = time.split(':').map(Number);
    const total = h * 60 + m + (minutes || 30);
    const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function closeModal() {
    el.modalOverlay.style.display = 'none';
  }

  async function submitBooking(dateStr, slot) {
    const name = document.getElementById('f-name').value.trim();
    const email = document.getElementById('f-email').value.trim();
    const errorBox = document.getElementById('modal-error');
    errorBox.innerHTML = '';

    if (!name || !email) {
      errorBox.innerHTML = `<div class="error-box">請填寫姓名與 Email</div>`;
      return;
    }

    const answers = Array.from(document.querySelectorAll('[data-qid]')).map((elm) => ({
      id: parseInt(elm.dataset.qid, 10),
      answer: elm.value.trim(),
    }));

    const submitBtn = document.getElementById('modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '送出中…';

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, start_time: slot, name, email, answers }),
      });
      const data = await res.json();

      if (!res.ok) {
        errorBox.innerHTML = `<div class="error-box">${escapeHtml(data.error || '發生錯誤，請稍後再試')}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = '送出預約';
        return;
      }

      showSuccess(data.booking);
      selectDate(dateStr); // 重新整理時段（此時段應已消失）
    } catch (err) {
      errorBox.innerHTML = `<div class="error-box">網路錯誤，請稍後再試</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = '送出預約';
    }
  }

  const LINE_OA_URL = 'https://lin.ee/tJhE64S';

  function showSuccess(booking) {
    const meetHtml = booking.meet_link
      ? `<div class="meet-link-box">視訊會議連結：<br/><a href="${booking.meet_link}" target="_blank">${booking.meet_link}</a></div>`
      : '';
    el.modalBody.innerHTML = `
      <div class="success-box">
        <div class="icon">✅</div>
        <h2>預約成功！</h2>
        <p>${booking.date} ${booking.start_time} - ${booking.end_time}（台北時間 GMT+8）</p>
        ${meetHtml}
        <p style="color:#6b7280;font-size:13px;">確認信已寄至您的信箱，會議前一小時也會收到提醒信。</p>
        <a class="btn" style="background:#06C755;display:block;margin-bottom:10px;text-decoration:none;" href="${LINE_OA_URL}" target="_blank">加入官方 LINE 好友</a>
        <button class="btn secondary" id="modal-close">完成</button>
      </div>
    `;
    document.getElementById('modal-close').addEventListener('click', closeModal);
  }

  el.modalOverlay.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });

  init();
})();
