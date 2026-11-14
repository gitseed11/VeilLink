'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  boot: $('boot-view'),
  login: $('login-view'),
  app: $('app-view'),
  loginForm: $('login-form'),
  adminToken: $('admin-token'),
  loginButton: $('login-button'),
  loginError: $('login-error'),
  logout: $('logout-button'),
  refresh: $('refresh-button'),
  clearLogs: $('clear-logs'),
  statusDot: $('status-dot'),
  statusLabel: $('status-label'),
  serviceState: $('service-state'),
  publicUrl: $('public-url'),
  upstreamSummary: $('upstream-summary'),
  keySummary: $('key-summary'),
  requestSummary: $('request-summary'),
  upstreamState: $('upstream-state'),
  configForm: $('config-form'),
  baseUrl: $('base-url'),
  protocol: $('protocol'),
  authMode: $('auth-mode'),
  model: $('upstream-model'),
  upstreamKey: $('upstream-key'),
  toggleUpstreamKey: $('toggle-upstream-key'),
  clearUpstreamKey: $('clear-upstream-key'),
  publicBaseUrl: $('public-base-url'),
  saveConfig: $('save-config'),
  testUpstream: $('test-upstream'),
  testResult: $('test-result'),
  keyForm: $('key-form'),
  keyName: $('key-name'),
  keyDevice: $('key-device'),
  generateKey: $('generate-key'),
  deviceMachine: $('device-machine'),
  deviceHint: $('device-hint'),
  keysBody: $('keys-body'),
  logsBody: $('logs-body'),
  footerVersion: $('footer-version'),
  keyDialog: $('key-dialog'),
  keyDialogTitle: $('key-dialog-title'),
  keyDialogSubtitle: $('key-dialog-subtitle'),
  keyOutput: $('key-output'),
  copyKey: $('copy-key'),
  toast: $('toast')
};

let appState = null;
let configLoaded = false;
let configDirty = false;
let refreshTimer = null;
let refreshInFlight = false;
let busy = false;
let toastTimer = null;
let warnedTokenMismatch = false;
let warnedUnreadableKeys = false;
let csrfToken = '';
try {
  csrfToken = sessionStorage.getItem('vl_csrf') || '';
} catch {
  csrfToken = '';
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = {};
  const csrf = path === '/admin/api/login' ? '1' : csrfToken;
  if (csrf) headers['X-VeilLink-CSRF'] = csrf;
  if (body !== null) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError('无法连接本机管理服务。', 0, 'network_error');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data?.error?.message || `请求失败（HTTP ${response.status}）。`;
    const code = data?.error?.code || '';
    if (!path.endsWith('/login') && (response.status === 401 || code === 'csrf_failed')) {
      showLogin(
        code === 'csrf_failed'
          ? '安全校验已失效，请重新登录。'
          : '管理会话已失效，请重新登录。'
      );
    }
    throw new ApiError(message, response.status, code);
  }
  return data;
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startRefresh() {
  stopRefresh();
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible' || busy || els.app.hidden) return;
    refreshState().catch(() => {});
  }, 12000);
}

function showLogin(message = '') {
  stopRefresh();
  busy = false;
  csrfToken = '';
  try {
    sessionStorage.removeItem('vl_csrf');
  } catch {
    // Ignore storage failures; the next login will issue a new token.
  }
  if (els.keyDialog.open) els.keyDialog.close();
  els.keyOutput.value = '';
  els.boot.hidden = true;
  els.app.hidden = true;
  els.login.hidden = false;
  els.loginError.textContent = message;
  if (!message) {
    window.setTimeout(() => els.adminToken.focus(), 20);
  }
}

function showApp() {
  els.boot.hidden = true;
  els.login.hidden = true;
  els.app.hidden = false;
}

