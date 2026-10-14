import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const items = fs.readFileSync(new URL('./items.js', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const CAP = 90000;

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

function boot(rows, preStore) {
  const els = Object.create(null);
  const getEl = id => (els[id] = els[id] || makeEl('div'));
  const store = new Map(preStore || []);
  store.set('endfield_line_timer_v2', JSON.stringify((rows || []).map(r => Object.assign({
    remark: '', region: 'wuling', prod: 0, cons: 0, stock: 0, ts: Date.now(), editing: false
  }, r))));
  store.set('endfield_notify_v1', JSON.stringify({
    url: 'https://demo.workers.dev', token: 'tok', warn: 30, on: true, warnFull: true, warnEmpty: true
  }));

  const cssVars = {};
  const rootEl = makeEl('html');
  rootEl.style.setProperty = (k, v) => { cssVars[k] = v; };

  const sandbox = {
    console,
    document: {
      documentElement: rootEl,
      getElementById: getEl, createElement: makeEl, querySelector: () => makeEl('div'),
      addEventListener() {}, hidden: false, activeElement: null
    },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    navigator: { sendBeacon: () => true },
    location: { host: 'demo.example', href: 'https://demo.example/', reload: () => {} },
    fetch: () => Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: 1, rows: 0, writes: 0, removed: 0, foreignRows: 0, quota: 0, quotaAt: 0, owner: { mine: true }, lastPushAt: 0, lastPushOk: true, lastError: null })
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
  return { getEl, store, cssVars };
}

console.log('显示设置：字体');

await check('面板存在，两个输入框在通知设置之前', () => {
  const iFont = html.indexOf('id="fontPanel"');
  const iNotify = html.indexOf('id="ntPanel"');
  assert(iFont > 0, '未找到显示设置面板');
  assert(iFont < iNotify, '显示设置应在通知设置之前');
  assert(/id="fnZh"/.test(html) && /id="fnEn"/.test(html), '缺少字体输入框');
  return '显示设置 → 通知设置';
});

await check('界面顺序：中文在前，英文在后', () => {
  const grid = html.slice(html.indexOf('id="fontPanel"'), html.indexOf('id="ntPanel"'));
  assert(grid.indexOf('中文字体') < grid.indexOf('英文字体'), '界面上中文应排在英文前面');
  return '中文 → 英文';
});

await check('未填时使用默认字体变量', () => {
  const { cssVars } = boot([]);
  assert(/Barlow/.test(cssVars['--font-en'] || ''), '默认英文字体不对：' + cssVars['--font-en']);
  assert(/Noto Sans SC/.test(cssVars['--font-zh'] || ''), '默认中文字体不对：' + cssVars['--font-zh']);
  return '默认值生效';
});

await check('含空格的字族名自动加引号（不加引号会被 CSS 当成多个字体名而失效）', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnZh').value = 'Maple Mono NF CN';
  getEl('fnZh').listeners.blur.forEach(fn => fn());
  assert(cssVars['--font-zh'] === '"Maple Mono NF CN"', '中文未加引号：' + cssVars['--font-zh']);
  const mono = cssVars['--mono-user'] || '';
  assert(mono.indexOf('"Maple Mono NF CN"') >= 0, '数字区未用该字体：' + mono);
  assert(mono.indexOf('Barlow') < 0, '数字区不该混入默认拉丁字体栈：' + mono);
  return cssVars['--mono-user'];
});

await check('单字字体名不加引号；已带引号的不重复加', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnEn').value = 'Consolas';
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  assert(cssVars['--font-en'] === 'Consolas', '单字名被加了引号：' + cssVars['--font-en']);
  getEl('fnEn').value = '"Already Quoted"';
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  assert(cssVars['--font-en'] === '"Already Quoted"', '重复加引号：' + cssVars['--font-en']);
  return 'Consolas / "Already Quoted"';
});

await check('用逗号写完整字体栈时原样保留', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnEn').value = 'Maple Mono NF CN, monospace';
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  assert(cssVars['--font-en'] === 'Maple Mono NF CN, monospace', '逗号写法被改动：' + cssVars['--font-en']);
  return cssVars['--font-en'];
});

await check('全空时数字区回到原默认等宽栈（不被 Barlow 接管）', () => {
  const { cssVars } = boot([]);
  const mono = cssVars['--mono-user'] || '';
  assert(/Cascadia Mono/.test(mono), '数字默认栈不对：' + mono);
  assert(!/Barlow/.test(mono), '数字区不该被 Barlow 接管：' + mono);
  return mono;
});

