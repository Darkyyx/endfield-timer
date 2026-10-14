import fs from 'node:fs';
import worker, { __test } from './worker.js';

const {
  fmtInZone, fmtClock, tzOffset, tzLabel, posixZone,
  quotaResetText, quotaMessage, composeItemMessage, effectiveConfig, DEFAULT_TZ
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
/* UTC 20:00（跨日用） */
const N = Date.UTC(2026, 4, 29, 20, 0, 0);

console.log('A. 时刻换算：不再用运行时本地时区（Worker 上是 UTC）');

await check('Cloudflare 运行在 UTC —— 这正是要修掉的问题', () => {
  assert(new Date(T).getUTCHours() === 6, 'UTC 小时应为 6');
  return 'getHours() 在 Worker 里 = UTC 06:40';
});

await check('UTC+8 得到 +8 小时后的时刻（核心修复）', () => {
  assert(fmtInZone(T, 8) === '14:40', '应为 14:40，实际 ' + fmtInZone(T, 8));
  return '06:40Z → 14:40';
});

await check('各偏移换算正确（-12 到 +14）', () => {
  const cases = [[0, '06:40'], [9, '15:40'], [7, '13:40'], [-5, '01:40'], [-8, '22:40'],
    [5.5, '12:10'], [14, '20:40'], [-12, '18:40']];
  cases.forEach(([tz, want]) => {
    const got = fmtInZone(T, tz);
    assert(got === want, 'UTC' + tz + ' 应为 ' + want + '，实际 ' + got);
  });
  return cases.map(([tz, w]) => tz + '→' + w).join('  ');
});

await check('跨日：UTC 20:00 在 UTC+8 是次日 04:00', () => {
  assert(fmtInZone(N, 8) === '04:00', '实际 ' + fmtInZone(N, 8));
  assert(fmtInZone(N, 8, true) === '05-30 04:00', '实际 ' + fmtInZone(N, 8, true));
  return '04:00 / 05-30 04:00';
});

console.log('\nB. 偏移解析与 POSIX 串');

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
  assert(tzOffset(-12) === -12 && tzOffset(14) === 14, '边界值应接受');
  return '全部回落到 +8，合法值保留';
});

await check('偏移标签', () => {
  assert(tzLabel(8) === 'UTC+8', tzLabel(8));
  assert(tzLabel(-5) === 'UTC-5', tzLabel(-5));
  assert(tzLabel(5.5) === 'UTC+5:30', tzLabel(5.5));
  assert(tzLabel(0) === 'UTC+0', tzLabel(0));
  return 'UTC+8 / UTC-5 / UTC+5:30 / UTC+0';
});

console.log('\nC. 额度重置文案跟着偏移走');

await check('Cloudflare 按 UTC 零点重置 → 本地钟点随偏移变化', () => {
  assert(quotaResetText(8) === '每天 8:00 点重置', 'UTC+8 实际 ' + quotaResetText(8));
  assert(quotaResetText(9) === '每天 9:00 点重置', 'UTC+9 实际 ' + quotaResetText(9));
  assert(quotaResetText(0) === '每天 0:00 点重置', 'UTC+0 实际 ' + quotaResetText(0));
  assert(quotaResetText(5.5) === '每天 5:30 点重置', 'UTC+5:30 实际 ' + quotaResetText(5.5));
  assert(quotaResetText(13) === '每天 13:00 点重置', 'UTC+13 实际 ' + quotaResetText(13));
  return '8 / 9 / 0 / 5:30 / 13';
});

await check('负偏移跨到前一天', () => {
  assert(quotaResetText(-5) === '每天（前一天）19:00 点重置', 'UTC-5 实际 ' + quotaResetText(-5));
  assert(quotaResetText(-12) === '每天（前一天）12:00 点重置', 'UTC-12 实际 ' + quotaResetText(-12));
  return quotaResetText(-5);
});

await check('时区未知时不写死钟点，只说"次日重置"', () => {
  assert(quotaResetText(undefined) === '次日重置', '实际 ' + quotaResetText(undefined));
  assert(quotaResetText('') === '次日重置', '实际 ' + quotaResetText(''));
  return '次日重置';
});

await check('quotaMessage 使用同一偏移', () => {
  assert(/每天 9:00 点重置$/.test(quotaMessage(9)), quotaMessage(9));
  assert(!/每天 8:00/.test(quotaMessage(9)), '不该残留 +8 的钟点：' + quotaMessage(9));
  return quotaMessage(9);
});

