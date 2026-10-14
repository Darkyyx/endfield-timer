/* ============================================================
 * 终末地 · 产线倒计时 — 通知哨兵 (Cloudflare Worker)
 * ------------------------------------------------------------
 * 职责：
 *   1. POST /sync  接收前端推送的产线快照，写入 KV
 *   2. 每 5 分钟定时巡检（cron 见 README），按时间锚点外推存量，跨阈值时推送 Server酱
 *   3. GET  /test  给设置面板用的连通性自检
 *   4. POST /reset-alerts  清空"已提醒"标记
 *
 * 部署：不需要 Wrangler，直接在 Cloudflare Dashboard 里粘贴本文件。
 * 详见 README.md「通知部署」一节。
 * ============================================================ */

/* ================= 配置（可在 Dashboard 覆盖） ================= */

/* Worker 版本号。页面会拿它和自身版本比对，不一致就提示"该重新部署 Worker 了" —— 
   否则改了 worker.js 却忘了部署，会表现为"功能不生效"且毫无线索。
   发新版时与 index.html 页脚的版本号保持一致。 */
const WORKER_VERSION = '1.12.0';

const DEFAULTS = {
  // 推送到某个产线达到上限/下限前多少秒开始预警
  WARN_SECONDS: 1800,

  // Server酱³ 推送地址模板。{uid} 与 {key} 会被环境变量替换。
  // 若你的后台给出的示例与此不符，只改这一行即可。
  SC_ENDPOINT: 'https://{uid}.push.ft07.com/send/{key}.send',

  // Server酱通道。留空 = 走默认通道（你在后台只留 App 通道即可）。
  // 若以后要多通道，填通道标识，会作为 channel 参数发送。
  SC_CHANNEL: '',

  // 推送失败后的重试间隔，避免失败时每 5 分钟重试一次
  PUSH_RETRY_COOLDOWN_MS: 15 * 60 * 1000,

  // 单次快照最多接受多少行，防止 KV 被灌爆
  MAX_ROWS: 200,

  // 一条产线连续缺席多少次同步后从 KV 删除（前端 60 秒一次 → 2 次约 2 分钟）
  DELETE_AFTER_MISSES: 2
};

const CAPS = { gudi: 80000, wuling: 90000 };
const REGION_LABEL = { gudi: '四号谷地', wuling: '武陵' };

/**
 * KV 写不进去时的兜底状态（必须在使用它的函数与 __test 之前声明）。
 *
 * 额度用尽时，"已提醒水位"和"上次尝试时间"都落不了盘，于是每次巡检都会重新
 * 认为"等级上升了、该推"→ 每 5 分钟重复推送，既刷屏又烧 Server酱 的推送额度。
 * quotaCooldown 在 isolate 内存里记一笔挡住重复；pendingWrites 排队等写入恢复后补写。
 */
const quotaCooldown = new Map();   // key → 上次推送尝试时间
const pendingWrites = new Map();   // key → 待补写的行数据

// 等级 1/2 看涨（爆仓方向），3/4 看跌（耗尽方向）
const LEVEL_META = {
  1: { icon: '⚠', title: '即将爆仓', tag: '即将爆仓' },
  2: { icon: '🛑', title: '已爆仓', tag: '爆仓' },
  3: { icon: '⚠', title: '即将耗尽', tag: '即将耗尽' },
  4: { icon: '🛑', title: '已耗尽', tag: '耗尽' }
};

/* ================= 纯函数（本地 node worker.test.mjs 可直接测） ================= */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 与 index.html 的 currentStock() 保持同一套公式 */
function projectStock(row, now) {
  const cap = CAPS[row.region] || CAPS.gudi;
  const net = num(row.prod) - num(row.cons);
  const base = Math.max(0, num(row.stock));
  const ts = num(row.ts) || now;
  const elapsed = Math.max(0, (now - ts) / 1000);
  return Math.min(cap, Math.max(0, base + net * elapsed / 60));
}

/**
 * 当前等级。
 *   0 = 正常（或不该提醒）
 *   1 = 即将爆仓   2 = 已爆仓
 *   3 = 即将耗尽   4 = 已耗尽
 * 注意：产销平衡（net = 0）一律返回 0。刚添加、还没填数据的行也返回 0。
 * types 用来按方向开关：{ full, empty }，关掉的方向直接返回 0（不提醒也不占水位）。
 */
function evaluateLevel(row, now, warnSeconds, types) {
  const t = types || { full: true, empty: true };

  // 刚点「添加产物」、三项都是 0 的空行：不参与提醒
  if (num(row.stock) === 0 && num(row.prod) === 0 && num(row.cons) === 0) return 0;

  const cap = CAPS[row.region] || CAPS.gudi;
  const prod = Math.max(0, num(row.prod));
  const cons = Math.max(0, num(row.cons));
  const net = prod - cons;
  if (net === 0) return 0;

  const stock = projectStock(row, now);

  if (net > 0) {
    if (!t.full) return 0;
    if (stock >= cap) return 2;
    if (stock + net * warnSeconds / 60 >= cap) return 1;
    return 0;
  }

  if (!t.empty) return 0;

  if (stock <= 0) return 4;
  if (stock + net * warnSeconds / 60 <= 0) return 3;
  return 0;
}

