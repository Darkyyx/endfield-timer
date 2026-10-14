import fs from 'node:fs';
import worker, { __test } from './worker.js';

const {
  fmtInZone, fmtClock, normZone, zoneOffsetHours, offsetLabel, tzLabel,
  quotaResetText, quotaMessage, composeItemMessage, effectiveConfig, DEFAULT_TZ
} = __test;

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* 固定时刻 */
const W = Date.UTC(2026, 0, 15, 6, 40, 0);   // 冬令时期间（北半球）
const S = Date.UTC(2026, 6, 15, 6, 40, 0);   // 夏令时期间（北半球）
const N = Date.UTC(2026, 4, 29, 20, 0, 0);   // 跨日用

console.log('A. 时刻换算：不再用运行时本地时区（Worker 上是 UTC）');

await check('Cloudflare 运行在 UTC —— 这正是要修掉的问题', () => {
  assert(new Date(W).getUTCHours() === 6, 'UTC 小时应为 6');
  return 'getHours() 在 Worker 里 = UTC 06:40';
});

await check('Asia/Shanghai 得到 +8 小时后的时刻（核心修复）', () => {
  assert(fmtInZone(W, 'Asia/Shanghai') === '14:40', '应为 14:40，实际 ' + fmtInZone(W, 'Asia/Shanghai'));
  return '06:40Z → 14:40';
});

await check('各时区换算正确', () => {
  const cases = [
    ['UTC', '06:40'], ['Asia/Tokyo', '15:40'], ['Asia/Bangkok', '13:40'],
    ['America/New_York', '01:40'], ['America/Los_Angeles', '22:40']
  ];
  cases.forEach(([z, want]) => {
    const got = fmtInZone(W, z);
    assert(got === want, z + ' 应为 ' + want + '，实际 ' + got);
  });
  return cases.map(([z, w]) => z.split('/').pop() + '→' + w).join('  ');
});

await check('半小时/三刻钟时区', () => {
  assert(fmtInZone(W, 'Asia/Kolkata') === '12:10', '印度应为 12:10，实际 ' + fmtInZone(W, 'Asia/Kolkata'));
  assert(fmtInZone(W, 'Asia/Kathmandu') === '12:25', '尼泊尔应为 12:25，实际 ' + fmtInZone(W, 'Asia/Kathmandu'));
  return '12:10 / 12:25';
});

await check('跨日：UTC 20:00 在上海是次日 04:00', () => {
  assert(fmtInZone(N, 'Asia/Shanghai') === '04:00', '实际 ' + fmtInZone(N, 'Asia/Shanghai'));
  assert(fmtInZone(N, 'Asia/Shanghai', true) === '05-30 04:00', '实际 ' + fmtInZone(N, 'Asia/Shanghai', true));
  return '04:00 / 05-30 04:00';
});

console.log('\nB. 夏令时（用固定偏移做不到的部分）');

await check('柏林：冬 +1 / 夏 +2', () => {
  assert(zoneOffsetHours(W, 'Europe/Berlin') === 1, '冬季实际 ' + zoneOffsetHours(W, 'Europe/Berlin'));
  assert(zoneOffsetHours(S, 'Europe/Berlin') === 2, '夏季实际 ' + zoneOffsetHours(S, 'Europe/Berlin'));
  return '冬 +1 / 夏 +2';
});

await check('纽约：冬 -5 / 夏 -4', () => {
  assert(zoneOffsetHours(W, 'America/New_York') === -5, '冬季实际 ' + zoneOffsetHours(W, 'America/New_York'));
  assert(zoneOffsetHours(S, 'America/New_York') === -4, '夏季实际 ' + zoneOffsetHours(S, 'America/New_York'));
  return '冬 -5 / 夏 -4';
});

await check('悉尼：南半球相反，冬 +11 / 夏 +10', () => {
  assert(zoneOffsetHours(W, 'Australia/Sydney') === 11, '1 月实际 ' + zoneOffsetHours(W, 'Australia/Sydney'));
  assert(zoneOffsetHours(S, 'Australia/Sydney') === 10, '7 月实际 ' + zoneOffsetHours(S, 'Australia/Sydney'));
  return '1 月 +11 / 7 月 +10';
});

await check('上海、迪拜无夏令时，全年恒定', () => {
  assert(zoneOffsetHours(W, 'Asia/Shanghai') === zoneOffsetHours(S, 'Asia/Shanghai'), '上海应恒定');
  assert(zoneOffsetHours(W, 'Asia/Dubai') === zoneOffsetHours(S, 'Asia/Dubai'), '迪拜应恒定');
  return '上海 +8 / 迪拜 +4';
});

