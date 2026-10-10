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
 */
function evaluateLevel(row, now, warnSeconds) {
  // 刚点「添加产物」、三项都是 0 的空行：不参与提醒
  if (num(row.stock) === 0 && num(row.prod) === 0 && num(row.cons) === 0) return 0;

  const cap = CAPS[row.region] || CAPS.gudi;
  const prod = Math.max(0, num(row.prod));
  const cons = Math.max(0, num(row.cons));
  const net = prod - cons;
  if (net === 0) return 0;

  const stock = projectStock(row, now);

  if (net > 0) {
    if (stock >= cap) return 2;
    if (stock + net * warnSeconds / 60 >= cap) return 1;
    return 0;
  }

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

/** 把本轮要推的条目渲染成一条消息（多条产线合并成一条，省配额也少打扰） */
function composeMessage(items, now) {
  const groups = new Map();
  items.forEach(function (it) {
    if (!groups.has(it.level)) groups.set(it.level, []);
    groups.get(it.level).push(it);
  });

  const lines = [];
  [1, 2, 3, 4].forEach(function (lv) {
    const list = groups.get(lv);
    if (!list || !list.length) return;
    lines.push('**' + LEVEL_META[lv].icon + ' ' + LEVEL_META[lv].title + '**');
    list.forEach(function (it) {
      lines.push('- ' + it.text);
    });
    lines.push('');
  });

  const tags = [];
  groups.forEach(function (_list, lv) {
    const t = LEVEL_META[lv].tag;
    if (tags.indexOf(t) < 0) tags.push(t);
  });

  const hhmm = function (d) {
    const p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  lines.push('_快照 ' + hhmm(new Date(now)) + ' · 数据来自电脑端页面_');

  const title = items.length === 1
    ? LEVEL_META[items[0].level].icon + ' ' + LEVEL_META[items[0].level].title + '：' + items[0].name
    : '终末地产线预警 · ' + items.length + ' 条';

  const shortParts = [];
  [1, 2, 3, 4].forEach(function (lv) {
    const list = groups.get(lv);
    if (list && list.length) shortParts.push(LEVEL_META[lv].title + ' ' + list.length);
  });

  return {
    title: title,
    desp: lines.join('\n'),
    short: shortParts.join(' · '),
    tags: tags.join('|')
  };
}

/** 把一条产线渲染成一行动态文案（带存量与净速率，方便手机上判断轻重） */
function describeItem(item, now) {
  const row = item.row;
  const cap = CAPS[row.region] || CAPS.gudi;
  const region = REGION_LABEL[row.region] || '武陵';
  const net = num(row.prod) - num(row.cons);
  const stock = Math.round(projectStock(row, now));
  const sign = net > 0 ? '+' : '';
  const tail = '净 ' + sign + Math.round(net * 100) / 100 + '/分';

  if (item.level === 2) {
    return row.name + '（' + region + '） 存量 ' + stock.toLocaleString('en-US')
      + ' / ' + cap.toLocaleString('en-US') + ' — ' + tail;
  }
  if (item.level === 4) {
    return row.name + '（' + region + '） 存量已归零 — ' + tail;
  }

  // 即将爆仓 / 即将耗尽：报出剩余量与预计时间
  const remain = item.level === 1
    ? Math.max(0, cap - stock)
    : stock;
  const mins = Math.max(0, Math.round(remain / Math.abs(net)));
  const verb = item.level === 1 ? '爆仓' : '耗尽';
  return row.name + '（' + region + '）' + (item.level === 1 ? ' 剩余 ' : ' 存量 ')
    + remain.toLocaleString('en-US') + ' — 约 ' + mins + ' 分钟后' + verb + '，' + tail;
}

/* 仅供本地 worker.test.mjs 调用；Cloudflare 只使用 default 导出，多一个具名导出不影响运行 */
export const __test = {
  projectStock, evaluateLevel, decideAlert, composeMessage, describeItem,
  deriveUid, resolveCredentials
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
      if (url.pathname === '/sync') {
        return await handleSync(request, env, cfg);
      }
      if (url.pathname === '/test') {
        return await handleTest(env, cfg);
      }
      if (url.pathname === '/reset-alerts') {
        return await handleResetAlerts(request, env, cfg);
      }
      if (url.pathname === '/state') {
        return await handleState(request, env, cfg);
      }
      return json({ ok: 0, message: 'not found' }, 404);
    } catch (err) {
      return json({ ok: 0, message: String(err && err.message || err) }, 500);
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

/** 预警窗口秒数：以前端同步过来的 warnMinutes 为准，未同步时用 Worker 自己的 WARN_SECONDS */
async function effectiveWarnSeconds(env, cfg) {
  const meta = (await env.STATE.get('meta:config', 'json')) || {};
  const m = num(meta.warnMinutes);
  if (m > 0) return Math.min(720, m) * 60;
  return num(cfg.WARN_SECONDS);
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
  let written = 0;

  // 前端设置面板里的"预警提前量"以这里为准，避免两处配置打架
  const warnMinutes = num(body && body.warnMinutes);
  if (warnMinutes > 0) {
    await env.STATE.put('meta:config', JSON.stringify({
      warnMinutes: Math.min(720, warnMinutes),
      updatedAt: Date.now()
    }));
  }

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;

    seen[raw.id] = true;
    const prev = (await env.STATE.get('row:' + raw.id, 'json')) || {};
    const next = {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : String(prev.name || ''),
      region: CAPS[raw.region] ? raw.region : 'wuling',
      prod: Math.max(0, num(raw.prod)),
      cons: Math.max(0, num(raw.cons)),
      stock: Math.max(0, Math.floor(num(raw.stock))),
      ts: num(raw.ts) || Date.now(),
      // 保留 Worker 自己的提醒水位，不因前端同步而丢
      alerted: num(prev.alerted),
      lastAttemptAt: num(prev.lastAttemptAt),
      lastError: prev.lastError || null,
      misses: 0,
      updatedAt: Date.now()
    };
    await env.STATE.put('row:' + raw.id, JSON.stringify(next));
    written++;
  }

  // 前端已删除的行：连续缺席若干次后清理
  let removed = 0;
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const id = k.name.slice(4);
    if (seen[id]) continue;
    const prev = (await env.STATE.get(k.name, 'json')) || {};
    const misses = num(prev.misses) + 1;
    if (misses >= cfg.DELETE_AFTER_MISSES) {
      await env.STATE.delete(k.name);
      removed++;
    } else {
      prev.misses = misses;
      await env.STATE.put(k.name, JSON.stringify(prev));
    }
  }

  const last = (await env.STATE.get('meta:status', 'json')) || {};
  return json({
    ok: 1,
    rows: written,
    removed: removed,
    lastPushAt: last.lastPushAt || 0,
    lastPushOk: last.lastPushOk !== false,
    lastError: last.lastError || null,
    lastPushCode: last.lastPushCode == null ? null : last.lastPushCode
  });
}

/* ================= /state ================= */

async function handleState(request, env, cfg) {
  if (!env || !env.STATE) return json({ ok: 0, message: '未绑定 KV 命名空间 STATE' }, 500);
  if (!checkToken(request, env)) return json({ ok: 0, message: '令牌错误' }, 401);

  const now = Date.now();
  const warnSeconds = await effectiveWarnSeconds(env, cfg);
  const out = [];
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;
    out.push({
      id: row.id,
      name: row.name,
      region: row.region,
      alerted: num(row.alerted),
      misses: num(row.misses),
      level: evaluateLevel(row, now, warnSeconds),
      stock: Math.round(projectStock(row, now))
    });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
  return json({ ok: 1, now: now, rows: out });
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
  const list = await env.STATE.list({ prefix: 'row:' });
  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;
    if (ids && ids.indexOf(row.id) < 0) continue;
    row.alerted = 0;
    row.lastError = null;
    await env.STATE.put(k.name, JSON.stringify(row));
    reset++;
  }
  return json({ ok: 1, reset: reset });
}

