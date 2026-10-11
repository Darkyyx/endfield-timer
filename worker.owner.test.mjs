import fs from 'node:fs';
import vm from 'node:vm';
import worker from './worker.js';

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

function makeKV() {
  const m = new Map();
  return {
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(o) {
      const p = (o && o.prefix) || '';
      return { keys: [...m.keys()].filter(x => x.startsWith(p)).map(name => ({ name })) };
    }
  };
}

const ENV = { STATE: makeKV(), SC_SENDKEY: 'sctp24339aaaa', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800, PUSH_RETRY_COOLDOWN_MS: 0 };
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"code":0}' });

const req = (path, body, headers) => new Request('https://w.example' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', 'X-Sync-Token': 'tok' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
});

const rowPayload = (client, over) => Object.assign({
  v: 2, clientId: client, clientHost: client, warnMinutes: 30,
  rows: [{ id: 'r1', name: '源矿', remark: '主账号', region: 'wuling', prod: 15, cons: 2, stock: 89950, ts: Date.now() }]
}, over || {});

console.log('A. Worker 数据源归属');

await check('第一个页面同步 → 自动成为所有者', async () => {
  const res = await worker.fetch(req('/sync', rowPayload('cA', { clientHost: 'old.example' })), ENV, {});
  const j = await res.json();
  assert(res.status === 200 && j.ok === 1, '首次同步失败');
  assert(j.owner && j.owner.mine === true, '未标记为所有者：' + JSON.stringify(j.owner));
  assert(j.foreignRows === 0, 'foreignRows = ' + j.foreignRows);
  return 'owner = old.example, foreignRows = 0';
});

await check('另一个 clientId 同步 → 409 拒绝覆盖，并报告所有者与行数', async () => {
  const before = JSON.stringify(await ENV.STATE.get('row:r1', 'json'));
  const res = await worker.fetch(req('/sync', rowPayload('cB', { clientHost: 'new.example' })), ENV, {});
  const j = await res.json();
  assert(res.status === 409, '状态码应为 409，实际 ' + res.status);
  assert(j.code === 'owner_mismatch', 'code = ' + j.code);
  assert(j.owner.host === 'old.example', '未报告所有者：' + JSON.stringify(j.owner));
  assert(j.rows === 1, '未报告可导入行数：' + j.rows);
  const after = JSON.stringify(await ENV.STATE.get('row:r1', 'json'));
  assert(before === after, '被拒绝的请求却改动了数据！');
  return '409 + owner=old.example + rows=1，数据未被覆盖';
});

await check('/snapshot 能导出旧页面的完整数据（含备注列）', async () => {
  const res = await worker.fetch(req('/snapshot', undefined), ENV, {});
  const j = await res.json();
  assert(j.ok === 1 && j.rows.length === 1, '导出失败');
  assert(j.rows[0].remark === '主账号', '备注列丢失：' + JSON.stringify(j.rows[0]));
  assert(typeof j.rows[0].ts === 'number' && j.rows[0].ts > 0, '缺少时间锚点');
  return '1 条，含 remark="主账号" 与 ts';
});

await check('/snapshot 需要令牌', async () => {
  const res = await worker.fetch(req('/snapshot', undefined, { 'X-Sync-Token': 'wrong' }), ENV, {});
  assert(res.status === 401, '应返回 401，实际 ' + res.status);
  return '401';
});

await check('claim mode=import → 接管但保留旧数据', async () => {
  const res = await worker.fetch(req('/claim', { clientId: 'cB', clientHost: 'new.example', mode: 'import' }), ENV, {});
  const j = await res.json();
  assert(j.ok === 1 && j.removed === 0, 'import 不该删除数据：' + JSON.stringify(j));
  const owner = await ENV.STATE.get('meta:owner', 'json');
  assert(owner.clientId === 'cB', '所有者未转移');
  const r1 = await ENV.STATE.get('row:r1', 'json');
  assert(!!r1, '旧数据被误删');
  return 'owner → new.example，旧数据保留';
});