await check('偏移标签含夏令时后的值', () => {
  assert(offsetLabel(zoneOffsetHours(W, 'Europe/Berlin')) === 'UTC+1', '柏林冬季');
  assert(offsetLabel(zoneOffsetHours(S, 'Europe/Berlin')) === 'UTC+2', '柏林夏季');
  assert(offsetLabel(zoneOffsetHours(W, 'Asia/Kathmandu')) === 'UTC+5:45', '尼泊尔 +5:45');
  return 'UTC+1 / UTC+2 / UTC+5:45';
});

console.log('\nC. 标识符校验与回落');

await check('非法标识符一律回落到默认时区', () => {
  assert(normZone('bogus') === DEFAULT_TZ, 'bogus 实际 ' + normZone('bogus'));
  assert(normZone('') === DEFAULT_TZ, '空串');
  assert(normZone(null) === DEFAULT_TZ, 'null');
  assert(normZone('Asia/Nowhere') === DEFAULT_TZ, '不存在的地区');
  assert(normZone('../../etc/passwd') === DEFAULT_TZ, '路径穿越样式');
  return '全部 → ' + DEFAULT_TZ;
});

await check('Etc/GMT±N 被拒绝（符号与直觉相反，容易误用）', () => {
  assert(normZone('Etc/GMT+8') === DEFAULT_TZ, '实际 ' + normZone('Etc/GMT+8'));
  assert(normZone('Etc/GMT-8') === DEFAULT_TZ, '实际 ' + normZone('Etc/GMT-8'));
  return 'Etc/* → 默认时区';
});

await check('合法标识符原样保留（含三段式与 UTC）', () => {
  assert(normZone('Asia/Shanghai') === 'Asia/Shanghai', normZone('Asia/Shanghai'));
  assert(normZone('America/Argentina/Buenos_Aires') === 'America/Argentina/Buenos_Aires', '三段式被改动了');
  assert(normZone('UTC') === 'UTC', 'UTC 被改动了');
  assert(normZone('  Asia/Tokyo  ') === 'Asia/Tokyo', '未去空白');
  return 'Asia/Shanghai / 三段式 / UTC';
});

await check('时区展示名 = 标识符 + 当前偏移', () => {
  assert(tzLabel('Asia/Shanghai', W) === 'Asia/Shanghai（UTC+8）', tzLabel('Asia/Shanghai', W));
  assert(/Europe\/Berlin（UTC\+[12]）/.test(tzLabel('Europe/Berlin', W)), tzLabel('Europe/Berlin', W));
  return tzLabel('Asia/Shanghai', W);
});

console.log('\nD. 额度重置文案');

await check('Cloudflare 按 UTC 零点重置 → 本地钟点随时区变化', () => {
  assert(quotaResetText('Asia/Shanghai') === '每天 8:00 点重置', '上海实际 ' + quotaResetText('Asia/Shanghai'));
  assert(quotaResetText('Asia/Tokyo') === '每天 9:00 点重置', '东京实际 ' + quotaResetText('Asia/Tokyo'));
  assert(quotaResetText('UTC') === '每天 0:00 点重置', 'UTC 实际 ' + quotaResetText('UTC'));
  assert(quotaResetText('Asia/Kolkata') === '每天 5:30 点重置', '印度实际 ' + quotaResetText('Asia/Kolkata'));
  return '上海 8:00 / 东京 9:00 / UTC 0:00 / 印度 5:30';
});

await check('负偏移跨到前一天', () => {
  const got = quotaResetText('America/Los_Angeles');
  assert(/^每天（前一天）/.test(got), '实际 ' + got);
  return got;
});

await check('时区未知时只说"次日重置"，不写死钟点', () => {
  assert(quotaResetText(undefined) === '次日重置', '实际 ' + quotaResetText(undefined));
  assert(quotaResetText('') === '次日重置', '实际 ' + quotaResetText(''));
  assert(quotaResetText(null) === '次日重置', '实际 ' + quotaResetText(null));
  return '次日重置';
});

await check('quotaMessage 使用同一时区', () => {
  assert(/每天 9:00 点重置$/.test(quotaMessage('Asia/Tokyo')), quotaMessage('Asia/Tokyo'));
  assert(!/每天 8:00/.test(quotaMessage('Asia/Tokyo')), '不该残留上海的钟点：' + quotaMessage('Asia/Tokyo'));
  return quotaMessage('Asia/Tokyo');
});

console.log('\nE. 通知正文使用所选时区');

const item = {
  level: 1,
  row: { id: 'a', name: '源矿', remark: '装满：液体A', region: 'wuling', prod: 20, cons: 0, stock: 88000, ts: W }
};

