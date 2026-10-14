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

function boot(reply, preStore, rowJson) {
  const els = Object.create(null);
  const getEl = id => (els[id] = els[id] || makeEl('div'));
  const store = new Map(preStore || []);
  /* rowJson 可覆盖"存储里的行内容"，用来构造"与上次同步快照一致/不一致"两种启动状态 */
  store.set('endfield_line_timer_v2', rowJson || JSON.stringify([
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

/* 版本号从源码里读，避免每次升版本都要改测试 */
const pageVersion = (fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .match(/const PAGE_VERSION = '([^']+)'/) || [])[1] || '';
const workerVersion = (fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
  .match(/const WORKER_VERSION = '([^']+)'/) || [])[1] || '';

const okReply = { ok: 1, worker: pageVersion, rows: 1, writes: 1, removed: 0, foreignRows: 0, quota: 0, quotaAt: 0, owner: { mine: true }, lastPushAt: 0, lastPushOk: true, lastError: null };
const quotaReply = Object.assign({}, okReply, { quota: 1, quotaAt: 1780000000000, message: 'KV 每日写入额度已用尽（免费版 1000 次/天），UTC 零点重置' });

console.log('\nB. 页面显示');

await check('额度用尽 → 状态为异常（红灯），而不是"正常"', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(s.includes('同步 异常'), '仍显示正常：' + s.slice(s.indexOf('nstat')));
  assert(!s.includes('同步 正常'), '不能出现绿灯');
  return '同步 异常';
});

await check('消息区说明是 KV 额度问题，并说明本地倒计时不受影响', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const msg = String(getEl('ntMsg').textContent);
  assert(/额度/.test(msg), '未提示额度：' + msg);
  assert(/额度已用尽/.test(msg), '未说明额度问题：' + msg);
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
  assert(s.includes('同步 异常'), '刷新后变回绿灯：' + s.slice(s.indexOf('nstat')));
  return '刷新后仍是异常';
});

await check('额度恢复（quota=0）后回到正常', async () => {
  const { getEl, store } = boot(okReply, [['endfield_quota_at', '1780000000000']]);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(s.includes('同步 正常'), '恢复后未回到正常：' + s.slice(s.indexOf('nstat')));
  assert(!store.get('endfield_quota_at'), '额度标记未清除');
  return '同步 正常，标记已清除';
});

console.log('\nC0. 状态文案：只反映数据同步，不夹带通知状态');

await check('状态里只有"已同步 N 条"，不带通知/推送之类的字眼', async () => {
  const { getEl } = boot(Object.assign({}, okReply, { lastPushAt: 0, writes: 0 }));
  await new Promise(r => setTimeout(r, 1700));
  const msg = String(getEl('ntMsg').textContent);
  assert(/^已同步 \d+ 条/.test(msg), '应报出本轮同步结果：' + msg);
  // 通知有没有发出过不属于"同步状态"，混在这里会读成自相矛盾
  ['通知', '推送', '尚无', '未写入'].forEach(w => {
    assert(msg.indexOf(w) < 0, '状态里不该出现「' + w + '」：' + msg);
  });
  return msg;
});

await check('发过通知与否，状态文案完全一样', async () => {
  const a = boot(Object.assign({}, okReply, { lastPushAt: 0 }));
  await new Promise(r => setTimeout(r, 1700));
  const msgA = String(a.getEl('ntMsg').textContent);
  const b = boot(Object.assign({}, okReply, { lastPushAt: Date.now() - 60000 }));
  await new Promise(r => setTimeout(r, 1700));
  const msgB = String(b.getEl('ntMsg').textContent);
  assert(msgA === msgB, '两者应当一致：' + msgA + ' vs ' + msgB);
  return msgA;
});

/* 按页面 rowsSnapshot() 的键序生成行指纹，避免手写 JSON 时键序不一致导致比对失败 */
function snap(rows) {
  return JSON.stringify(rows.map(r => ({
    id: r.id, name: r.name, remark: r.remark || '', region: r.region,
    prod: r.prod, cons: r.cons, stock: r.stock, ts: r.ts
  })));
}
const ROW = (ts) => [{ id: 'a', name: '源矿', remark: '', region: 'wuling', prod: 1, cons: 0, stock: 100, ts: ts }];

await check('加载时总会同步一次：没改动也发请求，但带 dirty=false（Worker 不写 KV）', async () => {
  // 发请求是为了让状态灯有确定结果；dirty=false 才是省额度的地方
  // writes=0 是"Worker 一个键都没写"的如实回执，状态里应据此标注（无改动）
  const only = ROW(1780000000000);
  const { sent, getEl } = boot(Object.assign({}, okReply, { writes: 0 }),
    [['endfield_synced_rows_v1', snap(only)]], JSON.stringify(only));
  await new Promise(r => setTimeout(r, 1700));
  assert(sent().length === 1, '应发 1 次请求，实际 ' + sent().length);
  assert(sent()[0].dirty === false, '无改动时 dirty 应为 false，实际 ' + sent()[0].dirty
    + '（载荷 rows=' + JSON.stringify(sent()[0].rows) + '）');
  // 状态灯必须从"等待首次同步…"变成确定结果
  const msg = String(getEl('ntMsg').textContent);
  assert(!/等待首次同步/.test(msg), '状态一直停在等待首次同步：' + msg);
  assert(/^已同步 \d+ 条（无改动）$/.test(msg), '应给出确定结果：' + msg);
  return msg + ' / dirty=false';
});

await check('有未同步改动时，加载同步带 dirty=true 且不标"无改动"', async () => {
  // 快照是旧锚点，本地已改过（ts 不同）
  const { sent, getEl } = boot(okReply, [['endfield_synced_rows_v1', snap(ROW(1780000000000))]], JSON.stringify(ROW(1780000900000)));
  await new Promise(r => setTimeout(r, 1700));
  assert(sent().length === 1, '应发 1 次请求，实际 ' + sent().length);
  assert(sent()[0].dirty === true, '有改动时 dirty 应为 true，实际 ' + sent()[0].dirty);
  const msg = String(getEl('ntMsg').textContent);
  assert(!/无改动/.test(msg), '有改动却被标成无改动：' + msg);
  return msg + ' / dirty=true';
});

console.log('\nC. 手动「立即同步」不受自动优化约束');

await check('手动「立即同步」强制推送：dirty=true', async () => {
  const { getEl, sent } = boot(Object.assign({}, okReply, { writes: 0 }));
  await new Promise(r => setTimeout(r, 1700));
  const before = sent().length;
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const all = sent();
  assert(all.length > before, '手动同步没有发出请求');
  assert(all[all.length - 1].dirty === true, '手动同步的 dirty = ' + all[all.length - 1].dirty);
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

console.log('\nD. 重置时间与文案');

await check('额度提示里的重置时间按 UTC+8 显示，不再是 UTC', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const msg = String(getEl('ntMsg').textContent);
  assert(!/UTC/.test(msg), '文案里仍有 UTC：' + msg);
  assert(/每天 8:00 点重置/.test(msg), '未按北京时间 8:00 显示：' + msg);
  return msg.slice(0, 46) + '…';
});

await check('额度文案只说明额度与重置时间，不再额外解释通知行为', async () => {
  const { getEl } = boot(quotaReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const msg = String(getEl('ntMsg').textContent);
  assert(!/通知会停/.test(msg), '仍在错误地宣称通知会停：' + msg);
  assert(!/最后一份快照|反复触发提醒/.test(msg), '仍带有被要求删除的解释：' + msg);
  assert(/免费版 1000 次\/天/.test(msg), '缺少额度说明：' + msg);
  return msg;
});

console.log('\nE. 过期额度标记必须能自己解开（曾出现自我维持的死循环）');

await check('页面报额度不足但 KV 无记录 → Worker 执行探测写入并纠正判断', async () => {
  const kv = makeKV(999);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});
  const before = kv.stats.put;
  // 页面带着一个过期的 quotaAt 上来，且本次没有需要写入的内容
  const res = await worker.fetch(req('/sync', body({ dirty: false, quotaAt: 1780000000000 })), env, {});
  const j = await res.json();
  assert(kv.stats.put > before, '未做探测写入，过期标记无法被纠正');
  assert(j.quota === 0, '额度可用却仍报 quota=1：' + JSON.stringify(j));
  assert(j.quotaAt === 0, 'quotaAt 未清零：' + j.quotaAt);
  return '探测写入后纠正为 quota=0';
});

await check('探测写入失败时如实报告额度不足', async () => {
  const kv = makeKV(999);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});
  kv.stats.quota = kv.stats.put;      // 从此写入全部失败
  const res = await worker.fetch(req('/sync', body({ dirty: false, quotaAt: 1780000000000 })), env, {});
  const j = await res.json();
  assert(j.quota === 1, '探测失败却报正常：' + JSON.stringify(j));
  assert(j.probed === 1, '未标记为探测结果');
  assert(j.quotaAt > 1780000000000, '未更新时间戳：' + j.quotaAt);
  return 'reportedQuotaAt 更新为 ' + j.quotaAt;
});