/**
 * 一次性提醒的核心规则：
 *   等级上升且高于"已提醒水位" → 推；推成功后把水位抬到该等级。
 *   等级不高于水位            → 什么都不做（所以爆仓后躺一天也不会重推）。
 *   等级降到 0（恢复）        → 水位归 0，为下一轮循环留出机会。
 * 返回 null 表示不需要推送。
 */
function decideAlert(prev, level) {
  const alerted = num(prev && prev.alerted);

  if (level === 0) {
    return alerted === 0 ? null : { action: 'reset', next: { ...prev, alerted: 0 } };
  }
  if (level > alerted) {
    return { action: 'push', next: { ...prev, alerted: level } };
  }
  return null;
}

/**
 * 把所有对外显示的时间统一按"固定小时偏移"的时区来格式化。
 *
 * 为什么必须显式指定：Cloudflare Workers 的运行时是 UTC，`getHours()` 拿到的
 * 永远是 UTC 时刻，和用户实际所在时区无关——直接用它会让通知里的预计时间差 8 小时。
 *
 * 这里不接受 IANA 名称（如 Asia/Shanghai）是因为 Etc/GMT 的符号与直觉相反
 * （UTC+8 对应 Etc/GMT-8），映射起来容易出错；用数字偏移配合 POSIX 时区串最直接。
 * 注意：POSIX 时区串的符号同样与常识相反，UTC+8 写作 "UTC-8"。
 */
function posixZone(offset) {
  const o = Number(offset);
  if (!isFinite(o) || o === 0) return 'UTC';
  const sign = o > 0 ? '-' : '+';
  const abs = Math.abs(o);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

/** 从任意配置值里解析出小时偏移；缺失或非法时回落到 +8（北京时间） */
function tzOffset(tz) {
  const o = Number(tz);
  if (!isFinite(o) || o < -12 || o > 14) return 8;
  return Math.round(o * 2) / 2;        // 支持半小时时区（如 UTC+5:30）
}

function tzLabel(tz) {
  const o = tzOffset(tz);
  const v = Math.abs(o);
  const h = Math.floor(v);
  const m = Math.round((v - h) * 60);
  return 'UTC' + (o < 0 ? '-' : '+') + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

/** 在指定时区里格式化某个时刻；withDate 为真时带上日期 */
function fmtInZone(ms, tz, withDate) {
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: posixZone(tz),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const get = function (t) { const f = parts.find(function (x) { return x.type === t; }); return f ? f.value : ''; };
    const clock = get('hour') + ':' + get('minute');
    return withDate ? (get('month') + '-' + get('day') + ' ' + clock) : clock;
  } catch (e) {
    // 极端环境下 Intl 不可用：退回固定偏移手算，结果一致
    const shifted = new Date(ms + tzOffset(tz) * 3600000);
    const clock = p(shifted.getUTCHours()) + ':' + p(shifted.getUTCMinutes());
    return withDate
      ? p(shifted.getUTCMonth() + 1) + '-' + p(shifted.getUTCDate()) + ' ' + clock
      : clock;
  }
}

/** 只给时刻，形如 14:32 —— 日期由 App 自身的通知时间体现，不重复写 */
function fmtClock(ms, tz) {
  return fmtInZone(ms, tz, false);
}

/**
 * 把一条产线渲染成一条独立消息（不再合并）。
 * 正文只说明"发生了什么 / 什么时候发生"，不带存量、上限、净速率和快照时间。
 * tz 是展示用时区的小时偏移，见 fmtInZone()。
 */
function composeItemMessage(item, now, tz) {
  const row = item.row;
  const meta = LEVEL_META[item.level];
  const remark = typeof row.remark === 'string' ? row.remark.trim() : '';

  const title = meta.icon + ' ' + meta.title + '：' + row.name
    + (remark ? '（' + remark + '）' : '');

  let desp;
  if (item.level === 1 || item.level === 3) {
    const net = num(row.prod) - num(row.cons);
    const remain = item.level === 1
      ? Math.max(0, (CAPS[row.region] || CAPS.gudi) - projectStock(row, now))
      : projectStock(row, now);
    const mins = Math.max(0, Math.round(remain / Math.abs(net)));
    desp = '预计 ' + fmtClock(now + mins * 60000, tz) + ' ' + meta.title.replace('即将', '')
      + '（约 ' + mins + ' 分钟后）';
  } else if (item.level === 2) {
    desp = '仓库已填满';
  } else {
    desp = '物品已耗尽';
  }

  return { title: title, desp: desp, short: desp, tags: meta.tag };
}

/* 仅供本地 worker.test.mjs 调用；Cloudflare 只使用 default 导出，多一个具名导出不影响运行 */
export const __test = {
  projectStock, evaluateLevel, decideAlert, composeItemMessage, fmtClock,
  tzOffset, tzLabel, fmtInZone, posixZone, quotaMessage, quotaResetText,
  deriveUid, resolveCredentials, effectiveConfig,
  quotaCooldown, pendingWrites
};

/* ================= Cloudflare 入口 ================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = Object.assign({}, DEFAULTS, env || {});

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === '/version') {
        return json({ ok: 1, version: WORKER_VERSION });
      }
      if (url.pathname === '/sync') {
        return await handleSync(request, env, cfg);
      }
      if (url.pathname === '/test') {
        return await handleTest(env, cfg);
      }
      if (url.pathname === '/claim') {
        return await handleClaim(request, env, cfg);
      }
      if (url.pathname === '/snapshot') {
        return await handleSnapshot(request, env, cfg);
      }
      if (url.pathname === '/reset-alerts') {
        return await handleResetAlerts(request, env, cfg);
      }
      if (url.pathname === '/state') {
        return await handleState(request, env, cfg);
      }
      return json({ ok: 0, message: 'not found' }, 404);
    } catch (err) {
      const msg = String(err && err.message || err);
      // 兜底：任何没被 safePut/safeDelete 拦住的可恢复错误（如 KV 额度耗尽）
      // 都换成可读信息，而不是把英文异常丢给页面
      if (QUOTA_RE.test(msg)) {
        return json({ ok: 0, quota: 1, message: QUOTA_MSG }, 503);
      }
      return json({ ok: 0, message: msg }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const cfg = Object.assign({}, DEFAULTS, env || {});
    ctx.waitUntil(runPatrol(env, cfg));
  }
};

/* ================= 鉴权与响应 ================= */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Token'
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders())
  });
}