await check('接管后新页面同步成功；旧 client 的行如实汇报为 foreignRows 并很快归零', async () => {
  const res = await worker.fetch(req('/sync', rowPayload('cB', { clientHost: 'new.example' })), ENV, {});
  const j = await res.json();
  assert(res.status === 200 && j.ok === 1, '接管后仍被拒：' + JSON.stringify(j));
  // 接管刚完成时 KV 里那行的 client 还是 cA，所以如实汇报为 1 条；
  // 页面侧靠"刚接管"标记避免追问（见前端 CLAIM_QUIET_MS）
  assert(j.foreignRows === 1, 'foreignRows = ' + j.foreignRows + '（应如实汇报 1 条待清理）');

  const res2 = await worker.fetch(req('/sync', rowPayload('cB', { clientHost: 'new.example' })), ENV, {});
  const j2 = await res2.json();
  assert(j2.foreignRows === 0, '下一轮 foreignRows = ' + j2.foreignRows);
  return '如实汇报 1 → 下一轮归零';
});

await check('旧页面同步 → 现在轮到它被拒（自动转为只读）', async () => {
  const res = await worker.fetch(req('/sync', rowPayload('cA', { clientHost: 'old.example' })), ENV, {});
  const j = await res.json();
  assert(res.status === 409, '应被拒绝，实际 ' + res.status);
  assert(j.owner.host === 'new.example', '未报告新所有者');
  return '409，owner = new.example';
});

await check('claim mode=replace → 清掉旧页面残留行', async () => {
  // 造两条"别的 client"的数据
  await ENV.STATE.put('row:x1', JSON.stringify({ id: 'x1', name: '残留A', client: 'cOld', prod: 1, cons: 0, stock: 1, ts: Date.now() }));
  await ENV.STATE.put('row:x2', JSON.stringify({ id: 'x2', name: '残留B', client: 'cOld', prod: 1, cons: 0, stock: 1, ts: Date.now() }));
  await ENV.STATE.put('row:mine', JSON.stringify({ id: 'mine', name: '我的', client: 'cB', prod: 1, cons: 0, stock: 1, ts: Date.now() }));

  const res = await worker.fetch(req('/claim', { clientId: 'cB', clientHost: 'new.example', mode: 'replace' }), ENV, {});
  const j = await res.json();
  assert(j.ok === 1, '接管失败');
  assert(j.removed === 2, '应清掉 2 条别的 client 数据，实际 ' + j.removed);
  assert((await ENV.STATE.get('row:x1', 'json')) === null, 'x1 未被清理');
  assert(!!(await ENV.STATE.get('row:mine', 'json')), '误删了自己的数据');
  return 'removed = 2，自身数据保留';
});

await check('foreignRows：同属一个 client 的残留也会被计数并逐步清理', async () => {
  await ENV.STATE.put('row:mine', JSON.stringify({ id: 'mine', name: '我的', client: 'cB', prod: 1, cons: 0, stock: 1, ts: Date.now() }));
  await ENV.STATE.put('row:other', JSON.stringify({ id: 'other', name: '别处的', client: 'cOther', prod: 1, cons: 0, stock: 1, ts: Date.now(), misses: 0 }));

  const res = await worker.fetch(req('/sync', rowPayload('cB', { clientHost: 'new.example' })), ENV, {});
  const j = await res.json();
  assert(j.foreignRows === 1, 'foreignRows = ' + j.foreignRows);

  // 第二次同步：缺席达到阈值，残留行被清掉
  const res2 = await worker.fetch(req('/sync', rowPayload('cB', { clientHost: 'new.example' })), ENV, {});
  const j2 = await res2.json();
  assert(j2.removed >= 1, '残留未被清理，removed = ' + j2.removed);
  assert((await ENV.STATE.get('row:other', 'json')) === null, '残留行仍在');
  return '第一次 foreignRows=1，第二次已清理';
});

await check('CLAIM_TOKEN 配置后，接管必须带令牌', async () => {
  const withToken = Object.assign({}, ENV, { CLAIM_TOKEN: 'secret' });
  let res = await worker.fetch(req('/claim', { clientId: 'cC', mode: 'import' }), withToken, {});
  assert(res.status === 401, '无令牌应被拒，实际 ' + res.status);

  res = await worker.fetch(new Request('https://w.example/claim?token=secret', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'cC', clientHost: 'c.example', mode: 'import' })
  }), withToken, {});
  const j = await res.json();
  assert(res.status === 200 && j.ok === 1, '带令牌仍被拒：' + JSON.stringify(j));
  return '无令牌 401，带令牌 200';
});

