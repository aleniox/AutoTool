/** Tien ich UI: escape, toast, modal, format. */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* -------------------------------- Toasts -------------------------------- */

export function toast(message, kind = 'info', ms = 4200) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* -------------------------------- Modal --------------------------------- */

let modalCleanup = null;

export function openModal({ title, body, footer = '', wide = false, onMount }) {
  const root = $('#modalRoot');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <header>
        <h3>${esc(title)}</h3>
        <button class="close" data-modal-close aria-label="Đóng">&times;</button>
      </header>
      <div class="body">${body}</div>
      ${footer ? `<footer>${footer}</footer>` : ''}
    </div>`;

  const close = () => closeModal();
  root.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
  root.onclick = (e) => {
    if (e.target === root) close();
  };
  document.onkeydown = (e) => {
    if (e.key === 'Escape') close();
  };
  if (onMount) modalCleanup = onMount(root.querySelector('.modal')) ?? null;
  return root.querySelector('.modal');
}

export function closeModal() {
  const root = $('#modalRoot');
  if (typeof modalCleanup === 'function') modalCleanup();
  modalCleanup = null;
  root.hidden = true;
  root.innerHTML = '';
  root.onclick = null;
  document.onkeydown = null;
}

export function confirmDialog(message, { title = 'Xác nhận', danger = false, okLabel = 'Đồng ý' } = {}) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `<p style="margin:0">${esc(message)}</p>`,
      footer: `<button data-modal-close>Huỷ</button>
               <button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>`,
    });
    modal.querySelector('[data-ok]').addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
    modal.querySelectorAll('[data-modal-close]').forEach((b) =>
      b.addEventListener('click', () => resolve(false)),
    );
    modal.parentElement.addEventListener('click', (e) => {
      if (e.target === modal.parentElement) resolve(false);
    });
  });
}

/* -------------------------------- Format -------------------------------- */

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = withTime
    ? { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return d.toLocaleString('vi-VN', opts);
}

export function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const fut = diff < 0;
  const units = [
    [86400000, 'ngày'],
    [3600000, 'giờ'],
    [60000, 'phút'],
    [1000, 'giây'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return fut ? `sau ${n} ${label}` : `${n} ${label} trước`;
    }
  }
  return 'vừa xong';
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function truncate(s, n = 70) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

/* -------------------------------- Badges -------------------------------- */

const STATUS_MAP = {
  new: ['muted', 'Mới'],
  pending_login: ['warn', 'Chờ đăng nhập'],
  awaiting_login: ['warn', 'Chờ đăng nhập'],
  logged_in: ['ok', 'Đã đăng nhập'],
  expired: ['err', 'Hết phiên'],
  error: ['err', 'Lỗi'],
  unknown: ['muted', 'Chưa rõ'],
  scheduled: ['info', 'Đã lên lịch'],
  running: ['accent', 'Đang chạy'],
  paused: ['warn', 'Tạm dừng'],
  done: ['ok', 'Hoàn tất'],
  failed: ['err', 'Thất bại'],
  canceled: ['muted', 'Đã huỷ'],
  success: ['ok', 'Thành công'],
  pending: ['muted', 'Chờ'],
  skipped: ['warn', 'Bỏ qua'],
};

export const statusBadge = (status) => {
  const [kind, label] = STATUS_MAP[status] ?? ['muted', status ?? '—'];
  return `<span class="badge ${kind}">${esc(label)}</span>`;
};

export const platformTag = (name, color) =>
  `<span class="platform-tag"><i style="background:${esc(color || '#888')}"></i>${esc(name || '')}</span>`;

/* -------------------------------- Misc ---------------------------------- */

export function spinner(label = 'Đang tải…') {
  return `<div class="empty"><div class="big">⏳</div>${esc(label)}</div>`;
}

export function emptyState(icon, title, hint = '') {
  return `<div class="empty"><div class="big">${icon}</div><div><strong>${esc(title)}</strong></div>${
    hint ? `<div class="tiny mt">${esc(hint)}</div>` : ''
  }</div>`;
}

/** Nap file CSS/JS dong. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Dinh dang datetime-local value tu Date. */
export function toLocalInput(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