function readToken(request) {
  const h = request.headers.get('X-Sync-Token');
  if (h) return h;
  const auth = request.headers.get('Authorization') || '';
  if (auth.indexOf('Bearer ') === 0) return auth.slice(7);
  return '';
}

function checkToken(request, env) {
  const expect = env && env.SYNC_TOKEN;
  if (!expect) return true;              // 没配令牌就不校验（部署初期自测方便，但强烈建议配上）
  return readToken(request) === expect;
}

/**
 * 读取前端下发的运行配置（预警窗口 + 提醒方向）。
 * KV 里的值是权威（页面改设置时会同步过来），缺失时退回 Worker 自己的默认值。
 */
async function effectiveConfig(env, cfg) {
  const meta = (await env.STATE.get('meta:config', 'json')) || {};
  const m = num(meta.warnMinutes);
  const at = meta.alertTypes && typeof meta.alertTypes === 'object' ? meta.alertTypes : {};
  return {
    warnSeconds: m > 0 ? Math.min(720, m) * 60 : num(cfg.WARN_SECONDS),
    types: {
      full: at.full !== false,
      empty: at.empty !== false
    },
    // 展示用时区（小时偏移）。meta 里没有就用 Worker 环境变量，再没有就 +8。
    timeZone: meta.timeZone != null && meta.timeZone !== '' ? tzOffset(meta.timeZone)
      : (cfg.TIME_ZONE != null && cfg.TIME_ZONE !== '' ? tzOffset(cfg.TIME_ZONE) : 8),
    lastQuotaAt: num(meta.lastQuotaAt)
  };
}

async function saveQuotaFlag(env, at) {
  try {
    const prev = (await env.STATE.get('meta:config', 'json')) || {};
    prev.lastQuotaAt = at;
    prev.updatedAt = Date.now();
    await env.STATE.put('meta:config', JSON.stringify(prev));
  } catch (e) { /* 写不进去是正常的（正因为写不进去才要记） */ }
}

/**
 * 批量写入。入参是 { key, value } 数组。
 *
 * 注意 Cloudflare KV 的额度按「写操作次数」计费，不是按字节也不是按键数，
 * 所以这里必须逐个键调用 put(k, v)，并靠"只在真正有变更时才写"来省额度 —— 
 * 不能把数组当作值传给 put()（那是把数组本身当成一个 value 存进某个键）。
 * 另外把"配额耗尽"这类可恢复错误换成可读信息，而不是让页面显示一串英文异常。
 */
const QUOTA_RE = /limit exceeded|quota|429|daily/i;

/**
 * 额度重置时刻的文案。
 * Cloudflare 按 **UTC 零点** 重置额度，所以本地时间取决于用户选的时区：
 * UTC+8 → 8:00，UTC+9 → 9:00，UTC-5 → 前一天 19:00。
 * 时区未知（例如上面那些还没拿到配置就出错的路径）时只说"次日"，不写死时间，避免误导。
 */
function quotaResetText(tz) {
  const raw = Number(tz);
  if (!isFinite(raw) || raw < -12 || raw > 14) return '次日重置';
  const o = tzOffset(raw);
  const h = ((24 + o) % 24 + 24) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  const hh = Math.floor(h);
  // 钟点不补零（"每天 8:00"），分钟补零（"8:05"）
  const clock = hh + ':' + String(mm).padStart(2, '0');
  return (o >= 0 ? '每天 ' : '每天（前一天）') + clock + ' 点重置';
}

