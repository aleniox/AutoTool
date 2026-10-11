import { api } from '../api.js';
import {
  esc, $, toast, openModal, closeModal, confirmDialog, statusBadge,
  platformTag, fmtRelative, emptyState, truncate,
} from '../ui.js';

export const title = 'Tài khoản';

let platforms = [];
let projects = [];

export async function render(root) {
  [platforms, projects] = await Promise.all([
    api.platforms().then((r) => r.platforms),
    api.projects.list().then((r) => r.projects).catch(() => []),
  ]);

  $('#viewActions').innerHTML = `
    <button class="primary" id="addAccount">+ Thêm tài khoản</button>`;

  let alive = true;

  async function draw() {
    const { accounts } = await api.accounts.list();
    if (!alive) return;

    root.innerHTML = `
      <div class="note info">
        Tool <strong>không lưu mật khẩu</strong>. Khi bấm "Đăng nhập", một cửa sổ trình duyệt sẽ mở ra để bạn
        đăng nhập thủ công (kể cả 2FA). Sau đó phiên đăng nhập được lưu trong profile riêng của từng tài khoản
        tại <code>data/profiles/</code>.
      </div>

      ${accounts.length ? accountsTable(accounts) : emptyState('👤', 'Chưa có tài khoản nào', 'Bấm "+ Thêm tài khoản" để bắt đầu.')}
    `;

    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn, draw));
    });
  }

  $('#addAccount').addEventListener('click', () => accountModal(null, draw));

  await draw();
  return () => {
    alive = false;
  };
}

function accountsTable(accounts) {
  return `<div class="table-wrap"><table>
    <thead>
      <tr>
        <th>Nền tảng</th><th>Tài khoản</th><th>Trạng thái</th>
        <th class="num">Hôm nay</th><th class="num">Nhóm</th>
        <th>Nhịp đăng</th><th>Kiểm tra lần cuối</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${accounts.map(accountRow).join('')}
    </tbody>
  </table></div>`;
}

function accountRow(a) {
  const color = platformColor(a.platform);
  const needsLogin = a.status !== 'logged_in';
  const todayPct = a.daily_limit ? Math.min(100, ((a.posted_today ?? 0) / a.daily_limit) * 100) : 0;

  return `<tr>
    <td>${platformTag(a.platformName ?? a.platform, color)}</td>
    <td>
      <strong>${esc(a.label)}</strong>
      ${a.browserOpen ? ' <span class="badge ok" title="Trình duyệt đang mở">●</span>' : ''}
      ${a.project_name ? `<div class="tiny muted">${esc(a.project_name)}</div>` : ''}
    </td>
    <td>
      ${statusBadge(a.status)}
      ${a.status_message ? `<div class="tiny muted" style="max-width:220px">${esc(truncate(a.status_message, 70))}</div>` : ''}
    </td>
    <td class="num" style="min-width:96px">
      ${a.posted_today ?? 0} / ${a.daily_limit || '∞'}
      <div class="progress" style="margin-top:4px"><i class="p-ok" style="width:${todayPct}%"></i></div>
    </td>
    <td class="num">${a.enabled_target_count ?? 0}/${a.target_count ?? 0}</td>
    <td class="tiny">${a.min_delay_sec}–${a.max_delay_sec}s</td>
    <td class="tiny muted">${esc(fmtRelative(a.last_check_at))}</td>
    <td class="actions">
      <button class="sm ${needsLogin ? 'primary' : ''}" data-act="login" data-id="${a.id}">Đăng nhập</button>
      <button class="sm" data-act="check" data-id="${a.id}">Kiểm tra</button>
      <button class="sm" data-act="edit" data-id="${a.id}">Sửa</button>
      <button class="sm danger" data-act="del" data-id="${a.id}" data-label="${esc(a.label)}">Xoá</button>
    </td>
  </tr>`;
}

