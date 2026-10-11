import worker, { __test } from './worker.js';

let failed = 0;
const check = async (name, fn) => {
  try { const r = await fn(); console.log('  ✓ ' + name + (r === undefined ? '' : '  → ' + r)); }
  catch (e) { failed++; console.log('  ✗ ' + name + '  → ' + (e && e.message)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

function makeKV(quota) {
  const m = new Map();
  const st = { put: 0, del: 0, quota };
  return {
    stats: st,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) {
      if (st.quota !== Infinity && st.put >= st.quota) throw new Error('KV put() limit exceeded for the day.');
      st.put++; m.set(k, v);
    },
    async delete(k) {
      if (st.quota !== Infinity && st.del >= st.quota) throw new Error('KV delete() limit exceeded for the day.');
      st.del++; m.delete(k);
    },
    async list(o) {
      const p = (o && o.prefix) || '';
      return { keys: [...m.keys()].filter(x => x.startsWith(p)).map(name => ({ name })) };
    }
  };
}

let pushes = [];
globalThis.fetch = async (url, init) => {
  pushes.push(String(init.body));
  return { ok: true, status: 200, text: async () => '{"code":0,"message":"ok"}' };
};

const CAP = 90000;
const ENV = { STATE: makeKV(Infinity), SC_SENDKEY: 'sctp24339aaaa', WARN_SECONDS: 1800, PUSH_RETRY_COOLDOWN_MS: 15 * 60 * 1000 };

function patrol(env) {
  const pending = [];
  const p = worker.scheduled({}, env || ENV, { waitUntil: x => { pending.push(x); return x; } });
  return Promise.resolve(p).then(() => Promise.allSettled(pending));
}

const row = () => ({
  id: 'r1', name: '源矿', remark: '', region: 'wuling', prod: 15, cons: 2,
  stock: CAP - 50, ts: Date.now(), alerted: 0, lastAttemptAt: 0, lastError: null, misses: 0, client: 'c1'
});

console.log('额度中断期间的推送行为');

await check('正常时：等级上升推一次，水位落盘', async () => {
  __test.quotaCooldown.clear();
  __test.pendingWrites.clear();
  ENV.STATE = makeKV(Infinity);
  await ENV.STATE.put('row:r1', JSON.stringify(row()));
  pushes = [];
  await patrol();
  assert(pushes.length === 1, '推送次数 = ' + pushes.length);
  assert((await ENV.STATE.get('row:r1', 'json')).alerted === 1, '水位未落盘');
  return '推送 1 次，alerted=1';
});

await check('额度用尽时：水位写不进去，但不会每轮重复推送', async () => {
  __test.quotaCooldown.clear();
  __test.pendingWrites.clear();
  const kv = makeKV(Infinity);
  ENV.STATE = kv;
  await kv.put('row:r1', JSON.stringify(row()));

  // 先让它正常推一次并落盘
  pushes = [];
  await patrol();
  assert(pushes.length === 1, '首次推送异常');

  // 让水位"丢掉"（模拟水位没写成功的情形），然后开始额度中断
  const r = await kv.get('row:r1', 'json');
  r.alerted = 0;
  await kv.put('row:r1', JSON.stringify(r));
  kv.stats.quota = kv.stats.put;      // 从此所有写入都失败

  pushes = [];
  for (let i = 0; i < 12; i++) await patrol();   // 模拟 1 小时（12 轮 × 5 分钟）
  assert(pushes.length === 1, '额度中断的 1 小时里推送了 ' + pushes.length + ' 次（应只 1 次）');
  assert(__test.pendingWrites.size === 1, '未排队待补写：' + __test.pendingWrites.size);
  return '12 轮巡检只推 1 次，水位已排队待补写';
});

await check('写入恢复后：积压的水位被补写回 KV', async () => {
  const kv = ENV.STATE;
  kv.stats.quota = Infinity;          // 额度恢复
  await patrol();
  const stored = await kv.get('row:r1', 'json');
  assert(stored.alerted === 1, '补写失败，alerted = ' + stored.alerted);
  assert(__test.pendingWrites.size === 0, '队列未清空');
  assert(__test.quotaCooldown.size === 0, '冷却未清空');
  return 'alerted 补写为 1，队列清空';
});

await check('恢复后不会因为"水位丢了"而重复推送', async () => {
  pushes = [];
  for (let i = 0; i < 5; i++) await patrol();
  assert(pushes.length === 0, '恢复后又推了 ' + pushes.length + ' 次');
  return '5 轮巡检 0 推送';
});

console.log('\n结果：' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
