/* ============================================================
 * worker.js 的本地自测（不依赖 Cloudflare）
 * 运行：node worker.test.mjs
 * ============================================================ */

import worker, { __test } from './worker.js';

/* ---------- 极简断言 ---------- */
let pass = 0;
const fails = [];

function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
  console.log('  ✗ ' + label);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label + '  → 期望 ' + b + '，实际 ' + a);
}
function group(name) { console.log('\n' + name); }

/* ---------- 内存版 KV ---------- */
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    }
  };
}

/* ---------- 内存版 fetch 拦截 ---------- */
let sentMessages = [];
let nextFetchResult = { ok: true, status: 200, body: '{"code":0,"message":"ok"}' };

globalThis.fetch = async (url, init) => {
  sentMessages.push({ url, body: String(init.body) });
  const r = nextFetchResult;
  return { ok: r.ok, status: r.status, text: async () => r.body };
};

const ENV = {
  STATE: makeKV(),
  SC_UID: 'UID123',
  SC_SENDKEY: 'SCTKEY456',
  SYNC_TOKEN: 'tok',
  WARN_SECONDS: 1800,
  PUSH_RETRY_COOLDOWN_MS: 0   // 测试里不等冷却
};
const CFG = Object.assign({}, ENV, {
  SC_ENDPOINT: 'https://{uid}.push.ft07.com/send/{key}.send'
});

/* ---------- 工具 ---------- */
const CAP_W = 90000;
const CAP_G = 80000;

function rowAt(over) {
  return Object.assign({
    id: 'r1', name: '源矿', region: 'wuling', prod: 24, cons: 6,
    stock: 52000, ts: Date.now(), alerted: 0, lastAttemptAt: 0, lastError: null, misses: 0
  }, over);
}
function postJSON(path, payload, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  return new Request('https://w.example' + path, {
    method: 'POST', headers: h, body: JSON.stringify(payload)
  });
}
function reset() {
  ENV.STATE = makeKV();
  CFG.STATE = ENV.STATE;
  sentMessages = [];
  nextFetchResult = { ok: true, status: 200, body: '{"code":0,"message":"ok"}' };
}
function patrol() {
  const pending = [];
  const p = worker.scheduled({}, ENV, { waitUntil: x => { pending.push(x); return x; } });
  return Promise.resolve(p).then(() => Promise.allSettled(pending));
}
function formField(body, name) {
  const v = new URLSearchParams(body).get(name);
  return v === null ? '' : v;
}

/* ============================================================ */

group('一、等级判定 evaluateLevel');
{
  const now = Date.now();
  const warn = 1800;
  const mk = (o) => Object.assign({ region: 'wuling', prod: 0, cons: 0, stock: 0, ts: now }, o);

  eq(__test.evaluateLevel(mk({}), now, warn), 0, '刚添加的空行（0/0/0）不提醒');
  eq(__test.evaluateLevel(mk({ prod: 10, cons: 10, stock: 5000 }), now, warn), 0, '产销平衡不提醒');
  eq(__test.evaluateLevel(mk({ prod: 10, cons: 0, stock: 5000 }), now, warn), 0, '刚跑起来、离上限很远 = 正常');
  eq(__test.evaluateLevel(mk({ prod: 100, cons: 0, stock: 89000 }), now, warn), 1, '10 分钟就会爆仓 = 预警（净 +100/分，距上限 1000）');
  eq(__test.evaluateLevel(mk({ prod: 100, cons: 0, stock: 85000 }), now, warn), 0, '50 分钟才会爆仓、超出 30 分钟预警窗 = 正常');
  eq(__test.evaluateLevel(mk({ prod: 100, cons: 0, stock: CAP_W }), now, warn), 2, '已达上限 = 已爆仓');
  eq(__test.evaluateLevel(mk({ prod: 100, cons: 0, stock: CAP_W + 999 }), now, warn), 2, '超过上限仍是已爆仓');
  eq(__test.evaluateLevel(mk({ prod: 0, cons: 100, stock: 3000 }), now, warn), 3, '30 分钟内就会耗尽 = 预警（等级 3）');
  eq(__test.evaluateLevel(mk({ region: 'gudi', prod: 0, cons: 100, stock: 1000 }), now, warn), 3, '四号谷地的耗尽方向同样计入（等级 3）');
  eq(__test.evaluateLevel(mk({ prod: 0, cons: 100, stock: 0 }), now, warn), 4, '存量为 0 = 已耗尽');
  eq(__test.evaluateLevel(mk({ prod: 0, cons: 100, stock: 6000 }), now, warn), 0, '60 分钟才会耗尽、超出预警窗 = 正常');
  eq(__test.evaluateLevel(mk({ region: 'gudi', prod: 100, cons: 0, stock: 79900 }), now, warn), 1, '四号谷地上限 80000 生效（净 +100/分，距上限 100）');
}

