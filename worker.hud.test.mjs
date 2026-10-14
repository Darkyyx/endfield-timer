import fs from 'node:fs';
import vm from 'node:vm';

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

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const now = Date.now();
const CAP = 90000;

function boot(rows, cfgOver) {
  const els = Object.create(null);
  const getEl = id => (els[id] = els[id] || makeEl('div'));
  const store = new Map();
  store.set('endfield_line_timer_v2', JSON.stringify(rows.map(r => Object.assign({
    remark: '', region: 'wuling', prod: 0, cons: 0, stock: 0, ts: now, editing: false
  }, r))));
  store.set('endfield_notify_v1', JSON.stringify(Object.assign({
    url: 'https://demo.workers.dev', token: 'tok', warn: 30, on: true, warnFull: true, warnEmpty: true
  }, cfgOver || {})));

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
    fetch: () => Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        ok: 1, rows: rows.length, writes: 0, removed: 0, foreignRows: 0,
        quota: 0, quotaAt: 0, owner: { mine: true }, lastPushAt: 0, lastPushOk: true, lastError: null
      })
    }),
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Blob: class { constructor(p) { this.parts = p; } },
    URL, Date, Math, JSON, Number, String, Array, Object, Error, isFinite, parseInt, parseFloat,
    confirm: () => true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(items, sandbox, { filename: 'items.js' });
  vm.runInContext(code, sandbox, { filename: 'index-inline.js' });
  return { getEl, store };
}

/* 取出每个顶层统计项的"标签 + 数值"，例如 "正常 2" */
function statsOf(getEl) {
  const out = [];
  const h = getEl('stats').innerHTML;
  const re = /<span(?: class="[^"]*")?>([\s\S]*?)<\/span>(?=\s*<span|$)/g;
  let m;
  while ((m = re.exec(h)) !== null) {
    const label = (m[1].match(/<span class="k">([\s\S]*?)<\/span>/) || [])[1] || '';
    const val = (m[1].match(/<b[^>]*>([\s\S]*?)<\/b>/) || [])[1] || '';
    const txt = (label.replace(/<[^>]*>/g, '').trim() + ' ' + val.trim()).trim();
    if (txt) out.push(txt);
  }
  return out;
}
const rawHud = getEl => getEl('stats').innerHTML;

console.log('右上角：按状态计数');

await check('只有「正常」和「预警」两项计数', () => {
  const { getEl } = boot([
    { id: 'a', name: 'N1', prod: 0, cons: 0, stock: 0 },                       // 产销平衡 → 正常
    { id: 'b', name: 'N2', prod: 1, cons: 0, stock: 1000 },                    // 很久才爆 → 正常
    { id: 'c', name: 'W1', prod: 100, cons: 0, stock: CAP - 1000 },            // 10 分钟爆 → 预警
    { id: 'd', name: 'D1', prod: 100, cons: 0, stock: CAP }                    // 已爆仓 → 预警
  ]);
  const t = statsOf(getEl);
  assert(t.length === 2, '计数项应只有 正常/预警 两项，实际：' + JSON.stringify(t));
  assert(/同步 /.test(rawHud(getEl)), '状态灯应仍然存在');
  assert(t.some(x => x === '正常 2'), '正常计数不对：' + JSON.stringify(t));
  assert(t.some(x => x === '预警 2'), '已爆仓未并入预警：' + JSON.stringify(t));
  return t.join(' · ');
});

await check('产物与危险两项已移除', () => {
  const { getEl } = boot([{ id: 'a', name: 'X', prod: 0, cons: 0, stock: 0 }]);
  const h = rawHud(getEl);
  assert(!/产物/.test(h), '仍有「产物」统计：' + h);
  assert(!/危险/.test(h), '仍有「危险」统计：' + h);
  assert(!/class="danger"/.test(h), '仍有 danger 元素：' + h);
  assert(!/\.stats \.danger b/.test(html), 'CSS 里仍有 danger 规则');
  return '只剩 正常 / 预警 / 同步';
});