await check('额度恢复后再次请求 → 标记自动清除', async () => {
  const kv = makeKV(999);
  const env = { STATE: kv, SC_SENDKEY: 'sctp1a', WARN_SECONDS: 1800 };
  await worker.fetch(req('/sync', body({ rows: [] })), env, {});
  kv.stats.quota = kv.stats.put;
  await worker.fetch(req('/sync', body({ dirty: false, quotaAt: 1780000000000 })), env, {});   // 失败一次，写入标记
  kv.stats.quota = 999;                                                                          // 额度恢复
  const res = await worker.fetch(req('/sync', body({ dirty: false, quotaAt: 1780000000000 })), env, {});
  const j = await res.json();
  assert(j.quota === 0 && j.quotaAt === 0, '恢复后未清除标记：' + JSON.stringify(j));
  const meta = await kv.get('meta:config', 'json');
  assert(!meta.lastQuotaAt, 'KV 里的标记未清除：' + JSON.stringify(meta));
  return 'quota=0，KV 标记已清';
});

await check('页面侧：success 响应会清除本地 quota 标记', async () => {
  const withFlag = [['endfield_quota_at', '1780000000000']];
  const { getEl, store } = boot(okReply, withFlag);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 80));
  assert(!store.get('endfield_quota_at'), '本地标记未被清除：' + store.get('endfield_quota_at'));
  assert(getEl('stats').innerHTML.includes('同步 正常'), '未回到绿灯');
  return '本地标记已清，状态回到正常';
});