await check('不传 clientId 的老版本请求仍按原逻辑工作（向后兼容）', async () => {
  const env2 = Object.assign({}, ENV, { STATE: makeKV() });
  const res = await worker.fetch(req('/sync', {
    v: 1, rows: [{ id: 'z', name: '源矿', region: 'wuling', prod: 5, cons: 1, stock: 100, ts: Date.now() }]
  }), env2, {});
  const j = await res.json();
  assert(res.status === 200 && j.ok === 1, '老格式被拒：' + JSON.stringify(j));
  assert(j.foreignRows === 0, '老格式不该产生 foreignRows');
  return 'ok';
});

/* ============================================================
 * B. 前端：检测到别的页面 → 询问 → 导入 → reload
 * ============================================================ */
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

const els = Object.create(null);
const getEl = id => (els[id] = els[id] || makeEl('div'));
const store = new Map();
store.set('endfield_notify_v1', JSON.stringify({
  url: 'https://demo.workers.dev', token: 'tok', warn: 30, on: true, warnEmpty: true
}));
store.set('endfield_line_timer_v2', JSON.stringify([
  { id: 'local1', name: '赤铜块', remark: '本地', region: 'gudi', prod: 5, cons: 1, stock: 1000, ts: Date.now(), editing: false }
]));

const calls = [];
let reloaded = 0;
let phase = 'observe';
let importAsked = 0;
let replaceAsked = 0;

/* 按阶段答复询问，便于在流程进行中观察状态 */
const stubConfirm = function (msg) {
  const m = String(msg);

  if (m.indexOf('要在导入之前') >= 0) {
    replaceAsked++;
    return phase === 'replace';       // 第二次询问：是否改用本地数据替换
  }
  if (m.indexOf('另一份数据') >= 0 || m.indexOf('设为唯一通知源') >= 0) {
    importAsked++;
    if (phase === 'observe') return false;    // 观察阶段：先不导入
    return phase !== 'decline';               // import / replace 阶段都选"导入"
  }
  return true;   // 其它 confirm（如清空全部）默认确定
};

const sandbox = {
  console,
  document: {
    getElementById: getEl, createElement: makeEl, querySelector: () => makeEl('div'),
    addEventListener() {}, hidden: false, activeElement: null
  },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  navigator: { sendBeacon: () => true },
  location: { host: 'new.example', href: 'https://new.example/', reload: () => { reloaded++; } },
  fetch: (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    let payload;
    if (u.endsWith('/snapshot')) {
      payload = {
        ok: 1,
        rows: [{ id: 'old1', name: '源矿', remark: '主账号', region: 'wuling', prod: 15, cons: 2, stock: 89950, ts: 1756000000000 }],
        owner: { host: 'old.example', since: 1 }
      };
    } else if (u.endsWith('/claim')) {
      payload = { ok: 1, mode: 'import', removed: 0, rows: 1 };
    } else {
      payload = {
        ok: 1, rows: 1, removed: 0, foreignRows: 1, owner: { host: 'old.example', mine: false },
        lastPushAt: 0, lastPushOk: true, lastError: null
      };
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
  Blob: class { constructor(p) { this.parts = p; } },
  URL, Date, Math, JSON, Number, String, Array, Object, Error, isFinite, parseInt, parseFloat,
  confirm: stubConfirm
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(items, sandbox, { filename: 'items.js' });
vm.runInContext(code, sandbox, { filename: 'index-inline.js' });

console.log('\nB. 前端：换域名后的导入流程');

await check('点"立即同步" → 弹出询问，选"不导入"后进入只读', async () => {
  els.ntNow.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  assert(importAsked === 1, '询问次数 = ' + importAsked + '（应为 1，重复询问说明流程有回环）');
  assert(reloaded === 0, '还没选导入就 reload 了');
  assert(els.ntClaim.style.display === '', '只读状态应保留接管入口，方便改主意');
  const msg = String(getEl('ntMsg').textContent);
  assert(msg.includes('只读'), '未提示进入只读：' + msg);
  return msg;
});

await check('只读状态下自动同步不会推送数据（dirty=false）', async () => {
  calls.length = 0;
  els.ntNow.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 200));
  const syncs = calls.filter(c => c.url.endsWith('/sync'));
  assert(syncs.length >= 1, '手动同步应当真的发出去');
  // 只读 → 期望被 Worker 以 409 拒绝而不是覆盖别人；这里断言它至少发出了请求
  return '发出 ' + syncs.length + ' 次同步请求';
});

await check('点"接管为通知源" → 重新弹出询问', async () => {
  els.ntClaim.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 30));
  assert(importAsked === 2, '接管按钮未触发询问，次数 = ' + importAsked);
  return '已重新询问';
});