function setToast(message, kind = '') {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${kind ? ` ${kind}` : ''}`;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3800);
}

function setButtonBusy(button, isBusy, busyText, idleText) {
  if (!button) return;
  if (isBusy) {
    if (!button.dataset.idleText) button.dataset.idleText = idleText || button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.textContent = idleText || button.dataset.idleText || button.textContent;
  }
}

function formatTime(value, withDate = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: withDate ? undefined : '2-digit',
    hour12: false
  }).format(date);
}

function formatFullTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}

function compactUrl(raw) {
  if (!raw) return '未配置';
  try {
    const url = new URL(raw);
    return url.host + (url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '');
  } catch {
    return raw;
  }
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function emptyRow(colspan, text) {
  const tr = document.createElement('tr');
  const td = make('td', 'empty', text);
  td.colSpan = colspan;
  tr.appendChild(td);
  return tr;
}

async function loadState({ initial = false } = {}) {
  const data = await api('/admin/api/state');
  appState = data;
  if (initial || !configLoaded) {
    fillConfigForm(data);
    configLoaded = true;
  }
  renderSummary(data);
  renderKeys(data.keys || []);
  renderLogs(data.logs || []);
  renderSecurity(data);
  return data;
}

function fillConfigForm(data) {
  const upstream = data.upstream || {};
  els.baseUrl.value = upstream.baseUrl || '';
  els.protocol.value = upstream.protocol || 'anthropic';
  els.authMode.value = upstream.authMode || 'auto';
  els.model.value = upstream.model || '';
  els.publicBaseUrl.value = data.public?.baseUrl || '';
  els.upstreamKey.value = '';
  els.upstreamKey.type = 'password';
  els.toggleUpstreamKey.textContent = '显示';
  els.clearUpstreamKey.checked = false;
  els.upstreamKey.placeholder = upstream.hasApiKey ? '已保存（留空保持不变）' : '未设置（可选）';
  configDirty = false;
}

function updateAuthPlaceholder() {
  const hasKey = appState?.upstream?.hasApiKey;
  els.upstreamKey.placeholder = hasKey ? '已保存（留空保持不变）' : '未设置（可选）';
}

function renderSummary(data) {
  const upstream = data.upstream || {};
  const publicUrl = data.public?.baseUrl || '';
  els.publicUrl.textContent = publicUrl || '未填写';
  els.publicUrl.title = publicUrl || '';
  els.upstreamSummary.textContent = upstream.baseUrl ? compactUrl(upstream.baseUrl) : '未配置';
  els.upstreamSummary.title = upstream.baseUrl ? `${upstream.baseUrl}${upstream.model ? ` · ${upstream.model}` : ''}` : '';
  const keys = data.keys || [];
  const active = keys.filter((key) => !key.revokedAt).length;
  els.keySummary.textContent = `${active} / ${keys.length}`;
  els.keySummary.title = '有效 / 全部（含已吊销）';
  els.requestSummary.textContent = String(data.stats?.requestsTotal || 0);
  els.requestSummary.title = `成功 ${data.stats?.requestsOk || 0} · 失败 ${data.stats?.requestsError || 0}`;

  els.upstreamState.textContent = upstream.configured ? '已配置' : '未配置';
  els.upstreamState.className = `tag${upstream.configured ? ' ok' : ''}`;

  const last = data.stats?.lastUpstream;
  let dotClass = 'dot';
  let label = '运行中';
  let title = '';
  if (!upstream.configured) {
    dotClass += ' warn';
    label = '待配置';
    title = '请先填写本地网关地址并保存。';
  } else if (last && last.ok === false) {
    dotClass += ' error';
    label = '网关异常';
    title = last.detail || last.error || '最近一次网关调用失败。';
  } else if (last && last.ok) {
    dotClass += ' ok';
    label = '运行中';
    title = `最近成功 ${formatFullTime(last.time)} · ${formatDuration(last.latencyMs)}`;
  } else {
    dotClass += ' ok';
    title = '服务已就绪，等待第一次请求。';
  }
  els.statusDot.className = dotClass;
  els.statusLabel.textContent = label;
  els.serviceState.title = title;
  els.footerVersion.textContent = `${data.app?.name || 'VeilLink'} ${data.app?.version || ''} · Node ${data.app?.node || ''}`;
}

function renderSecurity(data) {
  const security = data.security || {};
  const machine = security.machineHint || '本机';
  els.deviceMachine.textContent = machine;
  els.deviceMachine.title = '设备白名单参考标识。客户端可用 X-VeilLink-Device 请求头发送。';
  els.deviceHint.textContent = `设备标识通过 X-VeilLink-Device 请求头校验。它是增强项，不是强身份认证；ZCode 图形界面目前不能设置自定义请求头。本机参考：${machine}`;
  if (security.adminTokenFileMatches === false && !warnedTokenMismatch) {
    warnedTokenMismatch = true;
    setToast('管理令牌文件缺失或与凭据不一致；如无法登录，请运行 npm run admin:reset', 'error');
  }
  if (security.unreadableKeys > 0 && !warnedUnreadableKeys) {
    warnedUnreadableKeys = true;
    setToast(
      `${security.unreadableKeys} 个已保存的 API Key 无法解密；通常是 data/master.key 被替换或丢失，请重新生成密钥或恢复备份。`,
      'error'
    );
  }
}

function renderKeys(keys) {
  clearChildren(els.keysBody);
  if (!keys.length) {
    els.keysBody.appendChild(emptyRow(5, '暂无密钥'));
    return;
  }
  for (const record of keys) {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const name = make('span', 'key-name', record.name || '未命名密钥');
    name.title = record.name || '';
    nameCell.appendChild(name);
    if (record.allowedDevice) {
      const device = make('span', 'key-device', record.allowedDevice);
      device.title = `绑定设备：${record.allowedDevice}`;
      nameCell.appendChild(device);
    }

    const statusCell = document.createElement('td');
    const badge = make('span', `badge${record.revokedAt ? ' revoked' : ' ok'}`, record.revokedAt ? '已吊销' : '有效');
    statusCell.appendChild(badge);

    const createdCell = document.createElement('td');
    createdCell.className = 'time';
    createdCell.textContent = formatTime(record.createdAt);
    createdCell.title = formatFullTime(record.createdAt);

    const usedCell = document.createElement('td');
    usedCell.className = 'time';
    usedCell.textContent = record.lastUsedAt ? formatTime(record.lastUsedAt) : '从未';
    if (record.lastUsedAt) {
      usedCell.title = `${formatFullTime(record.lastUsedAt)}${record.lastIp ? ` · ${record.lastIp}` : ''}`;
    }

    const actionsCell = document.createElement('td');
    actionsCell.className = 'align-right';
    const actions = make('div', 'row-actions');
    const reveal = make('button', 'link-button', '查看');
    reveal.type = 'button';
    reveal.addEventListener('click', () => revealKey(record.id));
    actions.appendChild(reveal);
    if (!record.revokedAt) {
      const revoke = make('button', 'link-button danger', '吊销');
      revoke.type = 'button';
      revoke.addEventListener('click', () => revokeKey(record));
      actions.appendChild(revoke);
    }
    actionsCell.appendChild(actions);

    tr.append(nameCell, statusCell, createdCell, usedCell, actionsCell);
    els.keysBody.appendChild(tr);
  }
}

function renderLogs(logs) {
  clearChildren(els.logsBody);
  const requests = logs.filter((entry) => entry.kind !== 'audit').slice(0, 100);
  if (!requests.length) {
    els.logsBody.appendChild(emptyRow(6, '暂无请求'));
    return;
  }
  for (const entry of requests) {
    const tr = document.createElement('tr');

    const timeCell = document.createElement('td');
    timeCell.className = 'time';
    timeCell.textContent = formatTime(entry.time, false);
    timeCell.title = formatFullTime(entry.time);

    const sourceCell = document.createElement('td');
    sourceCell.appendChild(make('span', 'log-key', entry.keyName || '未认证'));
    sourceCell.appendChild(make('span', 'log-ip', entry.ip || '—'));

    const modelCell = document.createElement('td');
    modelCell.appendChild(make('span', 'log-model', entry.model || '—'));
    const pathText = `${entry.path || ''}${entry.stream ? ' · 流式' : ''}`;
    modelCell.appendChild(make('span', 'log-path', pathText));

    const statusCell = document.createElement('td');
    const status = Number(entry.status) || 0;
    let statusClass = 'log-status';
    if (status >= 200 && status < 400) statusClass += ' ok';
    else if (status === 0) statusClass += ' pending';
    else statusClass += ' error';
    const statusText = make('span', statusClass, String(status || '—'));
    if (entry.error) statusText.title = entry.error;
    if (entry.upstreamStatus) statusText.title = `${statusText.title || ''}${statusText.title ? ' · ' : ''}上游 HTTP ${entry.upstreamStatus}`;
    statusCell.appendChild(statusText);

    const durationCell = document.createElement('td');
    durationCell.className = 'time';
    durationCell.textContent = formatDuration(entry.durationMs);

    const tokenCell = document.createElement('td');
    tokenCell.className = 'time';
    if (entry.inputTokens || entry.outputTokens) {
      tokenCell.textContent = `${entry.inputTokens || 0} / ${entry.outputTokens || 0}`;
      tokenCell.title = '输入 / 输出 token';
    } else {
      tokenCell.textContent = '—';
    }

    tr.append(timeCell, sourceCell, modelCell, statusCell, durationCell, tokenCell);
    els.logsBody.appendChild(tr);
  }
}

async function refreshState() {
  if (refreshInFlight) return null;
  refreshInFlight = true;
  try {
    await loadState();
    return true;
  } catch (error) {
    if (!els.app.hidden && error.status !== 401) {
      els.statusDot.className = 'dot error';
      els.statusLabel.textContent = '连接失败';
      els.serviceState.title = error.message;
    }
    return false;
  } finally {
    refreshInFlight = false;
  }
}

function collectConfigPayload() {
  const enteredKey = els.upstreamKey.value;
  if (enteredKey && els.clearUpstreamKey.checked) {
    throw new Error('不能同时输入新密钥并勾选清除已保存密钥。');
  }
  const baseUrl = els.baseUrl.value.trim();
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('基础地址不是有效 URL。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('基础地址必须使用 http 或 https。');
    }
  }
  if (!baseUrl) {
    throw new Error('基础地址不能为空。');
  }
  const model = els.model.value.trim();
  if (els.protocol.value === 'openai' && !model) {
    throw new Error('OpenAI 协议必须填写上游模型。');
  }
  const publicBase = els.publicBaseUrl.value.trim();
  if (publicBase) {
    let parsed;
    try {
      parsed = new URL(publicBase);
    } catch {
      throw new Error('公网 API 地址不是有效 URL。');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('公网 API 地址必须是 HTTPS。');
    }
  }
  return {
    upstream: {
      baseUrl,
      protocol: els.protocol.value,
      authMode: els.authMode.value,
      model,
      apiKey: enteredKey,
      clearApiKey: els.clearUpstreamKey.checked,
      timeoutMs: appState?.upstream?.timeoutMs || 300000
    },
    public: {
      baseUrl: publicBase
    }
  };
}

async function saveConfig({ silent = false } = {}) {
  if (busy) return false;
  let payload;
  try {
    payload = collectConfigPayload();
  } catch (error) {
    setToast(error.message, 'error');
    return false;
  }
  busy = true;
  setButtonBusy(els.saveConfig, true, '保存中…');
  try {
    const result = await api('/admin/api/config', { method: 'PUT', body: payload });
    if (appState) {
      appState.upstream = result.upstream;
      appState.public = result.public;
    }
    fillConfigForm(appState || { upstream: result.upstream, public: result.public });
    renderSummary(appState || { upstream: result.upstream, public: result.public, keys: [], stats: {} });
    updateAuthPlaceholder();
    await refreshState();
    if (!silent) setToast('配置已保存。', 'ok');
    return true;
  } catch (error) {
    if (error.status !== 401) setToast(error.message, 'error');
    return false;
  } finally {
    busy = false;
    setButtonBusy(els.saveConfig, false, '', '保存配置');
  }
}

async function testUpstream() {
  if (busy) return;
  if (configDirty) {
    const saved = await saveConfig({ silent: true });
    if (!saved) return;
  }
  busy = true;
  setButtonBusy(els.testUpstream, true, '测试中…');
  els.testResult.className = 'inline-result';
  els.testResult.textContent = '正在向上游发送 1 token 测试…';
  try {
    const result = await api('/admin/api/upstream/test', { method: 'POST', body: {} });
    els.testResult.className = `inline-result ${result.ok ? 'ok' : 'error'}`;
    els.testResult.textContent = result.ok
      ? `成功 · HTTP ${result.status} · ${formatDuration(result.latencyMs)}`
      : `失败 · ${result.message || '无法调用上游'}${result.status ? ` · HTTP ${result.status}` : ''}`;
    els.testResult.title = result.error || result.preview || '';
    await refreshState();
  } catch (error) {
    els.testResult.className = 'inline-result error';
    els.testResult.textContent = error.message;
    els.testResult.title = '';
  } finally {
    busy = false;
    setButtonBusy(els.testUpstream, false, '', '测试网关');
  }
}

function showKeyDialog(title, subtitle, key) {
  els.keyDialogTitle.textContent = title;
  els.keyDialogSubtitle.textContent = subtitle || '完整密钥只在本机显示';
  els.keyOutput.value = key;
  if (typeof els.keyDialog.showModal === 'function') {
    els.keyDialog.showModal();
  } else {
    els.keyDialog.setAttribute('open', '');
  }
  window.setTimeout(() => {
    els.keyOutput.focus();
    els.keyOutput.select();
  }, 30);
}

async function generateKey(event) {
  event.preventDefault();
  if (busy) return;
  busy = true;
  setButtonBusy(els.generateKey, true, '生成中…');
  try {
    const result = await api('/admin/api/keys', {
      method: 'POST',
      body: {
        name: els.keyName.value.trim(),
        allowedDevice: els.keyDevice.value.trim()
      }
    });
    els.keyName.value = '';
    els.keyDevice.value = '';
    showKeyDialog(
      '已生成 API 密钥',
      `${result.record.name}${result.record.allowedDevice ? ` · 设备 ${result.record.allowedDevice}` : ' · 未绑定设备'}`
    , result.key);
    await refreshState();
  } catch (error) {
    if (error.status !== 401) setToast(error.message, 'error');
  } finally {
    busy = false;
    setButtonBusy(els.generateKey, false, '', '生成密钥');
  }
}

async function revealKey(id) {
  if (busy) return;
  busy = true;
  try {
    const result = await api(`/admin/api/keys/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: {} });
    showKeyDialog(
      'API 密钥',
      `${result.record?.name || '未命名密钥'}${result.record?.revokedAt ? ' · 已吊销' : ''}`
    , result.key);
  } catch (error) {
    if (error.status !== 401) setToast(error.message, 'error');
  } finally {
    busy = false;
  }
}