/* ================= /test 与推送 ================= */

async function handleTest(env, cfg) {
  const now = Date.now();
  const res = await pushServerChan(env, cfg, {
    title: '✅ 终末地通知测试',
    desp: '如果你在 App 里看到这条消息，说明 **Worker → Server酱** 这条链路已经打通。\n\n'
      + '- 推送地址模板：`' + cfg.SC_ENDPOINT + '`\n'
      + '- 检查时间：' + new Date(now).toISOString(),
    short: '链路自检成功',
    tags: '测试'
  });
  if (res.ok) await savePushStatus(env, { lastPushAt: now, lastPushOk: true, lastError: null, lastPushCode: res.code });
  else await savePushStatus(env, { lastPushAt: now, lastPushOk: false, lastError: res.message, lastPushCode: res.code });
  return json({
    ok: res.ok ? 1 : 0,
    code: res.code == null ? null : res.code,
    message: res.message,
    endpoint: cfg.SC_ENDPOINT
  }, res.ok ? 200 : 502);
}

async function savePushStatus(env, patch) {
  if (!env || !env.STATE) return;
  const prev = (await env.STATE.get('meta:status', 'json')) || {};
  await env.STATE.put('meta:status', JSON.stringify(Object.assign(prev, patch)));
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

  const now = Date.now();
  const warnSeconds = await effectiveWarnSeconds(env, cfg);
  const retryCooldown = num(cfg.PUSH_RETRY_COOLDOWN_MS);

  const list = await env.STATE.list({ prefix: 'row:' });
  const candidates = [];

  for (const k of list.keys) {
    const row = await env.STATE.get(k.name, 'json');
    if (!row) continue;

    const level = evaluateLevel(row, now, warnSeconds);
    const decision = decideAlert(row, level);

    if (!decision) continue;

    // 状态恢复：静默把水位归零，不推送
    if (decision.action === 'reset') {
      await env.STATE.put(k.name, JSON.stringify(decision.next));
      continue;
    }

    // 上次推送失败时，别每 5 分钟就重试一次
    if (row.lastError && now - num(row.lastAttemptAt) < retryCooldown) continue;

    candidates.push({ row: row, key: k.name, level: level });
  }

  if (!candidates.length) return;

  const items = candidates.map(function (c) {
    return {
      level: c.level,
      name: c.row.name,
      text: describeItem(c, now)
    };
  }).sort(function (a, b) { return a.level - b.level; });

  const msg = composeMessage(items, now);
  const res = await pushServerChan(env, cfg, msg);
  await savePushStatus(env, {
    lastPushAt: now,
    lastPushOk: res.ok,
    lastError: res.ok ? null : res.message,
    lastPushCode: res.code == null ? null : res.code
  });

  for (const c of candidates) {
    if (res.ok) {
      c.row.alerted = c.level;
      c.row.lastError = null;
    } else {
      c.row.lastError = res.message;
    }
    c.row.lastAttemptAt = now;
    await env.STATE.put(c.key, JSON.stringify(c.row));
  }
}