await check('已耗尽（存量为 0）并入预警', () => {
  const { getEl } = boot([
    { id: 'e', name: 'E1', prod: 0, cons: 10, stock: 0 },
    { id: 'f', name: 'W1', prod: 0, cons: 100, stock: 500 }
  ]);
  const t = statsOf(getEl);
  assert(t.some(x => x === '预警 2'), '已耗尽与即将耗尽都应计入预警：' + JSON.stringify(t));
  assert(t.some(x => x === '正常 0'), '正常应为 0：' + JSON.stringify(t));
  return t.join(' · ');
});

await check('不再出现"X 分钟内爆仓/耗尽"这种窗口统计', () => {
  const { getEl } = boot([{ id: 'a', name: 'X', prod: 100, cons: 0, stock: CAP - 1000 }]);
  const h = rawHud(getEl);
  assert(!/分钟内爆仓|分钟内耗尽/.test(h), '旧文案仍在：' + h);
  assert(!/class="soon"|class="drain"/.test(h), '旧样式类仍在：' + h);
  return '已替换为状态计数';
});

await check('预警计数跟随设置的预警窗口', () => {
  const rows = [{ id: 'a', name: 'X', prod: 10, cons: 0, stock: CAP - 12000 }];   // 净 +10/分 → 1200 分钟后爆
  const t30 = statsOf(boot(rows, { warn: 30 }).getEl);
  assert(t30.some(x => x === '正常 1'), '30 分钟窗口下应为正常：' + JSON.stringify(t30));
  const t2000 = statsOf(boot(rows, { warn: 2000 }).getEl);
  assert(t2000.some(x => x === '预警 1'), '窗口放大后应为预警：' + JSON.stringify(t2000));
  return '30 分钟 → 正常；2000 分钟 → 预警';
});

await check('正常的数字：不为 0 时绿色，为 0 时与标签同色', () => {
  const withNormal = rawHud(boot([
    { id: 'a', name: 'N', prod: 0, cons: 0, stock: 0 }        // 产销平衡 → 正常 1
  ]).getEl);
  assert(/<span class="ok"><span class="k">正常<\/span><b class="on">1<\/b>/.test(withNormal),
    '正常=1 时应带 on 类：' + withNormal);

  const withoutNormal = rawHud(boot([
    { id: 'b', name: 'W', prod: 100, cons: 0, stock: CAP - 1000 }   // 全部预警 → 正常 0
  ]).getEl);
  assert(/<span class="ok"><span class="k">正常<\/span><b class="">0<\/b>/.test(withoutNormal),
    '正常=0 时不该带 on 类：' + withoutNormal);
  assert(/\.stats \.ok b\.on\{color:var\(--green\)\}/.test(html), '缺少 on 配色规则');
  return '1 → 绿色(on)，0 → 默认色';
});

await check('数字独立成块，不会与相邻数字连读', () => {
  const { getEl } = boot([{ id: 'a', name: 'X', prod: 0, cons: 0, stock: 0 }]);
  const h = rawHud(getEl);
  assert(/<span class="k">正常<\/span><b[^>]*>\d+<\/b>/.test(h), '结构不对：' + h);
  assert(!/<\/b>\d/.test(h), '出现数字紧接数字：' + h);
  return '结构正确';
});

await check('统计项之间有竖线分隔（CSS ::before）', () => {
  assert(/\.stats > span \+ span::before/.test(html), '缺少分隔样式');
  assert(/\.stats > span:first-child\{padding-left:0\}/.test(html), '缺少首项去分隔的规则');
  return '竖线分隔';
});

console.log('\n同步状态灯');

await check('状态灯文案是"同步"，不是"通知"', () => {
  const { getEl } = boot([{ id: 'a', name: 'X', prod: 0, cons: 0, stock: 0 }]);
  const h = rawHud(getEl);
  assert(/同步 待发送/.test(h), '状态灯文案不对：' + h.slice(h.indexOf('nstat')));
  assert(!/通知 /.test(h), '仍出现"通知 "：' + h);
  return '同步 待发送';
});

console.log('\n开关文案');
await check('两个开关不再带括号说明，改为"爆仓物品 / 耗尽物品"', () => {
  assert(/id="ntWarnFull">爆仓物品</.test(html), '开关文案不对');
  assert(/id="ntWarnEmpty">耗尽物品</.test(html), '开关文案不对');
  assert(!/生产 &gt; 消耗|消耗 &gt; 生产/.test(html), '仍残留括号说明');
  return '爆仓物品 / 耗尽物品';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
