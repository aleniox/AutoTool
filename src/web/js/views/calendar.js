import { api } from '../api.js';
import {
  esc, statusBadge, platformTag, fmtDate, truncate,
  openModal, closeModal, toast
} from '../ui.js';
import { jobModal } from './jobs.js';

export const title = 'Lịch đăng bài';

let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1-12
let selectedPlatform = '';
let selectedAccount = '';

export async function render(root) {
  let alive = true;

  const [accountsRes, platformsRes] = await Promise.all([
    api.accounts.list().catch(() => ({ accounts: [] })),
    api.platforms().catch(() => ({ platforms: [] }))
  ]);

  const accounts = accountsRes.accounts || [];
  const platforms = platformsRes.platforms || [];

  async function draw() {
    if (!alive) return;

    const monthStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
    let data;
    try {
      data = await api.calendar({
        month: monthStr,
        platform: selectedPlatform || undefined,
        accountId: selectedAccount ? Number(selectedAccount) : undefined,
      });
    } catch (err) {
      root.innerHTML = `<div class="card"><h2>Lỗi tải lịch</h2><p class="muted">${esc(err.message)}</p></div>`;
      return;
    }

    if (!alive) return;

    const items = data.items || [];
    const projections = data.projections || [];

    // Group events by day (1-31) in local timezone
    const dayEvents = {};
    for (let d = 1; d <= 31; d++) dayEvents[d] = [];

    // Group actual items
    for (const item of items) {
      if (!item.run_at) continue;
      const dt = new Date(item.run_at);
      // Check if it belongs to current displayed month/year
      if (dt.getFullYear() === currentYear && dt.getMonth() + 1 === currentMonth) {
        const day = dt.getDate();
        if (!dayEvents[day]) dayEvents[day] = [];
        dayEvents[day].push(item);
      }
    }

    // Group recurring projected runs
    for (const proj of projections) {
      if (!proj.run_at) continue;
      const dt = new Date(proj.run_at);
      if (dt.getFullYear() === currentYear && dt.getMonth() + 1 === currentMonth) {
        const day = dt.getDate();
        if (!dayEvents[day]) dayEvents[day] = [];
        dayEvents[day].push(proj);
      }
    }

    const monthTitle = `Tháng ${currentMonth}, ${currentYear}`;
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() + 1 === currentMonth;
    const todayDate = today.getDate();

    // Calendar grid calculations
    // First day of month: 0=Sun, 1=Mon, ..., 6=Sat
    const firstDay = new Date(currentYear, currentMonth - 1, 1).getDay();
    // Convert to Monday=0, ..., Sunday=6
    const startOffset = (firstDay + 6) % 7;
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const daysInPrevMonth = new Date(currentYear, currentMonth - 1, 0).getDate();

    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    let gridHtml = '';
    const weekdays = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
    for (const w of weekdays) {
      gridHtml += `<div class="cal-head-day">${w}</div>`;
    }

    for (let i = 0; i < totalCells; i++) {
      if (i < startOffset) {
        // Prev month
        const prevDay = daysInPrevMonth - startOffset + i + 1;
        gridHtml += `<div class="cal-day other-month"><div class="cal-day-top"><span class="cal-day-num">${prevDay}</span></div></div>`;
      } else if (i < startOffset + daysInMonth) {
        // Current month day
        const dayNum = i - startOffset + 1;
        const isToday = isCurrentMonth && dayNum === todayDate;
        const evts = dayEvents[dayNum] || [];

        // Sort items by time
        evts.sort((a, b) => new Date(a.run_at) - new Date(b.run_at));

        const visibleEvts = evts.slice(0, 3);
        const moreCount = evts.length - visibleEvts.length;

        const evtsHtml = visibleEvts.map((e) => {
          const dt = new Date(e.run_at);
          const timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
          if (e.projected) {
            return `<div class="cal-event-pill projected" data-act="view-job" data-id="${e.job_id}" title="Lặp định kỳ: ${esc(e.job_name)} lúc ${timeStr}">
              <span>🔄</span> <strong>${timeStr}</strong> <span class="truncate">${esc(e.job_name)}</span>
            </div>`;
          }
          const statusClass = `status-${e.status || 'pending'}`;
          const titleText = e.post_title || e.target_name || `#${e.id}`;
          const platIcon = e.platform ? platformTag(e.platform) : '';
          return `<div class="cal-event-pill ${statusClass}" data-act="view-item" data-id="${e.id}" title="${esc(titleText)} (${e.account_label || ''} -> ${e.target_name || ''})">
            <span>${platIcon}</span> <strong>${timeStr}</strong> <span class="truncate">${esc(titleText)}</span>
          </div>`;
        }).join('');

        const moreHtml = moreCount > 0 ? `<div class="cal-more" data-act="view-day" data-day="${dayNum}">+ ${moreCount} bài khác</div>` : '';

        gridHtml += `
          <div class="cal-day ${isToday ? 'today' : ''}" data-day="${dayNum}">
            <div class="cal-day-top">
              <span class="cal-day-num">${dayNum}</span>
              <button class="cal-day-add" title="Lên lịch bài cho ngày này" data-act="add-day" data-day="${dayNum}">+ Đăng</button>
            </div>
            <div class="cal-events">
              ${evtsHtml}
              ${moreHtml}
            </div>
          </div>
        `;
      } else {
        // Next month
        const nextDay = i - (startOffset + daysInMonth) + 1;
        gridHtml += `<div class="cal-day other-month"><div class="cal-day-top"><span class="cal-day-num">${nextDay}</span></div></div>`;
      }
    }

    root.innerHTML = `
      <div class="cal-bar">
        <div class="cal-nav">
          <button class="sm" id="calPrev">◀ Tháng trước</button>
          <h2 id="calTitle">${monthTitle}</h2>
          <button class="sm" id="calNext">Tháng sau ▶</button>
          <button class="sm" id="calToday">Hôm nay</button>
        </div>

        <div class="cal-filters">
          <select id="calFilterPlat" class="sm">
            <option value="">Tất cả nền tảng</option>
            ${platforms.map((p) => `<option value="${p.id}" ${selectedPlatform === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>

          <select id="calFilterAcc" class="sm">
            <option value="">Tất cả tài khoản</option>
            ${accounts.map((a) => `<option value="${a.id}" ${selectedAccount === String(a.id) ? 'selected' : ''}>${esc(a.label)} (${esc(a.platform)})</option>`).join('')}
          </select>

          <button class="primary sm" id="calBtnNewJob">➕ Lên lịch chiến dịch</button>
        </div>
      </div>

      <div class="cal-grid">
        ${gridHtml}
      </div>

      <div class="mt tiny muted" style="display:flex;gap:16px;flex-wrap:wrap">
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--ok);border-radius:2px"></span> Thành công</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--warn);border-radius:2px"></span> Đã lên lịch / Chờ xử lý</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--err);border-radius:2px"></span> Thất bại</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#a855f7;border-radius:2px"></span> Lặp định kỳ (Dự kiến)</span>
      </div>
    `;

    // Event handlers
    root.querySelector('#calPrev').addEventListener('click', () => {
      currentMonth -= 1;
      if (currentMonth < 1) {
        currentMonth = 12;
        currentYear -= 1;
      }
      draw();
    });

    root.querySelector('#calNext').addEventListener('click', () => {
      currentMonth += 1;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear += 1;
      }
      draw();
    });

    root.querySelector('#calToday').addEventListener('click', () => {
      currentYear = new Date().getFullYear();
      currentMonth = new Date().getMonth() + 1;
      draw();
    });

    root.querySelector('#calFilterPlat').addEventListener('change', (e) => {
      selectedPlatform = e.target.value;
      draw();
    });

    root.querySelector('#calFilterAcc').addEventListener('change', (e) => {
      selectedAccount = e.target.value;
      draw();
    });

    root.querySelector('#calBtnNewJob').addEventListener('click', () => {
      jobModal(draw);
    });

    // Add on specific day
    root.querySelectorAll('[data-act="add-day"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = Number(btn.dataset.day);
        const targetDate = new Date(currentYear, currentMonth - 1, d, 9, 0, 0);
        jobModal(draw, { defaultDate: targetDate });
      });
    });

    // View day details
    root.querySelectorAll('.cal-day').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        const d = Number(cell.dataset.day);
        if (!d) return;
        const evts = dayEvents[d] || [];
        showDayDetailModal(d, currentMonth, currentYear, evts, draw);
      });
    });

    // View more click
    root.querySelectorAll('[data-act="view-day"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = Number(el.dataset.day);
        const evts = dayEvents[d] || [];
        showDayDetailModal(d, currentMonth, currentYear, evts, draw);
      });
    });

    // View item detail
    root.querySelectorAll('[data-act="view-item"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemId = Number(el.dataset.id);
        const it = items.find((x) => x.id === itemId);
        if (it) showItemDetailModal(it, draw);
      });
    });

    // View recurring job detail
    root.querySelectorAll('[data-act="view-job"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = `#/jobs/${el.dataset.id}`;
      });
    });
  }

  await draw();
  return () => { alive = false; };
}