console.log('\nD. 通知正文使用所选偏移');

const item = {
  level: 1,
  row: { id: 'a', name: '源矿', remark: '装满：液体A', region: 'wuling', prod: 20, cons: 0, stock: 88000, ts: T }
};

await check('同一份数据在不同偏移给出相差 8 小时的时刻', () => {
  const a = composeItemMessage(item, T, 8);
  const b = composeItemMessage(item, T, 0);
  assert(a.desp.indexOf('16:20') >= 0, 'UTC+8 应为 16:20：' + a.desp);
  assert(b.desp.indexOf('08:20') >= 0, 'UTC+0 应为 08:20：' + b.desp);
  return a.desp + '  |  ' + b.desp;
});

await check('正文格式不变，标题与分钟数不受时区影响', () => {
  const a = composeItemMessage(item, T, 8);
  const b = composeItemMessage(item, T, -5);
  assert(/^预计 \d{2}:\d{2} 爆仓（约 100 分钟后）$/.test(a.desp), '格式变了：' + a.desp);
  assert(a.title === b.title, '标题不该随时区变化');
  assert(a.desp.replace(/\d{2}:\d{2}/, 'X') === b.desp.replace(/\d{2}:\d{2}/, 'X'), '除时刻外应一致');
  return a.title;
});

await check('缺少偏移时按默认 +8 渲染', () => {
  const noTz = composeItemMessage(item, T, undefined);
  const plus8 = composeItemMessage(item, T, 8);
  assert(noTz.desp === plus8.desp, '默认应为 +8：' + noTz.desp + ' vs ' + plus8.desp);
  return noTz.desp;
});

console.log('\nE. 时区配置链路');

function makeKV(seed) {
  const m = new Map(seed || []);
  return {
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
const baseEnv = (kv) => ({ STATE: kv, SC_SENDKEY: 'sctp1a', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800 });

await check('/sync 上报的 timeZone 偏移写进 meta:config', async () => {
  const env = baseEnv(makeKV());
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 9, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 9, '实际 ' + JSON.stringify(meta.timeZone));
  return 'timeZone = ' + meta.timeZone;
});

await check('字符串形式的偏移也能接受', async () => {
  const env = baseEnv(makeKV());
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: '9', rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 9, '实际 ' + JSON.stringify(meta.timeZone));
  return '"9" → 9';
});

await check('越界偏移被规范为默认值', async () => {
  const env = baseEnv(makeKV());
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 99, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === DEFAULT_TZ, '越界应回落到 ' + DEFAULT_TZ + '，实际 ' + JSON.stringify(meta.timeZone));
  return '99 → ' + meta.timeZone;
});

await check('页面没上报时区时保留原值（旧版页面不会把设置清掉）', async () => {
  const env = baseEnv(makeKV([['meta:config', JSON.stringify({ warnMinutes: 30, timeZone: -5, alertTypes: { full: true, empty: true } })]]));
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === -5, '不该被覆盖，实际 ' + JSON.stringify(meta.timeZone));
  return '保留 -5';
});

await check('effectiveConfig 读出 timeZone，缺失时用默认', async () => {
  const a = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 9 })]]) }, { WARN_SECONDS: 1800 });
  assert(a.timeZone === 9, '实际 ' + a.timeZone);
  const b = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800 });
  assert(b.timeZone === DEFAULT_TZ, '缺失应为 ' + DEFAULT_TZ + '，实际 ' + b.timeZone);
  const c = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 'x' })]]) }, { WARN_SECONDS: 1800 });
  assert(c.timeZone === DEFAULT_TZ, '非法应为 ' + DEFAULT_TZ + '，实际 ' + c.timeZone);
  return '9 / ' + DEFAULT_TZ + ' / ' + DEFAULT_TZ;
});

await check('环境变量 TIME_ZONE 作为 meta 缺失时的兜底', async () => {
  const r = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800, TIME_ZONE: '-5' });
  assert(r.timeZone === -5, '实际 ' + r.timeZone);
  return 'TIME_ZONE = -5';
});

await check('/sync 响应带回 timeZone 与 quotaReset', async () => {
  const env = baseEnv(makeKV([['meta:config', JSON.stringify({ timeZone: 9, warnMinutes: 30, alertTypes: { full: true, empty: true } })]]));
  const j = await (await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {})).json();
  assert(j.timeZone === 9, 'timeZone 实际 ' + j.timeZone);
  assert(j.quotaReset === '每天 9:00 点重置', 'quotaReset 实际 ' + j.quotaReset);
  return 'timeZone=9, quotaReset=' + j.quotaReset;
});

