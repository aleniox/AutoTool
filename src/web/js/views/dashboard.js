import { api } from '../api.js';
import {
  esc, statusBadge, platformTag, fmtDate, fmtRelative, truncate,
  toast, emptyState, confirmDialog,
} from '../ui.js';

export const title = 'Tổng quan';

export async function render(root) {
  let alive = true;

  async function draw() {
    if (!alive) return;
    const [stats, settings] = await Promise.all([api.stats(), api.settings().catch(() => null)]);
    if (!alive) return;

    const c = stats.counts ?? {};
    const today = stats.today ?? {};
    const pending = c.pending ?? 0;
    const failed = c.failed ?? 0;

    root.innerHTML = `
      <div class="grid cols-4 mb">
        ${statCard('Tài khoản', c.accounts ?? 0, accountHint(stats.accounts), 'accent')}
        ${statCard('Nhóm / Trang', c.targets ?? 0, `${c.posts ?? 0} bài viết`, '')}
        ${statCard('Hôm nay thành công', today.success ?? 0, `${today.failed ?? 0} thất bại`, 'ok')}
        ${statCard('Đang chờ xử lý', pending, `${c.running ?? 0} đang chạy`, pending ? 'warn' : '')}
      </div>

      ${failed ? `<div class="note danger"><strong>${failed} lượt đăng thất bại.</strong>
        Vào <a href="#/jobs">Chiến dịch</a> để xem chi tiết và bấm "Thử lại bài lỗi".</div>` : ''}

      ${settings?.runtime?.allowDryRun === false ? '' : `
      <div class="note info">
        <strong>Mẹo:</strong> dùng <em>Chế độ thử (dry-run)</em> khi tạo chiến dịch — tool sẽ mở trình duyệt,
        điền nội dung và đính ảnh như thật nhưng <strong>không bấm nút Đăng</strong>. Rất hữu ích để kiểm tra selector
        trước khi chạy thật.
      </div>`}

      <div class="grid cols-2">
        <div class="card">
          <h2>Trạng thái tài khoản</h2>
          <div class="sub mb">Số bài đã đăng hôm nay / giới hạn mỗi ngày</div>
          ${renderAccounts(stats.accounts)}
        </div>

        <div class="card">
          <h2>Chiến dịch đang hoạt động</h2>
          <div class="sub mb">Đã lên lịch, đang chạy hoặc tạm dừng</div>
          ${renderUpcoming(stats.upcoming)}
        </div>
      </div>

      <div class="card">
        <h2>Hoạt động gần đây</h2>
        <div class="sub mb">15 lượt đăng mới nhất</div>
        ${renderRecent(stats.recent)}
      </div>
    `;

    root.querySelectorAll('[data-act="check"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Đang kiểm tra…';
        try {
          const r = await api.accounts.check(btn.dataset.id);
          toast(
            r.result.status === 'logged_in' ? `OK: ${r.result.message}` : `Cần đăng nhập: ${r.result.message}`,
            r.result.status === 'logged_in' ? 'ok' : 'warn',
          );
        } catch (err) {
          toast(err.message, 'err');
        }
        draw();
      });
    });

    root.querySelectorAll('[data-act="login"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const r = await api.accounts.login(btn.dataset.id);
          toast(r.message, 'info', 9000);
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });

    root.querySelectorAll('[data-act="runnow"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const r = await api.jobs.runNow(btn.dataset.id);
          toast(`Đã đẩy ${r.moved} lượt đăng vào hàng đợi`, 'ok');
          draw();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });

    root.querySelectorAll('[data-act="pausejob"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api.jobs.pause(btn.dataset.id).catch((e) => toast(e.message, 'err'));
        draw();
      });
    });
  }

  await draw();
  const timer = setInterval(draw, 6000);

  return () => {
    alive = false;
    clearInterval(timer);
  };
}

