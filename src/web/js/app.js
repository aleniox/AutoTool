import { api } from './api.js';
import { $, toast } from './ui.js';

import * as dashboard from './views/dashboard.js';
import * as accounts from './views/accounts.js';
import * as targets from './views/targets.js';
import * as posts from './views/posts.js';
import * as jobs from './views/jobs.js';
import * as calendar from './views/calendar.js';
import * as reports from './views/reports.js';
import * as logs from './views/logs.js';
import * as help from './views/help.js';

const routes = { dashboard, accounts, targets, posts, jobs, calendar, reports, logs, help };

let cleanup = null;
let healthTimer = null;

/* -------------------------------------------------------------------------- */
/* Health polling                                                             */
/* -------------------------------------------------------------------------- */

async function pollHealth() {
  const pill = $('#workerPill');
  const text = $('#workerText');
  try {
    const h = await api.health();
    const w = h.worker ?? {};
    const busy = (w.running ?? 0) > 0;
    pill.className = `worker-pill ${busy ? 'busy' : 'idle'}`;
    text.textContent = busy
      ? `Đang đăng bài (${w.running}/${w.concurrency})`
      : 'Sẵn sàng';
    $('#healthText').textContent = `${h.browser?.channel ?? '?'} · ${h.dataDir ?? ''}`;
  } catch (err) {
    pill.className = 'worker-pill down';
    text.textContent = 'Mất kết nối';
    $('#healthText').textContent = err.message;
  }
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

async function navigate() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...params] = raw.split('/');
  const view = routes[name] ?? routes.dashboard;
  const viewName = routes[name] ? name : 'dashboard';

  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }

  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === viewName);
  });

  const root = $('#view');
  $('#viewTitle').textContent = view.title ?? '';
  $('#viewActions').innerHTML = '';
  root.innerHTML = `<div class="empty"><div class="big">⏳</div>Đang tải…</div>`;

  try {
    cleanup = (await view.render(root, params)) ?? null;
  } catch (err) {
    root.innerHTML = `<div class="card"><h2>Không tải được trang</h2><p class="muted">${err.message}</p></div>`;
    toast(err.message, 'err');
  }
}

/* -------------------------------------------------------------------------- */

window.addEventListener('hashchange', navigate);
window.addEventListener('DOMContentLoaded', () => {
  pollHealth();
  healthTimer = setInterval(pollHealth, 4000);
  navigate();
});

export { navigate, pollHealth };