group('二、一次性去抖 decideAlert');
{
  eq(__test.decideAlert({ alerted: 0 }, 0), null, '正常状态不产生动作');
  eq(__test.decideAlert({ alerted: 0 }, 1).action, 'push', '首次跨入预警要推');
  eq(__test.decideAlert({ alerted: 1 }, 1), null, '停在预警等级不重复推');
  eq(__test.decideAlert({ alerted: 1 }, 2).action, 'push', '预警升级为已爆仓要推');
  eq(__test.decideAlert({ alerted: 2 }, 2), null, '已爆仓后躺一天也不再推');
  eq(__test.decideAlert({ alerted: 2 }, 1), null, '已爆仓后即使回落到预警也不推');
  const r = __test.decideAlert({ alerted: 2 }, 0);
  eq([r.action, r.next.alerted], ['reset', 0], '恢复正常时静默复位水位');
}

group('三、巡检与推送（走完整 cron 路径）');
{
  reset();
  await patrol();
  eq(sentMessages.length, 0, '空 KV 不推送');

  // 即将爆仓
  const soon = rowAt({ stock: CAP_W - 50, prod: 15, cons: 2, ts: Date.now() });
  await ENV.STATE.put('row:r1', JSON.stringify(soon));
  await patrol();
  eq(sentMessages.length, 1, '跨入预警后推送一次');
  ok(sentMessages[0].url === 'https://UID123.push.ft07.com/send/SCTKEY456.send', 'URL 模板占位符替换正确');
  eq(formField(sentMessages[0].body, 'title'), '⚠ 即将爆仓：源矿', '单条消息标题');
  ok(formField(sentMessages[0].body, 'desp').includes('⚠ 即将爆仓'), '正文含等级标签');
  ok(formField(sentMessages[0].body, 'desp').includes('源矿（武陵）'), '正文含产物与地区');
  ok(formField(sentMessages[0].body, 'desp').includes('分钟后爆仓'), '正文含预计爆仓时间');
  eq(formField(sentMessages[0].body, 'tags'), '即将爆仓', 'tags 按等级分类');
  ok(formField(sentMessages[0].body, 'short').length > 0, 'short 摘要非空');

  // 水位已抬到 1 → 不再推
  await patrol();
  await patrol();
  eq(sentMessages.length, 1, '水位已抬升，后续巡检不重复推送');

  // 升级为已爆仓
  const stored = await ENV.STATE.get('row:r1', 'json');
  stored.stock = CAP_W;
  stored.ts = Date.now();
  await ENV.STATE.put('row:r1', JSON.stringify(stored));
  await patrol();
  eq(sentMessages.length, 2, '升级为已爆仓时再推一次');
  eq(formField(sentMessages[1].body, 'title'), '🛑 已爆仓：源矿', '已爆仓标题');
  eq(formField(sentMessages[1].body, 'tags'), '爆仓', '爆仓 tags');

  // 爆仓后长时间挂着（模拟"一天之内才删除"）——每 5 分钟巡检一次，共 6 小时
  for (let i = 0; i < 72; i++) await patrol();
  eq(sentMessages.length, 2, '爆仓后挂 6 小时（72 次巡检）也绝不重复推送');

  // 恢复到正常 → 静默复位，不推送
  const back = await ENV.STATE.get('row:r1', 'json');
  back.stock = 60000;
  back.ts = Date.now();
  await ENV.STATE.put('row:r1', JSON.stringify(back));
  await patrol();
  eq(sentMessages.length, 2, '恢复正常时静默复位、不推送');
  eq((await ENV.STATE.get('row:r1', 'json')).alerted, 0, '水位已复位为 0');

  // 复位后再次跨阈值 → 可以再推（下一轮循环）
  // 本组净速率 = 15 − 2 = 13/分，30 分钟预警窗的边界 = 上限 − 390。取 上限 − 100（约 7.7 分钟）确保确实跨过。
  const again = await ENV.STATE.get('row:r1', 'json');
  again.stock = CAP_W - 100;
  again.ts = Date.now();
  await ENV.STATE.put('row:r1', JSON.stringify(again));
  await patrol();
  eq(sentMessages.length, 3, '复位后再次跨阈值会重新推送');
}