async function revokeKey(record) {
  if (busy) return;
  const label = record.name || '未命名密钥';
  if (!window.confirm(`吊销密钥「${label}」？\n吊销会立即生效且不可恢复。`)) return;
  busy = true;
  try {
    await api(`/admin/api/keys/${encodeURIComponent(record.id)}/revoke`, { method: 'POST', body: {} });
    setToast('密钥已吊销。', 'ok');
    await refreshState();
  } catch (error) {
    if (error.status !== 401) setToast(error.message, 'error');
  } finally {
    busy = false;
  }
}

async function copyKey() {
  const value = els.keyOutput.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setToast('已复制完整密钥。', 'ok');
  } catch {
    els.keyOutput.focus();
    els.keyOutput.select();
    try {
      document.execCommand('copy');
      setToast('已复制完整密钥。', 'ok');
    } catch {
      setToast('复制失败，请手动选择并复制。', 'error');
    }
  }
}

async function clearLogs() {
  if (busy) return;
  if (!window.confirm('清空请求日志？此操作不会影响密钥或配置。')) return;
  busy = true;
  try {
    await api('/admin/api/logs/clear', { method: 'POST', body: {} });
    setToast('请求日志已清空。', 'ok');
    await refreshState();
  } catch (error) {
    if (error.status !== 401) setToast(error.message, 'error');
  } finally {
    busy = false;
  }
}

