import fs from 'node:fs';
import worker, { __test } from './worker.js';

const {
  fmtInZone, fmtClock, tzOffset, tzLabel, posixZone,
  quotaResetText, quotaMessage, composeItemMessage, effectiveConfig
} = __test;

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* 固定时刻：2026-05-29 06:40 UTC */
const T = Date.UTC(2026, 4, 29, 6, 40, 0);
/* 固定时刻：2026-05-29 20:00 UTC（用于跨日） */
const N = Date.UTC(2026, 4, 29, 20, 0, 0);

console.log('A. 时刻换算：不再用运行时本地时区（Worker 上是 UTC）');

await check('Cloudflare 运行在 UTC —— 旧写法会得到 UTC 时刻', () => {
  // 这正是要修掉的问题：getHours() 在 Worker 里永远是 UTC
  const d = new Date(T);
  assert(d.getUTCHours() === 6, 'UTC 小时应为 6');
  return 'getHours() 在 Worker 里 = UTC 06:40';
});

await check('UTC+8 得到 +8 小时后的时刻（核心修复）', () => {
  assert(fmtInZone(T, 8) === '14:40', 'UTC+8 应为 14:40，实际 ' + fmtInZone(T, 8));
  return '06:40Z → 14:40';
});

await check('各时区换算正确', () => {
  const cases = [[0, '06:40'], [9, '15:40'], [7, '13:40'], [-5, '01:40'], [-8, '22:40']];
  cases.forEach(([tz, want]) => {
    const got = fmtInZone(T, tz);
    assert(got === want, 'UTC' + (tz >= 0 ? '+' : '') + tz + ' 应为 ' + want + '，实际 ' + got);
  });
  return cases.map(([tz, w]) => tz + '→' + w).join('  ');
});

await check('半小时时区（UTC+5:30）', () => {
  assert(fmtInZone(T, 5.5) === '12:10', '应为 12:10，实际 ' + fmtInZone(T, 5.5));
  return '12:10';
});

await check('跨日：UTC 20:00 在 UTC+8 是次日 04:00', () => {
  assert(fmtInZone(N, 8) === '04:00', '应为 04:00，实际 ' + fmtInZone(N, 8));
  assert(fmtInZone(N, 8, true) === '05-30 04:00', '带日期应为 05-30 04:00，实际 ' + fmtInZone(N, 8, true));
  return '04:00 / 05-30 04:00';
});

console.log('\nB. POSIX 时区串与偏移解析');

await check('POSIX 时区串符号与常识相反（UTC+8 → "UTC-8"）', () => {
  assert(posixZone(8) === 'UTC-8', '实际 ' + posixZone(8));
  assert(posixZone(0) === 'UTC', '实际 ' + posixZone(0));
  assert(posixZone(-5) === 'UTC+5', '实际 ' + posixZone(-5));
  assert(posixZone(5.5) === 'UTC-5:30', '实际 ' + posixZone(5.5));
  return 'UTC-8 / UTC / UTC+5 / UTC-5:30';
});

await check('非法或缺失偏移回落到 +8', () => {
  assert(tzOffset(undefined) === 8, 'undefined');
  assert(tzOffset('abc') === 8, '非数字');
  assert(tzOffset(99) === 8, '超出范围');
  assert(tzOffset(-20) === 8, '低于范围');
  assert(tzOffset('8') === 8, '字符串数字应被接受');
  assert(tzOffset(5.5) === 5.5, '半小时应保留');
  return '全部回落到 +8，合法值保留';
});

await check('时区标签', () => {
  assert(tzLabel(8) === 'UTC+8', tzLabel(8));
  assert(tzLabel(-5) === 'UTC-5', tzLabel(-5));
  assert(tzLabel(5.5) === 'UTC+5:30', tzLabel(5.5));
  assert(tzLabel(0) === 'UTC+0', tzLabel(0));
  return 'UTC+8 / UTC-5 / UTC+5:30 / UTC+0';
});

console.log('\nC. 额度重置文案跟着时区走');

