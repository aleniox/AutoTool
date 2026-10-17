import { api } from '../api.js';
import {
  esc, $, toast, openModal, closeModal, confirmDialog, statusBadge,
  platformTag, fmtRelative, emptyState, truncate,
} from '../ui.js';

export const title = 'Nhóm & Trang';

let platforms = [];
let accounts = [];
let filterAccount = '';

export async function render(root) {
  const [p, a] = await Promise.all([api.platforms(), api.accounts.list()]);
  platforms = p.platforms;
  accounts = a.accounts;

  $('#viewActions').innerHTML = `
    <button id="importTargets">📥 Import danh sách</button>
    <button class="primary" id="addTarget">+ Thêm nhóm / trang</button>`;

  let alive = true;

  $('#addTarget').addEventListener('click', () => targetModal(null, draw));
  $('#importTargets').addEventListener('click', () => importModal(draw));

  async function draw() {
    const { targets } = await api.targets.list({ accountId: filterAccount || undefined });
    if (!alive) return;

    const byAccount = new Map();
    for (const t of targets) {
      if (!byAccount.has(t.account_id)) byAccount.set(t.account_id, []);
      byAccount.get(t.account_id).push(t);
    }

    root.innerHTML = `
      ${
        accounts.length
          ? `<div class="card">
              <div class="row tight">
                <label class="field" style="flex:0 0 280px;margin:0">
                  <span>Lọc theo tài khoản</span>
                  <select id="filterAccount">
                    <option value="">— Tất cả tài khoản (${targets.length} mục tiêu) —</option>
                    ${accounts
                      .map(
                        (acc) =>
                          `<option value="${acc.id}" ${String(filterAccount) === String(acc.id) ? 'selected' : ''}>${esc(acc.label)} · ${esc(platformName(acc.platform))}</option>`,
                      )
                      .join('')}
                  </select>
                </label>
                <div class="spacer"></div>
                <button class="sm danger" id="bulkDel" disabled>Xoá mục đã chọn</button>
              </div>
            </div>`
          : ''
      }

      ${
        !accounts.length
          ? emptyState('👤', 'Chưa có tài khoản', 'Cần tạo tài khoản trước khi thêm nhóm.')
          : !targets.length
            ? emptyState('👥', 'Chưa có nhóm / trang nào', 'Bấm "+ Thêm nhóm / trang" hoặc "Import danh sách" để dán hàng loạt.')
            : [...byAccount.entries()].map(([accId, list]) => accountGroup(accId, list)).join('')
      }
    `;

    const filter = root.querySelector('#filterAccount');
    if (filter) {
      filter.addEventListener('change', () => {
        filterAccount = filter.value;
        draw();
      });
    }

    const bulkBtn = root.querySelector('#bulkDel');
    const boxes = [...root.querySelectorAll('.target-check')];

    const refreshBulk = () => {
      const n = boxes.filter((b) => b.checked).length;
      bulkBtn.disabled = n === 0;
      bulkBtn.textContent = n ? `Xoá ${n} mục đã chọn` : 'Xoá mục đã chọn';
    };
    boxes.forEach((b) => b.addEventListener('change', refreshBulk));
    root.querySelectorAll('.check-all').forEach((master) => {
      const card = master.closest('.card');
      const own = [...card.querySelectorAll('.target-check')];
      master.addEventListener('change', () => {
        own.forEach((b) => {
          b.checked = master.checked;
        });
        refreshBulk();
      });
    });

    bulkBtn?.addEventListener('click', async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.id));
      const yes = await confirmDialog(`Xoá ${ids.length} nhóm / trang đã chọn?`, {
        title: 'Xoá hàng loạt',
        danger: true,
        okLabel: 'Xoá',
      });
      if (!yes) return;
      try {
        const r = await api.targets.removeBulk(ids);
        toast(`Đã xoá ${r.deleted} mục`, 'ok');
        draw();
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => handle(btn, draw));
    });
  }

  await draw();
  return () => {
    alive = false;
  };
}