function showDayDetailModal(day, month, year, events, redraw) {
  const dateStr = `Ngày ${day}/${month}/${year}`;
  openModal({
    title: `📅 Lịch bài đăng — ${dateStr}`,
    body: `
      <div class="mb" style="display:flex;justify-content:space-between;align-items:center">
        <span>Tổng cộng: <strong>${events.length}</strong> bài đăng / lịch chạy</span>
        <button class="primary sm" id="dayAddJob">➕ Lên lịch thêm bài</button>
      </div>
      ${
        events.length
          ? `<div class="table-wrap"><table>
              <thead>
                <tr>
                  <th>Giờ</th>
                  <th>Nền tảng</th>
                  <th>Bài viết</th>
                  <th>Mục tiêu</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                ${events.map((e) => {
                  const dt = new Date(e.run_at);
                  const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
                  if (e.projected) {
                    return `<tr>
                      <td><strong>${time}</strong></td>
                      <td><span class="badge accent">🔄 Định kỳ</span></td>
                      <td>${esc(e.job_name)}</td>
                      <td>—</td>
                      <td><span class="badge muted">Dự kiến</span></td>
                    </tr>`;
                  }
                  return `<tr>
                    <td><strong>${time}</strong></td>
                    <td>${platformTag(e.platform)} ${esc(e.account_label || '')}</td>
                    <td><div class="truncate" style="max-width:240px"><strong>${esc(e.post_title || '(Không tiêu đề)')}</strong></div></td>
                    <td>${esc(e.target_name || '')}</td>
                    <td>${statusBadge(e.status)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table></div>`
          : '<div class="muted">Chưa có bài viết nào được lên lịch cho ngày này.</div>'
      }
    `,
    footer: `<button data-modal-close>Đóng</button>`,
    onMount(modal) {
      modal.querySelector('#dayAddJob')?.addEventListener('click', () => {
        closeModal();
        const targetDate = new Date(year, month - 1, day, 9, 0, 0);
        jobModal(redraw, { defaultDate: targetDate });
      });
    }
  });
}

function showItemDetailModal(it, redraw) {
  openModal({
    title: `Chi tiết lượt đăng #${it.id}`,
    body: `
      <div class="row">
        <div><strong>Bài viết:</strong> ${esc(it.post_title || '(Không tiêu đề)')}</div>
        <div><strong>Trạng thái:</strong> ${statusBadge(it.status)}</div>
      </div>
      <div class="row mt">
        <div><strong>Chiến dịch:</strong> <a href="#/jobs/${it.job_id}">${esc(it.job_name || `#${it.job_id}`)}</a></div>
        <div><strong>Thời gian:</strong> ${esc(fmtDate(it.run_at))}</div>
      </div>
      <div class="row mt">
        <div><strong>Tài khoản:</strong> ${platformTag(it.platform)} ${esc(it.account_label || '')}</div>
        <div><strong>Nhóm / Trang:</strong> ${esc(it.target_name || '')}</div>
      </div>
      ${it.post_caption ? `<div class="card mt" style="max-height:160px;overflow-y:auto;white-space:pre-wrap;background:var(--panel-2)">${esc(it.post_caption)}</div>` : ''}
      ${it.error ? `<div class="note danger mt"><strong>Lỗi:</strong> ${esc(it.error)}</div>` : ''}
      ${it.remote_url ? `<div class="mt"><a class="btn sm" href="${esc(it.remote_url)}" target="_blank" rel="noopener">🔗 Xem bài trên mạng xã hội</a></div>` : ''}
    `,
    footer: `<button data-modal-close>Đóng</button>`
  });
}
