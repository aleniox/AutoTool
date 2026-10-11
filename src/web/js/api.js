/** Lop goi API. Moi ham nem Error voi message tu server. */

async function request(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (opts.raw) {
    delete init.headers['Content-Type'];
    init.headers['Content-Type'] = opts.contentType || 'application/octet-stream';
    init.body = opts.raw;
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => request('GET', '/api/health'),
  platforms: () => request('GET', '/api/platforms'),
  platformFlow: (id) => request('GET', `/api/platforms/${id}/flow`),
  resolveUrls: (urls, platform) => request('POST', '/api/platforms/resolve', { urls, platform }),
  stats: () => request('GET', '/api/stats'),
  worker: () => request('GET', '/api/worker'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (s) => request('PUT', '/api/settings', s),
  browsers: () => request('GET', '/api/browsers'),

  logs: (params) => request('GET', `/api/logs${qs(params)}`),
  clearLogs: () => request('DELETE', '/api/logs'),

  accounts: {
    list: (params) => request('GET', `/api/accounts${qs(params)}`),
    create: (data) => request('POST', '/api/accounts', data),
    update: (id, data) => request('PATCH', `/api/accounts/${id}`, data),
    remove: (id) => request('DELETE', `/api/accounts/${id}`),
    login: (id) => request('POST', `/api/accounts/${id}/login`),
    check: (id) => request('POST', `/api/accounts/${id}/check`),
    close: (id) => request('POST', `/api/accounts/${id}/close`),
  },

  targets: {
    list: (params) => request('GET', `/api/targets${qs(params)}`),
    create: (data) => request('POST', '/api/targets', data),
    import: (data) => request('POST', '/api/targets/import', data),
    update: (id, data) => request('PATCH', `/api/targets/${id}`, data),
    remove: (id) => request('DELETE', `/api/targets/${id}`),
    removeBulk: (ids) => request('POST', '/api/targets/delete-bulk', { ids }),
  },

  posts: {
    list: (params) => request('GET', `/api/posts${qs(params)}`),
    get: (id) => request('GET', `/api/posts/${id}`),
    create: (data) => request('POST', '/api/posts', data),
    update: (id, data) => request('PATCH', `/api/posts/${id}`, data),
    remove: (id) => request('DELETE', `/api/posts/${id}`),
    removeBulk: (ids) => request('POST', '/api/posts/delete-bulk', { ids }),
    import: (data) => request('POST', '/api/posts/import', data),
  },

  media: {
    list: () => request('GET', '/api/media'),
    upload: (file) =>
      request('POST', `/api/media?name=${encodeURIComponent(file.name)}`, undefined, {
        raw: file,
        contentType: file.type || 'application/octet-stream',
      }),
    remove: (name) => request('DELETE', `/api/media/${encodeURIComponent(name)}`),
  },

  jobs: {
    list: (params) => request('GET', `/api/jobs${qs(params)}`),
    get: (id) => request('GET', `/api/jobs/${id}`),
    items: (id, params) => request('GET', `/api/jobs/${id}/items${qs(params)}`),
    create: (data) => request('POST', '/api/jobs', data),
    preview: (data) => request('POST', '/api/jobs/preview', data),
    pause: (id) => request('POST', `/api/jobs/${id}/pause`),
    resume: (id) => request('POST', `/api/jobs/${id}/resume`),
    cancel: (id) => request('POST', `/api/jobs/${id}/cancel`),
    runNow: (id) => request('POST', `/api/jobs/${id}/run-now`),
    retryFailed: (id) => request('POST', `/api/jobs/${id}/retry-failed`),
    remove: (id) => request('DELETE', `/api/jobs/${id}`),
  },

  projects: {
    list: () => request('GET', '/api/projects'),
    create: (data) => request('POST', '/api/projects', data),
    remove: (id) => request('DELETE', `/api/projects/${id}`),
  },

  reports: (days) => request('GET', `/api/reports/summary${qs({ days })}`),
  calendar: (params) => request('GET', `/api/calendar${qs(params)}`),

  ai: {
    getSettings: () => request('GET', '/api/ai/settings'),
    saveSettings: (data) => request('POST', '/api/ai/settings', data),
    generate: (data) => request('POST', '/api/ai/generate', data),
  },
};

export default api;