function quotaMessage(tz) {
  return 'KV 每日写入额度已用尽（免费版 1000 次/天），' + quotaResetText(tz);
}

// 时区未知时的兜底（不写死钟点，避免换时区后误导）
const QUOTA_MSG = 'KV 每日写入额度已用尽（免费版 1000 次/天），次日重置';

async function safePut(env, pairs) {
  const list = (pairs || []).filter(function (p) { return p && p.key; });
  if (!list.length) return { ok: true, count: 0 };
  try {
    for (const p of list) await env.STATE.put(p.key, p.value);
    return { ok: true, count: list.length };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (QUOTA_RE.test(msg)) {
      // 失败时没法往 KV 写任何东西，所以把时间戳交给调用方，
      // 让它烙进"这次本来要写的内容"里 —— 下一次成功写入就把它捎进去了。
      return { ok: false, quota: true, at: Date.now(), message: QUOTA_MSG };
    }
    throw err;
  }
}

async function safeDelete(env, keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return { ok: true, count: 0 };
  try {
    for (const k of list) await env.STATE.delete(k);
    return { ok: true, count: list.length };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (QUOTA_RE.test(msg)) return { ok: false, quota: true, at: Date.now(), message: QUOTA_MSG };
    throw err;
  }
}

/**
 * 判断这一行是否有实质变化。没变就不写 —— KV 按写次数计费，
 * 一次同步里绝大多数行其实都跟上次一样，跳过它们才是省额度的关键。
 * 只比对页面负责的字段，Worker 自己的状态（alerted / lastError / misses）不算。
 */
function sameRow(prev, next) {
  if (!prev || !prev.id) return false;
  return prev.name === next.name
    && String(prev.remark || '') === String(next.remark || '')
    && prev.region === next.region
    && num(prev.prod) === next.prod
    && num(prev.cons) === next.cons
    && Math.floor(num(prev.stock)) === next.stock
    && num(prev.ts) === next.ts
    && String(prev.client || '') === String(next.client || '');
}

/* ================= /sync ================= */