function accountGroup(accountId, list) {
  const acc = accounts.find((a) => a.id === accountId);
  const enabled = list.filter((t) => t.enabled).length;
  return `
    <div class="card">
      <div class="section-title">
        <h2>${platformTag(acc ? platformName(acc.platform) : '?', acc ? platformColor(acc.platform) : '#888')}
          ${esc(acc?.label ?? `Tài khoản #${accountId}`)}</h2>
        <span class="badge muted">${enabled}/${list.length} đang bật</span>
        <div class="spacer"></div>
        <label class="check tiny"><input type="checkbox" class="check-all" /> Chọn tất cả</label>
      </div>
      <div class="table-wrap"><table>
        <thead>
          <tr>
            <th style="width:34px"></th><th>Tên</th><th>Loại</th><th>ID / URL</th>
            <th>Đăng gần nhất</th><th>Bật</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map(
              (t) => `<tr>
            <td><input type="checkbox" class="target-check" data-id="${t.id}" /></td>
            <td><strong>${esc(truncate(t.name, 44))}</strong></td>
            <td><span class="badge muted">${esc(t.kindLabel ?? t.kind)}</span></td>
            <td class="tiny mono muted">${esc(truncate(t.external_id || t.url, 40))}</td>
            <td class="tiny muted">${esc(fmtRelative(t.last_post_at))}</td>
            <td>
              <label class="check"><input type="checkbox" data-act="toggle" data-id="${t.id}" ${t.enabled ? 'checked' : ''} /></label>
            </td>
            <td class="actions">
              <button class="sm" data-act="edit" data-id="${t.id}">Sửa</button>
              <button class="sm danger" data-act="del" data-id="${t.id}" data-name="${esc(t.name)}">Xoá</button>
            </td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>
    </div>`;
}

async function handle(btn, draw) {
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  if (act === 'toggle') {
    try {
      await api.targets.update(id, { enabled: btn.checked });
      toast(btn.checked ? 'Đã bật' : 'Đã tắt', 'ok', 1500);
    } catch (err) {
      toast(err.message, 'err');
      btn.checked = !btn.checked;
    }
    return;
  }

  if (act === 'edit') {
    const { targets } = await api.targets.list();
    const t = targets.find((x) => String(x.id) === String(id));
    targetModal(t, draw);
    return;
  }

  if (act === 'del') {
    const yes = await confirmDialog(`Xoá "${btn.dataset.name}"?`, { danger: true, okLabel: 'Xoá' });
    if (!yes) return;
    try {
      await api.targets.remove(id);
      toast('Đã xoá', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
}

/* -------------------------------------------------------------------------- */

function targetModal(target, onDone) {
  const isEdit = !!target;
  const acc = accounts.find((a) => a.id === (target?.account_id ?? accounts[0]?.id));
  const kinds = acc ? platformKinds(acc.platform) : [{ kind: 'group', label: 'Nhóm' }];

  openModal({
    title: isEdit ? `Sửa: ${target.name}` : 'Thêm nhóm / trang',
    body: `
      ${
        isEdit
          ? ''
          : `<label class="field"><span>Tài khoản <b>*</b></span>
              <select id="t-account">
                ${accounts
                  .map(
                    (a) =>
                      `<option value="${a.id}">${esc(a.label)} · ${esc(platformName(a.platform))}</option>`,
                  )
                  .join('')}
              </select>
            </label>`
      }

      <label class="field">
        <span>URL nhóm / trang</span>
        <input type="text" id="t-url" placeholder="https://www.facebook.com/groups/123456789"
               value="${esc(target?.url ?? '')}" />
        <div class="tiny muted mt">Dán URL vào đây, tool sẽ tự nhận diện loại và ID.</div>
      </label>

      <label class="field">
        <span>Tên hiển thị <b>*</b></span>
        <input type="text" id="t-name" placeholder="VD: Nhóm Mua Bán Đồ Cũ" value="${esc(target?.name ?? '')}" />
      </label>

      <div class="row">
        <label class="field">
          <span>Loại</span>
          <select id="t-kind">
            ${kinds.map((k) => `<option value="${k.kind}" ${target?.kind === k.kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>ID nền tảng</span>
          <input type="text" id="t-ext" placeholder="Tự động lấy từ URL" value="${esc(target?.external_id ?? '')}" />
        </label>
      </div>

      <label class="check"><input type="checkbox" id="t-enabled" ${target?.enabled === 0 ? '' : 'checked'} /> Bật mục tiêu này</label>
    `,
    footer: `<button data-modal-close>Huỷ</button><button class="primary" id="t-save">${isEdit ? 'Lưu' : 'Thêm'}</button>`,
    onMount(modal) {
      const accSel = modal.querySelector('#t-account');
      const kindSel = modal.querySelector('#t-kind');

      if (accSel) {
        accSel.addEventListener('change', () => {
          const a = accounts.find((x) => String(x.id) === accSel.value);
          kindSel.innerHTML = platformKinds(a?.platform)
            .map((k) => `<option value="${k.kind}">${esc(k.label)}</option>`)
            .join('');
        });
      }

      modal.querySelector('#t-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const url = modal.querySelector('#t-url').value.trim();
        const name = modal.querySelector('#t-name').value.trim();
        if (!name && !url) return toast('Nhập URL hoặc tên', 'warn');

        const payload = {
          name: name || url,
          url,
          kind: kindSel.value,
          externalId: modal.querySelector('#t-ext').value.trim(),
          enabled: modal.querySelector('#t-enabled').checked,
        };

        btn.disabled = true;
        try {
          if (isEdit) {
            await api.targets.update(target.id, payload);
            toast('Đã lưu', 'ok');
          } else {
            payload.accountId = Number(accSel.value);
            const r = await api.targets.create(payload);
            toast(
              r.parsed ? `Đã thêm (nhận diện: ${r.parsed.kind} · ${r.parsed.externalId})` : 'Đã thêm',
              'ok',
            );
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

/* -------------------------------------------------------------------------- */

function importModal(onDone) {
  const importable = accounts;

  openModal({
    title: 'Import danh sách nhóm / trang',
    wide: true,
    body: `
      <div class="note">
        Mỗi dòng một nhóm. Hỗ trợ 3 dạng:
        <pre>https://www.facebook.com/groups/123456789
https://www.facebook.com/groups/123456789 | Nhóm Mua Bán
Nhóm Mua Bán | https://www.facebook.com/groups/123456789</pre>
        Dòng bắt đầu bằng <code>#</code> sẽ bị bỏ qua.
      </div>

      <div class="row">
        <label class="field">
          <span>Tài khoản nhận danh sách <b>*</b></span>
          <select id="i-account">
            ${importable
              .map(
                (a) => `<option value="${a.id}">${esc(a.label)} · ${esc(platformName(a.platform))}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label class="field">
          <span>Ép loại (tuỳ chọn)</span>
          <select id="i-kind">
            <option value="auto">Tự nhận diện từ URL</option>
            <option value="group">Nhóm (Group)</option>
            <option value="page">Trang (Page)</option>
            <option value="profile">Trang cá nhân (Profile)</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span>Danh sách URL</span>
        <textarea id="i-text" class="mono" rows="12" placeholder="https://www.facebook.com/groups/123456789&#10;https://www.facebook.com/groups/987654321 | Nhóm khác"></textarea>
      </label>

      <div id="i-result"></div>
    `,
    footer: `
      <button data-modal-close>Đóng</button>
      <button id="i-preview">Xem trước</button>
      <button class="primary" id="i-import">Import</button>
    `,
    onMount(modal) {
      const result = modal.querySelector('#i-result');

      modal.querySelector('#i-preview').addEventListener('click', async () => {
        const text = modal.querySelector('#i-text').value.trim();
        if (!text) return toast('Chưa dán danh sách', 'warn');
        const urls = text
          .split(/\r?\n/)
          .map((l) => l.split('|')[0].trim())
          .filter((l) => l && !l.startsWith('#'));
        const acc = accounts.find((a) => String(a.id) === modal.querySelector('#i-account').value);
        const r = await api.resolveUrls(urls, acc?.platform);
        const ok = r.results.filter((x) => x.parsed);
        const bad = r.results.filter((x) => !x.parsed);
        result.innerHTML = `
          <div class="note ${bad.length ? 'danger' : 'info'}">
            Nhận diện được <strong>${ok.length}</strong>/${r.results.length} dòng.
            ${bad.length ? `<br>Không nhận diện được ${bad.length} dòng (sẽ bị bỏ qua).` : ''}
          </div>
          ${
            ok.length
              ? `<div class="table-wrap" style="max-height:220px;overflow:auto"><table>
                   <thead><tr><th>Loại</th><th>ID</th><th>URL</th></tr></thead>
                   <tbody>${ok.map((x) => `<tr><td>${esc(x.parsed.kind)}</td><td class="mono tiny">${esc(x.parsed.externalId)}</td><td class="tiny muted">${esc(truncate(x.url, 60))}</td></tr>`).join('')}</tbody>
                 </table></div>`
              : ''
          }`;
      });

      modal.querySelector('#i-import').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const text = modal.querySelector('#i-text').value.trim();
        if (!text) return toast('Chưa dán danh sách', 'warn');

        btn.disabled = true;
        try {
          const r = await api.targets.import({
            accountId: Number(modal.querySelector('#i-account').value),
            kind: modal.querySelector('#i-kind').value,
            text,
          });
          toast(`Đã import ${r.imported.length} mục, bỏ qua ${r.skipped.length}`, 'ok', 7000);
          if (r.skipped.length) {
            result.innerHTML = `<div class="note danger"><strong>Bỏ qua ${r.skipped.length} dòng:</strong>
              <ul>${r.skipped.slice(0, 12).map((s) => `<li class="tiny">${esc(truncate(s.line, 70))} — ${esc(s.reason)}</li>`).join('')}</ul>
              ${r.skipped.length > 12 ? `<div class="tiny">… và ${r.skipped.length - 12} dòng khác</div>` : ''}
            </div>`;
          } else {
            closeModal();
          }
          onDone();
        } catch (err) {
          toast(err.message, 'err');
        }
        btn.disabled = false;
      });
    },
  });
}

const platformName = (id) => platforms.find((p) => p.id === id)?.name ?? id;
const platformColor = (id) => platforms.find((p) => p.id === id)?.color ?? '#888';
const platformKinds = (id) =>
  platforms.find((p) => p.id === id)?.kinds ?? [{ kind: 'group', label: 'Nhóm' }];
