import { api } from '../api.js';
import {
  esc, $, toast, openModal, closeModal, confirmDialog, statusBadge,
  platformTag, fmtDate, fmtRelative, emptyState, truncate, toLocalInput,
} from '../ui.js';

export const title = 'Chiến dịch';

let cache = { posts: [], targets: [], accounts: [], platforms: [] };

export async function render(root, params) {
  const [p, posts, targets, accounts] = await Promise.all([
    api.platforms(),
    api.posts.list({ limit: 500 }),
    api.targets.list(),
    api.accounts.list(),
  ]);
  cache = { platforms: p.platforms, posts: posts.posts, targets: targets.targets, accounts: accounts.accounts };

  const jobId = params?.[0];

  $('#viewActions').innerHTML = `
    ${jobId ? '<a class="btn" href="#/jobs">← Danh sách</a>' : ''}
    <button class="primary" id="addJob">+ Tạo chiến dịch</button>`;

  $('#addJob').addEventListener('click', () => jobModal(draw));

  let alive = true;

  async function draw() {
    if (jobId) await drawDetail(root, jobId);
    else await drawList(root);
  }

  await draw();

  if (jobId) {
    const timer = setInterval(() => alive && drawDetail(root, jobId), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }

  const timer = setInterval(() => alive && drawList(root), 6000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

/* -------------------------------------------------------------------------- */
/* Danh sach chien dich                                                       */
/* -------------------------------------------------------------------------- */

async function drawList(root) {
  const { jobs } = await api.jobs.list({ limit: 100 });

  root.innerHTML = `
    ${
      jobs.length
        ? jobs.map(jobCard).join('')
        : `<div class="card">${emptyState('🚀', 'Chưa có chiến dịch nào', 'Bấm "+ Tạo chiến dịch" để đăng bài hàng loạt.')}</div>`
    }
  `;

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => jobAction(btn, drawList.bind(null, root)));
  });
}

function jobCard(j) {
  const total = j.total || 1;
  const done = (j.success_count ?? 0) + (j.failed_count ?? 0);
  const pct = Math.round((done / total) * 100);

  return `<div class="card">
    <div class="row" style="align-items:flex-start">
      <div style="flex:1 1 320px">
        <div class="section-title" style="margin:0 0 6px">
          <h2>${esc(j.name)}</h2>
          ${statusBadge(j.status)}
          ${j.recurring_type && j.recurring_type !== 'none' ? `<span class="badge accent">🔄 ${esc(recurringLabel(j))}</span>` : ''}
          ${j.dry_run ? '<span class="badge warn">Chế độ thử</span>' : ''}
          ${j.project_name ? `<span class="badge muted">${esc(j.project_name)}</span>` : ''}
        </div>
        <div class="tiny muted">
          ${esc(strategyLabel(j.strategy))} · Lịch: ${esc(fmtDate(j.scheduled_at))}
          ${j.recurring_count ? ` · Đã lặp ${j.recurring_count} chu kỳ` : ''}
          ${j.finished_at ? ` · Kết thúc: ${esc(fmtDate(j.finished_at))}` : ''}
        </div>
      </div>
      <div style="flex:0 0 auto" class="actions">
        ${j.status === 'running' ? `<button class="sm" data-act="pause" data-id="${j.id}">Tạm dừng</button>` : ''}
        ${j.status === 'paused' ? `<button class="sm primary" data-act="resume" data-id="${j.id}">Tiếp tục</button>` : ''}
        ${['scheduled', 'paused'].includes(j.status) ? `<button class="sm" data-act="runnow" data-id="${j.id}">Chạy ngay</button>` : ''}
        ${j.failed_count ? `<button class="sm" data-act="retry" data-id="${j.id}">Thử lại bài lỗi (${j.failed_count})</button>` : ''}
        <a class="btn sm" href="#/jobs/${j.id}">Chi tiết</a>
        <button class="sm danger" data-act="del" data-id="${j.id}" data-name="${esc(j.name)}">Xoá</button>
      </div>
    </div>

    <div class="mt">
      <div class="tiny muted mb" style="display:flex;gap:14px;flex-wrap:wrap">
        <span>✅ ${j.success_count ?? 0} thành công</span>
        <span>❌ ${j.failed_count ?? 0} thất bại</span>
        <span>⏭️ ${j.skipped_count ?? 0} bỏ qua</span>
        <span>📦 ${j.total} tổng lượt đăng</span>
        <span>Tiến độ ${pct}%</span>
      </div>
      <div class="progress">
        <i class="p-ok" style="width:${((j.success_count ?? 0) / total) * 100}%"></i>
        <i class="p-err" style="width:${((j.failed_count ?? 0) / total) * 100}%"></i>
        <i class="p-skip" style="width:${((j.skipped_count ?? 0) / total) * 100}%"></i>
      </div>
    </div>
  </div>`;
}