async function handleSync(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: 0, message: 'use POST' }, 405);
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);
  if (!checkToken(request, env)) return json({ ok: 0, message: '令牌错误' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: 0, message: '请求体不是合法 JSON' }, 400);
  }

  const incoming = Array.isArray(body && body.rows) ? body.rows.slice(0, cfg.MAX_ROWS) : [];
  const seen = Object.create(null);
  const rowPuts = [];
  let written = 0;

  /* ---- 数据源归属：同一份 Worker 状态只接受一个 clientId 覆盖 ---- */
  const clientId = String((body && body.clientId) || '').slice(0, 64);
  const clientHost = String((body && body.clientHost) || '').slice(0, 120);
  const force = !!(body && body.force);
  let owner = (await env.STATE.get('meta:owner', 'json')) || null;

  if (owner && owner.clientId && clientId && owner.clientId !== clientId && !force) {
    // 不覆盖别人的数据，把情况告诉页面，由你来决定导入还是替换
    return json({
      ok: 0,
      code: 'owner_mismatch',
      message: '另一个页面正在作为通知源',
      worker: WORKER_VERSION,
      owner: { host: owner.host || '', since: owner.since || 0 },
      rows: await countRows(env)
    }, 409);
  }

  if (clientId && (!owner || owner.clientId !== clientId)) {
    owner = { clientId: clientId, host: clientHost, since: Date.now() };
    const ownRes = await safePut(env, [{ key: 'meta:owner', value: JSON.stringify(owner) }]);
    if (ownRes.quota) {
      return json({ ok: 1, quota: 1, quotaAt: ownRes.at, message: ownRes.message, rows: 0 }, 200);
    }
  }

  // 前端设置面板里的"预警提前量""提醒方向""展示时区"以这里为准，避免两处配置打架
  const warnMinutes = num(body && body.warnMinutes);
  const at = (body && body.alertTypes) || null;
  const tzIn = body && body.timeZone != null && body.timeZone !== '' ? num(body.timeZone) : NaN;
  if (warnMinutes > 0 || at || isFinite(tzIn)) {
    const prev = (await env.STATE.get('meta:config', 'json')) || {};
    const next = {
      warnMinutes: warnMinutes > 0 ? Math.min(720, warnMinutes) : num(prev.warnMinutes) || 30,
      alertTypes: at
        ? { full: at.full !== false, empty: at.empty !== false }
        : (prev.alertTypes || { full: true, empty: true }),
      // 时区只在页面明确上报时覆盖；缺失时保留原值，避免旧版页面把设置清掉
      timeZone: isFinite(tzIn) ? tzOffset(tzIn) : (prev.timeZone != null ? prev.timeZone : undefined)
    };
    // 只有真的变了才写，避免每次心跳都消耗一次写入额度
    if (next.warnMinutes !== num(prev.warnMinutes)
      || next.timeZone !== prev.timeZone
      || !prev.alertTypes
      || next.alertTypes.full !== prev.alertTypes.full
      || next.alertTypes.empty !== prev.alertTypes.empty) {
      next.updatedAt = Date.now();
      await safePut(env, [{ key: 'meta:config', value: JSON.stringify(next) }]);
    }
  }

  // dirty 为 false 表示页面自上次同步以来没有任何改动 —— 此时一个字节都不写。
  // 页面的倒计时靠自个儿的锚点算，Worker 也按同一锚点外推，所以没必要反复推同样的数据。
  const dirty = body && body.dirty === false ? false : true;

  for (let i = 0; dirty && i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;

    seen[raw.id] = true;
    const prev = (await env.STATE.get('row:' + raw.id, 'json')) || {};
    const next = {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : String(prev.name || ''),
      remark: typeof raw.remark === 'string' ? raw.remark : String(prev.remark || ''),
      region: CAPS[raw.region] ? raw.region : 'wuling',
      prod: Math.max(0, num(raw.prod)),
      cons: Math.max(0, num(raw.cons)),
      stock: Math.max(0, Math.floor(num(raw.stock))),
      ts: num(raw.ts) || Date.now(),
      client: clientId || String(prev.client || ''),
      // 保留 Worker 自己的提醒水位，不因前端同步而丢
      alerted: num(prev.alerted),
      lastAttemptAt: num(prev.lastAttemptAt),
      lastError: prev.lastError || null,
      misses: 0,
      updatedAt: Date.now()
    };
    if (!sameRow(prev, next)) {                 // 内容没变就不写，省下这一次额度
      rowPuts.push({ key: 'row:' + raw.id, value: JSON.stringify(next) });
    }
    written++;
  }

  // 不是本 client 留下的行也要计入"缺席"，这样换域名后残留数据会被逐步清掉
  let foreignRows = 0;
  let removed = 0;
  let lastPushAt = 0;
  let lastQuota = 0;
  let lastPushOk = true;
  let lastError = null;
  const missPuts = [];
  const delKeys = [];
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const prev = (await env.STATE.get(k.name, 'json')) || {};
    const id = k.name.slice(4);
    // 上次写入是否因额度失败：这个标记会被成功写入时一起带进 KV，
    // 所以只读请求（dirty=false）也能如实把它报给页面
    const qAt = num(prev.lastQuotaAt) || num(prev.lastQuota);
    if (qAt > lastQuota) lastQuota = qAt;
    // 如实汇报：KV 里有多少行不属于本页面（含换域名后的残留）。
    // "刚接管完要不要再问一次"是页面的判断，不在这里替它决定。
    const foreign = !!clientId && String(prev.client || '') !== clientId;
    if (foreign) foreignRows++;
    if (num(prev.lastPushAt) > lastPushAt) {
      lastPushAt = num(prev.lastPushAt);
      lastPushOk = prev.lastError ? false : true;
      lastError = prev.lastError || null;
    }
    // dirty=false 时本轮没有覆盖任何行，缺席计数必须整个跳过，否则会把好数据当残留删掉
    if (!dirty) continue;
    if (seen[id]) continue;
    const misses = num(prev.misses) + 1;
    if (misses >= cfg.DELETE_AFTER_MISSES) {
      delKeys.push(k.name);
      removed++;
    } else {
      prev.misses = misses;
      missPuts.push({ key: k.name, value: JSON.stringify(prev) });
    }
  }

  // 无论多少行，一次同步最多只产生 2 次写操作（批量 put + 批量 delete）
  const putRes = await safePut(env, rowPuts.concat(missPuts));
  const delRes = await safeDelete(env, delKeys);
  const quotaHit = putRes.quota || delRes.quota;
  const quotaAt = putRes.at || delRes.at || 0;
  const quotaMsg = putRes.message || delRes.message || QUOTA_MSG;
  if (quotaHit) await saveQuotaFlag(env, quotaAt);

  // 额度状态以 KV 里的记录（meta:config.lastQuotaAt）为权威，**不再无条件相信页面的回显**。
  // 否则会出现自我维持的死循环：页面把 localStorage 里的旧时间戳传上来 → 这里回显 →
  // 页面又存回去 → 下次继续传……即使额度早已重置也永远解不掉。
  // 额度刚命中时也可以读配置（只是写不进去），所以要拿时区来做文案。
  const cfgMeta = await effectiveConfig(env, cfg);
  const quotaText = quotaHit ? quotaMessage(cfgMeta.timeZone) : quotaMsg;
  let reportedQuotaAt = quotaHit ? quotaAt : (lastQuota || (cfgMeta && cfgMeta.lastQuotaAt) || 0);

  // 页面报着"额度不足"但 KV 里没有任何记录时，做一次探测写入来验证：
  //   · 额度已恢复 → 探测成功，顺带把 KV 里的标记清掉，页面随即回绿
  //   · 额度仍不足 → 探测失败，如实回 idle 状态并重新记下时间戳
  // 代价是最多 1 次写入，只在"页面与 Worker 判断不一致"时发生。
  const echoed = num(body && body.quotaAt);
  let probeFailed = false;
  if (!quotaHit && echoed && !reportedQuotaAt) {
    const probe = await safePut(env, [{
      key: 'meta:config',
      value: JSON.stringify({
        warnMinutes: num(cfg && cfg.WARN_SECONDS) > 0 ? Math.round(num(cfg.WARN_SECONDS) / 60) : 30,
        alertTypes: (cfgMeta && cfgMeta.types) || { full: true, empty: true },
        timeZone: cfgMeta ? cfgMeta.timeZone : undefined,
        lastQuotaAt: 0,
        updatedAt: Date.now()
      })
    }]);
    if (probe.quota) {
      probeFailed = true;
      reportedQuotaAt = probe.at || Date.now();
      await saveQuotaFlag(env, reportedQuotaAt);
    }
  }

  return json({
    ok: 1,                              // 请求本身处理成功；额度问题用 quota 字段单独表达
    worker: WORKER_VERSION,             // 让页面能发现"Worker 忘了重新部署"
    quota: reportedQuotaAt ? 1 : 0,     // 含"这次没写、但已知额度不足"的情况
    quotaAt: reportedQuotaAt,
    probed: probeFailed ? 1 : 0,
    message: reportedQuotaAt ? quotaText : undefined,
    // 回传时区与重置时刻文案，页面不必自己再算一遍（避免两边算法漂移）
    timeZone: cfgMeta ? cfgMeta.timeZone : tzOffset(8),
    quotaReset: quotaResetText(cfgMeta ? cfgMeta.timeZone : 8),
    writes: rowPuts.length + missPuts.length,
    rows: written,
    removed: removed,
    foreignRows: foreignRows,          // 属于别的页面的残留行数量，>0 时前端会问你要不要导入
    owner: owner && owner.clientId
      ? { host: owner.host || '', mine: owner.clientId === clientId }
      : null,
    lastPushAt: lastPushAt,
    lastPushOk: lastPushOk,
    lastError: lastError
  });
}

