import { api } from '../api.js';
import {
  esc, $, toast, openModal, closeModal, confirmDialog, emptyState, truncate, fmtDate, fmtBytes,
} from '../ui.js';

export const title = 'Bài viết';

let projects = [];

export async function render(root) {
  projects = await api.projects.list().then((r) => r.projects).catch(() => []);

  $('#viewActions').innerHTML = `
    <button class="secondary" id="openAiAssistant">✨ Trợ lý AI</button>
    <button id="importPosts">📥 Import nhiều bài</button>
    <button class="primary" id="addPost">+ Tạo bài viết</button>`;

  let alive = true;

  $('#addPost').addEventListener('click', () => postModal(null, draw));
  $('#importPosts').addEventListener('click', () => importModal(draw));
  $('#openAiAssistant').addEventListener('click', () => aiAssistantModal({ onDone: draw }));

  async function draw() {
    const [{ posts }, { files }] = await Promise.all([api.posts.list(), api.media.list()]);
    if (!alive) return;

    root.innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h2>Bài viết (${posts.length})</h2>
          <div class="sub mb">Nội dung sẽ được đăng lên các nhóm / trang bạn chọn trong chiến dịch</div>
          ${posts.length ? postsTable(posts) : emptyState('📝', 'Chưa có bài viết nào', 'Bấm "+ Tạo bài viết" hoặc "Import nhiều bài".')}
        </div>

        <div class="card">
          <h2>Thư viện ảnh / video (${files.length})</h2>
          <div class="sub mb">Upload một lần, dùng cho nhiều bài viết</div>
          <div class="dropzone" id="dropzone">
            <div>📁 Kéo thả file vào đây hoặc <strong>bấm để chọn</strong></div>
            <div class="tiny mt">Ảnh: jpg, png, gif, webp · Video: mp4, mov, webm · Tối đa 64MB/file</div>
          </div>
          <input type="file" id="fileInput" multiple accept="image/*,video/*" hidden />
          ${files.length ? `<div class="media-grid mt">${files.map(mediaTile).join('')}</div>` : ''}
        </div>
      </div>
    `;

    bindUpload(root, draw);

    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => handle(btn, draw));
    });
  }

  await draw();
  return () => {
    alive = false;
  };
}

/* -------------------------------------------------------------------------- */
/* Bai viet                                                                   */
/* -------------------------------------------------------------------------- */

function postsTable(posts) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Tiêu đề</th><th>Nội dung</th><th class="num">Media</th><th>Ngày tạo</th><th></th></tr></thead>
    <tbody>
      ${posts
        .map(
          (p) => `<tr>
        <td><strong>${esc(truncate(p.title || '(không tiêu đề)', 32))}</strong>
          ${p.link ? `<div class="tiny"><a href="${esc(p.link)}" target="_blank" rel="noopener">link</a></div>` : ''}
        </td>
        <td class="tiny muted" style="max-width:280px">${esc(truncate(p.caption, 90))}</td>
        <td class="num">${p.media?.length ?? 0}</td>
        <td class="tiny muted">${esc(fmtDate(p.created_at, false))}</td>
        <td class="actions">
          <button class="sm" data-act="edit" data-id="${p.id}">Sửa</button>
          <button class="sm danger" data-act="del" data-id="${p.id}" data-title="${esc(p.title || p.id)}">Xoá</button>
        </td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table></div>`;
}

function mediaTile(f) {
  const isImage = f.type === 'image';
  return `<div class="media-item ${isImage ? '' : 'video'}" title="${esc(f.name)}">
    ${isImage ? `<img src="${esc(f.url)}" loading="lazy" alt="" />` : '🎬'}
    <div class="name">${esc(truncate(f.name, 22))}</div>
  </div>`;
}

async function handle(btn, draw) {
  const id = btn.dataset.id;
  if (btn.dataset.act === 'edit') {
    const { post } = await api.posts.get(id);
    postModal(post, draw);
    return;
  }
  if (btn.dataset.act === 'del') {
    const yes = await confirmDialog(`Xoá bài viết "${btn.dataset.title}"?`, { danger: true, okLabel: 'Xoá' });
    if (!yes) return;
    try {
      await api.posts.remove(id);
      toast('Đã xoá bài viết', 'ok');
      draw();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Upload media                                                               */
/* -------------------------------------------------------------------------- */

function bindUpload(root, onDone) {
  const dz = root.querySelector('#dropzone');
  const input = root.querySelector('#fileInput');
  if (!dz || !input) return;

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => uploadFiles([...input.files], onDone));

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    }),
  );
  dz.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files], onDone));
}

export async function uploadFiles(files, onDone) {
  if (!files.length) return;
  let ok = 0;
  for (const file of files) {
    try {
      await api.media.upload(file);
      ok += 1;
    } catch (err) {
      toast(`Lỗi upload ${file.name}: ${err.message}`, 'err');
    }
  }
  if (ok) toast(`Đã upload ${ok}/${files.length} file`, 'ok');
  onDone?.();
}

/* -------------------------------------------------------------------------- */
/* Modal tao / sua bai viet                                                   */
/* -------------------------------------------------------------------------- */

async function postModal(post, onDone) {
  const isEdit = !!post;
  const { files } = await api.media.list();
  const selected = new Set((post?.media ?? []).map((m) => m.name));

  openModal({
    title: isEdit ? 'Sửa bài viết' : 'Tạo bài viết mới',
    wide: true,
    body: `
      <div class="row">
        <label class="field" style="flex:2 1 320px">
          <span>Tiêu đề</span>
          <input type="text" id="p-title" value="${esc(post?.title ?? '')}" placeholder="Tiêu đề bài viết" />
        </label>
        <label class="field">
          <span>Dự án</span>
          <select id="p-project">
            <option value="">— Không —</option>
            ${projects.map((p) => `<option value="${p.id}" ${post?.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
      </div>

      <label class="field">
        <div class="row tight" style="align-items:center; justify-content:space-between; margin-bottom:5px">
          <span>Nội dung <b>*</b></span>
          <div style="display:flex; gap:6px">
            <button type="button" class="sm secondary" id="btnAiRewrite" title="Dùng AI viết lại hoặc trau chuốt nội dung này">✨ Viết lại</button>
            <button type="button" class="sm secondary" id="btnAiGenerate" title="Mở trợ lý AI để soạn bài mới">✨ Soạn bằng AI</button>
          </div>
        </div>
        <textarea id="p-caption" rows="7" placeholder="Nội dung bài đăng…">${esc(post?.caption ?? '')}</textarea>
      </label>

      <div class="row">
        <label class="field">
          <span>Link đính kèm</span>
          <input type="text" id="p-link" value="${esc(post?.link ?? '')}" placeholder="https://…" />
        </label>
        <label class="field">
          <span>Hashtag</span>
          <input type="text" id="p-hashtags" value="${esc(post?.hashtags ?? '')}" placeholder="#khuyenmai #muaban" />
        </label>
      </div>

      <label class="field">
        <span>Ảnh / video đính kèm <span id="mediaCount" class="muted"></span></span>
        <div class="dropzone" id="p-dropzone">📁 Kéo thả hoặc bấm để upload thêm</div>
        <input type="file" id="p-file" multiple accept="image/*,video/*" hidden />
      </label>

      <div class="media-grid" id="p-media">
        ${
          files.length
            ? files.map((f) => mediaPick(f, selected.has(f.name))).join('')
            : '<div class="muted tiny">Thư viện trống — hãy upload ảnh ở trên.</div>'
        }
      </div>
    `,
    footer: `<button data-modal-close>Huỷ</button><button class="primary" id="p-save">${isEdit ? 'Lưu' : 'Tạo bài viết'}</button>`,
    onMount(modal) {
      const grid = modal.querySelector('#p-media');
      const count = modal.querySelector('#mediaCount');
      const titleInput = modal.querySelector('#p-title');
      const captionInput = modal.querySelector('#p-caption');
      const hashtagsInput = modal.querySelector('#p-hashtags');

      modal.querySelector('#btnAiRewrite')?.addEventListener('click', () => {
        aiAssistantModal({
          mode: 'rewrite',
          initialCaption: captionInput.value,
          onApply(res) {
            if (res.title && !titleInput.value) titleInput.value = res.title;
            if (res.caption) captionInput.value = res.caption;
            if (res.hashtags) hashtagsInput.value = res.hashtags;
            toast('Đã điền nội dung AI vào form bài viết!', 'ok');
          },
        });
      });

      modal.querySelector('#btnAiGenerate')?.addEventListener('click', () => {
        aiAssistantModal({
          mode: 'generate',
          initialCaption: captionInput.value,
          onApply(res) {
            if (res.title) titleInput.value = res.title;
            if (res.caption) captionInput.value = res.caption;
            if (res.hashtags) hashtagsInput.value = res.hashtags;
            toast('Đã điền nội dung AI vào form bài viết!', 'ok');
          },
        });
      });

      const refreshCount = () => {
        count.textContent = `(đã chọn ${selected.size})`;
      };
      refreshCount();

      const bindPicks = () => {
        grid.querySelectorAll('.media-item').forEach((tile) => {
          tile.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return;
            const box = tile.querySelector('input');
            box.checked = !box.checked;
            tile.classList.toggle('selected', box.checked);
            if (box.checked) selected.add(box.value);
            else selected.delete(box.value);
            refreshCount();
          });
          const box = tile.querySelector('input');
          box.addEventListener('change', () => {
            tile.classList.toggle('selected', box.checked);
            if (box.checked) selected.add(box.value);
            else selected.delete(box.value);
            refreshCount();
          });
        });
      };
      bindPicks();

      const dz = modal.querySelector('#p-dropzone');
      const fileInput = modal.querySelector('#p-file');
      dz.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        await uploadFiles([...fileInput.files]);
        const fresh = await api.media.list();
        const known = new Set([...grid.querySelectorAll('input')].map((i) => i.value));
        for (const f of fresh.files.filter((x) => !known.has(x.name))) {
          grid.insertAdjacentHTML('beforeend', mediaPick(f, true));
          selected.add(f.name);
        }
        grid.querySelector('.muted')?.remove();
        bindPicks();
        refreshCount();
      });

      modal.querySelector('#p-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const payload = {
          title: modal.querySelector('#p-title').value.trim(),
          caption: modal.querySelector('#p-caption').value.trim(),
          link: modal.querySelector('#p-link').value.trim(),
          hashtags: modal.querySelector('#p-hashtags').value.trim(),
          projectId: modal.querySelector('#p-project').value || null,
          media: [...selected],
        };
        if (!payload.caption && !payload.title) return toast('Nhập tiêu đề hoặc nội dung', 'warn');

        btn.disabled = true;
        try {
          if (isEdit) await api.posts.update(post.id, payload);
          else await api.posts.create(payload);
          toast(isEdit ? 'Đã lưu bài viết' : 'Đã tạo bài viết', 'ok');
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

function mediaPick(f, checked) {
  const isImage = f.type === 'image';
  return `<div class="media-item ${checked ? 'selected' : ''}" title="${esc(f.name)}">
    ${isImage ? `<img src="${esc(f.url)}" loading="lazy" alt="" />` : '🎬'}
    <label class="pick"><input type="checkbox" value="${esc(f.name)}" ${checked ? 'checked' : ''} /></label>
    <div class="name">${esc(truncate(f.name, 22))} · ${esc(fmtBytes(f.size))}</div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Import nhieu bai                                                           */
/* -------------------------------------------------------------------------- */

function importModal(onDone) {
  openModal({
    title: 'Import nhiều bài viết',
    wide: true,
    body: `
      <div class="note">
        Mỗi bài cách nhau bằng một dòng <code>---</code>. Trong mỗi bài có thể có:
        <pre>Tiêu đề: Khuyến mãi tháng 12
Link: https://example.com/sale
Ảnh: 1700000-abc-anh1.jpg, 1700000-def-anh2.jpg
#khuyenmai #sale

Nội dung bài viết ở đây…
---
Tiêu đề: Bài số 2
Nội dung bài số 2…</pre>
        Nếu không ghi dòng <code>Ảnh:</code>, bài viết sẽ dùng ảnh theo lựa chọn bên dưới.
      </div>

      <label class="field">
        <span>Nội dung</span>
        <textarea id="imp-text" class="mono" rows="14" placeholder="Tiêu đề: Bài 1&#10;Nội dung bài 1&#10;---&#10;Tiêu đề: Bài 2&#10;Nội dung bài 2"></textarea>
      </label>

      <div class="row">
        <label class="field">
          <span>Dự án</span>
          <select id="imp-project">
            <option value="">— Không —</option>
            ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>Ảnh đính kèm</span>
          <select id="imp-media">
            <option value="none">Không đính kèm tự động</option>
            <option value="all">Đính kèm tất cả ảnh trong thư viện</option>
          </select>
        </label>
      </div>
    `,
    footer: `<button data-modal-close>Đóng</button><button class="primary" id="imp-go">Import</button>`,
    onMount(modal) {
      modal.querySelector('#imp-go').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const text = modal.querySelector('#imp-text').value.trim();
        if (!text) return toast('Chưa nhập nội dung', 'warn');

        btn.disabled = true;
        try {
          const attachMedia = modal.querySelector('#imp-media').value;
          const media = attachMedia === 'all' ? (await api.media.list()).files.map((f) => f.name) : [];
          const r = await api.posts.import({
            text,
            projectId: modal.querySelector('#imp-project').value || null,
            attachMedia,
            media,
          });
          toast(`Đã tạo ${r.posts.length} bài viết`, 'ok');
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
/* Modal Tro ly AI (Gemini)                                                  */
/* -------------------------------------------------------------------------- */

async function aiAssistantModal({ mode = 'generate', initialCaption = '', onApply = null, onDone = null } = {}) {
  let activeMode = mode;
  let currentResult = null;
  let activeVarIndex = 0;

  let aiSettings = await api.ai.getSettings().catch(() => ({
    activeProvider: 'gemini',
    hasKey: false,
    maskedKey: '',
    model: 'gemini-2.5-flash',
    providers: [
      { id: 'gemini', name: 'Google Gemini', badge: 'Gemini', defaultModel: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }], requiresKey: true },
      { id: 'openai', name: 'OpenAI (ChatGPT)', badge: 'ChatGPT', defaultModel: 'gpt-4o-mini', models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }], requiresKey: true },
      { id: 'deepseek', name: 'DeepSeek', badge: 'DeepSeek', defaultModel: 'deepseek-chat', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }], requiresKey: true },
      { id: 'claude', name: 'Anthropic Claude', badge: 'Claude', defaultModel: 'claude-3-5-haiku-20241022', models: [{ id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }], requiresKey: true },
      { id: 'custom', name: 'Tùy chỉnh (Ollama/Groq)', badge: 'Custom', defaultModel: 'llama3', models: [], requiresKey: false },
    ],
  }));

  const providers = aiSettings.providers || [];
  let currentPid = aiSettings.activeProvider || 'gemini';
  let activeProvider = providers.find((p) => p.id === currentPid) || providers[0] || { id: 'gemini', name: 'Google Gemini' };

  openModal({
    title: '✨ Trợ lý AI sáng tạo nội dung (Gemini, ChatGPT, DeepSeek...)',
    wide: true,
    body: `
      <div class="ai-key-box" id="aiKeyBox">
        <div class="row tight" style="align-items:center; gap:10px; flex-wrap:wrap">
          <label class="field" style="margin:0; min-width:180px; flex:1">
            <span style="font-weight:600">Nhà cung cấp AI</span>
            <select id="aiProviderSelect">
              ${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === currentPid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field" style="margin:0; min-width:220px; flex:1">
            <span style="font-weight:600">Mô hình (Model)</span>
            <select id="aiModelSelect"></select>
            <input type="text" id="aiCustomModelInput" style="display:none; margin-top:4px" placeholder="Nhập tên model (vd: llama3, qwen2.5:7b...)" />
          </label>
          <div style="margin-top:auto; padding-bottom:2px">
            <button type="button" class="sm ghost" id="btnToggleKeyInput">⚙️ Cấu hình API Key</button>
          </div>
        </div>

        <div class="row tight" style="align-items:center; justify-content:space-between; margin-top:10px">
          <div style="display:flex; align-items:center; gap:8px">
            <span class="badge ${esc(activeProvider.id)}" id="providerBadge">${esc(activeProvider.badge || activeProvider.name)}</span>
            <span class="tiny muted" id="keyStatusText"></span>
          </div>
        </div>

        <div id="keyInputSection" style="display:none; margin-top:10px; border-top:1px solid var(--border-soft); padding-top:10px">
          <div id="customEndpointBox" style="display:none; margin-bottom:8px">
            <label class="field" style="margin:0">
              <span>Địa chỉ máy chủ (Base URL / Endpoint)</span>
              <input type="text" id="aiEndpointInput" placeholder="http://localhost:11434/v1" />
              <div class="tiny muted mt">Hỗ trợ Ollama cục bộ (http://localhost:11434/v1), Groq, OpenRouter, vLLM...</div>
            </label>
          </div>

          <label class="field" style="margin-bottom:6px">
            <span id="apiKeyLabel">API Key</span>
            <div class="row tight" style="align-items:center">
              <input type="password" id="aiApiKeyInput" placeholder="Dán API Key..." style="flex:1" />
              <button type="button" class="sm" id="btnEyeKey" title="Ẩn/hiện key">👁️</button>
              <button type="button" class="sm primary" id="btnSaveKey">💾 Lưu cấu hình</button>
            </div>
          </label>
          <div class="tiny muted" id="keyHelpTextContainer"></div>
        </div>
      </div>

      <!-- Phong cach ca nhan & Giong dieu rieng -->
      <div class="ai-key-box" style="margin-top:-4px; margin-bottom:14px">
        <div class="row tight" style="align-items:center; justify-content:space-between">
          <div style="display:flex; align-items:center; gap:8px">
            <span style="font-weight:600; font-size:13px">🎨 Phong cách cá nhân &amp; Giọng điệu riêng</span>
            <span class="badge" id="personaBadge" style="display:none; font-size:11px; padding:1px 7px; background:rgba(34,197,94,0.15); color:var(--ok); border-color:rgba(34,197,94,0.3)">✓ Đang áp dụng</span>
          </div>
          <button type="button" class="sm ghost" id="btnTogglePersona">Ẩn / Hiện thiết lập</button>
        </div>
        <div id="personaBox" style="margin-top:10px">
          <label class="field" style="margin-bottom:6px">
            <span class="tiny muted" style="margin-bottom:4px">Định hình phong cách để AI viết chuẩn giọng của bạn (xưng hô, emoji, hotline, thông điệp thương hiệu...):</span>
            <textarea id="aiPersonaPrompt" rows="3" placeholder="Ví dụ: Xưng hô Shop - Bạn, phong cách hóm hỉnh gần gũi, dùng nhiều emoji năng động, cuối bài luôn để hotline: 0988.xxx.xxx, kêu gọi inbox nhận ưu đãi...">${esc(aiSettings.personaPrompt || '')}</textarea>
          </label>
          <div class="row tight" style="gap:6px; flex-wrap:wrap; margin-bottom:10px">
            <span class="tiny muted" style="align-self:center; font-size:11.5px">Gợi ý nhanh:</span>
            <button type="button" class="ai-chip" data-insert="Xưng hô: Em - Anh/Chị.">+ Em - Anh/Chị</button>
            <button type="button" class="ai-chip" data-insert="Xưng hô: Shop - Bạn.">+ Shop - Bạn</button>
            <button type="button" class="ai-chip" data-insert="Phong cách trẻ trung Gen Z, ngôn từ bắt trend, nhiều emoji vui vẻ.">+ Gen Z &amp; Emoji</button>
            <button type="button" class="ai-chip" data-insert="Phong cách chuyên gia uy tín, chuyên nghiệp, súc tích và mạch lạc.">+ Chuyên gia uy tín</button>
            <button type="button" class="ai-chip" data-insert="Cuối bài luôn kèm Hotline / Zalo: 09xx.xxx.xxx để tư vấn.">+ Hotline/Zalo</button>
            <button type="button" class="ai-chip" data-insert="Kêu gọi hành động mạnh mẽ: Inbox ngay để nhận ưu đãi đặc biệt hôm nay!">+ Kêu gọi Inbox</button>
          </div>
          <div class="row tight" style="align-items:center; justify-content:space-between">
            <label class="check" style="font-size:12px; margin:0">
              <input type="checkbox" id="chkApplyPersona" checked /> Tự động áp dụng phong cách này cho mọi bài viết
            </label>
            <button type="button" class="sm primary" id="btnSavePersona">💾 Lưu phong cách</button>
          </div>
        </div>
      </div>

      <div class="ai-tabs">
        <button type="button" class="ai-tab ${activeMode === 'generate' ? 'active' : ''}" data-aimode="generate">✨ Soạn bài mới</button>
        <button type="button" class="ai-tab ${activeMode === 'rewrite' ? 'active' : ''}" data-aimode="rewrite">✍️ Viết lại / Nâng cấp</button>
      </div>

      <!-- Tab: Soan bai moi -->
      <div id="tabContentGenerate" style="${activeMode === 'generate' ? '' : 'display:none;'}">
        <label class="field">
          <span>Chủ đề / Ý tưởng bài viết <b>*</b></span>
          <textarea id="ai-topic" rows="3" placeholder="Ví dụ: Giảm giá 30% toàn bộ áo thun nam nhân dịp cuối tuần, freeship từ 2 áo, bảo hành đổi trả 7 ngày..."></textarea>
        </label>
        <div class="row">
          <label class="field">
            <span>Nền tảng hướng tới</span>
            <select id="ai-gen-platform">
              <option value="Facebook" selected>Facebook (Page / Group / Cá nhân)</option>
            </select>
          </label>
          <label class="field">
            <span>Giọng điệu / Phong cách</span>
            <select id="ai-gen-tone">
              <option value="theo phong cách cá nhân đã lưu" ${aiSettings.personaPrompt ? 'selected' : ''}>🌟 Chuẩn phong cách cá nhân của bạn</option>
              <option value="bán hàng thu hút, kêu gọi hành động mạnh mẽ" ${!aiSettings.personaPrompt ? 'selected' : ''}>Bán hàng &amp; Kêu gọi hành động (CTA)</option>
              <option value="chuyên nghiệp, uy tín, chuẩn mực">Chuyên nghiệp &amp; Uy tín</option>
              <option value="hài hước, hóm hỉnh, bắt trend">Hài hước, bắt trend (Gen Z)</option>
              <option value="chia sẻ kiến thức, hữu ích, khách quan">Chia sẻ kiến thức &amp; Giá trị</option>
              <option value="kể chuyện (storytelling), chạm cảm xúc">Kể chuyện (Storytelling)</option>
            </select>
          </label>
          <label class="field" style="flex:0 0 160px">
            <span>Số lượng bài viết</span>
            <select id="ai-gen-count">
              <option value="1">1 bài viết</option>
              <option value="3">3 biến thể (đăng xoay vòng)</option>
              <option value="5">5 biến thể (đa dạng)</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>Yêu cầu bổ sung (tùy chọn)</span>
          <input type="text" id="ai-gen-inst" placeholder="Ví dụ: Thêm nhiều emoji sinh động, kèm số hotline 0901234567..." />
        </label>
      </div>

      <!-- Tab: Viet lai / Nang cap -->
      <div id="tabContentRewrite" style="${activeMode === 'rewrite' ? '' : 'display:none;'}">
        <label class="field">
          <span>Nội dung gốc cần viết lại <b>*</b></span>
          <textarea id="ai-rewrite-content" rows="5" placeholder="Dán nội dung bài viết hiện tại vào đây...">${esc(initialCaption)}</textarea>
        </label>
        <div class="row">
          <label class="field">
            <span>Mục tiêu viết lại</span>
            <select id="ai-rewrite-tone">
              <option value="viết lại chuẩn theo phong cách cá nhân đã lưu">🌟 Viết lại theo phong cách cá nhân của bạn</option>
              <option value="trau chuốt câu cú, ngắt dòng dễ đọc và thêm emoji sinh động" selected>Trau chuốt, ngắt dòng &amp; thêm emoji sinh động</option>
              <option value="viết ngắn gọn, súc tích, đi thẳng vào trọng tâm">Viết ngắn gọn, súc tích hơn</option>
              <option value="tăng tính thuyết phục và thêm lời kêu gọi hành động (CTA) chốt đơn">Bổ sung lời kêu gọi hành động (CTA)</option>
              <option value="chuyển sang phong cách bán hàng hấp dẫn">Chuyển sang phong cách bán hàng</option>
              <option value="chuyển sang phong cách trang trọng, chuyên nghiệp">Chuyển sang phong cách chuyên nghiệp</option>
            </select>
          </label>
          <label class="field">
            <span>Nền tảng</span>
            <select id="ai-rewrite-platform">
              <option value="Facebook" selected>Facebook</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>Yêu cầu bổ sung (tùy chọn)</span>
          <input type="text" id="ai-rewrite-inst" placeholder="Ví dụ: Chỉnh sửa lại các lỗi chính tả, bổ sung thêm 3 hashtag liên quan..." />
        </label>
      </div>

      <button type="button" class="primary" id="btnAiRun" style="width:100%; margin-top:8px; padding:10px">
        🚀 Tạo bài viết với AI
      </button>

      <!-- Loading Indicator -->
      <div id="aiLoadingBox" style="display:none; text-align:center; padding:24px 0">
        <div class="big">✨</div>
        <div><strong>AI đang sáng tạo nội dung…</strong></div>
        <div class="tiny muted" style="margin-top:4px">Thường mất khoảng 2-5 giây</div>
      </div>

      <!-- Result Box -->
      <div id="aiResultBox" class="ai-result-box" style="display:none">
        <div class="row tight" style="align-items:center; justify-content:space-between; margin-bottom:10px">
          <strong>🎉 Kết quả</strong>
          <div id="varTabsContainer" class="ai-var-tabs" style="margin-bottom:0"></div>
        </div>

        <label class="field">
          <span>Tiêu đề</span>
          <div class="row tight">
            <input type="text" id="resTitle" style="flex:1" />
            <button type="button" class="sm" id="btnCopyTitle">Sao chép</button>
          </div>
        </label>

        <label class="field">
          <span>Nội dung</span>
          <div style="position:relative">
            <textarea id="resCaption" rows="7"></textarea>
            <button type="button" class="sm" id="btnCopyCaption" style="position:absolute; top:8px; right:8px">Sao chép</button>
          </div>
        </label>

        <label class="field">
          <span>Hashtags</span>
          <div class="row tight">
            <input type="text" id="resHashtags" style="flex:1" />
            <button type="button" class="sm" id="btnCopyHashtags">Sao chép</button>
          </div>
        </label>

        <div class="row" style="margin-top:14px; gap:8px; flex-wrap:wrap">
          ${onApply ? '<button type="button" class="primary" id="btnApplyPost">📋 Áp dụng vào form bài viết</button>' : ''}
          <button type="button" class="${onApply ? '' : 'primary'}" id="btnSaveDirect">💾 Lưu thành bài viết mới</button>
          ${!onApply ? '<button type="button" class="secondary" id="btnEditInForm">📝 Mở trong form để chọn ảnh</button>' : ''}
          <button type="button" id="btnSaveAllVars" style="display:none">💾 Lưu tất cả biến thể</button>
        </div>
      </div>
    `,
    footer: `<button data-modal-close>Đóng</button>`,
    onMount(modal) {
      const selProvider = modal.querySelector('#aiProviderSelect');
      const selModel = modal.querySelector('#aiModelSelect');
      const customModelInput = modal.querySelector('#aiCustomModelInput');
      const customEndpointBox = modal.querySelector('#customEndpointBox');
      const endpointInput = modal.querySelector('#aiEndpointInput');
      const keyBox = modal.querySelector('#keyInputSection');
      const keyInput = modal.querySelector('#aiApiKeyInput');
      const btnToggleKey = modal.querySelector('#btnToggleKeyInput');
      const btnEye = modal.querySelector('#btnEyeKey');
      const btnSaveKey = modal.querySelector('#btnSaveKey');
      const providerBadge = modal.querySelector('#providerBadge');
      const keyStatusText = modal.querySelector('#keyStatusText');
      const apiKeyLabel = modal.querySelector('#apiKeyLabel');
      const keyHelpBox = modal.querySelector('#keyHelpTextContainer');
      const btnRun = modal.querySelector('#btnAiRun');

      function updateProviderUI(pid) {
        activeProvider = (aiSettings.providers || []).find((x) => x.id === pid) || aiSettings.providers?.[0];
        if (!activeProvider) return;

        providerBadge.className = `badge ${activeProvider.id}`;
        providerBadge.textContent = activeProvider.badge || activeProvider.name;

        // Models
        const models = activeProvider.models || [];
        let opts = models.map((m) => `<option value="${esc(m.id)}" ${m.id === activeProvider.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
        if (activeProvider.id === 'custom') {
          opts += `<option value="custom_other" ${!models.some((m) => m.id === activeProvider.model) ? 'selected' : ''}>-- Nhập model khác --</option>`;
        }
        selModel.innerHTML = opts;

        if (activeProvider.id === 'custom') {
          customEndpointBox.style.display = 'block';
          endpointInput.value = activeProvider.endpoint || activeProvider.defaultEndpoint || 'http://localhost:11434/v1';
          const isOther = selModel.value === 'custom_other';
          customModelInput.style.display = isOther ? 'block' : 'none';
          if (isOther) customModelInput.value = activeProvider.model || '';
        } else {
          customEndpointBox.style.display = 'none';
          customModelInput.style.display = 'none';
        }

        // Key status
        const hasKey = activeProvider.hasKey || !activeProvider.requiresKey;
        if (activeProvider.requiresKey) {
          apiKeyLabel.textContent = `${activeProvider.name} API Key *`;
          keyInput.placeholder = activeProvider.keyPlaceholder || 'Dán API Key...';
          keyStatusText.innerHTML = activeProvider.hasKey
            ? `Đã cấu hình Key: <code>${esc(activeProvider.maskedKey)}</code>`
            : '<span style="color:var(--warn)">⚠️ Chưa có API Key</span>';
        } else {
          apiKeyLabel.textContent = `${activeProvider.name} API Key (Tùy chọn)`;
          keyInput.placeholder = activeProvider.keyPlaceholder || 'Bỏ trống nếu dùng máy cá nhân';
          keyStatusText.innerHTML = activeProvider.hasKey
            ? `Đã có Key: <code>${esc(activeProvider.maskedKey)}</code>`
            : '<span style="color:var(--ok)">✓ Sẵn sàng (không bắt buộc key)</span>';
        }

        if (activeProvider.keyHelpUrl) {
          keyHelpBox.innerHTML = `Chưa có key? <a href="${esc(activeProvider.keyHelpUrl)}" target="_blank" rel="noopener">${esc(activeProvider.keyHelpText || 'Lấy API Key ↗')}</a>`;
        } else {
          keyHelpBox.innerHTML = esc(activeProvider.keyHelpText || '');
        }

        btnRun.textContent = `🚀 Tạo bài viết với ${activeProvider.name}`;
      }

      selProvider.addEventListener('change', () => {
        updateProviderUI(selProvider.value);
      });

      selModel.addEventListener('change', () => {
        if (activeProvider.id === 'custom') {
          const isOther = selModel.value === 'custom_other';
          customModelInput.style.display = isOther ? 'block' : 'none';
        }
      });

      btnToggleKey.addEventListener('click', () => {
        keyBox.style.display = keyBox.style.display === 'none' ? 'block' : 'none';
      });

      btnEye.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      });

      btnSaveKey.addEventListener('click', async () => {
        const val = keyInput.value.trim();
        const selectedModel = (activeProvider.id === 'custom' && selModel.value === 'custom_other')
          ? customModelInput.value.trim()
          : selModel.value;
        const selectedEp = activeProvider.id === 'custom' ? endpointInput.value.trim() : undefined;

        try {
          const r = await api.ai.saveSettings({
            provider: activeProvider.id,
            apiKey: val || undefined,
            model: selectedModel || undefined,
            endpoint: selectedEp,
            setActive: true,
          });
          aiSettings = r;
          toast(`Đã lưu cấu hình ${activeProvider.name}!`, 'ok');
          updateProviderUI(activeProvider.id);
          keyInput.value = '';
          keyBox.style.display = 'none';
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      // Persona style controls
      const btnTogglePersona = modal.querySelector('#btnTogglePersona');
      const personaBox = modal.querySelector('#personaBox');
      const personaInput = modal.querySelector('#aiPersonaPrompt');
      const personaBadge = modal.querySelector('#personaBadge');
      const chkApplyPersona = modal.querySelector('#chkApplyPersona');
      const btnSavePersona = modal.querySelector('#btnSavePersona');

      function updatePersonaBadge() {
        const val = personaInput ? personaInput.value.trim() : '';
        if (personaBadge) {
          personaBadge.style.display = val ? 'inline-block' : 'none';
        }
      }
      updatePersonaBadge();

      btnTogglePersona?.addEventListener('click', () => {
        personaBox.style.display = personaBox.style.display === 'none' ? 'block' : 'none';
      });

      modal.querySelectorAll('.ai-chip[data-insert]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const text = chip.dataset.insert;
          const cur = personaInput.value.trim();
          if (!cur) {
            personaInput.value = text;
          } else {
            personaInput.value = `${cur}\n- ${text}`;
          }
          personaInput.focus();
          updatePersonaBadge();
        });
      });

      personaInput?.addEventListener('input', updatePersonaBadge);

      btnSavePersona?.addEventListener('click', async () => {
        const text = personaInput ? personaInput.value.trim() : '';
        try {
          await api.ai.saveSettings({
            personaPrompt: text,
          });
          aiSettings.personaPrompt = text;
          updatePersonaBadge();
          toast('Đã lưu phong cách cá nhân thành công!', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      // Initialize UI
      updateProviderUI(currentPid);

      // Tabs switcher
      const tabBtns = modal.querySelectorAll('.ai-tab');
      const tabGen = modal.querySelector('#tabContentGenerate');
      const tabRew = modal.querySelector('#tabContentRewrite');

      tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          tabBtns.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          activeMode = btn.dataset.aimode;
          tabGen.style.display = activeMode === 'generate' ? 'block' : 'none';
          tabRew.style.display = activeMode === 'rewrite' ? 'block' : 'none';
        });
      });

      // Generate action
      const loadingBox = modal.querySelector('#aiLoadingBox');
      const resultBox = modal.querySelector('#aiResultBox');
      const resTitle = modal.querySelector('#resTitle');
      const resCaption = modal.querySelector('#resCaption');
      const resHashtags = modal.querySelector('#resHashtags');
      const varTabsContainer = modal.querySelector('#varTabsContainer');
      const btnSaveAllVars = modal.querySelector('#btnSaveAllVars');

      function getAllVariants() {
        if (!currentResult) return [];
        const main = {
          title: currentResult.title || '',
          caption: currentResult.caption || '',
          hashtags: currentResult.hashtags || '',
        };
        const vars = Array.isArray(currentResult.variations) ? currentResult.variations : [];
        return [main, ...vars];
      }

      function showVariant(idx) {
        const list = getAllVariants();
        if (!list[idx]) return;
        activeVarIndex = idx;
        resTitle.value = list[idx].title || '';
        resCaption.value = list[idx].caption || '';
        resHashtags.value = list[idx].hashtags || '';

        varTabsContainer.querySelectorAll('.ai-var-tab').forEach((t, i) => {
          t.classList.toggle('active', i === idx);
        });
      }

      btnRun.addEventListener('click', async () => {
        const customKey = keyInput.value.trim();
        const selectedModel = (activeProvider.id === 'custom' && selModel.value === 'custom_other')
          ? customModelInput.value.trim()
          : selModel.value;
        const selectedEp = activeProvider.id === 'custom' ? endpointInput.value.trim() : undefined;

        const personaText = personaInput ? personaInput.value.trim() : '';
        const shouldApplyPersona = chkApplyPersona ? chkApplyPersona.checked : true;

        const payload = {
          provider: activeProvider.id,
          model: selectedModel,
          endpoint: selectedEp,
          apiKey: customKey || undefined,
          saveKey: !!customKey,
          mode: activeMode,
          personaPrompt: shouldApplyPersona && personaText ? personaText : undefined,
          savePersona: shouldApplyPersona && !!personaText,
        };

        if (activeMode === 'generate') {
          payload.topic = modal.querySelector('#ai-topic').value.trim();
          payload.platform = modal.querySelector('#ai-gen-platform').value;
          payload.tone = modal.querySelector('#ai-gen-tone').value;
          payload.count = Number(modal.querySelector('#ai-gen-count').value) || 1;
          payload.instructions = modal.querySelector('#ai-gen-inst').value.trim();
          if (!payload.topic) return toast('Vui lòng nhập chủ đề bài viết', 'warn');
        } else {
          payload.existingContent = modal.querySelector('#ai-rewrite-content').value.trim();
          payload.platform = modal.querySelector('#ai-rewrite-platform').value;
          payload.tone = modal.querySelector('#ai-rewrite-tone').value;
          payload.instructions = modal.querySelector('#ai-rewrite-inst').value.trim();
          if (!payload.existingContent) return toast('Vui lòng nhập nội dung cần viết lại', 'warn');
        }

        btnRun.disabled = true;
        loadingBox.style.display = 'block';
        resultBox.style.display = 'none';

        try {
          const res = await api.ai.generate(payload);
          currentResult = res.result;

          loadingBox.style.display = 'none';
          resultBox.style.display = 'block';

          const allVars = getAllVariants();
          if (allVars.length > 1) {
            varTabsContainer.innerHTML = allVars
              .map((_, i) => `<button type="button" class="ai-var-tab ${i === 0 ? 'active' : ''}" data-var="${i}">Biến thể ${i + 1}</button>`)
              .join('');
            varTabsContainer.querySelectorAll('.ai-var-tab').forEach((tab) => {
              tab.addEventListener('click', () => showVariant(Number(tab.dataset.var)));
            });
            btnSaveAllVars.style.display = 'inline-flex';
            btnSaveAllVars.textContent = `💾 Lưu cả ${allVars.length} bài vào hệ thống`;
          } else {
            varTabsContainer.innerHTML = '';
            btnSaveAllVars.style.display = 'none';
          }

          showVariant(0);
          toast(`${activeProvider.name} đã tạo nội dung thành công!`, 'ok');
        } catch (err) {
          loadingBox.style.display = 'none';
          toast(err.message, 'err');
        } finally {
          btnRun.disabled = false;
        }
      });

      // Copy helpers
      const copyVal = (val, msg) => {
        navigator.clipboard.writeText(val);
        toast(msg, 'ok');
      };
      modal.querySelector('#btnCopyTitle')?.addEventListener('click', () => copyVal(resTitle.value, 'Đã sao chép tiêu đề'));
      modal.querySelector('#btnCopyCaption')?.addEventListener('click', () => copyVal(resCaption.value, 'Đã sao chép nội dung'));
      modal.querySelector('#btnCopyHashtags')?.addEventListener('click', () => copyVal(resHashtags.value, 'Đã sao chép hashtag'));

      // Apply button
      modal.querySelector('#btnApplyPost')?.addEventListener('click', () => {
        if (typeof onApply === 'function') {
          onApply({
            title: resTitle.value.trim(),
            caption: resCaption.value.trim(),
            hashtags: resHashtags.value.trim(),
          });
          closeModal(modal);
        }
      });

      // Open in post form (when opened standalone without prior form)
      modal.querySelector('#btnEditInForm')?.addEventListener('click', () => {
        const titleVal = resTitle.value.trim();
        const captionVal = resCaption.value.trim();
        const hashtagsVal = resHashtags.value.trim();
        closeModal(modal);
        postModal(
          {
            title: titleVal,
            caption: captionVal,
            hashtags: hashtagsVal,
            media: [],
          },
          onDone,
        );
      });

      // Save directly as new post
      modal.querySelector('#btnSaveDirect')?.addEventListener('click', async () => {
        const postData = {
          title: resTitle.value.trim(),
          caption: resCaption.value.trim(),
          hashtags: resHashtags.value.trim(),
          media: [],
        };
        try {
          await api.posts.create(postData);
          toast('Đã lưu bài viết mới vào danh sách!', 'ok');
          closeModal(modal);
          onDone?.();
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      // Save all variations
      btnSaveAllVars?.addEventListener('click', async () => {
        const allVars = getAllVariants();
        let countOk = 0;
        for (const v of allVars) {
          try {
            await api.posts.create({
              title: v.title || '',
              caption: v.caption || '',
              hashtags: v.hashtags || '',
              media: [],
            });
            countOk += 1;
          } catch {
            /* ignore individual errors */
          }
        }
        toast(`Đã lưu ${countOk} bài viết vào danh sách!`, 'ok');
        closeModal(modal);
        onDone?.();
      });
    },
  });
}