await check('同一份数据在不同时区给出正确时刻', () => {
  const sh = composeItemMessage(item, W, 'Asia/Shanghai');
  const ny = composeItemMessage(item, W, 'America/New_York');
  assert(sh.desp.indexOf('16:20') >= 0, '上海应为 16:20：' + sh.desp);
  assert(ny.desp.indexOf('03:20') >= 0, '纽约应为 03:20：' + ny.desp);
  return sh.desp + '  |  ' + ny.desp;
});

await check('正文格式不变，标题与分钟数不受时区影响', () => {
  const a = composeItemMessage(item, W, 'Asia/Shanghai');
  const b = composeItemMessage(item, W, 'America/Los_Angeles');
  assert(/^预计 \d{2}:\d{2} 爆仓（约 100 分钟后）$/.test(a.desp), '格式变了：' + a.desp);
  assert(a.title === b.title, '标题不该随时区变化');
  assert(a.desp.replace(/\d{2}:\d{2}/, 'X') === b.desp.replace(/\d{2}:\d{2}/, 'X'), '除时刻外应一致');
  return a.title;
});

await check('同一时刻、同一数据，柏林比伦敦晚一小时（夏令时差异）', () => {
  // 用同一个 ms 才是可比实验：换时间戳会让数据外推量也跟着变
  const berlin = composeItemMessage(item, W, 'Europe/Berlin');
  const london = composeItemMessage(item, W, 'Europe/London');
  const hb = Number((berlin.desp.match(/(\d{2}):\d{2}/) || [])[1]);
  const hl = Number((london.desp.match(/(\d{2}):\d{2}/) || [])[1]);
  // 06:40Z + 100 分钟 = 08:20（伦敦 UTC+0）；柏林再 +1 小时 = 09:20
  assert(hl === 8, '伦敦冬季应为 08:xx（UTC+0）：' + london.desp);
  assert(hb === 9, '柏林冬季应为 09:xx（UTC+1）：' + berlin.desp);
  assert(hb - hl === 1, '两者应正好差一小时');
  return london.desp + '  vs  ' + berlin.desp;
});

await check('夏令时期间同一城市的偏移确实变了（换时区不用改设置）', () => {
  // 冬 06:40Z 柏林 07:40；夏 06:40Z 柏林 08:40 —— 偏移从 +1 变 +2
  assert(fmtInZone(W, 'Europe/Berlin') === '07:40', '冬季实际 ' + fmtInZone(W, 'Europe/Berlin'));
  assert(fmtInZone(S, 'Europe/Berlin') === '08:40', '夏季实际 ' + fmtInZone(S, 'Europe/Berlin'));
  return '07:40 → 08:40（同一时刻的钟点差）';
});

console.log('\nF. 时区配置链路');

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

await check('/sync 上报的 timeZone 标识符写进 meta:config', async () => {
  const env = baseEnv(makeKV());
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 'Europe/Berlin', rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 'Europe/Berlin', '实际 ' + JSON.stringify(meta.timeZone));
  return 'timeZone = ' + meta.timeZone;
});

await check('非法标识符被规范化后再落盘', async () => {
  const env = baseEnv(makeKV());
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, timeZone: 'Evil/../Zone', rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === DEFAULT_TZ, '实际 ' + JSON.stringify(meta.timeZone));
  return 'Evil/../Zone → ' + meta.timeZone;
});

await check('页面没上报时区时保留原值（旧版页面不会把设置清掉）', async () => {
  const env = baseEnv(makeKV([['meta:config', JSON.stringify({ warnMinutes: 30, timeZone: 'America/Chicago', alertTypes: { full: true, empty: true } })]]));
  await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {});
  const meta = await env.STATE.get('meta:config', 'json');
  assert(meta.timeZone === 'America/Chicago', '不该被覆盖，实际 ' + JSON.stringify(meta.timeZone));
  return '保留 America/Chicago';
});

await check('effectiveConfig 读出 timeZone，缺失时用默认', async () => {
  const a = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 'Asia/Tokyo' })]]) }, { WARN_SECONDS: 1800 });
  assert(a.timeZone === 'Asia/Tokyo', '实际 ' + a.timeZone);
  const b = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800 });
  assert(b.timeZone === DEFAULT_TZ, '缺失应为 ' + DEFAULT_TZ + '，实际 ' + b.timeZone);
  const c = await effectiveConfig({ STATE: makeKV([['meta:config', JSON.stringify({ timeZone: 'nope' })]]) }, { WARN_SECONDS: 1800 });
  assert(c.timeZone === DEFAULT_TZ, '非法应为 ' + DEFAULT_TZ + '，实际 ' + c.timeZone);
  return 'Asia/Tokyo / ' + DEFAULT_TZ + ' / ' + DEFAULT_TZ;
});