/* ================= 数据源归属：/claim 与 /snapshot ================= */

async function countRows(env) {
  if (!env || !env.STATE) return 0;
  const list = await env.STATE.list({ prefix: 'row:' });
  return list.keys.length;
}

function readClaimToken(request, url) {
  const h = request.headers.get('X-Claim-Token');
  if (h) return h;
  return url.searchParams.get('token') || '';
}

/**
 * 接管为通知源。换域名 / 换电脑时，由新页面点一下完成；旧所有者下次同步会收到 409 转为只读。
 *   mode = import  → 保留 Worker 现有数据（换域名时把旧数据接过来）
 *   mode = replace → 清掉旧数据，改用本页面自己的数据
 * 若配置了 CLAIM_TOKEN，则必须带上才允许接管。
 */
async function handleClaim(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: 0, message: 'use POST' }, 405);
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);

  const url = new URL(request.url);
  const expect = env.CLAIM_TOKEN;
  if (expect && readClaimToken(request, url) !== expect) {
    return json({ ok: 0, message: '接管令牌错误（CLAIM_TOKEN）' }, 401);
  }

  let body = {};
  try { body = (await request.json()) || {}; } catch (e) { /* 允许空 body */ }

  const clientId = String(body.clientId || '').slice(0, 64);
  const host = String(body.clientHost || '').slice(0, 120);
  const mode = body.mode === 'replace' ? 'replace' : 'import';

  if (!clientId) return json({ ok: 0, message: '缺少 clientId' }, 400);

  let removed = 0;
  if (mode === 'replace') {
    // 旧页面的数据整批清掉，避免残留行继续按旧数据发通知
    const list = await env.STATE.list({ prefix: 'row:' });
    const delKeys = [];
    for (const k of list.keys) {
      const row = await env.STATE.get(k.name, 'json');
      if (row && String(row.client || '') === clientId) continue;
      delKeys.push(k.name);
      removed++;
    }
    await safeDelete(env, delKeys);   // 一次批量删除，只算一次写
  }

  await safePut(env, [{ key: 'meta:owner', value: JSON.stringify({ clientId: clientId, host: host, since: Date.now() }) }]);

  return json({ ok: 1, mode: mode, removed: removed, rows: await countRows(env) });
}

/** 导出 Worker 现有数据，供新页面导入（必须持有同步令牌） */
async function handleSnapshot(request, env, cfg) {
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);
  if (!checkToken(request, env)) return json({ ok: 0, message: '令牌错误' }, 401);

  const now = Date.now();
  const out = [];
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;
    out.push({
      id: row.id,
      name: row.name,
      remark: row.remark || '',
      region: CAPS[row.region] ? row.region : 'wuling',
      prod: num(row.prod),
      cons: num(row.cons),
      stock: Math.max(0, Math.floor(num(row.stock))),
      ts: num(row.ts) || now
    });
  }

  const owner = (await env.STATE.get('meta:owner', 'json')) || null;
  return json({
    ok: 1,
    rows: out,
    owner: owner ? { host: owner.host || '', since: owner.since || 0 } : null
  });
}