console.log('\nF. Worker 版本一致性');

await check('页面与 Worker 的版本号常量保持一致', () => {
  assert(pageVersion, '未找到 PAGE_VERSION');
  assert(workerVersion, '未找到 WORKER_VERSION');
  assert(pageVersion === workerVersion, '两边版本不一致：页面 ' + pageVersion + ' / Worker ' + workerVersion);
  return 'v' + pageVersion;
});

await check('Worker 版本与页面不一致 → 红灯并提示重新部署', async () => {
  const stale = Object.assign({}, okReply, { worker: '0.0.1' });
  const { getEl } = boot(stale);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const msg = String(getEl('ntMsg').textContent);
  const s = getEl('stats').innerHTML;
  assert(s.includes('同步 异常'), '未亮红灯：' + s.slice(s.indexOf('nstat')));
  assert(/版本不一致/.test(msg), '未提示版本问题：' + msg);
  assert(msg.indexOf('0.0.1') >= 0, '未列出 Worker 版本：' + msg);
  assert(msg.indexOf(pageVersion) >= 0, '未列出版本页面的版本号：' + msg);
  return msg.slice(0, 44) + '…';
});

await check('版本一致时不受影响', async () => {
  const { getEl } = boot(okReply);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(s.includes('同步 正常'), '版本一致却报错：' + s.slice(s.indexOf('nstat')));
  return '同步 正常';
});

await check('旧版 Worker 不返回 worker 字段时不误报', async () => {
  const legacy = Object.assign({}, okReply);
  delete legacy.worker;
  const { getEl } = boot(legacy);
  getEl('ntNow').listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  const s = getEl('stats').innerHTML;
  assert(!s.includes('同步 异常'), '旧版 Worker 被误判：' + s.slice(s.indexOf('nstat')));
  return '不误报';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
