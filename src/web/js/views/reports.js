import { api } from '../api.js';
import { esc, $, toast, emptyState, statusBadge, fmtDate, truncate } from '../ui.js';

export const title = 'Báo cáo';

let days = 30;

export async function render(root) {
  let alive = true;

  async function draw() {
    const r = await api.reports(days);
    if (!alive) return;
    const o = r.overall ?? {};
    const rate = o.total ? Math.round(((o.success ?? 0) / o.total) * 100) : 0;

    root.innerHTML = `
      <div class="card">
        <div class="row tight">
          <label class="field" style="flex:0 0 200px;margin:0">
            <span>Khoảng thời gian</span>
            <select id="days">
              ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} ngày gần nhất</option>`).join('')}
            </select>
          </label>
          <div class="spacer"></div>
          <div class="tiny muted" style="align-self:center">Từ ${esc(fmtDate(r.since, false))}</div>
        </div>
      </div>

      <div class="grid cols-4 mb">
        ${stat('Tổng lượt đăng', o.total ?? 0, '')}
        ${stat('Thành công', o.success ?? 0, `tỉ lệ ${rate}%`, 'ok')}
        ${stat('Thất bại', o.failed ?? 0, '', o.failed ? 'err' : '')}
        ${stat('Đang chờ / bỏ qua', `${o.pending ?? 0} / ${o.skipped ?? 0}`, '', 'warn')}
      </div>

      <div class="card">
        <h2>Theo ngày</h2>
        <div class="sub mb">Số lượt đăng thành công và thất bại mỗi ngày</div>
        ${r.byDay.length ? dayChart(r.byDay) : emptyState('📈', 'Chưa có dữ liệu trong khoảng này')}
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>Theo nền tảng</h2>
          ${tableOrEmpty(r.byPlatform, ['Nền tảng', 'Tổng', 'Thành công', 'Thất bại'], (p) => `
            <tr><td>${esc(p.platform)}</td><td class="num">${p.total}</td>
                <td class="num" style="color:var(--ok)">${p.success}</td>
                <td class="num" style="color:${p.failed ? 'var(--err)' : 'inherit'}">${p.failed}</td></tr>`)}
        </div>

        <div class="card">
          <h2>Theo tài khoản</h2>
          ${tableOrEmpty(r.byAccount, ['Tài khoản', 'Tổng', 'Thành công', 'Thất bại'], (a) => `
            <tr><td>${esc(a.label)}<div class="tiny muted">${esc(a.platform)}</div></td>
                <td class="num">${a.total}</td>
                <td class="num" style="color:var(--ok)">${a.success}</td>
                <td class="num" style="color:${a.failed ? 'var(--err)' : 'inherit'}">${a.failed}</td></tr>`)}
        </div>
      </div>

      <div class="card">
        <h2>Chiến dịch</h2>
        ${tableOrEmpty(r.byJob, ['Chiến dịch', 'Trạng thái', 'Tiến độ', 'Lịch'], (j) => `
          <tr>
            <td><a href="#/jobs/${j.id}">${esc(truncate(j.name, 40))}</a>
              ${j.dry_run ? ' <span class="badge warn">thử</span>' : ''}</td>
            <td>${statusBadge(j.status)}</td>
            <td class="tiny">✅ ${j.success_count} · ❌ ${j.failed_count} · ⏭️ ${j.skipped_count} / ${j.total}</td>
            <td class="tiny muted">${esc(fmtDate(j.scheduled_at))}</td>
          </tr>`)}
      </div>

      ${
        r.topErrors?.length
          ? `<div class="card">
              <h2>Lỗi thường gặp</h2>
              <div class="sub mb">Xếp theo số lần xuất hiện</div>
              <div class="table-wrap"><table>
                <thead><tr><th class="num" style="width:70px">Số lần</th><th>Nội dung lỗi</th></tr></thead>
                <tbody>${r.topErrors
                  .map((e) => `<tr><td class="num">${e.count}</td><td class="tiny mono">${esc(e.error)}</td></tr>`)
                  .join('')}</tbody>
              </table></div>
            </div>`
          : ''
      }
    `;

    root.querySelector('#days').addEventListener('change', (e) => {
      days = Number(e.target.value);
      draw();
    });
  }

  await draw();
  return () => {
    alive = false;
  };
}

function stat(label, value, hint, cls = '') {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}

function tableOrEmpty(rows, headers, rowFn) {
  if (!rows?.length) return emptyState('📭', 'Chưa có dữ liệu');
  return `<div class="table-wrap"><table>
    <thead><tr>${headers.map((h, i) => `<th class="${i ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(rowFn).join('')}</tbody>
  </table></div>`;
}

function dayChart(byDay) {
  const max = Math.max(...byDay.map((d) => d.success + d.failed), 1);
  return `<div class="bar-chart">
    ${byDay
      .map((d) => {
        const okH = (d.success / max) * 100;
        const errH = (d.failed / max) * 100;
        return `<div class="col" title="${esc(d.day)}: ${d.success} thành công, ${d.failed} thất bại">
          <div class="bar err" style="height:${errH}%"></div>
          <div class="bar" style="height:${okH}%"></div>
          <div class="lbl">${esc(d.day?.slice(5) ?? '')}</div>
        </div>`;
      })
      .join('')}
  </div>`;
}