function statCard(label, value, hint, cls = '') {
  return `<div class="stat ${cls}">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

function accountHint(accounts = []) {
  if (!accounts?.length) return 'chưa có tài khoản nào';
  const ok = accounts.filter((a) => a.status === 'logged_in').length;
  const need = accounts.filter((a) => a.status === 'expired' || a.status === 'new').length;
  return `${ok} đã đăng nhập${need ? `, ${need} cần đăng nhập` : ''}`;
}

function renderAccounts(accounts = []) {
  if (!accounts.length) {
    return emptyState('👤', 'Chưa có tài khoản', 'Vào mục "Tài khoản" để thêm nền tảng đầu tiên.');
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>Nền tảng</th><th>Tài khoản</th><th>Trạng thái</th><th class="num">Hôm nay</th><th class="num">Nhóm</th><th></th></tr></thead>
    <tbody>
      ${accounts
        .map(
          (a) => `<tr>
        <td>${platformTag(a.platform, headingColor(a.platform))}</td>
        <td><strong>${esc(a.label)}</strong></td>
        <td>${statusBadge(a.status)}</td>
        <td class="num">${a.posted_today ?? 0} / ${a.daily_limit || '∞'}</td>
        <td class="num">${a.targets ?? 0}</td>
        <td class="actions">
          ${
            a.status === 'logged_in'
              ? `<button class="sm" data-act="check" data-id="${a.id}">Kiểm tra</button>`
              : `<button class="sm primary" data-act="login" data-id="${a.id}">Đăng nhập</button>`
          }
        </td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table></div>`;
}

const PLATFORM_COLORS = {
  facebook: '#1877F2', linkedin: '#0A66C2', x: '#888', telegram: '#2AABEE',
  reddit: '#FF4500', instagram: '#E1306C', threads: '#888', tiktok: '#FE2C55', zalo: '#0068FF',
};
const headingColor = (p) => PLATFORM_COLORS[p] ?? '#888';

function renderUpcoming(jobs = []) {
  if (!jobs.length) return emptyState('🚀', 'Chưa có chiến dịch nào', 'Tạo chiến dịch ở mục "Chiến dịch".');
  return `<div class="job-list">
    ${jobs
      .map((j) => {
        const total = j.total || 1;
        const done = (j.success_count ?? 0) + (j.failed_count ?? 0);
        const pct = Math.round((done / total) * 100);
        return `<div class="job-mini">
          <div class="job-mini-head">
            <strong class="truncate">${esc(j.name)}</strong>
            ${j.dry_run ? '<span class="badge warn">thử</span>' : ''}
            ${statusBadge(j.status)}
          </div>
          <div class="tiny muted mt">
            ${done}/${j.total} lượt (${pct}%) · ${esc(fmtDate(j.scheduled_at))}
          </div>
          <div class="progress mt">
            <i class="p-ok" style="width:${((j.success_count ?? 0) / total) * 100}%"></i>
            <i class="p-err" style="width:${((j.failed_count ?? 0) / total) * 100}%"></i>
          </div>
          <div class="row tight mt">
            <button class="sm" data-act="runnow" data-id="${j.id}">Chạy ngay</button>
            <a class="btn sm" href="#/jobs/${j.id}">Chi tiết</a>
          </div>
        </div>`;
      })
      .join('')}
  </div>`;
}

function renderRecent(items = []) {
  if (!items.length) return emptyState('📭', 'Chưa có lượt đăng nào');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Kết quả</th><th>Bài viết</th><th>Nhóm / Trang</th><th>Tài khoản</th><th>Thời điểm</th><th>Ghi chú</th></tr></thead>
    <tbody>
      ${items
        .map(
          (i) => `<tr>
        <td>${statusBadge(i.status)}</td>
        <td>${esc(truncate(i.post_title || '(không tiêu đề)', 34))}</td>
        <td>${esc(truncate(i.target_name, 26))}</td>
        <td>${platformTag(i.account_label, headingColor(i.platform))}</td>
        <td class="tiny">${esc(fmtRelative(i.finished_at))}</td>
        <td class="tiny muted">${
          i.status === 'success'
            ? i.remote_url
              ? `<a href="${esc(i.remote_url)}" target="_blank" rel="noopener">Xem bài</a>`
              : 'Thành công'
            : esc(truncate(i.error, 60))
        }</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table></div>`;
}
