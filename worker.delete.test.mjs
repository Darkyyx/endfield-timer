import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const items = fs.readFileSync(new URL('./items.js', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

function makeEl(tag, q) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, attrs: {}, children: [], listeners: {},
    value: '', textContent: '', innerHTML: '', className: '', checked: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) { return (this._q && this._q[sel]) || makeEl('div'); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, height: 0, left: 0, right: 0, bottom: 0, width: 0 }; },
    focus() {}, blur() {}, contains() { return false; }, closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
  if (q) el._q = q;
  return el;
}

/* 让行元素里的查询返回带监听器的节点，才能模拟点删除 */
function boot(rows) {
  const els = Object.create(null);
  const getEl = id => (els[id] = els[id] || makeEl('div'));
  const store = new Map();
  store.set('endfield_line_timer_v2', JSON.stringify(rows.map(r => Object.assign({
    remark: '', region: 'wuling', prod: 0, cons: 0, stock: 0, ts: Date.now(), editing: false
  }, r))));
  store.set('endfield_notify_v1', JSON.stringify({
    url: 'https://demo.workers.dev', token: 'tok', warn: 30, on: true, warnFull: true, warnEmpty: true
  }));

  const requests = [];
  const delBtn = makeEl('button');
  /* 行元素里的 .del 统一指向同一个按钮，这样测试点一次就等于用户点一次删除 */
  const rowQ = {
    '.del': delBtn,
    '.edit-btn': makeEl('button'),
    '[data-k="stock"]': makeEl('input'),
    '[data-k="name"]': makeEl('option'),
    '[data-k="region"]': makeEl('option'),
    '.name-cell': makeEl('div'),
    '.region-cell': makeEl('div')
  };

  const sandbox = {
    console,
    document: {
      documentElement: makeEl('html'),
      getElementById: getEl, createElement: (tag) => makeEl(tag, rowQ),
      querySelector: () => makeEl('div'), addEventListener() {}, hidden: false, activeElement: null
    },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    navigator: { sendBeacon: () => true },
    location: { host: 'demo.example', href: 'https://demo.example/', reload: () => {} },
    fetch: (u, o) => { requests.push({ url: String(u), body: o && o.body }); return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: 1, rows: rows.length, writes: 1, removed: 1, foreignRows: 0, quota: 0, quotaAt: 0, owner: { mine: true }, lastPushAt: 0, lastPushOk: true, lastError: null }) }); },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Blob: class { constructor(p) { this.parts = p; } },
    URL, Date, Math, JSON, Number, String, Array, Object, Error, isFinite, parseInt, parseFloat, Intl, RegExp,
    confirm: () => true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(items, sandbox, { filename: 'items.js' });
  vm.runInContext(code, sandbox, { filename: 'index-inline.js' });
  return { getEl, store, requests, delBtn };
}

console.log('删除条目必须触发同步');

await check('删除处理里调用了同步调度（不能只 save + render）', () => {
  const src = html.slice(html.indexOf("el.querySelector('.del')"), html.indexOf('/* ================= 图标 ================='));
  assert(/notify\.scheduleSync\(/.test(src), '删除处理里没有调用 scheduleSync：' + src);
  assert(/notify\.onEditingChange\(\)/.test(src), '删除处理里没有调用 onEditingChange：' + src);
  return 'scheduleSync + onEditingChange 都在';
});

await check('删除后会把带 dirty 的全量快照发出去', async () => {
  const b = boot([{ id: 'a', name: '爆仓的', stock: 90000 }]);
  // 找出行元素：render 会创建，这里直接拿脚本暴露的删除路径来验证 fetch 是否发生
  const before = b.requests.length;
  // 触发一次同步（等价于删除后 scheduleSync 到点执行）
  assert(b.delBtn, '未取到删除按钮');
  return '（见下条：用真实删除路径验证）';
});

await check('删除路径确实发出 /sync 请求并带 dirty:true', async () => {
  const b = boot([{ id: 'a', name: '爆仓的', stock: 90000 }]);
  // render() 在启动时已跑过；直接调用删除按钮的监听器
  const fns = b.delBtn.listeners.click || [];
  assert(fns.length > 0, '删除按钮没有绑定监听器');
  fns.forEach(fn => fn());
  // scheduleSync 有 600ms 延迟
  await new Promise(r => setTimeout(r, 800));
  const sync = b.requests.filter(r => /\/sync$/.test(r.url));
  assert(sync.length > 0, '删除后没有发出 /sync 请求，实际请求：' + JSON.stringify(b.requests.map(r => r.url)));
  const body = JSON.parse(sync[sync.length - 1].body);
  assert(body.dirty === true, '同步载荷的 dirty 应为 true，实际 ' + body.dirty);
  assert(Array.isArray(body.rows) && body.rows.length === 0, '删除后快照里不该还有那条：' + JSON.stringify(body.rows));
  return '发出 ' + sync.length + ' 次同步，rows=0, dirty=true';
});

await check('Worker 侧：一次全量同步就清掉缺失的行（DELETE_AFTER_MISSES=1）', () => {
  const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const v = (src.match(/DELETE_AFTER_MISSES:\s*(\d+)/) || [])[1];
  assert(v === '1', 'DELETE_AFTER_MISSES 应为 1，实际 ' + v);
  return 'DELETE_AFTER_MISSES = 1';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
