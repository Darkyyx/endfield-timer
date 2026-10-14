import fs from 'node:fs';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* ---------- 把页面里的纯函数抽出来跑 ----------
   fmtEta / wallClock / daysBetween / fmtDur / fmtNum 都不依赖 DOM，
   只需给它们一个可控的 pageTzOffset 与可注入的"当前时间"。 */
function extract(startMarker, endMarker) {
  const a = code.indexOf(startMarker);
  const b = code.indexOf(endMarker, a);
  assert(a > 0 && b > a, '抽不出代码段：' + startMarker);
  return code.slice(a, b);
}

const src = extract('function fmtNum(n) {', 'function escAttr(s) {');

/* 用固定偏移 + 固定"现在"构造一个隔离环境，避免依赖真实时钟与机器时区 */
function makeEnv(tz, nowMs) {
  const sandbox = {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [nowMs])); }
      static now() { return nowMs; }
      static UTC(...a) { return Date.UTC(...a); }
    },
    Math, Number, String, Array, Object, JSON, isFinite, parseInt, parseFloat
  };
  sandbox.notify = { tzOffset: () => tz };
  const fn = new Function(
    'notify', 'Date', 'Math', 'Number', 'String', 'Array', 'Object', 'JSON', 'isFinite',
    src + '\nreturn { fmtEta, fmtDur, fmtNum, wallClock, daysBetween };'
  );
  return fn(sandbox.notify, sandbox.Date, Math, Number, String, Array, Object, JSON, isFinite);
}

/* 固定"现在"：2026-05-29 06:40 UTC */
const NOW = Date.UTC(2026, 4, 29, 6, 40, 0);
const at = (ms) => new Date(ms);   // 真实 Date 实例，仅用于传给 fmtEta

console.log('目标时刻按设置时区渲染');

await check('UTC+8：同一时刻比 UTC 晚 8 小时', () => {
  const sh = makeEnv(8, NOW), utc = makeEnv(0, NOW);
  // NOW 的墙上时间：UTC 06:40 → 上海 14:40（都是"今天"）
  assert(sh.fmtEta(at(NOW)) === '今天 14:40', '上海实际 ' + sh.fmtEta(at(NOW)));
  assert(utc.fmtEta(at(NOW)) === '今天 06:40', 'UTC 实际 ' + utc.fmtEta(at(NOW)));
  return '上海 今天 14:40 / UTC 今天 06:40';
});

await check('今天 / 明天 的判定以所选时区的日期为准', () => {
  const sh = makeEnv(8, NOW);
  // UTC 20:00 = 上海次日 04:00 → 应显示"明天"
  const nextDayInSh = Date.UTC(2026, 4, 29, 20, 0, 0);
  assert(sh.fmtEta(at(nextDayInSh)) === '明天 04:00', '实际 ' + sh.fmtEta(at(nextDayInSh)));
  return '上海 明天 04:00';
});

await check('UTC-5 下的"今天"与上海不同（证明用的是所选时区）', () => {
  const ny = makeEnv(-5, NOW);
  // NOW = UTC 06:40 → 纽约 01:40（同为当天）
  assert(ny.fmtEta(at(NOW)) === '今天 01:40', '实际 ' + ny.fmtEta(at(NOW)));
  // UTC 05:00 时纽约还是前一天 00:00
  const prevDay = Date.UTC(2026, 4, 29, 5, 0, 0);
  assert(ny.fmtEta(at(prevDay)) === '今天 00:00', '实际 ' + ny.fmtEta(at(prevDay)));
  return '纽约 今天 01:40';
});

await check('2-6 天用星期，7 天以上用日期', () => {
  const sh = makeEnv(8, NOW);
  const in3 = Date.UTC(2026, 4, 31, 6, 40, 0);      // 3 天后
  const in10 = Date.UTC(2026, 5, 8, 6, 40, 0);      // 10 天后
  const r3 = sh.fmtEta(at(in3));
  const r10 = sh.fmtEta(at(in10));
  assert(/^周[日一二三四五六] \d{2}:\d{2}$/.test(r3), '3 天后应为星期：' + r3);
  assert(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(r10), '10 天后应为日期：' + r10);
  return r3 + ' / ' + r10;
});

await check('不会退回浏览器本机时区的写法', () => {
  const sh = makeEnv(8, NOW);
  const out = sh.fmtEta(at(NOW));
  assert(!/^\d{2}-\d{2} \d{2}:\d{2}$/.test(out), '当天不该退化成纯日期：' + out);
  assert(/^(今天|明天|周[日一二三四五六])/.test(out), '缺少日期前缀：' + out);
  return out;
});

console.log('\n倒计时列只保留两行');

await check('倒计时列只有 cd-time 与 cd-note 两个元素', () => {
  const cell = html.slice(html.indexOf('<div class="cell cd">'), html.indexOf('<div class="cell act">'));
  assert(/cd-time/.test(cell), '缺少 cd-time');
  assert(/cd-note/.test(cell), '缺少 cd-note');
  assert(!/cd-sub|cd-eta/.test(cell), '仍残留旧的 cd-sub / cd-eta：' + cell);
  // 这一列里恰好是 cell 本身 + 两个子元素，多一个就是又塞了行进来
  const divs = (cell.match(/<div /g) || []).length;
  assert(divs === 3, '倒计时列应有 cell + 两个子元素，实际 ' + divs + ' 个 div');
  const inner = cell.slice(cell.indexOf('>') + 1, cell.lastIndexOf('</div>'));
  assert((inner.match(/<div /g) || []).length === 2, '子元素应恰好两个：' + inner);
  return '两行：cd-time + cd-note';
});

await check('净速率已从页面彻底移除', () => {
  assert(!/cd-sub/.test(html), '仍残留 .cd-sub 样式或引用');
  assert(!/fmtRate/.test(html), '仍残留 fmtRate');
  assert(!/净 \+|净 ' \+/.test(html), '仍残留净速率的文案拼接');
  return '已移除';
});

await check('目标时刻用设置里的时区，而不是本机时区', () => {
  assert(/notify\.tzOffset\(\)/.test(src), 'fmtEta 没有取设置里的时区');
  assert(!/getHours\(\)/.test(src), '仍在用本机时区的 getHours');
  assert(!/getMonth\(\)|getFullYear\(\)|getDate\(\)/.test(src), '仍在用本机时区的日期方法');
  return '全部走 wallClock(ms, 偏移)';
});

await check('空行与已爆仓/已耗尽都有明确的第二行文案', () => {
  const paint = html.slice(html.indexOf('function paint(el, row)'), html.indexOf('/* ================= 显示设置'));
  assert(/cdNote\.textContent = '产销平衡'/.test(paint), '产销平衡行缺少说明');
  assert(/cdNote\.textContent = fmtNum\(c\.cap\)/.test(paint), '已爆仓行应显示上限');
  assert(/cdNote\.textContent = '0'/.test(paint), '已耗尽行应显示 0');
  assert(!/cdSub/.test(paint), 'paint 里仍有 cdSub 引用');
  return '四种状态都有文案';
});

await check('目标时刻带"爆仓 / 耗尽"标签', () => {
  const paint = html.slice(html.indexOf('function paint(el, row)'), html.indexOf('/* ================= 显示设置'));
  assert(/cdNote\.textContent = '爆仓 ' \+ fmtEta\(/.test(paint), '缺少爆仓标签');
  assert(/cdNote\.textContent = '耗尽 ' \+ fmtEta\(/.test(paint), '缺少耗尽标签');
  return '爆仓 … / 耗尽 …';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
