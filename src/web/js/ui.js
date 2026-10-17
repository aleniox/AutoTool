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

const modalStack = [];

export function openModal({ title, body, footer = '', wide = false, onMount }) {
  const root = $('#modalRoot');
  root.hidden = false;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const zIdx = 100 + modalStack.length * 10;
  backdrop.style.zIndex = String(zIdx);
  if (modalStack.length > 0) {
    backdrop.style.background = 'rgba(0,0,0,0.75)';
  }

  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <header>
        <h3>${esc(title)}</h3>
        <button class="close" data-modal-close aria-label="Đóng">&times;</button>
      </header>
      <div class="body">${body}</div>
      ${footer ? `<footer>${footer}</footer>` : ''}
    </div>`;

  const modalEl = backdrop.querySelector('.modal');
  let cleanup = null;

  const closeThis = () => closeModal(modalEl);

  backdrop.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeThis));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeThis();
  });

  const entry = {
    backdrop,
    modalEl,
    get cleanup() { return cleanup; },
    set cleanup(fn) { cleanup = fn; },
  };
  modalStack.push(entry);
  root.appendChild(backdrop);

  document.onkeydown = (e) => {
    if (e.key === 'Escape') closeModal();
  };

  if (onMount) {
    cleanup = onMount(modalEl) ?? null;
  }
  return modalEl;
}

export function closeModal(targetModal = null) {
  const root = $('#modalRoot');
  if (!modalStack.length) return;

  let idx = modalStack.length - 1;
  if (targetModal) {
    const found = modalStack.findIndex((m) => m.modalEl === targetModal || m.backdrop === targetModal);
    if (found !== -1) idx = found;
  }

  const [item] = modalStack.splice(idx, 1);
  if (item) {
    if (typeof item.cleanup === 'function') {
      try { item.cleanup(); } catch (err) { console.error(err); }
    }
    item.backdrop.remove();
  }

  if (modalStack.length === 0) {
    root.hidden = true;
    root.innerHTML = '';
    document.onkeydown = null;
  }
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
      closeModal(modal);
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