await check('Cloudflare 按 UTC 零点重置 → 本地钟点随偏移变化', () => {
  assert(quotaResetText(8) === '每天 8:00 点重置', 'UTC+8 实际 ' + quotaResetText(8));
  assert(quotaResetText(9) === '每天 9:00 点重置', 'UTC+9 实际 ' + quotaResetText(9));
  assert(quotaResetText(0) === '每天 0:00 点重置', 'UTC+0 实际 ' + quotaResetText(0));
  assert(quotaResetText(5.5) === '每天 5:30 点重置', 'UTC+5:30 实际 ' + quotaResetText(5.5));
  return '8 / 9 / 0 / 5:30';
});

await check('负偏移跨到前一天', () => {
  assert(quotaResetText(-5) === '每天（前一天）19:00 点重置', 'UTC-5 实际 ' + quotaResetText(-5));
  return quotaResetText(-5);
});

await check('时区未知时不写死钟点，只说"次日重置"', () => {
  assert(quotaResetText(undefined) === '次日重置', '实际 ' + quotaResetText(undefined));
  assert(quotaResetText(NaN) === '次日重置', '实际 ' + quotaResetText(NaN));
  return '次日重置';
});

await check('quotaMessage 使用同一时区', () => {
  assert(/每天 9:00 点重置$/.test(quotaMessage(9)), quotaMessage(9));
  assert(!/每天 8:00/.test(quotaMessage(9)), '不该残留 +8 的钟点：' + quotaMessage(9));
  return quotaMessage(9);
});

console.log('\nD. 通知正文使用所选时区');

const item = {
  level: 1,
  row: { id: 'a', name: '源矿', remark: '装满：液体A', region: 'wuling', prod: 20, cons: 0, stock: 88000, ts: T }
};

await check('同一份数据在不同时区给出相差 8 小时的时刻', () => {
  const a = composeItemMessage(item, T, 8);
  const b = composeItemMessage(item, T, 0);
  assert(a.desp !== b.desp, '不同时区应给出不同时刻');
  assert(a.desp.indexOf('16:20') >= 0, 'UTC+8 应为 16:20：' + a.desp);
  assert(b.desp.indexOf('08:20') >= 0, 'UTC+0 应为 08:20：' + b.desp);
  return a.desp + '  |  ' + b.desp;
});

await check('正文格式不变，标题与分钟数不受时区影响', () => {
  const a = composeItemMessage(item, T, 8);
  const b = composeItemMessage(item, T, -5);
  assert(/^预计 \d{2}:\d{2} 爆仓（约 100 分钟后）$/.test(a.desp), '格式变了：' + a.desp);
  assert(a.title === b.title, '标题不该随时区变化');
  assert(a.desp.replace(/\d{2}:\d{2}/, 'X') === b.desp.replace(/\d{2}:\d{2}/, 'X'), '除时刻外应完全一致');
  return a.title;
});

console.log('\nE. 时区配置链路');

function makeKV(seed) {
  const m = new Map(seed || []);
  return {
    _m: m,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(o) { const p = (o && o.prefix) || ''; return { keys: [...m.keys()].filter(x => x.startsWith(p)).map(name => ({ name })) }; }
  };
}
const req = (body) => new Request('https://w.example/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Sync-Token': 'tok' },
  body: JSON.stringify(body)
});

await check('/sync 上报的 timeZone 写进 meta:config', async () => {
  const env = { STATE: makeKV(), SC_SENDKEY: 'sctp1a', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800 };
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 9, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 9, 'meta.timeZone 应为 9，实际 ' + JSON.stringify(meta.timeZone));
  return 'timeZone = ' + meta.timeZone;
});

await check('页面没上报时区时保留原值（旧版页面不会把设置清掉）', async () => {
  const env = {
    STATE: makeKV([['meta:config', JSON.stringify({ warnMinutes: 30, timeZone: -5, alertTypes: { full: true, empty: true } })]]),
    SC_SENDKEY: 'sctp1a', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800
  };
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === -5, '不该被覆盖成默认值，实际 ' + JSON.stringify(meta.timeZone));
  return '保留 -5';
});