console.log('\nF. 页面侧时区下拉框');

await check('只有一个时区下拉框（已回退两级级联）', () => {
  assert(/id="ntTz"/.test(html), '缺少时区下拉框');
  assert(!/id="ntTzRegion"/.test(html), '仍残留地区下拉框');
  assert(!/id="ntTzCity"/.test(html), '仍残留城市下拉框');
  assert(!/TZ_CURATED|buildTzIndex|fillRegions|fillCities/.test(html), '仍残留级联代码');
  return '单个 ntTz';
});

await check('预警时间与时区相邻（同一行）', () => {
  const iWarn = html.indexOf('id="ntWarn"');
  const iTz = html.indexOf('id="ntTz"');
  assert(iWarn > 0 && iTz > iWarn, '顺序应为 预警时间 → 时区');
  assert(iTz - iWarn < 600, '两者应当相邻（同一行）');
  return '预警时间 → 时区';
});

await check('列表覆盖 -12 到 +12 的全部整点，另含 +13 / +14，无重复', () => {
  const src = html.slice(html.indexOf('const TZ_LIST'), html.indexOf('function normalizeUrl'));
  const vals = [...src.matchAll(/^\s*\[(-?\d+),/gm)].map(m => Number(m[1]));
  assert(vals.length >= 20, '选项过少：' + vals.length);
  assert(new Set(vals).size === vals.length, '存在重复偏移：' + vals.join(','));
  for (let i = -12; i <= 12; i++) assert(vals.includes(i), '缺少偏移 ' + i);
  assert(vals.includes(13) && vals.includes(14), '缺少 UTC+13 / UTC+14');
  assert(!vals.some(v => v % 1 !== 0), '不应出现非整点偏移：' + vals.filter(v => v % 1 !== 0));
  assert(vals.includes(8), '缺少 UTC+8');
  return vals.length + ' 个整点偏移：' + vals[0] + ' … ' + vals[vals.length - 1];
});

await check('按 +14 → 0 → -12 严格递减排列', () => {
  const src = html.slice(html.indexOf('const TZ_LIST'), html.indexOf('function normalizeUrl'));
  const vals = [...src.matchAll(/^\s*\[(-?\d+),/gm)].map(m => Number(m[1]));
  assert(vals[0] === 14, '首项应为 UTC+14，实际 ' + vals[0]);
  assert(vals[vals.length - 1] === -12, '末项应为 UTC-12，实际 ' + vals[vals.length - 1]);
  for (let i = 1; i < vals.length; i++) {
    assert(vals[i] === vals[i - 1] - 1, '第 ' + (i + 1) + ' 项应为 ' + (vals[i - 1] - 1) + '，实际 ' + vals[i]);
  }
  return '14 → 13 → … → 0 → … → -12，逐档递减';
});

await check('每档只给一个城市，不带斜杠或括号补充', () => {
  const src = html.slice(html.indexOf('const TZ_LIST'), html.indexOf('function normalizeUrl'));
  const labels = [...src.matchAll(/\[\s*-?\d+,\s*'(UTC[^']*)'\]/g)].map(m => m[1]);
  assert(labels.length >= 20, '标签过少：' + labels.length);
  labels.forEach(l => {
    const m = l.match(/^(UTC[+-]\d+)[　\s]+(\S+)$/);
    assert(m, '标签形态不对（应为 "UTC±N　城市"）：' + l);
    assert(!/[/、（）()]/.test(m[2]), '城市名不该有多个城市或补充说明：' + l);
  });
  assert(labels.some(l => /上海/.test(l)), 'UTC+8 应含上海');
  return labels.length + ' 档，每档一个城市';
});

await check('页面把 timeZone 偏移放进同步载荷', () => {
  const src = html.slice(html.indexOf('function buildPayload'), html.indexOf('function alertTypes'));
  assert(/timeZone:\s*cfg\.tz/.test(src), 'buildPayload 未带上 cfg.tz');
  return 'timeZone: cfg.tz';
});

await check('页面本地推算额度重置文案用偏移，不写死钟点', () => {
  const src = html.slice(html.indexOf('function quotaResetHint'), html.indexOf('function readQuotaAt'));
  assert(/cfg\.tz/.test(src), 'quotaResetHint 未使用 cfg.tz');
  assert(html.indexOf('每天 8:00 点重置') < 0, '页面里写死了 8:00');
  return '按 cfg.tz 推算';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
