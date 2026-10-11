import { api } from '../api.js';
import { esc, $, toast, emptyState } from '../ui.js';

export const title = 'Nhật ký';

let level = 'all';

export async function render(root) {
  let alive = true;

  $('#viewActions').innerHTML = `
    <button id="clearLogs" class="danger">Xoá nhật ký</button>`;

  $('#clearLogs').addEventListener('click', async () => {
    try {
      await api.clearLogs();
      toast('Đã xoá nhật ký', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  async function draw() {
    const { logs } = await api.logs({ level, limit: 400 });
    if (!alive) return;

    root.innerHTML = `
      <div class="card">
        <div class="row tight mb">
          <label class="field" style="flex:0 0 200px;margin:0">
            <span>Mức độ</span>
            <select id="level">
              ${['all', 'info', 'warn', 'error', 'debug']
                .map((l) => `<option value="${l}" ${level === l ? 'selected' : ''}>${
                  { all: 'Tất cả', info: 'Thông tin', warn: 'Cảnh báo', error: 'Lỗi', debug: 'Gỡ lỗi' }[l]
                }</option>`)
                .join('')}
            </select>
          </label>
          <div class="spacer"></div>
          <div class="tiny muted" style="align-self:center">
            ${logs.length} dòng · tự động làm mới mỗi 4 giây
          </div>
        </div>

        ${
          logs.length
            ? `<div class="log-box">${logs.map(logLine).join('')}</div>`
            : emptyState('🧾', 'Chưa có nhật ký nào')
        }
      </div>
    `;

    root.querySelector('#level').addEventListener('change', (e) => {
      level = e.target.value;
      draw();
    });
  }

  await draw();
  const timer = setInterval(draw, 4000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

function logLine(l) {
  const time = new Date(l.ts).toLocaleTimeString('vi-VN');
  return `<div class="log-line ${esc(l.level)}">
    <span class="ts">${esc(time)}</span>
    <span class="lvl">${esc(l.level.toUpperCase())}</span>
    <span class="msg">${l.scope ? `<span class="muted">[${esc(l.scope)}]</span> ` : ''}${esc(l.message)}</span>
  </div>`;
}