async function logout() {
  if (busy) return;
  busy = true;
  try {
    await api('/admin/api/logout', { method: 'POST', body: {} });
  } catch {
    // The local session may already be gone.
  } finally {
    busy = false;
    appState = null;
    configLoaded = false;
    configDirty = false;
    warnedTokenMismatch = false;
    warnedUnreadableKeys = false;
    els.configForm.reset();
    showLogin('');
    setToast('已退出管理端。');
  }
}

async function login(event) {
  event.preventDefault();
  const token = els.adminToken.value.trim();
  if (!token) {
    els.loginError.textContent = '请输入管理令牌。';
    return;
  }
  busy = true;
  setButtonBusy(els.loginButton, true, '验证中…');
  els.loginError.textContent = '';
  try {
    const result = await api('/admin/api/login', { method: 'POST', body: { token } });
    if (!result?.csrfToken) {
      throw new ApiError('登录响应缺少安全令牌，请重试。', 0, 'bad_login_response');
    }
    csrfToken = result.csrfToken;
    try {
      sessionStorage.setItem('vl_csrf', csrfToken);
    } catch {
      // The session still works in this tab; a reload will require login again.
    }
    els.adminToken.value = '';
    await loadState({ initial: true });
    showApp();
    startRefresh();
  } catch (error) {
    els.loginError.textContent = error.message;
    els.adminToken.focus();
  } finally {
    busy = false;
    setButtonBusy(els.loginButton, false, '', '进入管理端');
  }
}

