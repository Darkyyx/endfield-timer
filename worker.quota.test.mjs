import worker from './worker.js';

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* KV：统计写入次数，并可模拟"每日额度耗尽" */
function makeKV() {
  const m = new Map();
  const stats = { get: 0, put: 0, del: 0, list: 0, quotaLeft: Infinity };
  const kv = {
    stats,
    async get(k, t) { stats.get++; if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) {
      if (typeof k === 'object') throw new Error('put() 被传了对象，这是误用');
      if (stats.put >= stats.quotaLeft) throw new Error('KV put() limit exceeded for the day.');
      stats.put++; m.set(k, v);
    },
    async delete(k) {
      if (Array.isArray(k)) throw new Error('delete() 被传了数组，这是误用');
      if (stats.del >= stats.quotaLeft) throw new Error('KV delete() limit exceeded for the day.');
      stats.del++; m.delete(k);
    },
    async list(o) {
      stats.list++;
      const p = (o && o.prefix) || '';
      return { keys: [...m.keys()].filter(x => x.startsWith(p)).map(name => ({ name })) };
    }
  };
  return kv;
}

let pushes = [];
let fetchMode = 'ok';
globalThis.fetch = async (url, init) => {
  pushes.push({ url: String(url), body: String(init.body) });
  if (fetchMode === 'fail') return { ok: false, status: 401, text: async () => 'bad key' };
  return { ok: true, status: 200, text: async () => '{"code":0,"message":"ok"}' };
};

const ENV = { STATE: makeKV(), SC_SENDKEY: 'sctp24339aaaa', SYNC_TOKEN: 'tok', WARN_SECONDS: 1800, PUSH_RETRY_COOLDOWN_MS: 0 };

const req = (path, body, headers) => new Request('https://w.example' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', 'X-Sync-Token': 'tok' }, headers || {}),
  body: body === undefined ? undefined : JSON.stringify(body)
});

function patrol() {
  const pending = [];
  const p = worker.scheduled({}, ENV, { waitUntil: x => { pending.push(x); return x; } });
  return Promise.resolve(p).then(() => Promise.allSettled(pending));
}

/* 20 条产线，都在"正常"区间（不会触发通知）。
   时间锚点固定：否则每次调用都会产生新的 ts，会把"内容相同"误判成"每行都变了"。 */
const FIXED_TS = Date.now();
function rowsFor(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'r' + i, name: '产物' + i, remark: '备注' + i, region: 'wuling',
      prod: 1, cons: 0, stock: 1000 + i, ts: FIXED_TS
    });
  }
  return out;
}
const syncBody = (over) => Object.assign({
  v: 2, clientId: 'cPage', clientHost: 'page.example', warnMinutes: 30,
  alertTypes: { full: true, empty: true }, dirty: true, rows: rowsFor(20)
}, over || {});

console.log('A. 每日写入额度预算（免费版上限 1000 次/天）');

await check('首次同步只写"有变化的行"（KV 按写次数计费，无法合并）', async () => {
  const before = ENV.STATE.stats.put;
  const res = await worker.fetch(req('/sync', syncBody()), ENV, {});
  const j = await res.json();
  const used = ENV.STATE.stats.put - before;
  assert(j.ok === 1, '同步失败：' + JSON.stringify(j));
  // 20 行 + meta:owner + meta:config：每个键都是一次写，这是 KV 的计费方式
  assert(used <= 25, '首次同步写入了 ' + used + ' 次，超出预期');
  return '20 行首次落盘 → ' + used + ' 次写';
});

await check('紧接着再同步一次（内容相同）→ 0 次写', async () => {
  const before = ENV.STATE.stats.put;
  await worker.fetch(req('/sync', syncBody({ dirty: true })), ENV, {});
  const used = ENV.STATE.stats.put - before;
  assert(used === 0, '内容没变却写入了 ' + used + ' 次');
  return '内容未变 → 0 次写（靠逐行比对跳过）';
});

await check('空闲心跳（dirty=false）消耗 0 次写', async () => {
  const before = ENV.STATE.stats.put;
  const res = await worker.fetch(req('/sync', syncBody({ dirty: false })), ENV, {});
  const j = await res.json();
  const used = ENV.STATE.stats.put - before;
  assert(j.ok === 1, '心跳失败：' + JSON.stringify(j));
  assert(used === 0, '心跳写入了 ' + used + ' 次（应为 0）');
  return 'dirty=false → 0 次写';
});

await check('dirty=false 不会误删数据（缺席计数被跳过）', async () => {
  const before = (await ENV.STATE.list({ prefix: 'row:' })).keys.length;
  for (let i = 0; i < 5; i++) await worker.fetch(req('/sync', syncBody({ dirty: false })), ENV, {});
  const after = (await ENV.STATE.list({ prefix: 'row:' })).keys.length;
  assert(before === after, '行数从 ' + before + ' 变成 ' + after + '：空闲心跳把数据删了');
  return '连续 5 次心跳后仍是 ' + after + ' 行';
});

await check('模拟一整天：1440 次心跳 + 288 次巡检的总写入量', async () => {
  const put0 = ENV.STATE.stats.put;
  const del0 = ENV.STATE.stats.del;

  // 一整天的心跳：每分钟一次，都没有改动
  for (let i = 0; i < 1440; i++) {
    await worker.fetch(req('/sync', syncBody({ dirty: false })), ENV, {});
  }
  // 一整天每 5 分钟一次的巡检
  for (let i = 0; i < 288; i++) await patrol();

  const used = (ENV.STATE.stats.put - put0) + (ENV.STATE.stats.del - del0);
  assert(used < 1000, '一天消耗 ' + used + ' 次写，超出免费额度');
  return '一天共 ' + used + ' 次写（额度 1000）';
});

