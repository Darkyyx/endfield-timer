import fs from 'node:fs';
import vm from 'node:vm';
import worker from './worker.js';

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* ---------- A. Worker：额度失败要能被后续"只读"请求如实上报 ---------- */
function makeKV(quota) {
  const m = new Map();
  const st = { put: 0, del: 0, quota };
  return {
    stats: st,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) {
      if (st.put >= st.quota) throw new Error('KV put() limit exceeded for the day.');
      st.put++; m.set(k, v);
    },
    async delete(k) {
      if (st.del >= st.quota) throw new Error('KV delete() limit exceeded for the day.');
      st.del++; m.delete(k);
    },
    async list(o) {
      const p = (o && o.prefix) || '';
      return { keys: [...m.keys()].filter(x => x.startsWith(p)).map(name => ({ name })) };
    }
  };
}

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"code":0}' });
const req = (path, body) => new Request('https://w.example' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Sync-Token': 'tok' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const body = (over) => Object.assign({
  v: 2, clientId: 'cX', clientHost: 'p.example', dirty: true,
  warnMinutes: 30, alertTypes: { full: true, empty: true },
  rows: [{ id: 'r1', name: '源矿', remark: '', region: 'wuling', prod: 1, cons: 0, stock: 100, ts: 1780000000000 }]
}, over || {});

console.log('A. Worker 上报额度状态');

await check('额度正常时不报 quota', async () => {
  const env = { STATE: makeKV(999), SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  const j = await (await worker.fetch(req('/sync', body()), env, {})).json();
  assert(j.quota === 0, 'quota = ' + j.quota);
  assert(!j.quotaAt, 'quotaAt 应为 0');
  return 'quota=0';
});

await check('写入命中额度上限 → 立刻报 quota=1 并给出可读信息', async () => {
  const kv = makeKV(1);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});     // 先让 owner 写掉那 1 次
  const j = await (await worker.fetch(req('/sync', body()), env, {})).json();
  assert(j.quota === 1, 'quota = ' + j.quota);
  assert(j.quotaAt > 0, 'quotaAt = ' + j.quotaAt);
  assert(/额度/.test(j.message || ''), '信息不可读：' + j.message);
  return 'quota=1 · ' + j.message;
});

await check('之后一次"只读"请求（dirty=false）也如实上报额度不足', async () => {
  const kv = makeKV(1);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});
  await worker.fetch(req('/sync', body()), env, {});                  // 这次失败，且记录了额度标记
  // 页面会把上次的额度时间戳回显上来（额度用尽时 Worker 自己写不进 KV）
  const j = await (await worker.fetch(req('/sync', body({ dirty: false, quotaAt: 1780000000000 })), env, {})).json();
  assert(j.quota === 1, '只读请求漏报了额度问题');
  assert(j.quotaAt > 0, '只读请求缺少 quotaAt');
  return '只读也能看到 quota=1';
});

await check('额度恢复后不再报 quota', async () => {
  const kv = makeKV(1);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});
  await worker.fetch(req('/sync', body()), env, {});                  // 失败一次
  kv.stats.quota = 999;                                               // 额度恢复
  const j = await (await worker.fetch(req('/sync', body()), env, {})).json();
  assert(j.quota === 0, '恢复后仍报 quota=1');
  return 'quota=0';
});

/* ---------- B. 前端：红灯与提示 ---------- */
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const items = fs.readFileSync(new URL('./items.js', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, classList: {
      _s: new Set(),
      add() { [...arguments].forEach(c => this._s.add(c)); },
      remove() { [...arguments].forEach(c => this._s.delete(c)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    children: [], listeners: {},
    value: '', textContent: '', innerHTML: '', className: '',
    readOnly: false, tabIndex: 0, disabled: false, checked: false,
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, height: 0, left: 0, right: 0, bottom: 0, width: 0 }; },
    focus() {}, blur() {}, contains() { return false; }, closest() { return null; }
  };
}

function boot(reply, preStore) {
  const els = Object.create(null);
  const getEl = id => (els[id] = els[id] || makeEl('div'));
  const store = new Map(preStore || []);
  store.set('endfield_line_timer_v2', JSON.stringify([
    { id: 'a', name: '源矿', remark: '', region: 'wuling', prod: 1, cons: 0, stock: 100, ts: Date.now(), editing: false }
  ]));
  store.set('endfield_notify_v1', JSON.stringify({
    url: 'https://demo.workers.dev', token: 'tok', warn: 30, on: true, warnFull: true, warnEmpty: true
  }));
  store.set('endfield_sent', '[]');
  const record = (init) => {
    if (!init || !init.body) return;
    try {
      const arr = JSON.parse(store.get('endfield_sent') || '[]');
      arr.push(JSON.parse(init.body));
      store.set('endfield_sent', JSON.stringify(arr));
    } catch (e) { /* 忽略非 JSON 请求体 */ }
  };
  const sandbox = {
    console,
    document: { getElementById: getEl, createElement: makeEl, querySelector: () => makeEl('div'), addEventListener() {}, hidden: false, activeElement: null },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    navigator: { sendBeacon: () => true },
    location: { host: 'demo.example', href: 'https://demo.example/', reload: () => {} },
    fetch: (url, init) => {
      record(init);
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(reply) });
    },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Blob: class { constructor(p) { this.parts = p; } },
    URL, Date, Math, JSON, Number, String, Array, Object, Error, isFinite, parseInt, parseFloat,
    confirm: () => confirmValue
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(items, sandbox, { filename: 'items.js' });
  vm.runInContext(code, sandbox, { filename: 'index-inline.js' });
  return { getEl, store, sent: () => JSON.parse(store.get('endfield_sent') || '[]') };
}