await check('非法 timeZone 被规范为合法范围', async () => {
  const env = { STATE: makeKV(), SC_SENDKEY: 'sctp1a', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800 };
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 99, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 8, '越界应回落到 +8，实际 ' + JSON.stringify(meta.timeZone));
  return '99 → 8';
});

await check('effectiveConfig 读出 timeZone，缺失时为 +8', async () => {
  const a = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 9 })]]) }, { WARN_SECONDS: 1800 });
  assert(a.timeZone === 9, '实际 ' + a.timeZone);
  const b = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800 });
  assert(b.timeZone === 8, '缺失应为 +8，实际 ' + b.timeZone);
  const c = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 'x' })]]) }, { WARN_SECONDS: 1800 });
  assert(c.timeZone === 8, '非法应为 +8，实际 ' + c.timeZone);
  return '9 / 8 / 8';
});

await check('环境变量 TIME_ZONE 作为 meta 缺失时的兜底', async () => {
  const r = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800, TIME_ZONE: '-5' });
  assert(r.timeZone === -5, '实际 ' + r.timeZone);
  return 'TIME_ZONE = -5';
});

await check('/sync 响应带回 timeZone 与 quotaReset', async () => {
  const env = {
    STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 9, warnMinutes: 30, alertTypes: { full: true, empty: true } })]]),
    SC_SENDKEY: 'sctp1a', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800
  };
  const j = await (await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {})).json();
  assert(j.timeZone === 9, 'timeZone 应为 9，实际 ' + j.timeZone);
  assert(j.quotaReset === '每天 9:00 点重置', 'quotaReset 实际 ' + j.quotaReset);
  return 'timeZone=9, quotaReset=' + j.quotaReset;
});

console.log('\nF. 页面侧时区下拉框');

await check('通知设置里有"时区"下拉框，默认 UTC+8', () => {
  const panel = html.slice(html.indexOf('id="ntPanel"'), html.indexOf('id="fontPanel"') > 0 ? html.length : html.length);
  assert(/id="ntTz"/.test(panel), '缺少时区下拉框');
  const first = (panel.match(/<select[^>]*id="ntTz"[\s\S]*?<option value="([^"]+)"/) || [])[1];
  assert(first === '8', '第一个选项应为 UTC+8，实际 ' + first);
  return '默认 UTC+8';
});

await check('时区下拉框在「预警时间」之后、「爆仓物品」开关之前', () => {
  const iWarn = html.indexOf('id="ntWarn"');
  const iTz = html.indexOf('id="ntTz"');
  const iTog = html.indexOf('class="ntToggles"');
  assert(iWarn > 0 && iTz > 0 && iTog > 0, '未找到相关元素');
  assert(iWarn < iTz, '时区应在预警时间之后');
  assert(iTz < iTog, '时区应在开关之前');
  return '预警时间 → 时区 → 开关';
});

await check('时区选项覆盖常见偏移且不重复', () => {
  const block = html.slice(html.indexOf('id="ntTz"'), html.indexOf('</select>', html.indexOf('id="ntTz"')));
  const vals = [...block.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert(vals.length >= 8, '选项过少：' + vals.length);
  assert(new Set(vals).size === vals.length, '存在重复选项：' + vals.join(','));
  ['8', '9', '0', '-5', '5.5'].forEach(v => assert(vals.includes(v), '缺少常用时区 ' + v));
  return vals.join(' / ');
});

await check('页面把 timeZone 放进同步载荷', () => {
  const src = html.slice(html.indexOf('function buildPayload'), html.indexOf('function alertTypes'));
  assert(/timeZone:\s*cfg\.tz/.test(src), 'buildPayload 未带上 timeZone');
  return 'timeZone: cfg.tz';
});

await check('页面本地推算额度重置文案（Worker 未回应时的兜底）', () => {
  const src = html.slice(html.indexOf('function quotaResetHint'), html.indexOf('function readQuotaAt'));
  assert(/cfg\.tz/.test(src), 'quotaResetHint 未使用 cfg.tz');
  assert(!/每天 8:00/.test(src), '仍写死 8:00：' + src.slice(0, 120));
  return '跟随 cfg.tz 推算';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