function markConfigDirty() {
  configDirty = true;
}

function bindEvents() {
  els.loginForm.addEventListener('submit', login);
  els.configForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveConfig();
  });
  for (const input of [els.baseUrl, els.protocol, els.authMode, els.model, els.upstreamKey, els.clearUpstreamKey, els.publicBaseUrl]) {
    input.addEventListener('input', markConfigDirty);
    input.addEventListener('change', markConfigDirty);
  }
  els.toggleUpstreamKey.addEventListener('click', () => {
    const show = els.upstreamKey.type === 'password';
    els.upstreamKey.type = show ? 'text' : 'password';
    els.toggleUpstreamKey.textContent = show ? '隐藏' : '显示';
  });
  els.testUpstream.addEventListener('click', testUpstream);
  els.keyForm.addEventListener('submit', generateKey);
  els.logout.addEventListener('click', logout);
  els.refresh.addEventListener('click', async () => {
    const result = await refreshState();
    if (result === true) {
      setToast('状态已刷新。');
    } else if (result === false && !els.app.hidden) {
      setToast(els.serviceState.title || '刷新失败，请稍后重试。', 'error');
    }
  });
  els.clearLogs.addEventListener('click', clearLogs);
  els.copyKey.addEventListener('click', copyKey);
  els.keyDialog.addEventListener('close', () => {
    els.keyOutput.value = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !els.app.hidden) {
      refreshState().catch(() => {});
    }
  });
}

async function boot() {
  bindEvents();
  if (!csrfToken) {
    showLogin('');
    return;
  }
  try {
    await loadState({ initial: true });
    showApp();
    startRefresh();
  } catch (error) {
    if (error.status === 401 || error.code === 'csrf_failed') {
      showLogin('');
    } else {
      showLogin(error.message || '无法连接本机管理服务。');
    }
  }
}

boot();