group('四、已耗尽与多产线聚合');
{
  reset();
  await ENV.STATE.put('row:a', JSON.stringify(rowAt({ id: 'a', name: '源矿', region: 'wuling', prod: 0, cons: 10, stock: 0 })));
  await ENV.STATE.put('row:b', JSON.stringify(rowAt({ id: 'b', name: '赤铜块', region: 'gudi', prod: 20, cons: 0, stock: 79900 })));
  await patrol();
  eq(sentMessages.length, 1, '两条产线同一轮只推一条消息');
  eq(formField(sentMessages[0].body, 'title'), '终末地产线预警 · 2 条', '多条产线聚合标题');
  const desp = formField(sentMessages[0].body, 'desp');
  ok(desp.includes('已耗尽'), '聚合正文含已耗尽分组');
  ok(desp.includes('即将爆仓'), '聚合正文含即将爆仓分组');
  ok(desp.indexOf('即将爆仓') < desp.indexOf('已耗尽'), '分组按等级从预警到严重排序');
  eq(formField(sentMessages[0].body, 'tags'), '即将爆仓|耗尽', '聚合 tags 去重合并');
  ok(formField(sentMessages[0].body, 'short').includes('即将爆仓 1'), 'short 含各组数量');
}

group('五、推送失败时的重试与状态');
{
  reset();
  nextFetchResult = { ok: true, status: 200, body: '{"code":40001,"message":"bad pushkey"}' };
  await ENV.STATE.put('row:r1', JSON.stringify(rowAt({ stock: CAP_W - 500, ts: Date.now() })));
  await patrol();
  eq(sentMessages.length, 1, '推送失败也记录了一次尝试');
  const after = await ENV.STATE.get('row:r1', 'json');
  eq(after.alerted, 0, '推送失败不抬升水位（下次还会提醒）');
  ok(String(after.lastError).includes('bad pushkey'), '失败原因写入行记录');

  // 失败后重试（冷却已设为 0）
  nextFetchResult = { ok: true, status: 200, body: '{"code":0,"message":"ok"}' };
  await patrol();
  eq(sentMessages.length, 2, '失败后重试');
  eq((await ENV.STATE.get('row:r1', 'json')).alerted, 1, '重试成功后水位抬升');
}