async function handleAction(btn, draw) {
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  if (act === 'login') {
    btn.disabled = true;
    try {
      const r = await api.accounts.login(id);
      toast(r.message, 'info', 9000);
      setTimeout(() => {
        btn.disabled = false;
        draw();
      }, 2000);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
    return;
  }

  if (act === 'check') {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '…';
    try {
      const r = await api.accounts.check(id);
      const ok = r.result.status === 'logged_in';
      toast(`${ok ? 'OK' : 'Cần đăng nhập lại'}: ${r.result.message}`, ok ? 'ok' : 'warn', 7000);
    } catch (err) {
      toast(err.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = old;
    draw();
    return;
  }

  if (act === 'edit') {
    const { accounts } = await api.accounts.list();
    accountModal(accounts.find((a) => String(a.id) === String(id)), draw);
    return;
  }

  if (act === 'del') {
    const yes = await confirmDialog(
      `Xoá tài khoản "${btn.dataset.label}"? Toàn bộ nhóm và lịch sử đăng của tài khoản này cũng bị xoá.`,
      { title: 'Xoá tài khoản', danger: true, okLabel: 'Xoá' },
    );
    if (!yes) return;
    try {
      await api.accounts.remove(id);
      toast('Đã xoá tài khoản', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Modal them / sua tai khoan                                                 */
/* -------------------------------------------------------------------------- */

function accountModal(account, onDone) {
  const isEdit = !!account;
  const selected = account?.platform ?? platforms[0]?.id ?? 'facebook';

  openModal({
    title: isEdit ? `Sửa tài khoản: ${account.label}` : 'Thêm tài khoản mới',
    body: `
      ${
        isEdit
          ? `<div class="note">Nền tảng: <strong>${esc(platformName(account.platform))}</strong> (không đổi được)</div>`
          : `<label class="field"><span>Nền tảng <b>*</b></span>
               <select id="f-platform">
                 ${platforms
                   .map(
                     (p) =>
                       `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.experimental ? ' (thử nghiệm)' : ''}</option>`,
                   )
                   .join('')}
               </select>
             </label>`
      }

      <div id="platformNote"></div>

      <label class="field">
        <span>Tên gợi nhớ <b>*</b></span>
        <input type="text" id="f-label" placeholder="VD: Fanpage chính, TK cá nhân 1…"
               value="${esc(account?.label ?? '')}" />
      </label>

      <label class="field">
        <span>Dự án (tuỳ chọn)</span>
        <select id="f-project">
          <option value="">— Không thuộc dự án —</option>
          ${projects.map((p) => `<option value="${p.id}" ${account?.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>

      <div class="row">
        <label class="field">
          <span>Giới hạn bài / ngày</span>
          <input type="number" id="f-limit" min="0" value="${esc(account?.daily_limit ?? 15)}" />
        </label>
        <label class="field">
          <span>Nghỉ tối thiểu (giây)</span>
          <input type="number" id="f-min" min="0" value="${esc(account?.min_delay_sec ?? 120)}" />
        </label>
        <label class="field">
          <span>Nghỉ tối đa (giây)</span>
          <input type="number" id="f-max" min="0" value="${esc(account?.max_delay_sec ?? 360)}" />
        </label>
      </div>

      <label class="check">
        <input type="checkbox" id="f-enabled" ${account?.enabled === 0 ? '' : 'checked'} />
        Bật tài khoản này (tắt để tạm dừng mọi hoạt động đăng bài)
      </label>
    `,
    footer: `
      <button data-modal-close>Huỷ</button>
      <button class="primary" id="f-save">${isEdit ? 'Lưu thay đổi' : 'Tạo tài khoản'}</button>
    `,
    onMount(modal) {
      const noteBox = modal.querySelector('#platformNote');
      const select = modal.querySelector('#f-platform');

      const showNote = (pid) => {
        const p = platforms.find((x) => x.id === pid);
        if (!p) {
          noteBox.innerHTML = '';
          return;
        }
        noteBox.innerHTML = `
          <div class="note ${p.experimental ? 'danger' : ''}">
            <strong>${esc(p.name)}</strong>${p.experimental ? ' — <em>thử nghiệm, selector có thể cần chỉnh</em>' : ''}
            <div class="tiny mt">${esc(p.notes || '')}</div>
            <div class="tiny mt">Hỗ trợ: ${esc((p.kinds ?? []).map((k) => k.label).join(', ') || 'trang cá nhân')}
              · Tối đa ${p.limits?.maxChars || '∞'} ký tự</div>
          </div>`;
      };

      if (select) {
        showNote(select.value);
        select.addEventListener('change', () => showNote(select.value));
      } else {
        showNote(account.platform);
      }

      modal.querySelector('#f-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const payload = {
          label: modal.querySelector('#f-label').value.trim(),
          projectId: modal.querySelector('#f-project').value || null,
          dailyLimit: Number(modal.querySelector('#f-limit').value),
          minDelaySec: Number(modal.querySelector('#f-min').value),
          maxDelaySec: Number(modal.querySelector('#f-max').value),
          enabled: modal.querySelector('#f-enabled').checked,
        };
        if (!payload.label) return toast('Nhập tên gợi nhớ', 'warn');
        if (payload.maxDelaySec < payload.minDelaySec) {
          return toast('Nghỉ tối đa phải lớn hơn hoặc bằng tối thiểu', 'warn');
        }
        if (!isEdit) payload.platform = modal.querySelector('#f-platform').value;

        btn.disabled = true;
        try {
          if (isEdit) {
            await api.accounts.update(account.id, payload);
            toast('Đã lưu thay đổi', 'ok');
          } else {
            const created = await api.accounts.create(payload);
            toast('Đã tạo tài khoản. Bấm "Đăng nhập" để mở trình duyệt.', 'ok', 7000);
            if (created.target) {
              toast(`Đã tạo sẵn mục tiêu "${created.target.name}" cho ${platformName(payload.platform)}`, 'info');
            }
          }
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

const platformName = (id) => platforms.find((p) => p.id === id)?.name ?? id;
const platformColor = (id) => platforms.find((p) => p.id === id)?.color ?? '#888';