await check('只改一行 → 只有那 1 行被写（其余 19 行跳过）', async () => {
  const rows = rowsFor(20);
  rows[7].stock = 7777;                       // 只动第 8 行
  const before = ENV.STATE.stats.put;
  await worker.fetch(req('/sync', syncBody({ dirty: true, rows: rows })), ENV, {});
  const used = ENV.STATE.stats.put - before;
  assert(used === 1, '改 1 行却写入了 ' + used + ' 次');
  return '改 1 行 → 1 次写';
});

await check('改预警设置只写 1 次；设置没变则 0 次', async () => {
  let before = ENV.STATE.stats.put;
  await worker.fetch(req('/sync', syncBody({ dirty: false, warnMinutes: 45 })), ENV, {});
  assert(ENV.STATE.stats.put - before === 1, '改设置应只写 1 次');

  before = ENV.STATE.stats.put;
  await worker.fetch(req('/sync', syncBody({ dirty: false, warnMinutes: 45 })), ENV, {});
  assert(ENV.STATE.stats.put - before === 0, '设置没变时不该写');
  return '改 1 次 / 不变 0 次';
});

console.log('\nB. 额度耗尽时的表现');

await check('额度耗尽 + 确实需要写 → 返回 503 与可读信息，而不是英文异常', async () => {
  const kv = makeKV();
  kv.stats.quotaLeft = 0;
  const env = Object.assign({}, ENV, { STATE: kv });
  const res = await worker.fetch(req('/sync', syncBody({ dirty: true })), env, {});
  const j = await res.json();
  assert(res.status === 503, '状态码 = ' + res.status);
  assert(j.ok === 0 && j.quota === 1, '未标记配额问题：' + JSON.stringify(j));
  assert(/额度/.test(j.message), '信息不可读：' + j.message);
  return 'HTTP 503 · ' + j.message;
});

await check('额度耗尽但无需写入（数据已在 KV）→ 成功且 0 次写', async () => {
  const kv = makeKV();
  const env = Object.assign({}, ENV, { STATE: kv });
  await worker.fetch(req('/sync', syncBody({ dirty: true })), env, {});
  kv.stats.quotaLeft = 0;
  const before = kv.stats.put;
  const res = await worker.fetch(req('/sync', syncBody({ dirty: false })), env, {});
  const j = await res.json();
  assert(res.status === 200 && j.ok === 1, '应成功，实际 ' + res.status + ' ' + JSON.stringify(j));
  assert(kv.stats.put - before === 0, '不该产生写入');
  return '200 · 无需写入时不受额度影响';
});

await check('额度耗尽时不会抛出未捕获异常', async () => {
  const kv = makeKV();
  const env = Object.assign({}, ENV, { STATE: kv });
  await worker.fetch(req('/sync', syncBody({ dirty: true })), env, {});
  kv.stats.quotaLeft = 0;
  const res = await worker.fetch(req('/reset-alerts', {}), env, {});
  assert(res.status === 503, '状态码 = ' + res.status);
  const j = await res.json();
  assert(j.quota === 1, '未标记配额问题');
  return '/reset-alerts 也优雅降级';
});

console.log('\nC. 预警照常工作（别为了省额度把功能改坏）');

await check('20 行里有一条即将爆仓 → 推送 1 条，且只写必要的那 1 行', async () => {
  ENV.STATE = makeKV();
  const kv = ENV.STATE;
  const env = ENV;
  const rows = rowsFor(20);
  rows[3].prod = 100; rows[3].cons = 0; rows[3].stock = 89000;   // 10 分钟封顶
  await worker.fetch(req('/sync', syncBody({ rows: rows })), env, {});

  pushes = [];
  const putBefore = kv.stats.put;
  await patrol();

  assert(pushes.length === 1, '推送次数 = ' + pushes.length);
  const title = new URLSearchParams(pushes[0].body).get('title');
  assert(/产物3/.test(title), '标题不对：' + title);
  const used = kv.stats.put - putBefore;
  assert(used <= 1, '一次巡检写入了 ' + used + ' 次（应只写状态变化的那 1 行）');
  return '推送 1 条，写入 ' + used + ' 次';
});

await check('推送失败时不写 meta:status（避免额外写）', async () => {
  ENV.STATE = makeKV();
  const kv = ENV.STATE;
  const env = ENV;
  const rows = rowsFor(5);
  rows[0].prod = 100; rows[0].cons = 0; rows[0].stock = 89000;
  await worker.fetch(req('/sync', syncBody({ rows: rows })), env, {});

  fetchMode = 'fail';
  const before = kv.stats.put;
  await patrol();
  fetchMode = 'ok';
  const used = kv.stats.put - before;
  assert(used <= 1, '推送失败时写入了 ' + used + ' 次');
  assert(!(await kv.get('meta:status', 'json')), '不该再写 meta:status');
  return '失败时也只写 ' + used + ' 次（记录在行内）';
});

await check('成功的推送时间可从行数据读出（页面状态灯仍能显示）', async () => {
  ENV.STATE = makeKV();
  const kv = ENV.STATE;
  const env = ENV;
  const rows = rowsFor(5);
  rows[0].prod = 100; rows[0].cons = 0; rows[0].stock = 89000;
  await worker.fetch(req('/sync', syncBody({ rows: rows })), env, {});
  await patrol();

  const res = await worker.fetch(req('/sync', syncBody({ rows: rows, dirty: false })), env, {});
  const j = await res.json();
  assert(j.lastPushAt > 0, 'lastPushAt = ' + j.lastPushAt);
  assert(j.lastPushOk === true, 'lastPushOk = ' + j.lastPushOk);
  return 'lastPushAt 由行数据聚合而来';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