async function jobAction(btn, redraw) {
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === 'pause') {
      await api.jobs.pause(id);
      toast('Đã tạm dừng', 'ok');
    } else if (btn.dataset.act === 'resume') {
      await api.jobs.resume(id);
      toast('Đã tiếp tục', 'ok');
    } else if (btn.dataset.act === 'runnow') {
      const r = await api.jobs.runNow(id);
      toast(`Đã đẩy ${r.moved} lượt đăng vào hàng đợi`, 'ok');
    } else if (btn.dataset.act === 'retry') {
      const r = await api.jobs.retryFailed(id);
      toast(`Đã đưa ${r.retried} lượt đăng lỗi trở lại hàng đợi`, 'ok');
    } else if (btn.dataset.act === 'del') {
      const yes = await confirmDialog(`Xoá chiến dịch "${btn.dataset.name}" và toàn bộ lịch sử của nó?`, {
        danger: true,
        okLabel: 'Xoá',
      });
      if (!yes) return;
      await api.jobs.remove(id);
      toast('Đã xoá chiến dịch', 'ok');
    }
    redraw();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* -------------------------------------------------------------------------- */
/* Chi tiet chien dich                                                        */
/* -------------------------------------------------------------------------- */

let itemFilter = 'all';

async function drawDetail(root, jobId) {
  const [{ job, counts }, { items, total }] = await Promise.all([
    api.jobs.get(jobId),
    api.jobs.items(jobId, { status: itemFilter, limit: 300 }),
  ]);

  root.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0">
        <h2>${esc(job.name)}</h2>
        ${statusBadge(job.status)}
        ${job.dry_run ? '<span class="badge warn">Chế độ thử</span>' : ''}
      </div>
      <div class="grid cols-4 mt">
        ${miniStat('Tổng', job.total, '')}
        ${miniStat('Thành công', counts.success, 'ok')}
        ${miniStat('Thất bại', counts.failed, counts.failed ? 'err' : '')}
        ${miniStat('Đang chờ', counts.pending + counts.running, 'warn')}
      </div>
      <div class="tiny muted mt">
        Chiến lược: ${esc(strategyLabel(job.strategy))} · Lịch: ${esc(fmtDate(job.scheduled_at))}
        · Thử lại tối đa ${job.max_attempts} lần
        ${job.min_delay_sec ? ` · Nghỉ ${job.min_delay_sec}–${job.max_delay_sec}s` : ''}
      </div>
      <div class="mt actions">
        ${job.status === 'running' ? `<button class="sm" data-act="pause" data-id="${job.id}">Tạm dừng</button>` : ''}
        ${job.status === 'paused' ? `<button class="sm primary" data-act="resume" data-id="${job.id}">Tiếp tục</button>` : ''}
        <button class="sm" data-act="runnow" data-id="${job.id}">Chạy ngay</button>
        ${counts.failed ? `<button class="sm" data-act="retry" data-id="${job.id}">Thử lại ${counts.failed} bài lỗi</button>` : ''}
        <button class="sm danger" data-act="cancel" data-id="${job.id}">Huỷ phần còn lại</button>
      </div>
    </div>

    <div class="card">
      <div class="row tight mb">
        <label class="field" style="flex:0 0 200px;margin:0">
          <span>Lọc trạng thái</span>
          <select id="itemFilter">
            ${['all', 'pending', 'running', 'success', 'failed', 'skipped', 'canceled']
              .map((s) => `<option value="${s}" ${itemFilter === s ? 'selected' : ''}>${filterLabel(s)}</option>`)
              .join('')}
          </select>
        </label>
        <div class="spacer"></div>
        <div class="tiny muted" style="align-self:center">Hiển thị ${items.length}/${total} lượt đăng</div>
      </div>
      ${items.length ? itemsTable(items) : emptyState('📭', 'Không có lượt đăng nào khớp bộ lọc')}
    </div>
  `;

  root.querySelector('#itemFilter')?.addEventListener('change', (e) => {
    itemFilter = e.target.value;
    drawDetail(root, jobId);
  });

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => jobAction(btn, () => drawDetail(root, jobId)));
  });
}

function itemsTable(items) {
  return `<div class="table-wrap"><table>
    <thead>
      <tr><th>Trạng thái</th><th>Bài viết</th><th>Nhóm / Trang</th><th>Tài khoản</th>
        <th>Chạy lúc</th><th class="num">Số lần thử</th><th>Ghi chú</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (i) => `<tr>
        <td>${statusBadge(i.status)}</td>
        <td>${esc(truncate(i.post_title || i.post_excerpt || `#${i.post_id}`, 30))}</td>
        <td>${esc(truncate(i.target_name, 26))}
          <div class="tiny muted">${esc(i.target_kind)}</div></td>
        <td>${platformTag(i.platform, '#888')}
          <div class="tiny muted">${esc(i.account_label)}</div></td>
        <td class="tiny muted">
          ${esc(fmtDate(i.run_at))}
          ${i.finished_at ? `<div>${esc(fmtRelative(i.finished_at))}</div>` : ''}
        </td>
        <td class="num">${i.attempts}/${i.max_attempts}${i.defers ? `<div class="tiny muted">hoãn ${i.defers}×</div>` : ''}</td>
        <td class="tiny" style="max-width:300px">
          ${
            i.status === 'success' && i.remote_url
              ? `<a href="${esc(i.remote_url)}" target="_blank" rel="noopener">Xem bài đăng</a>`
              : i.error
                ? `<span class="muted">${esc(truncate(i.error, 110))}</span>`
                : '<span class="muted">—</span>'
          }
          ${i.screenshot ? `<div><a href="/screenshots/${esc(i.screenshot)}" target="_blank" rel="noopener">📷 Ảnh lúc lỗi</a></div>` : ''}
        </td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table></div>`;
}

function miniStat(label, value, cls) {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

const filterLabel = (s) =>
  ({ all: 'Tất cả', pending: 'Đang chờ', running: 'Đang chạy', success: 'Thành công', failed: 'Thất bại', skipped: 'Bỏ qua', canceled: 'Đã huỷ' })[s] ?? s;

const strategyLabel = (s) =>
  ({
    cross: 'Mỗi bài → mọi nhóm',
    zip: 'Ghép 1-1 theo thứ tự',
    round_robin: 'Chia đều, xoay vòng',
  })[s] ?? s;

export const recurringLabel = (j) => {
  const t = j.recurring_type;
  const time = j.recurring_time ? ` (${j.recurring_time})` : '';
  if (t === 'daily') return `Hàng ngày${time}`;
  if (t === 'weekly') return `Hàng tuần${time}`;
  if (t === 'monthly') return `Hàng tháng${time}`;
  return 'Định kỳ';
};

/* -------------------------------------------------------------------------- */
/* Modal tao chien dich                                                       */
/* -------------------------------------------------------------------------- */

export async function jobModal(onDone, opts = {}) {
  if (!cache.posts.length || !cache.targets.length) {
    try {
      const [p, posts, targets, accounts] = await Promise.all([
        api.platforms(),
        api.posts.list(),
        api.targets.list(),
        api.accounts.list(),
      ]);
      cache = { platforms: p.platforms, posts: posts.posts, targets: targets.targets, accounts: accounts.accounts };
    } catch {
      /* ignore */
    }
  }
  const { posts, targets, accounts } = cache;

  if (!posts.length) return toast('Chưa có bài viết nào. Vào mục "Bài viết" để tạo trước.', 'warn', 6000);
  if (!targets.length) return toast('Chưa có nhóm / trang nào. Vào mục "Nhóm & Trang" để thêm trước.', 'warn', 6000);

  const targetsByAccount = new Map();
  for (const t of targets) {
    if (!targetsByAccount.has(t.account_id)) targetsByAccount.set(t.account_id, []);
    targetsByAccount.get(t.account_id).push(t);
  }

  openModal({
    title: 'Tạo chiến dịch đăng bài',
    wide: true,
    body: `
      <label class="field">
        <span>Tên chiến dịch <b>*</b></span>
        <input type="text" id="j-name" placeholder="VD: Đăng khuyến mãi 20/12" value="Chiến dịch ${new Date().toLocaleString('vi-VN')}" />
      </label>

      <div class="grid cols-2">
        <div>
          <div class="section-title" style="margin-top:0">
            <h2>Bài viết</h2>
            <span class="badge accent" id="postCount">0</span>
            <div class="spacer"></div>
            <label class="check tiny"><input type="checkbox" id="allPosts" /> Tất cả</label>
          </div>
          <div class="picker" id="postPicker">
            ${posts
              .map(
                (p) => `<label>
                  <input type="checkbox" class="post-check" value="${p.id}" />
                  <span class="grow">
                    <div class="truncate"><strong>${esc(p.title || '(không tiêu đề)')}</strong></div>
                    <div class="meta truncate">${esc(truncate(p.caption, 60))} · ${p.media?.length ?? 0} media</div>
                  </span>
                </label>`,
              )
              .join('')}
          </div>
        </div>

        <div>
          <div class="section-title" style="margin-top:0">
            <h2>Nhóm / Trang</h2>
            <span class="badge accent" id="targetCount">0</span>
            <div class="spacer"></div>
            <label class="check tiny"><input type="checkbox" id="allTargets" /> Tất cả</label>
          </div>
          <div class="picker" id="targetPicker">
            ${[...targetsByAccount.entries()]
              .map(([accId, list]) => {
                const acc = accounts.find((a) => a.id === accId);
                const warn =
                  acc && acc.status !== 'logged_in'
                    ? ` <span class="badge err">chưa đăng nhập</span>`
                    : '';
                return `<label style="background:var(--panel-3)">
                    <input type="checkbox" class="acc-check" data-acc="${accId}" />
                    <span class="grow"><strong>${esc(acc?.label ?? `#${accId}`)}</strong>${warn}
                      <div class="meta">${esc(acc?.platformName ?? acc?.platform ?? '')} · ${list.length} mục tiêu</div>
                    </span>
                  </label>
                  ${list
                    .map(
                      (t) => `<label>
                        <input type="checkbox" class="target-check" value="${t.id}" data-acc="${accId}" />
                        <span class="grow">
                          <div class="truncate">${esc(t.name)}</div>
                          <div class="meta">${esc(t.kindLabel ?? t.kind)}</div>
                        </span>
                      </label>`,
                    )
                    .join('')}`;
              })
              .join('')}
          </div>
        </div>
      </div>

      <div class="section-title"><h2>Cách đăng</h2></div>
      <div class="row">
        <label class="field">
          <span>Chiến lược ghép bài × nhóm</span>
          <select id="j-strategy">
            <option value="cross">Mỗi bài → mọi nhóm (nhiều lượt nhất)</option>
            <option value="round_robin">Chia đều, xoay vòng (tránh trùng bài trong 1 nhóm)</option>
            <option value="zip">Ghép 1-1 theo thứ tự</option>
          </select>
        </label>
        <label class="field">
          <span>Thời điểm bắt đầu</span>
          <input type="datetime-local" id="j-when" value="${toLocalInput(opts.defaultDate)}" />
        </label>
      </div>

      <div class="row tight mb">
        <button type="button" class="sm" data-quick="now">Bây giờ</button>
        <button type="button" class="sm" data-quick="1h">Sau 1 giờ</button>
        <button type="button" class="sm" data-quick="8am">8h sáng mai</button>
      </div>

      <div class="section-title"><h2>Lên lịch định kỳ (Lặp lại)</h2></div>
      <div class="row">
        <label class="field">
          <span>Chu kỳ lặp lại</span>
          <select id="j-rec-type">
            <option value="none">Một lần duy nhất (Không lặp)</option>
            <option value="daily">🔄 Hàng ngày (Mỗi ngày vào giờ cố định)</option>
            <option value="weekly">📅 Hàng tuần (Chọn các ngày trong tuần)</option>
            <option value="monthly">📆 Hàng tháng (Theo ngày trong tháng)</option>
          </select>
        </label>
        <label class="field" id="j-rec-time-field">
          <span>Giờ đăng mỗi chu kỳ</span>
          <input type="time" id="j-rec-time" value="09:00" />
        </label>
      </div>

      <div id="j-rec-weekly-days" class="field mb" style="display:none">
        <span>Chọn các ngày trong tuần:</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="1" checked /> T2</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="2" checked /> T3</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="3" checked /> T4</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="4" checked /> T5</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="5" checked /> T6</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="6" /> T7</label>
          <label class="btn sm check-btn"><input type="checkbox" class="rec-day" value="7" /> CN</label>
        </div>
      </div>

      <div class="row" id="j-rec-extra" style="display:none">
        <label class="field">
          <span>Ngày kết thúc lặp (tuỳ chọn)</span>
          <input type="date" id="j-rec-end" />
        </label>
        <label class="field">
          <span>Số chu kỳ tối đa (0 = vô hạn)</span>
          <input type="number" id="j-rec-max" min="0" value="0" />
        </label>
      </div>

      <div class="row">
        <label class="field">
          <span>Nghỉ tối thiểu (giây) — để trống = theo tài khoản</span>
          <input type="number" id="j-min" min="0" placeholder="120" />
        </label>
        <label class="field">
          <span>Nghỉ tối đa (giây)</span>
          <input type="number" id="j-max" min="0" placeholder="360" />
        </label>
        <label class="field">
          <span>Thử lại tối đa</span>
          <input type="number" id="j-attempts" min="1" value="3" />
        </label>
      </div>

      <label class="check mb">
        <input type="checkbox" id="j-dry" />
        <strong>Chế độ thử (dry-run)</strong> — mở trình duyệt, điền nội dung và đính ảnh nhưng
        <u>không bấm nút Đăng</u>. Dùng để kiểm tra trước khi chạy thật.
      </label>

      <div id="j-preview" class="note info"></div>
    `,
    footer: `<button data-modal-close>Huỷ</button><button class="primary" id="j-save">Tạo chiến dịch</button>`,
    onMount(modal) {
      const postBoxes = [...modal.querySelectorAll('.post-check')];
      const targetBoxes = [...modal.querySelectorAll('.target-check')];
      const preview = modal.querySelector('#j-preview');

      const selectedPosts = () => postBoxes.filter((b) => b.checked).length;
      const selectedTargets = () => targetBoxes.filter((b) => b.checked).length;

      async function refresh() {
        modal.querySelector('#postCount').textContent = selectedPosts();
        modal.querySelector('#targetCount').textContent = selectedTargets();

        for (const accBox of modal.querySelectorAll('.acc-check')) {
          const own = targetBoxes.filter((b) => b.dataset.acc === accBox.dataset.acc);
          const checked = own.filter((b) => b.checked).length;
          accBox.checked = checked > 0 && checked === own.length;
          accBox.indeterminate = checked > 0 && checked < own.length;
        }

        const np = selectedPosts();
        const nt = selectedTargets();
        if (!np || !nt) {
          preview.innerHTML = 'Chọn ít nhất 1 bài viết và 1 nhóm để xem trước.';
          return;
        }
        try {
          const r = await api.jobs.preview({
            postIds: postBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
            targetIds: targetBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
            strategy: modal.querySelector('#j-strategy').value,
          });
          const dry = modal.querySelector('#j-dry').checked;
          preview.innerHTML = `Sẽ tạo <strong>${r.items}</strong> lượt đăng
            (${r.postCount} bài × ${r.targetCount} mục tiêu, ${esc(strategyLabel(r.strategy))}).
            ${dry ? '<br><span class="badge warn">Chế độ thử</span> Không bài nào thực sự được đăng.' : ''}`;
        } catch {
          preview.textContent = '';
        }
      }

      postBoxes.forEach((b) => b.addEventListener('change', refresh));
      targetBoxes.forEach((b) => b.addEventListener('change', refresh));
      modal.querySelector('#j-strategy').addEventListener('change', refresh);
      modal.querySelector('#j-dry').addEventListener('change', refresh);

      modal.querySelector('#allPosts').addEventListener('change', (e) => {
        postBoxes.forEach((b) => {
          b.checked = e.target.checked;
        });
        refresh();
      });
      modal.querySelector('#allTargets').addEventListener('change', (e) => {
        targetBoxes.forEach((b) => {
          b.checked = e.target.checked;
        });
        refresh();
      });
      modal.querySelectorAll('.acc-check').forEach((accBox) => {
        accBox.addEventListener('change', () => {
          targetBoxes
            .filter((b) => b.dataset.acc === accBox.dataset.acc)
            .forEach((b) => {
              b.checked = accBox.checked;
            });
          refresh();
        });
      });

      modal.querySelectorAll('[data-quick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = modal.querySelector('#j-when');
          const d = new Date();
          if (btn.dataset.quick === '1h') d.setHours(d.getHours() + 1);
          if (btn.dataset.quick === '8am') {
            d.setDate(d.getDate() + 1);
            d.setHours(8, 0, 0, 0);
          }
          input.value = toLocalInput(d);
        });
      });

      const recTypeSelect = modal.querySelector('#j-rec-type');
      const recDaysBox = modal.querySelector('#j-rec-weekly-days');
      const recExtraBox = modal.querySelector('#j-rec-extra');
      recTypeSelect.addEventListener('change', () => {
        const v = recTypeSelect.value;
        recDaysBox.style.display = v === 'weekly' ? 'block' : 'none';
        recExtraBox.style.display = v !== 'none' ? 'flex' : 'none';
      });

      refresh();

      modal.querySelector('#j-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const name = modal.querySelector('#j-name').value.trim();
        const postIds = postBoxes.filter((b) => b.checked).map((b) => Number(b.value));
        const targetIds = targetBoxes.filter((b) => b.checked).map((b) => Number(b.value));

        if (!name) return toast('Nhập tên chiến dịch', 'warn');
        if (!postIds.length) return toast('Chọn ít nhất 1 bài viết', 'warn');
        if (!targetIds.length) return toast('Chọn ít nhất 1 nhóm / trang', 'warn');

        const min = modal.querySelector('#j-min').value;
        const max = modal.querySelector('#j-max').value;

        const payload = {
          name,
          postIds,
          targetIds,
          strategy: modal.querySelector('#j-strategy').value,
          scheduledAt: modal.querySelector('#j-when').value
            ? new Date(modal.querySelector('#j-when').value).toISOString()
            : new Date().toISOString(),
          recurringType: modal.querySelector('#j-rec-type').value,
          recurringTime: modal.querySelector('#j-rec-time').value,
          recurringDays: [...modal.querySelectorAll('.rec-day:checked')].map((b) => Number(b.value)),
          recurringEndAt: modal.querySelector('#j-rec-end').value || null,
          maxCycles: Number(modal.querySelector('#j-rec-max').value) || 0,
          dryRun: modal.querySelector('#j-dry').checked,
          minDelaySec: min === '' ? undefined : Number(min),
          maxDelaySec: max === '' ? undefined : Number(max),
          maxAttempts: Number(modal.querySelector('#j-attempts').value) || 3,
        };

        btn.disabled = true;
        try {
          const r = await api.jobs.create(payload);
          toast(
            `Đã tạo chiến dịch với ${r.preview.items} lượt đăng${payload.dryRun ? ' (chế độ thử)' : ''}`,
            'ok',
            7000,
          );
          closeModal();
          onDone();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
        }
      });
    },
  });
}