let confirmValue = true;

const okReply = { ok: 1, rows: 1, writes: 1, removed: 0, foreignRows: 0, quota: 0, quotaAt: 0, owner: { mine: true }, lastPushAt: 0, lastPushOk: true, lastError: null };
const quotaReply = Object.assign({}, okReply, { quota: 1, quotaAt: 1780000000000, message: 'KV 每日写入额度已用尽（免费版 1000 次/天），UTC 零点重置' });

console.log('\nB. 页面显示');

await check('额度用尽 → 状态为异常（红灯），而不是"正常"', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(s.includes('通知 异常'), '仍显示正常：' + s.slice(s.indexOf('nstat')));
  assert(!s.includes('通知 正常'), '不能出现绿灯');
  return '通知 异常';
});

await check('消息区说明是 KV 额度问题，并说明本地倒计时不受影响', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const msg = String(getEl('ntMsg').textContent);
  assert(/额度/.test(msg), '未提示额度：' + msg);
  assert(/未存入/.test(msg), '未说明数据没存进去：' + msg);
  return msg.slice(0, 40) + '…';
});

await check('额度状态跨刷新保留（不会因为刷新又变绿灯）', async () => {
  const { getEl, store } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  assert(store.get('endfield_quota_at'), '未持久化额度时间戳');

  // 模拟刷新：带着上次的额度时间戳重新启动
  const again = boot(okReply, [['endfield_quota_at', store.get('endfield_quota_at')]]);
  const s = again.getEl('stats').innerHTML;
  assert(s.includes('通知 异常'), '刷新后变回绿灯：' + s.slice(s.indexOf('nstat')));
  return '刷新后仍是异常';
});

await check('额度恢复（quota=0）后回到正常', async () => {
  const { getEl, store } = boot(okReply, [['endfield_quota_at', '1780000000000']]);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(s.includes('通知 正常'), '恢复后未回到正常：' + s.slice(s.indexOf('nstat')));
  assert(!store.get('endfield_quota_at'), '额度标记未清除');
  return '通知 正常，标记已清除';
});

console.log('\nC. 手动「立即同步」不受自动优化约束');

await check('自动同步在无改动时标注"未写入"', async () => {
  const { getEl } = boot(Object.assign({}, okReply, { writes: 0 }));
  await new Promise(r => setTimeout(r, 1700));   // 等进入页面时那次自动同步
  const msg = String(getEl('ntMsg').textContent);
  assert(/未写入/.test(msg), '未说明没有写入：' + msg);
  return msg;
});

await check('手动「立即同步」强制推送：dirty=true 且不再说"未写入"', async () => {
  const { getEl, sent } = boot(Object.assign({}, okReply, { writes: 0 }));
  await new Promise(r => setTimeout(r, 1700));
  const before = sent().length;
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const all = sent();
  assert(all.length > before, '手动同步没有发出请求');
  assert(all[all.length - 1].dirty === true, '手动同步的 dirty = ' + all[all.length - 1].dirty);
  const msg = String(getEl('ntMsg').textContent);
  assert(!/未写入/.test(msg), '手动同步不该说"未写入"：' + msg);
  return 'dirty=true，已推送 ' + all[all.length - 1].rows.length + ' 行';
});

await check('只读状态下手动「立即同步」也会真的发出去（不再被静默挡掉）', async () => {
  confirmValue = false;   // 询问一律选"不导入"
  const conflict = { ok: 0, code: 'owner_mismatch', message: '另一个页面正在作为通知源', owner: { host: 'old.example' }, rows: 1 };
  const { getEl, sent } = boot(conflict);

  getEl('ntNow').listeners.click.forEach(fn => fn());     // 触发询问 → 选不导入 → 进入只读
  await new Promise(r => setTimeout(r, 100));
  assert(/只读/.test(String(getEl('ntMsg').textContent)), '未进入只读：' + getEl('ntMsg').textContent);

  const before = sent().length;
  getEl('ntNow').listeners.click.forEach(fn => fn());     // 只读下的手动同步
  await new Promise(r => setTimeout(r, 100));
  assert(sent().length > before, '只读时手动同步被静默挡掉了');
  confirmValue = true;
  return '已发出请求（会被 Worker 以 409 告知去向）';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