group('六、/sync 端点');
{
  reset();
  let res = await worker.fetch(postJSON('/sync', { rows: [{ id: 'x', name: '源矿', region: 'wuling', prod: 5, cons: 1, stock: 100, ts: Date.now() }] }, { 'X-Sync-Token': 'tok' }), ENV, {});
  let body = await res.json();
  eq([res.status, body.ok, body.rows], [200, 1, 1], '正常同步写入成功');

  res = await worker.fetch(postJSON('/sync', { rows: [] }, { 'X-Sync-Token': 'wrong' }), ENV, {});
  eq(res.status, 401, '令牌错误返回 401');

  res = await worker.fetch(postJSON('/sync', { rows: [] }, { 'X-Sync-Token': 'tok' }), ENV, {});
  body = await res.json();
  eq(body.rows, 0, '快照里没出现的行不计入本次写入');
  eq(body.ok, 1, '空快照也算成功');

  // 缺席两轮后清理
  await worker.fetch(postJSON('/sync', { rows: [] }, { 'X-Sync-Token': 'tok' }), ENV, {});
  eq(await ENV.STATE.get('row:x', 'json'), null, '连续缺席 2 轮后从 KV 删除');

  // 前端编辑后 ts 更新 → Worker 保留自己的水位
  reset();
  await ENV.STATE.put('row:y', JSON.stringify({ id: 'y', name: '源矿', alerted: 2, misses: 0 }));
  await worker.fetch(postJSON('/sync', { rows: [{ id: 'y', name: '源矿', region: 'wuling', prod: 5, cons: 1, stock: 10, ts: Date.now() }] }, { 'X-Sync-Token': 'tok' }), ENV, {});
  eq((await ENV.STATE.get('row:y', 'json')).alerted, 2, '前端同步不会清掉 Worker 的提醒水位');
}

group('七、SendKey 里解析 UID');
{
  eq(__test.deriveUid('sctp24339tauwt87osfuw9nyptebxxxx'), '24339', '标准 SendKey → 取出 UID');
  eq(__test.deriveUid('SCTP24339TAUWT87OSFUW9NYPtebxxxx'), '24339', '大写前缀也能解析');
  eq(__test.deriveUid('  sctp24339abc  '), '24339', '首尾空格被忽略');
  eq(__test.deriveUid('sctp1abc'), '1', '单位数 UID');
  eq(__test.deriveUid('sctp987654321xyz'), '987654321', '多位数 UID');
  eq(__test.deriveUid('24339'), '24339', '直接填纯数字 UID 也认');
  eq(__test.deriveUid('sctp'), '', '只有前缀 → 解析失败');
  eq(__test.deriveUid('sctpabc123'), '', '前缀后不是数字 → 解析失败');
  eq(__test.deriveUid('SCTxxxxxxxx'), '', '旧版 Turbo SendKey → 解析失败且不误判为数字');
  eq(__test.deriveUid(''), '', '空串');
  eq(__test.deriveUid(null), '', 'null 不炸');

  eq(__test.resolveCredentials({}).ok, false, '什么都没配 → 不可用');
  ok(String(__test.resolveCredentials({}).reason).includes('SC_SENDKEY'), '提示指明缺 SC_SENDKEY');

  const onlyKey = __test.resolveCredentials({ SC_SENDKEY: 'sctp24339tauwt87osfuw9nyptebxxxx' });
  eq([onlyKey.ok, onlyKey.uid, onlyKey.uidFrom], [true, '24339', 'sendkey'], '只配 SendKey 即可推送（UID 自动解析）');

  const both = __test.resolveCredentials({ SC_SENDKEY: 'sctp24339aaa', SC_UID: '99999' });
  eq([both.ok, both.uid, both.uidFrom], [true, '99999', 'env'], '显式 SC_UID 优先于解析结果');

  const badKey = __test.resolveCredentials({ SC_SENDKEY: 'SCTxxxxxxxx' });
  eq(badKey.ok, false, 'SendKey 格式不对 → 不可用');
  ok(String(badKey.reason).includes('SC_UID'), '提示告知可以补一个 SC_UID');
}