await check('数字区域已全部改用 --mono-user', () => {
  const uses = (html.match(/font-family:var\(--mono-user\)/g) || []).length;
  assert(uses >= 10, '--mono-user 使用处过少：' + uses);
  assert(!/font-family:var\(--mono\)/.test(html), '仍有地方在用旧的 --mono 变量');
  return uses + ' 处';
});

await check('优先级=英文时：英文字体排在中文字体之前（微软雅黑等不会吃掉 Consolas）', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnZh').value = 'Microsoft YaHei';
  getEl('fnZh').listeners.blur.forEach(fn => fn());
  getEl('fnEn').value = 'Consolas';
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  getEl('fnPriority').value = 'en';
  getEl('fnPriority').listeners.change.forEach(fn => fn());
  const mono = cssVars['--mono-user'] || '';
  assert(mono.indexOf('Consolas') < mono.indexOf('Microsoft YaHei'), '英文应在前：' + mono);
  const body = cssVars['--font-body'] || '';
  assert(body.indexOf('Consolas') < body.indexOf('Microsoft YaHei'), '--font-body 英文应在前：' + body);
  return mono;
});

await check('优先级=中文时：中文字体排在最前（Maple Mono 之类可接管英文数字）', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnZh').value = 'Maple Mono NF CN';
  getEl('fnZh').listeners.blur.forEach(fn => fn());
  getEl('fnEn').value = 'Consolas';
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  getEl('fnPriority').value = 'zh';
  getEl('fnPriority').listeners.change.forEach(fn => fn());
  const mono = cssVars['--mono-user'] || '';
  assert(mono.indexOf('"Maple Mono NF CN"') < mono.indexOf('Consolas'), '中文应在前：' + mono);
  return mono;
});

await check('优先级持久化，且非法值回落到英文优先', () => {
  const { store, getEl } = boot([]);
  getEl('fnEn').value = 'Consolas';           // 触发一次提交，写入存储
  getEl('fnEn').listeners.blur.forEach(fn => fn());
  assert(JSON.parse(store.get('endfield_font_v1')).priority === 'en', '默认应为 en');
  const restored = boot([], [['endfield_font_v1', JSON.stringify({ zh: 'ZhFont', en: 'EnFont', priority: 'zh' })]]);
  const mono = restored.cssVars['--mono-user'] || '';
  assert(mono.indexOf('ZhFont') >= 0 && mono.indexOf('ZhFont') < mono.indexOf('EnFont'), '未恢复中文优先：' + mono);
  assert(restored.getEl('fnPriority').value === 'zh', '下拉框未回填');
  return '已持久化并回填';
});

await check('优先级下拉框存在且有说明文字', () => {
  assert(/id="fnPriority"/.test(html), '缺少优先级下拉框');
  assert(/英文字体优先/.test(html) && /中文字体优先/.test(html), '缺少选项文案');
  assert(/自带拉丁字形/.test(html), '缺少说明文字');
  return '下拉框 + 说明';
});

await check('面板文案：DISPLAY / NOTIFICATION，占位符为"使用默认"', () => {
  assert(/显示设置 · DISPLAY/.test(html), '显示设置标题不对');
  assert(/通知设置 · NOTIFICATION/.test(html), '通知设置标题不对');
  assert(!/SERVERCHAN PUSH/.test(html), '旧的通知标题仍在');
  assert(html.indexOf('留空 = 使用默认') < 0, '仍残留"留空 = 使用默认"');
  // 只看显示设置面板里的提示文字（代码注释里保留行为说明是合理的，不算残留）
  const panel = html.slice(html.indexOf('id="fontPanel"'), html.indexOf('id="ntPanel"'));
  const hint = (panel.match(/<span class="ntMsg">([\s\S]*?)<\/span>/) || [])[1] || '';
  assert(hint.indexOf('回车或失焦才应用') < 0, '界面提示仍写"回车或失焦才应用"：' + hint);
  assert(hint.indexOf('未填写则使用默认字体') >= 0, '缺少默认字体说明：' + hint);
  assert((html.match(/placeholder="使用默认"/g) || []).length === 2, '两个字体框的占位符应为"使用默认"');
  return hint;
});

await check('填了字体后，失焦才应用（输入过程不应用）', () => {
  const { getEl, cssVars } = boot([]);
  getEl('fnZh').value = 'My Chinese Font';
  getEl('fnEn').value = 'My English Font';
  assert(!/My Chinese/.test(cssVars['--font-zh'] || ''), '输入时不应立即应用');
  getEl('fnZh').listeners.blur.forEach(fn => fn());
  assert(/My Chinese/.test(cssVars['--font-zh'] || ''), '失焦后未应用中文：' + cssVars['--font-zh']);
  assert(!/My English/.test(cssVars['--font-en'] || ''), '未失焦的英文框不该被应用');
  return '仅失焦的那个生效';
});