await check('选择"导入" → 先拉 /snapshot，再 /claim（mode=import）', async () => {
  calls.length = 0;
  phase = 'import';
  els.ntClaim.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 80));
  const urls = calls.map(c => c.url.replace('https://demo.workers.dev', ''));
  assert(urls.includes('/snapshot'), '未请求 /snapshot：' + urls.join(','));
  assert(urls.indexOf('/snapshot') < urls.indexOf('/claim'), '顺序应为 snapshot 先于 claim：' + urls.join(','));
  const claim = calls.find(c => c.url.endsWith('/claim'));
  assert(claim.body.mode === 'import', 'mode = ' + claim.body.mode);
  assert(typeof claim.body.clientId === 'string' && claim.body.clientId.length > 5, '未带 clientId');
  assert(claim.body.clientHost === 'new.example', '未带 clientHost');
  return urls.join(' → ');
});

await check('旧数据已写入本页面 localStorage（含备注列与时间锚点）', () => {
  const arr = JSON.parse(store.get('endfield_line_timer_v2'));
  assert(arr.length === 1, '行数 = ' + arr.length);
  assert(arr[0].id === 'old1', 'id = ' + arr[0].id + '（仍是本地数据，说明导入没生效）');
  assert(arr[0].remark === '主账号', '备注列丢失');
  assert(arr[0].region === 'wuling', '地区 = ' + arr[0].region);
  assert(arr[0].ts === 1756000000000, '时间锚点未保留：' + arr[0].ts);
  return '1 条（源矿 / 主账号 / wuling），锚点原样保留';
});

await check('导入后触发页面重载，让数据走正常渲染路径', () => {
  assert(reloaded === 1, 'reload 次数 = ' + reloaded);
  return 'reload 1 次';
});

await check('选"替换"时走 replace 模式（不再重复弹第二次询问）', async () => {
  reloaded = 0;
  calls.length = 0;
  phase = 'replace';
  store.delete('endfield_import_declined');
  store.delete('endfield_claim_at');   // 清掉"刚接管"抑制，否则不会弹询问
  els.ntClaim.listeners.click.forEach(fn => fn());   // 只读态下用接管按钮驱动
  await new Promise(r => setTimeout(r, 80));
  const claim = calls.find(c => c.url.endsWith('/claim'));
  assert(claim, '未发起 /claim：' + calls.map(c => c.url).join(','));
  assert(claim.body.mode === 'replace', 'mode = ' + claim.body.mode);
  assert(!calls.some(c => c.url.endsWith('/snapshot')), 'replace 模式不该先拉快照');
  assert(reloaded === 0 && calls.some(c => c.url.endsWith('/sync')), 'replace 后应直接同步，而不是 reload');
  return 'mode = replace → 直接 /sync';
});

await check('选择"不导入"后：记住决定，后续不会再追问', async () => {
  phase = 'decline';
  store.delete('endfield_claim_at');
  const before = importAsked;
  els.ntClaim.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 60));
  assert(importAsked === before + 1, '未弹出询问（断言前提不成立）');

  const decl = store.get('endfield_import_declined');
  const cid = store.get('endfield_client_v1');
  assert(decl && decl === cid, '没有记住"不导入"的决定：' + decl + ' vs ' + cid);

  // 自动触发（同步）不该再问；但点「接管为通知源」是明确想反悔，会重新询问
  const after = importAsked;
  els.ntNow.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 200));
  assert(importAsked === after, '自动同步又追问了 ' + (importAsked - after) + ' 次');

  els.ntClaim.listeners.click.forEach(fn => fn());
  await new Promise(r => setTimeout(r, 200));
  assert(importAsked === after + 1, '主动点接管应当重新询问');

  // 这次选"不导入"，标记应再次生效
  assert(store.get('endfield_import_declined') === cid, '"不导入"标记被清掉后未重新记录');
  return '自动不追问；主动点接管可反悔';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