group('八、只配 SendKey 时的真实推送 URL');
{
  reset();
  // 刻意不提供 SC_UID，用一个真实的 SendKey 形态，验证地址里的 UID 是解析出来的
  const REAL_KEY = 'sctp24339aaaa';
  const envNoUid = Object.assign({}, ENV, { SC_SENDKEY: REAL_KEY, SC_UID: undefined });

  await ENV.STATE.put('row:r1', JSON.stringify(rowAt({ stock: CAP_W - 100, prod: 15, cons: 2, ts: Date.now() })));
  const pending = [];
  await worker.scheduled({}, envNoUid, { waitUntil: p => { pending.push(p); return p; } });
  await Promise.allSettled(pending);

  eq(sentMessages.length, 1, '配了 SendKey 就能推出去');
  eq(sentMessages[0].url, 'https://24339.push.ft07.com/send/' + REAL_KEY + '.send',
    'UID 由 SendKey 自动解析（未配置 SC_UID）');
  eq(formField(sentMessages[0].body, 'title'), '⚠ 即将爆仓：源矿', '解析 UID 后消息内容不受影响');
}

group('九、/test 与 /reset-alerts');
{
  reset();
  let res = await worker.fetch(new Request('https://w.example/test'), ENV, {});
  eq(res.status, 200, '/test 在推送成功时返回 200');
  eq(formField(sentMessages[0].body, 'title'), '✅ 终末地通知测试', '/test 标题');
  eq(formField(sentMessages[0].body, 'tags'), '测试', '/test tags');

  reset();
  nextFetchResult = { ok: false, status: 401, body: 'unauthorized' };
  res = await worker.fetch(new Request('https://w.example/test'), ENV, {});
  eq(res.status, 502, '/test 在推送失败时返回 502 并把原因带给前端');

  reset();
  await ENV.STATE.put('row:z', JSON.stringify({ id: 'z', name: '源矿', alerted: 2 }));
  res = await worker.fetch(new Request('https://w.example/reset-alerts', { method: 'POST', headers: { 'X-Sync-Token': 'tok' }, body: '{}' }), ENV, {});
  eq((await res.json()).reset, 1, '/reset-alerts 重置了 1 条');
  eq((await ENV.STATE.get('row:z', 'json')).alerted, 0, '水位被清零');
}

group('十、边界与容错');
{
  reset();
  let res = await worker.fetch(new Request('https://w.example/unknown'), ENV, {});
  eq(res.status, 404, '未知路径返回 404');

  res = await worker.fetch(new Request('https://w.example/sync', { method: 'GET' }), ENV, {});
  eq(res.status, 405, 'GET /sync 返回 405');

  res = await worker.fetch(new Request('https://w.example/sync', { method: 'POST', headers: { 'X-Sync-Token': 'tok' }, body: 'not json' }), ENV, {});
  eq(res.status, 400, '非法 JSON 返回 400');

  res = await worker.fetch(new Request('https://w.example/sync', { method: 'POST', headers: { 'X-Sync-Token': 'tok' }, body: '{"rows":[]}' }), Object.assign({}, ENV, { STATE: undefined }), {});
  eq(res.status, 500, '未绑定 KV 时返回 500 而不是崩掉');

  // 非法输入被清洗
  reset();
  await worker.fetch(postJSON('/sync', { rows: [
    { id: 'k', name: '源矿', region: '不存在的地区', prod: -5, cons: 'abc', stock: -100, ts: 0 }
  ] }, { 'X-Sync-Token': 'tok' }), ENV, {});
  const k = await ENV.STATE.get('row:k', 'json');
  eq([k.region, k.prod, k.cons, k.stock], ['wuling', 0, 0, 0], '非法地区/负数/非数字被清洗为安全值');
  ok(k.ts > 0, '缺失的 ts 被补成当前时间');

  // 无令牌配置时放行（部署初期便于自测）
  reset();
  res = await worker.fetch(postJSON('/sync', { rows: [] }, {}), Object.assign({}, ENV, { SYNC_TOKEN: undefined }), {});
  eq(res.status, 200, '未配置 SYNC_TOKEN 时不做鉴权');
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (fails.length === 0) {
  console.log('全部通过：' + pass + ' 项断言');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