await check('回车等同失焦（会触发 blur 而应用）', () => {
  const { getEl, cssVars } = boot([]);
  const el = getEl('fnEn');
  el.value = 'Enter Font';
  let blurred = false;
  el.blur = () => { blurred = true; el.listeners.blur.forEach(fn => fn()); };
  el.listeners.keydown.forEach(fn => fn({ key: 'Enter', preventDefault() {} }));
  assert(blurred, '回车未触发失焦');
  assert(/Enter Font/.test(cssVars['--font-en'] || ''), '回车后未应用：' + cssVars['--font-en']);
  return '回车 → blur → 应用';
});

await check('字体只存本机：同步载荷的字段里没有字体', () => {
  const { getEl, store } = boot([]);
  const sent = [];
  // 记录真正发出去的同步载荷
  const realFetch = globalThis.fetch;
  globalThis.fetch = realFetch;
  getEl('fnZh').value = 'Only Local Font';
  getEl('fnZh').listeners.blur.forEach(fn => fn());
  const payloadKeys = ['v', 'clientId', 'clientHost', 'clientTs', 'dirty', 'quotaAt', 'warnMinutes', 'alertTypes', 'rows'];
  const buildSrc = code.slice(code.indexOf('function buildPayload'), code.indexOf('function alertTypes'));
  payloadKeys.forEach(k => assert(new RegExp(k + ':').test(buildSrc) || k === 'rows', '载荷字段 ' + k + ' 不在预期列表里'));
  assert(!/font/i.test(buildSrc), 'buildPayload 里出现了字体，可能被同步出去了：' + buildSrc);
  assert(store.get('endfield_font_v1'), '字体未写入本机存储');
  return 'buildPayload 不含字体字段';
});

await check('启动时读取已保存的字体', () => {
  const saved = JSON.stringify({ zh: 'Saved ZH', en: 'Saved EN' });
  const { cssVars, getEl } = boot([], [['endfield_font_v1', saved]]);
  assert(/Saved EN/.test(cssVars['--font-en'] || ''), '未恢复英文字体');
  assert(/Saved ZH/.test(cssVars['--font-zh'] || ''), '未恢复中文字体');
  assert(getEl('fnZh').value === 'Saved ZH', '输入框未回填：' + getEl('fnZh').value);
  return '已回填并应用';
});

console.log('\n预警数字配色');

function statsHtml(rows) {
  return boot(rows).getEl('stats').innerHTML;
}

await check('预警为 0 → 用正常同色（class="zero"）', () => {
  const h = statsHtml([{ id: 'a', name: 'N', prod: 0, cons: 0, stock: 0 }]);
  assert(/class="zero"/.test(h), '未加 zero 类：' + h);
  assert(/\.stats \.warn b\.zero\{color:#c3ccd4\}/.test(html), '缺少 zero 配色规则');
  return '预警 0 → 与正常同色';
});

await check('预警非 0 且只有"即将"类 → 黄色（无额外类）', () => {
  const h = statsHtml([{ id: 'a', name: 'W', prod: 100, cons: 0, stock: CAP - 1000 }]);
  assert(/<b class="">1<\/b>/.test(h), '不应加额外类：' + h);
  assert(/\.stats \.warn b\{color:var\(--yellow\)\}/.test(html), '缺少黄色基础规则');
  return '预警 1 → 黄色';
});

await check('含已爆仓 → 红色（class="crit"）', () => {
  const h = statsHtml([{ id: 'a', name: 'F', prod: 100, cons: 0, stock: CAP }]);
  assert(/class="crit"/.test(h), '未加 crit 类：' + h);
  assert(/\.stats \.warn b\.crit\{color:var\(--red\)\}/.test(html), '缺少 crit 配色规则');
  return '含已爆仓 → 红色';
});

await check('含已耗尽 → 红色', () => {
  const h = statsHtml([{ id: 'a', name: 'E', prod: 0, cons: 10, stock: 0 }]);
  assert(/class="crit"/.test(h), '已耗尽未触发红色：' + h);
  return '含已耗尽 → 红色';
});

await check('同时有"即将"和"已耗尽" → 红色优先', () => {
  const h = statsHtml([
    { id: 'a', name: 'W', prod: 100, cons: 0, stock: CAP - 1000 },
    { id: 'b', name: 'E', prod: 0, cons: 10, stock: 0 }
  ]);
  assert(/class="crit"/.test(h), '应优先红色：' + h);
  assert(/<b class="crit">2<\/b>/.test(h), '计数或类不对：' + h);
  return '预警 2 → 红色';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