/* ================= /state ================= */

async function handleState(request, env, cfg) {
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);
  if (!checkToken(request, env)) return json({ ok: 0, message: '令牌错误' }, 401);

  const now = Date.now();
  const { warnSeconds, types, timeZone } = await effectiveConfig(env, cfg);
  const out = [];
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;
    out.push({
      id: row.id,
      name: row.name,
      remark: row.remark || '',
      region: row.region,
      alerted: num(row.alerted),
      misses: num(row.misses),
      level: evaluateLevel(row, now, warnSeconds, types),
      stock: Math.round(projectStock(row, now))
    });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });

  // 一并给出归属与近期写入状态，便于排查（令牌已校验过）
  const owner = (await env.STATE.get('meta:owner', 'json')) || null;
  const cfgMeta = (await env.STATE.get('meta:config', 'json')) || {};
  return json({
    ok: 1,
    worker: WORKER_VERSION,
    now: now,
    timeZone: timeZone,
    owner: owner ? { clientId: owner.clientId || '', host: owner.host || '', since: owner.since || 0 } : null,
    lastQuotaAt: num(cfgMeta.lastQuotaAt) || 0,
    rows: out
  });
}

/* ================= /reset-alerts ================= */

async function handleResetAlerts(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: 0, message: 'use POST' }, 405);
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);
  if (!checkToken(request, env)) return json({ ok: 0, message: '令牌错误' }, 401);

  let ids = null;
  try {
    const body = await request.json();
    if (body && Array.isArray(body.ids)) ids = body.ids;
  } catch (e) { /* 无 body 视为全部重置 */ }

  let reset = 0;
  const puts = [];
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;
    if (ids && ids.indexOf(row.id) < 0) continue;
    row.alerted = 0;
    row.lastError = null;
    puts.push({ key: k.name, value: JSON.stringify(row) });
    reset++;
  }
  const putRes = await safePut(env, puts);
  if (putRes.quota) await saveQuotaFlag(env, putRes.at);
  return json({
    ok: 1,                              // 与 /sync 一致：请求成功，配额问题用 quota 表达
    quota: putRes.quota ? 1 : 0,
    quotaAt: putRes.at || 0,
    message: putRes.quota ? putRes.message : undefined,
    reset: reset
  });
}

/* ================= /test 与推送 ================= */

async function handleTest(env, cfg) {
  // 检查时间按用户选的时区展示，并标出时区名，避免"这个时间是哪个时区"的疑问
  const eff = await effectiveConfig(env, cfg);
  const tz = eff.timeZone;
  const res = await pushServerChan(env, cfg, {
    title: '✅ 终末地通知测试',
    desp: '如果你在 App 里看到这条消息，说明 **Worker → Server酱** 这条链路已经打通。\n\n'
      + '- 推送地址模板：`' + cfg.SC_ENDPOINT + '`\n'
      + '- 检查时间：' + fmtInZone(Date.now(), tz, true) + '（' + tzLabel(tz) + '）',
    short: '链路自检成功',
    tags: '测试'
  });
  return json({
    ok: res.ok ? 1 : 0,
    code: res.code == null ? null : res.code,
    message: res.message,
    endpoint: cfg.SC_ENDPOINT
  }, res.ok ? 200 : 502);
}

/**
 * 从 SendKey 解析 UID。
 * Server酱³ 的 SendKey 形如 sctp<UID><随机串>（例：sctp24339tauwt87osfuw9nyptebxxxx → UID 24339），
 * 所以 UID 是冗余信息，不必让用户再手填一遍（也少一个填错的地方）。
 * 解析不出来（或 SendKey 格式与预期不符）时返回空串，由调用方决定报什么错。
 */
function deriveUid(sendkey) {
  const k = String(sendkey == null ? '' : sendkey).trim();
  if (!k) return '';

  const lower = k.toLowerCase();
  if (lower.indexOf('sctp') === 0) return k.slice(4).match(/^\d+/)?.[0] || '';
  if (/^\d+$/.test(k)) return k;   // 直接填了纯数字 UID 的情况
  return '';
}

/** 推送凭据：SendKey 必需；UID 优先用显式配置，否则从 SendKey 里解析 */
function resolveCredentials(env) {
  const key = String((env && env.SC_SENDKEY) || '').trim();
  if (!key) {
    return { ok: false, reason: '未配置 SC_SENDKEY（在 Worker 的 Variables and Secrets 里添加）' };
  }
  const explicit = String((env && env.SC_UID) || '').trim();
  const uid = explicit || deriveUid(key);
  if (!uid) {
    return {
      ok: false,
      reason: '无法从 SendKey 解析 UID，请检查 SC_SENDKEY 是否为 Server酱³ 的 SendKey'
        + '（形如 sctp<UID><随机串>），或额外配置一个 SC_UID'
    };
  }
  return { ok: true, uid: uid, key: key, uidFrom: explicit ? 'env' : 'sendkey' };
}

