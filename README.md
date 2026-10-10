# 终末地 · 产线倒计时

> Arknights: Endfield — Production Line Cap Countdown

一个用于《明日方舟：终末地》的产线产物倒计时工具。填写生产速度、消耗速度与当前存量，自动计算产物达到仓库上限的剩余时间；可选接入 **Server酱³**，在即将爆仓/耗尽时推送到手机 App。

**[在线使用 →](https://darkyyx.github.io/endfield-timer/)**

---

## 功能特性

- **双地区上限支持** — 四号谷地 80,000 / 武陵 90,000，自动匹配对应容量
- **实时倒计时** — 根据净生产速度（生产 − 消耗）动态计算封顶剩余时间，每秒刷新
- **净产出可视化** — 当消耗 ≥ 生产时不显示倒计时，改为提示「不封顶」或「产销平衡」
- **手机推送通知**（可选）— 经自建 Cloudflare Worker 调用 Server酱³，页面关着也能收到预警
- **数据持久化** — 所有数据自动保存至浏览器 `localStorage`，关闭页面后重新打开自动恢复
- **终末地视觉风格** — 暗色工业界面、扫描线、网格背景、黄色高亮，还原游戏 UI 氛围
- **零依赖** — 纯 HTML + CSS + JavaScript，无需构建工具，单文件即可部署

---

## 通知部署（可选，约 5 分钟）

通知链路：`电脑端页面 → Cloudflare Worker → Server酱³ → 手机 App`。
页面每 60 秒把一份「时间锚点」推给 Worker；Worker 每 5 分钟独立外推一次存量，跨过阈值就推一条消息。

**为什么需要 Worker**：Server酱 的 SendKey 等同于密码，写进公开仓库的网页源码里会被别人拿走；而且浏览器直接跨域请求 Server酱 接口也会被拦。SendKey 只存在 Cloudflare 那边，网页里永远不出现。

### 第 1 步：准备 Server酱³

1. 在 [Server酱³](https://sc3.ft07.com/) 注册，拿到 **SendKey**（形如 `sctp<UID><随机串>`，例：`sctp24339tauwt87osfuw9nyptebxxxx`）。
2. 在后台**只保留 App 通道**（本项目不推微信）。
3. 顺便看一眼你的**每日推送条数上限**——决定你要不要收紧预警频率。

> **UID 不用手填**：SendKey 里已经包含 UID（上面例子的 UID 就是 `24339`），Worker 会自动解析出来。

### 第 2 步：在 Cloudflare 建 KV 与 Worker

1. Cloudflare Dashboard → **Workers & Pages** → **KV** → 新建一个命名空间（例：`endfield-state`）。
2. → **Workers** → 新建 Worker，把本项目 `worker.js` 的全部内容粘贴进去并部署。
3. 在该 Worker 的 **Settings** 里绑定 KV：
   - **变量名必须是 `STATE`**（代码里按这个名字取），值选刚建的命名空间。
4. 配置变量（Settings → Variables and Secrets）：

   | 名称 | 类型 | 说明 |
   |---|---|---|
   | `SC_SENDKEY` | Secret | Server酱³ 的 SendKey（UID 会自动从里面解析） |
   | `SYNC_TOKEN` | Secret | 自己随便生成一串随机字符串，防止别人往你的 Worker 灌假数据 |
   | `SC_UID` | Secret（**可选**） | 仅当 SendKey 不以 `sctp` 开头时才需要手动指定 |
   | `WARN_SECONDS` | 可选 | 兜底预警窗口秒数，默认 `1800`（30 分钟）。**页面设置面板里的值会覆盖它** |

5. 添加定时触发器（Settings → Triggers → Cron）：**`*/5 * * * *`**（每 5 分钟）。

### 第 3 步：在页面上开启

1. 打开页面，展开底部的「**通知设置 · SERVERCHAN PUSH**」。
2. 填入 **Worker 地址**（形如 `https://xxx.yyy.workers.dev`）与**同步令牌**（即 `SYNC_TOKEN`）。
3. 勾选「开启通知」，点「**发送测试通知**」，确认手机 App 能收到。
4. 顶部 HUD 会出现状态灯：`通知 正常 / 待同步 / 异常`，一眼看出链路是否还活着。

### 通知规则（重要）

- **每级只提醒一次**。一条产线从正常 → 预警 → 爆仓最多收到两条；**爆仓后就闭嘴**，挂着一天也不会重复轰炸。
- 状态**恢复正常**（产线被清空、存量回落）后标记自动复位，下一轮跑到阈值时**会重新**提醒。
- 阈值：剩余时间 ≤ 设置面板里的「预警提前量」（默认 30 分钟）时提醒一次，真正爆仓/耗尽时再提醒一次。
- **产销平衡（生产 = 消耗）不提醒**；刚添加、还没填数据的空行也不提醒。
- 多条产线在同一轮跨阈值时**合并成一条消息**，省推送条数也少打扰。
- 想重新接收已经提醒过的产线：点面板里的「**重置已提醒标记**」。
- 只走 App 通道：代码固定不传 `channel`，走 Server酱 默认通道。

### 自检与排错

- `GET https://<你的 Worker>/test` — 触发一条测试推送，返回接口原始结果与所用地址模板。
- `GET https://<你的 Worker>/state` — 查看 Worker 掌握的行、等级与已提醒水位（需带 `X-Sync-Token` 头）。
- `POST https://<你的 Worker>/reset-alerts` — 清空全部「已提醒」标记。
- 页面状态灯显示**推送异常**时，消息区会显示 Server酱 返回的原始错误（如 Key 失效、额度用尽）。
- 常见提示对照：
  - `未配置 SC_SENDKEY` — 变量没配，或配完没重新 Deploy。
  - `无法从 SendKey 解析 UID` — SendKey 不是 `sctp` 开头的格式，额外配一个 `SC_UID` 即可。
  - `未绑定 KV 命名空间 STATE` — KV 绑定的变量名写错了，必须一字不差是 `STATE`。
- **测试通知能收到、但从不自动预警** → 多半是 Cron Trigger 没加。

### 本地跑 Worker 自测

```bash
node worker.test.mjs
```

覆盖等级判定、一次性去抖（含「爆仓后挂 6 小时不重推」）、聚合消息、推送失败重试、SendKey 解析 UID、`/sync` 鉴权与缺行清理等 87 项断言，不需要任何依赖。

---

## 物品配置

图标放在 `items/` 目录，文件名与物品名一致（`.png`）。新增物品只需编辑 `items.js` 里的数组：

```js
window.ITEMS_CONFIG = ['源矿', '赤铜块', /* ... */];
```

页面刷新后下拉框自动同步；没有对应图标的物品会显示占位斜线。