await check('环境变量 TIME_ZONE 作为 meta 缺失时的兜底', async () => {
  const r = await effectiveConfig({ STATE: makeKV() }, { WARN_SECONDS: 1800, TIME_ZONE: 'Australia/Sydney' });
  assert(r.timeZone === 'Australia/Sydney', '实际 ' + r.timeZone);
  return 'TIME_ZONE = Australia/Sydney';
});

await check('/sync 响应带回 timeZone 与 quotaReset', async () => {
  const env = baseEnv(makeKV([['meta:config', JSON.stringify({ timeZone: 'Asia/Tokyo', warnMinutes: 30, alertTypes: { full: true, empty: true } })]]));
  const j = await (await worker.fetch(req({ v: 2, clientId: 'c1', clientHost: 'p.example', dirty: true, warnMinutes: 30, rows: [] }), env, {})).json();
  assert(j.timeZone === 'Asia/Tokyo', 'timeZone 实际 ' + j.timeZone);
  assert(j.quotaReset === '每天 9:00 点重置', 'quotaReset 实际 ' + j.quotaReset);
  return 'timeZone=Asia/Tokyo, quotaReset=' + j.quotaReset;
});

console.log('\nG. 页面侧两级下拉框');

await check('有两个下拉框：地区 + 城市', () => {
  assert(/id="ntTzRegion"/.test(html), '缺少地区下拉框');
  assert(/id="ntTzCity"/.test(html), '缺少城市下拉框');
  return 'ntTzRegion + ntTzCity';
});

await check('预警时间、地区、城市在同一行（都是普通格子），地址与令牌独占整行', () => {
  const iWideUrl = html.indexOf('class="wide">\n          <span class="k">Worker 地址');
  const iWarn = html.indexOf('id="ntWarn"');
  const iRegion = html.indexOf('id="ntTzRegion"');
  const iCity = html.indexOf('id="ntTzCity"');
  assert(iWarn < iRegion && iRegion < iCity, '顺序应为 预警时间 → 地区 → 城市');
  assert(iWarn - iRegion < 0 && iCity - iWarn < 1200, '三者应当相邻（同一行）');
  // 地址与令牌带 wide 类，独占整行
  const wideCount = (html.match(/class="wide"/g) || []).length;
  assert(wideCount === 2, 'wide 应恰好两个（地址、令牌），实际 ' + wideCount);
  assert(/\.ntGrid \.wide\{grid-column:1\/-1\}/.test(html), '缺少 wide 的样式规则');
  return '地址/令牌整行，预警+地区+城市一行';
});

await check('时区用 IANA 标识符，不再是数字偏移', () => {
  const src = html.slice(html.indexOf('const TZ_DEFAULT'), html.indexOf('function normalizeUrl'));
  assert(/TZ_DEFAULT = 'Asia\/Shanghai'/.test(src), '默认时区应为 Asia/Shanghai');
  assert(/Intl\.supportedValuesOf\('timeZone'\)/.test(src), '未从浏览器补全时区列表');
  return 'Asia/Shanghai + supportedValuesOf 补全';
});

await check('页面把 timeZone 标识符放进同步载荷', () => {
  const src = html.slice(html.indexOf('function buildPayload'), html.indexOf('function alertTypes'));
  assert(/timeZone:\s*cfg\.zone/.test(src), 'buildPayload 未带上 cfg.zone');
  return 'timeZone: cfg.zone';
});

await check('页面本地推算额度重置文案时用 IANA 时区', () => {
  const src = html.slice(html.indexOf('function quotaResetHint'), html.indexOf('function readQuotaAt'));
  assert(/cfg\.zone/.test(src), 'quotaResetHint 未使用 cfg.zone');
  assert(/zoneOffset\(/.test(src), '未按 zoneOffset 计算偏移（夏令时会算错）');
  // 偏移算法本体在 zoneOffset() 里，必须用 longOffset，否则夏令时拿不到 +2
  const off = html.slice(html.indexOf('function zoneOffset'), html.indexOf('function quotaResetHint'));
  assert(/timeZoneName:\s*'longOffset'/.test(off), 'zoneOffset 未用 longOffset');
  const panel = html.slice(html.indexOf('id="ntUrl"'), html.indexOf('class="ntToggles"'));
  assert(!/每天 8:00/.test(panel), '面板里仍写死 8:00');
  return '按 cfg.zone + longOffset 推算';
});

await check('城市列表排除 Etc/* 这类易误用的时区', () => {
  const src = html.slice(html.indexOf('function tzCatalogue'), html.indexOf('function buildTzIndex'));
  assert(!/Etc\//.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), '未过滤 Etc/*');
  return '已过滤';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