async function pushServerChan(env, cfg, payload) {
  const cred = resolveCredentials(env);

  if (cred.ok) {
    const endpoint = String(cfg.SC_ENDPOINT)
      .replace('{uid}', encodeURIComponent(cred.uid))
      .replace('{key}', encodeURIComponent(cred.key));

    const form = new URLSearchParams();
    form.set('title', payload.title);
    form.set('desp', payload.desp);
    if (payload.short) form.set('short', payload.short);
    if (payload.tags) form.set('tags', payload.tags);
    if (cfg.SC_CHANNEL) form.set('channel', String(cfg.SC_CHANNEL));

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: form.toString()
      });
      const text = await res.text();

      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
      const code = data && data.code != null ? data.code : null;

      if (!res.ok) {
        return { ok: false, code: code, message: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
      }
      if (code != null && code !== 0) {
        return { ok: false, code: code, message: (data && (data.message || data.info)) || ('接口返回 code=' + code) };
      }
      return { ok: true, code: code, message: (data && data.message) || 'ok' };
    } catch (err) {
      return { ok: false, code: null, message: '请求异常：' + String(err && err.message || err) };
    }
  }

  // 凭据不可用时只做干跑：把原因写进状态，前端能看到"配置有问题"而不是静默失败
  return { ok: false, code: null, message: cred.reason + '（干跑，未真正推送）' };
}

/* ================= 定时巡检 ================= */

async function runPatrol(env, cfg) {
  if (!env || !env.STATE) return;

  // 先补写上次因额度中断而没落盘的水位；写入恢复正常时它们会一次性归位
  if (pendingWrites.size) {
    const retry = [];
    pendingWrites.forEach(function (value, key) { retry.push({ key: key, value: value }); });
    const res = await safePut(env, retry);
    if (!res.quota) {
      pendingWrites.clear();
      quotaCooldown.clear();
    }
  }

  const now = Date.now();
  const { warnSeconds, types, timeZone } = await effectiveConfig(env, cfg);
  const retryCooldown = num(cfg.PUSH_RETRY_COOLDOWN_MS);

  const list = await env.STATE.list({ prefix: 'row:' });
  const candidates = [];
  const writes = [];      // 收集本轮所有要写的行，最后合并成一次批量写

  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;

    const level = evaluateLevel(row, now, warnSeconds, types);
    const decision = decideAlert(row, level);

    if (!decision) continue;

    // 状态恢复：静默把水位归零，不推送
    if (decision.action === 'reset') {
      writes.push({ key: k.name, value: JSON.stringify(decision.next) });
      continue;
    }

    // 上次推送失败时，别每 5 分钟就重试一次
    if (row.lastError && now - num(row.lastAttemptAt) < retryCooldown) continue;
    // 额度中断期间水位落不了盘，用内存冷却挡住重复推送
    if (now - num(quotaCooldown.get(k.name), 0) < retryCooldown) continue;

    candidates.push({ row: row, key: k.name, level: level });
  }

  if (!candidates.length) {
    const r = await safePut(env, writes);   // 只有状态复位要落盘时，也只是一次写
    if (r.quota) await saveQuotaFlag(env, r.at);
    return;
  }

  // 每条物品单独推一条消息（不合并），严重等级优先
  const ordered = candidates.slice().sort(function (a, b) { return a.level - b.level; });
  let allOk = true;
  let lastErr = null;

  for (const c of ordered) {
    const one = await pushServerChan(env, cfg, composeItemMessage(c, now, timeZone));
    if (!one.ok) {
      allOk = false;
      lastErr = one.message;
    }
  }

  // 推送结果只写回待处理的那几行（与上面的复位合并成一次批量写），
  // 不再额外维护 meta:status，否则免费额度（1000 写/天）很容易被烧光
  for (const c of candidates) {
    if (allOk) {
      c.row.alerted = c.level;
      c.row.lastError = null;
    } else {
      c.row.lastError = lastErr;
    }
    c.row.lastAttemptAt = now;
    c.row.lastPushAt = now;
    writes.push({ key: c.key, value: JSON.stringify(c.row) });
  }
  const pr = await safePut(env, writes);
  if (pr.quota) {
    // 水位没落盘：在内存里记下尝试时间挡住重复推送，并排队等写入恢复后补写
    for (const c of candidates) {
      quotaCooldown.set(c.key, now);
      pendingWrites.set(c.key, JSON.stringify(c.row));
    }
    await saveQuotaFlag(env, pr.at);   // 尽力记录，供只读请求如实上报
  } else {
    for (const c of candidates) {
      quotaCooldown.delete(c.key);
      pendingWrites.delete(c.key);
    }
  }
}
