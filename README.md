# opencode2dsh Railway Server

一个**零依赖**的 OpenAI 兼容网关，把 OpenCode Zen 的免费通道暴露为标准
`/v1/*` 端点，可部署到 [Railway](https://railway.app)，供 OpenWebUI、Cherry
Studio 或任何支持 `base_url + API key` 的客户端调用。

> **需要一个上游凭证：`ZEN_ACCESS_TOKEN`（OpenCode 账号的 OAuth token，`st_…`，
> 约 30 天过期）。** 匿名通道（`Bearer public`）自 2026-10-14 起对免费模型
> 全部 `403 FreeTierError`，`oc_sk_…` Zen API key 调免费模型回 403（只可用于
> 付费模型）。`API_KEY` 只是**调用方**访问本服务用的密钥，和 OpenCode 账号
> 无关。取 token：`node ../../scripts/get-zen-token.mjs`（仓库根 `docs/`
> 有完整运维手册 `zen-free-lane-ops.md`）。

服务端直接复用插件里已实测验证的适配层源码（`packages/plugin/src/adapter/`）：

| 复用模块（`adapter/`，源码拷自 `packages/plugin/src/adapter/`） | 作用 |
| --- | --- |
| `catalog.ts` | 三级回退模型目录：Zen 实时列表 ∩ models.dev 免费判定，静态清单兜底 |
| `ids.ts` | 按对话派生稳定 session id + OpenCode CLI 同款伪装头（7 个关联头） |
| `messages.ts` | free-lane 形状门禁：注入 `bash`/`read` stub 工具、强制 `stream: true` |
| `routing.ts` | 识别仅支持 Responses 协议的 `muse-spark-*` 模型 |

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 目录状态（无需鉴权，Railway 健康检查用） |
| GET | `/v1/models` | OpenAI 模型列表（**列全部免费模型**，含 `muse-spark-*`；每行带 `"api": "chat"\|"responses"`；`?include_responses=true` 仍接受但已是空参数） |
| GET | `/v1/models/{id}` | 单个模型（响应含 `api` 字段，responses-only 模型也可查到） |
| POST | `/v1/chat/completions` | 流式透传 / 非流式聚合（含工具调用、reasoning）；`muse-spark-*` 在此**自动桥接**到 Responses 协议 |
| POST | `/v1/responses` | Responses API 直通（原生 Responses 客户端可用） |

除 `/health` 外都需要 `Authorization: Bearer <API_KEY>`。

> **`muse-spark-*` 现在默认列出且可直接使用**：这两个模型只支持 Responses
> 协议，原本列进 chat 列表会让 OpenWebUI 这类只会 chat 的客户端「选中即失败」
> （插件实测记录：opencode #44659/#44847、DSH #3957），所以过去只能靠
> `?include_responses=true` 发现。现在网关在 `/v1/chat/completions` 上为它们做了
> **协议桥接**（请求 chat→Responses，响应 Responses→chat，流式增量逐个转换），
> 因此默认列出也不会坏。它们以前在你本地不可见还有第二层原因：受限国家请求它们
> 会拿到 `403 RegionError`；服务搬到美国后该限制消失。

## 门禁现状（2026-10-15 实测，二分验证）

免费模型请求必须同时满足以下全部，缺一即 `403 FreeTierError`（`RegionError`
除外——那是门禁已过、出口国家被限，反而证明指纹正确）：

1. `Authorization: Bearer st_…`（`ZEN_ACCESS_TOKEN`）；
2. `User-Agent: opencode/latest/<semver>/cli`（当前 `2.0.29`，`ZEN_CLIENT_VERSION` 可覆盖）；
3. `x-opencode-session` 与 `x-opencode-session-id` 同值（`ses_` + 9位hex + `ffe` + 14位base62），另带 `x-session-affinity` / `X-Session-Id`；
4. `x-opencode-project: global`（`prj_*` 会 403）；
5. **不发** `x-opencode-request`（网关自有 tracing 头，出现即 403）；
6. body 带官方原版 `read` + `shell` 工具声明（逐字一致，见 `adapter/messages.ts`
   `GATE_TOOL_BODIES`），`tool_choice: auto`，`stream: true`。

## 本地补丁（2026-10-13 起，必须保留）

本目录从插件源码拷来的 `adapter/` 与 `server.ts` 各带一处**本地修正**。上游免费
通道的门禁在 2026-10 收紧过，**未打补丁时每个请求都会 403 `FreeTierError`**
（与账号、余额、免费额度无关）。升级/重装插件后重新拷贝 `adapter/` 时务必带上。

### 1. `adapter/ids.ts` — session id 尾部必须是 `ffe`

上游要求 `x-opencode-session` 形如 `ses_<9位hex>ffe<14位base62>`
（正则 `^ses_[0-9a-f]{9}ffe[0-9A-Za-z]{14}$`）。原实现按 `sha256(会话种子)`
直接取 12 位随机 hex，尾部恰为 `ffe` 的概率只有 1/4096：

```diff
- const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
+ const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{9}ffe[0-9A-Za-z]{14}$/
...
- const timePart = sum.subarray(0, 6).toString('hex')            // 12 位随机 hex
+ const timePart = sum.subarray(0, 5).toString('hex').slice(0, 9) + 'ffe'
```

要点：**形状校验，不校验真实会话**——前 9 位随机也放行，只有尾 12 位必须含
`ffe`（`fff` 同样放行，`ffe` 是官方客户端实际在用的值）。其余三条门禁
（`User-Agent` 为 OpenCode 客户端风格、body `stream:true`、`tools` 里同时有
`read` 与 `bash`/`shell`）本服务原本就已满足（见 `ids.ts` 伪装头与
`messages.ts` 的 `ensureFreeLaneShape`）。

### 2. `server.ts` — 复用连接看门狗不再误杀

原 `POOLED_HEADER_TIMEOUT_MS` 默认 `2500`，而上游发响应头实测要 **2.6–9.7s**，
于是"池里复用的连接"几乎每次都被判成半开失效；重试又落在另一个池连接上，再次
超时 → 直接 **502** `stale pooled socket (no response headers)`。改动：

- 默认放宽到 `10000`（真死连接由 OS 的 ~6s RST 兜底，看门狗退为后备）；
- 重试**强制走一条全新连接**（`keepAlive:false` 的 `freshAgent`），新连接不受该
  看门狗约束，因此最多损失一次等待，不会再 502。

实测（本机匿名模式，连续 6 次流式 + 3 次非流式）：修复前流式必现 502，修复后
**9/9 全部 200**，`/health` 的 `upstreamAuth` 为 `anonymous`。

### 3. `server.ts` — `muse-spark-*` 的 chat ↔ Responses 桥接

上游对 `muse-spark-*` 的 chat 接口回裸 500（这两个模型只会说 Responses 协议），
原实现因此把它们从 `/v1/models` 默认列表剔除，并在 chat 接口上**硬拒**
（400 `only speaks the Responses API`）。现在改为**透明桥接**：列表默认全列，
客户端选中即可用。

- `chatRequestToResponsesBody`：`messages` → `input`（system/developer 合成
  `instructions`；assistant 的 `tool_calls` → `function_call`；`role: "tool"` →
  `function_call_output`），嵌套的 chat 工具 schema 拍平为 Responses 的扁平格式，
  `max_tokens` → `max_output_tokens`，`reasoning_effort` → `reasoning.effort`；
- `responsesEventToChatChunks`：Responses 流事件 → chat chunk
  （`response.output_text.delta` → `delta.content`；`response.reasoning_*_text.delta`
  → `reasoning_content`/`reasoning`；`function_call_arguments.delta` → `tool_calls`
  增量；`response.completed` → 带 `finish_reason` 与 usage 的收尾块 + `data: [DONE]`）；
- 未知事件类型一律忽略；若上游始终不发增量事件，则在 `completed` 时用聚合结果兜底
  补一次全文，保证客户端一定拿得到答案；
- 转换后的 body 仍要过 `ensureResponsesFreeLaneShape`，所以 `ffe`、伪装头、
  `stream:true`、`bash`+`read` 四条门禁照旧由既有逻辑保证，桥接不碰门禁。

本机验证（`st_…` 通道）：`/v1/models` → 上游 44 个模型中 9–10 个免费；
在 chat 接口请求 `mimo-v2.6-flash-free`（`stream:false` 与流式）均 200。
转换逻辑另有 33 条离线单测
（请求翻译、流式增量、工具调用、无增量兜底、错误映射、非流式聚合）全绿。

### 4. `adapter/ids.ts` + `server.ts` — 2026-10-15：请求头指纹对齐官方客户端

对照官方客户端源码（`opencode` v2.0.29 `model-request.ts`）+ 在线二分：
`x-opencode-request` 一出现即 403（同请求去头即 200），`x-opencode-project`
发字面 `global`（官方非 git 目录行为；`prj_*` 403），多余的 `x-session-id`
去掉，UA 跟进 `2.0.29`。`RequestIDs.request` 保留只做本地日志，不再上送。

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `API_KEY` | **是** | 启动时随机生成 | 调用方使用的密钥；不设的话每次重启都会换 |
| `PORT` | Railway 自动注入 | `8080` | 监听端口 |
| `FIRST_EVENT_MS` | 否 | `30000` | 流式首事件看门狗（毫秒） |
| `BODY_IDLE_MS` | 否 | `120000` | 流式中途静默看门狗（毫秒） |
| `MAX_BODY_BYTES` | 否 | `10485760` | 请求体上限（超限回 413，连接随后关闭） |
| `CACHE_PATH` | 否 | `~/.opencode2dsh/…` | models.dev 元数据缓存位置 |
| `EARLY_SSE_HEADERS` | 否 | `false` | `true`：流式请求在**上游响应前**就回 200 + SSE 头（首字节 ~3ms）。代价是上游 401/429/403 只能以流内 `data:{"error":…}` 事件返回，不再是真实 HTTP 状态码。仅当客户端/代理会因等待响应头超时时才开 |
| `REASONING_DUAL_WRITE` | 否 | `true` | 流式 delta 中 `reasoning` 与 `reasoning_content` 互相补写，兼容只认其中一种字段名的客户端 |
| `STATUS_PATH` | 否 | `~/.opencode2dsh/railway-server.status.json` | 健康快照落盘位置（写入失败不影响服务） |
| `STATUS_WRITE_INTERVAL_MS` | 否 | `60000` | 请求触发的快照最小写入间隔（目录刷新与停机时强制写） |
| `SHUTDOWN_DRAIN_MS` | 否 | `5000` | SIGTERM 后给在途流的排空时间，超时才切断连接 |
| `POOL_WARM_INTERVAL_MS` | 否 | `20000` | 上游连接池保活心跳间隔（见下）。小于对端空闲回收时间，避免空闲后复用「半死」连接 |
| `POOLED_HEADER_TIMEOUT_MS` | 否 | `10000` | **复用连接看门狗**：仅针对从池里复用的 keep-alive 连接，若该窗口内没收到上游响应头就判为半开失效，换新连接重试一次（新连接不受此限，它本来就要付 DNS+TCP+TLS）。原默认 `2500` 低于上游实际响应头耗时（实测 2.6–9.7s），会误杀正常连接并 502，故放宽——真死连接由 OS 的 ~6s RST 兜底 |
| `DNS_TTL_MS` | 否 | `60000` | 上游 DNS 结果缓存时长；解析失败时回退到过期缓存 |
| `UPSTREAM_PROXY` | 否 | — | **出口代理**：上游流量（`opencode.ai` + `models.dev`）改由该代理出去，见下节。支持 `http://`、`https://`、`socks5://`（`socks5h://`、`socks://` 等价，域名一律交给代理解析）。也认标准变量 `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`，优先级：`UPSTREAM_PROXY` > `HTTPS_PROXY` > `ALL_PROXY` > `HTTP_PROXY`；不设则直连（与旧行为一致） |
| `NO_PROXY` | 否 | — | 逗号分隔的直连名单（按目标主机逐个判断）：`models.dev` 让元数据走直连、`*` 表示全部直连。支持 `.example.com`（含子域）与 `host:port`（限定端口） |
| `PROXY_CONNECT_TIMEOUT_MS` | 否 | `20000` | 建隧道总预算：连代理 + CONNECT/SOCKS5 握手 + 隧道内 TLS 握手。超时按普通上游错误处理（502，可被 key 池/重试逻辑看见） |
| `PROXY_POOL` | 否 | — | `auto`（或 `1`/`on`/`true`）：**免费代理自动池**——自动抓取公开代理列表、逐个用真实免费模型请求探活、坏出口自动轮换，见「免费代理自动池」节。开启后 `UPSTREAM_PROXY` 被忽略 |
| `PROXY_POOL_TARGET` | 否 | `5` | 池里保持的「已验证可用出口」数量；低于该值会自动重新扫描 |
| `PROXY_POOL_ATTEMPTS` | 否 | `3` | 单次客户端请求最多尝试几个不同出口（429/403 判定为出口问题即换下一个） |
| `PROXY_POOL_MAX_PROBE` | 否 | `120` | 单轮扫描最多探活多少个候选（含 TCP 预筛后的实际探测数） |
| `PROXY_POOL_REFRESH_MS` | 否 | `600000` | 池满时的后台重扫间隔；池空时每 60s 重试，未满时最多 3 分钟一次 |
| `PROXY_POOL_SEED` | 否 | — | 逗号分隔的预置出口（如 `socks5://1.2.3.4:1080,http://5.6.7.8:3128`），启动时最先验证，避免冷启动等待 |
| `PROXY_POOL_SOURCES` | 否 | 内置 15 个公开列表 | 逗号分隔的自定义列表 URL；含 `socks` 的按 socks5 解析，含 `json`/`geonode` 的按 JSON 解析 |
| `PROXY_POOL_PROBE_MODEL` | 否 | `mimo-v2.6-flash-free` | 探活用的免费模型 id（探针用 `Bearer public`，不消耗你的 key） |
| `PROXY_POOL_CONCURRENCY` | 否 | `16` | 探活并发数 |
| `PROXY_POOL_PROBE_TIMEOUT_MS` | 否 | `15000` | 单个候选探活超时（超时即判死） |
| `PROXY_POOL_COOLING_MS` | 否 | `120000` | 出口撞 429（额度用尽）后的冷却时长，冷却结束会重新探活 |
| `ZEN_ACCESS_TOKEN` | **是（免费模型）** | — | **上游凭证**：OpenCode 账号 OAuth token（`st_…`，约 30 天过期）。免费模型只认它。取法见仓库根 `docs/zen-free-lane-ops.md` 第 3 节。key 不写日志、不被任何接口回显（`/health` 只报 `st_***` 掩码） |
| `ZEN_SESSION_TOKEN` | 否 | — | `ZEN_ACCESS_TOKEN` 的别名 |
| `ZEN_CLIENT_VERSION` | 否 | `2.0.29` | 伪装 UA 里的官方客户端版本号，跟随 OpenCode 发版改即可 |
| `ZEN_API_KEY` | 否（只用于付费模型） | —（空） | Zen API key（`oc_sk_…`）：调免费模型回 403，只可用于付费模型 |
| `ZEN_API_KEYS` | 否 | — | **key 池**：逗号 / 分号 / 空白分隔多个 key（与 `ZEN_API_KEY` 同时设置会合并）。多于 1 个即启用池化行为，见下节 |
| `KEY_COOLDOWN_MS` | 否 | `60000` | key 撞 429/401 后的冷却基准时长；按连续失败次数指数递增（60s→120s→240s…），上限 10 分钟 |
| `KEY_POOL_ANONYMOUS` | 否 | 无 `st_…` 时 `true`，有则 `false` | 所有凭证都在冷却时，是否回退到匿名通道。匿名对免费模型已全 403，配了 `st_…` 时默认关闭，避免把真实错误换成误导性错误 |
| `KEY_POOL_FAILOVER` | 否 | `true` | 某个 key 回 429/401 时，是否在**同一次请求内**改用下一个就绪 key 重试一次（仅池模式生效；匿名单通道的 429 依旧原样透传） |

## 上游凭证与 key 池（`ZEN_ACCESS_TOKEN` / `ZEN_API_KEY(S)`）

免费模型只认 `ZEN_ACCESS_TOKEN`（`st_…`）。`oc_sk_…` 只用于付费模型；
匿名（什么都不填）对免费模型全 403，`/health` 会明确提示。其余行为完全一致
（伪装头、free-lane 形状门禁、目录过滤都保留）：

| | 只配 `ZEN_ACCESS_TOKEN`（正常形态） | 追加 `oc_sk_…`（仅付费模型） | 配置 ≥2 个凭证（池） |
| --- | --- | --- | --- |
| 凭证 | `Authorization: Bearer st_…` | 免费模型仍走 `st_…`；付费模型可用 key | 每次请求按粘滞规则取一个凭证 |
| base URL | `https://opencode.ai/zen/v1` | 同一个 | 同一个 |
| 暴露的模型 | 9–10 个 `*-free`（目录仍只放行免费模型；要放开付费模型需要再加开关） | 同左 | 同左 |
| 配额来源 | `st_…` 背后账号的免费额度（约 30 天轮换 token，见运维手册第 6 节） | 你 Zen 账户的付费限额 | 各凭证的限额相加 |
| 启动日志 | `upstream auth: zen-session (1 credential: st_***)` | `upstream auth: zen-key …` + 免费模型需 `st_…` 的提示行 | `upstream auth: zen-key-pool (N …)` + 池参数行 |
| `/health` | `"upstreamAuth": "zen-session"` | `"upstreamAuth": "zen-key"` | `"upstreamAuth": "zen-key-pool"` + `pool` 块 |

### key 池怎么工作

```sh
railway variables set ZEN_API_KEYS="key1,key2,key3,key4"
```

| 机制 | 行为 |
| --- | --- |
| **会话粘滞** | `sha256(会话种子)` 选首选 key，冷却中则顺延到下一个就绪 key。同一对话全程固定一把 key（上游 prompt 缓存亲和稳定），只有首选 key 进冷却才漂移 |
| **冷却熔断** | key 回 **429**（读 `retry-after`）或 **401** → 冷却 60s 起、指数递增到 10 分钟上限。403（free-tier 门禁）与 5xx（上游容量）**不算** key 的错，不冷却，避免白白缩小池子 |
| **请求内故障转移** | 池模式下 429/401 会立刻在**同一次请求**里改用下一个就绪 key 重试一次，客户端只看到 200（实测：混入 1 个坏 key，11/11 请求全部 200，坏 key 三次 401 后被指数冷却到 4 分钟） |
| **匿名兜底** | 所有凭证都在冷却 → 回退 `Bearer public`（仅 `KEY_POOL_ANONYMOUS=true` 时；匿名对免费模型已 403，一般保持默认关闭） |
| **模型列表身份** | 每次刷新都取「匿名公开列表 ∪ 一个就绪 key 的账户列表」再过滤出免费模型。单用 key 会漏掉 `nemotron-3-ultra-free`（实测 key 能调通它），单用匿名则列表里可能混入上游已无路由的条目 |
| **可观测** | `/health` 与 `STATUS_PATH` 快照里的 `pool` 块：每把 key 的掩码指纹、`ready`、`cooldownSeconds`、`used`、`rejected`、`lastStatus` |

```jsonc
// GET /health（池模式节选）
"upstreamAuth": "zen-key-pool",
"pool": {
  "size": 5, "ready": 4, "cooldown": 1,
  "cooldownMs": 60000, "failover": true, "anonymousFallback": true,
  "keys": [
    { "fingerprint": "oc_sk_c39adb58b3...Bztt", "ready": true,  "cooldownSeconds": 0,   "used": 2, "rejected": 0, "lastStatus": 200 },
    { "fingerprint": "zk-bogus-key-for...ting", "ready": false, "cooldownSeconds": 202, "used": 4, "rejected": 3, "lastStatus": 401 }
  ]
}
```

**掩码规则**：`fingerprint` = key 前 16 字符 + `...` + 后 4 字符（不含密钥主体），
日志、`/health`、状态文件里出现的**永远只有掩码形式**。

拿到付费 key（仅付费模型用）：登录 [opencode.ai/zen](https://opencode.ai/zen) → 绑卡充值（最低 $20，另有 4.4%+$0.30 卡费）→ 复制 API key。

```sh
railway variables set ZEN_API_KEY=<你的Zen key>    # 单 key（付费模型）
railway variables set ZEN_API_KEYS=<key1>,<key2>   # 池（付费模型）
# 清除：railway variables unset ZEN_API_KEY
```

**两点提醒**

1. **`-free` 模型只认 `st_…`**：`oc_sk_…` 调免费模型回 403 `Workspace access denied`；
   社区另报告过"有余额仍撞 `FreeUsageLimitError`"
   （[anomalyco/opencode#33318](https://github.com/anomalyco/opencode/issues/33318)）。
   上游返回 401/429 时，错误文案里会明确标注是凭证被拒还是通道限流，便于判断。
2. **key 只放 Railway 的 Variables**，不要提交进仓库；下游客户端用的仍是自己的
   `API_KEY`，两者互不相干。上游 key 不会出现在日志、`/health` 或任何响应里。

## 出口代理（`UPSTREAM_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`）

### 为什么需要它

免费模型的门禁按**请求方 IP** 判定。共享云出口（Render / Railway / AWS / GCP…）属于
数据中心段，在门禁眼里等同 VPN/代理，于是即便凭证完全正确也会被整段拒绝：

```
HTTP 403 FreeTierError: OpenCode's free models aren't available from your current
network because we've detected abusive traffic from this IP address. ...
If you're on a VPN or proxy, turn it off and try again.
```

换 key 无用（所有 key 都从同一个 IP 出去，且 403 不冷却 key）。唯一的解法是把上游流量
改从**干净出口**发出——就是本节的开关。网关其余部分不做任何改变（伪装头、形状门禁、
连接池、看门狗、key 池全部保留）。

> 注意：门禁拒绝的是**免费模型推理**。同一个被拒 IP 上 `GET /v1/models` 依旧 200，
> 所以「目录正常、聊天全 403」这个组合恰恰就是出口被判滥用的特征。

### 用法

```sh
# http CONNECT 代理（明文）
railway variables set UPSTREAM_PROXY=http://1.2.3.4:3128
# 需要认证：把 user:pass 写进 URL（日志里只会出现 user:***）
railway variables set UPSTREAM_PROXY=http://user:pass@1.2.3.4:3128
# 本地 Clash/v2ray 常见形态（域名交给代理解析，即 socks5h 语义）
railway variables set UPSTREAM_PROXY=socks5://user:pass@1.2.3.4:1080
# 只让 Zen 走代理、models.dev 直连
railway variables set NO_PROXY=models.dev
```

| 项 | 说明 |
| --- | --- |
| 支持的协议 | `http://`（CONNECT）、`https://`（先 TLS 连代理再 CONNECT）、`socks5://`；`socks5h://`、`socks://` 与 `socks5://` 等价 |
| 省略端口时 | `http` → 8080、`https` → 443、`socks5` → 1080 |
| 变量优先级 | `UPSTREAM_PROXY` > `HTTPS_PROXY` > `ALL_PROXY` > `HTTP_PROXY`（两种大小写拼写都认；`UPSTREAM_PROXY` 的存在是为了不误继承其他程序的全局代理变量） |
| 走代理的流量 | 聊天/Responses 上游请求、连接池保活心跳、Zen `/v1/models`、models.dev 元数据（被 `NO_PROXY` 命中则直连） |
| `NO_PROXY` | 逗号/空白分隔，支持 `host`、`.domain`（含子域）、`host:port`（限定端口）、`*`（全部直连） |
| **不做的事** | **不会**在代理失败时静默回退直连——直连正是被门禁拒绝的那条路。失败按普通上游错误暴露（客户端 502），并打日志 `[proxy] tunnel to opencode.ai:443 failed …`（首次 + 每 50 次一条，避免刷屏） |

### 怎么确认生效

1. 启动日志会写出实际路由：

   ```
   [proxy] upstream egress: socks5://1.2.3.4:1080 via UPSTREAM_PROXY
   ```

   若被 `NO_PROXY` 挡掉会是警告行；若 URL 写错，会打印原因并继续直连（服务不崩）。

2. `GET /health` 的 `egress` 块（公网可见，**故意不含代理地址**，避免泄出口）：

   ```jsonc
   "egress": {
     "proxy": { "protocol": "socks5", "authenticated": true, "source": "UPSTREAM_PROXY", "appliesToUpstream": true },
     "tunnels": { "ok": 3, "failed": 0 }
   },
   ```

3. 发一次聊天再看 `upstream.status`：`403` = 出口仍被判滥用（换出口）；`200` = 代理生效。
   `STATUS_PATH` 落盘的快照里有完整代理地址（仅落盘，不回显公网）。

### 实现与代价

- 隧道建在 `https.Agent.createConnection` 内部，因此连接池、`maxSockets`、
  「复用连接看门狗」（按 `req.reusedSocket` 判定，隧道连接握手在交回前已完成）、
  DNS 缓存（改为解析代理域名）全部照旧；一条池化连接 = 一次 CONNECT，之后的请求复用同一条隧道。
- 隧道内的 TLS 由网关自己完成（SNI = 目标主机，ALPN 固定 `http/1.1`），所以代理模式下
  新建连接不复用 TLS session（池化复用不受影响，代价可忽略）。
- 零依赖：CONNECT 与 SOCKS5（RFC 1928 + RFC 1929 认证）都在 `proxy.ts` 里手写，
  Node ≥ 22.18 均可跑，不依赖 Node 24 的 `NODE_USE_ENV_PROXY`。
- 代理是新的单点：它挂了上游就全挂。生产建议用固定 IP 的小 VPS / 住宅出口；
  若多个部署共用同一个出口 IP，仍可能被一起判滥用。
- 代理密码与上游 key 一样只存在于内存和掩码日志里（`socks5://user:***@host:1080`）。

## 免费代理自动池（`PROXY_POOL=auto`）

固定 `UPSTREAM_PROXY` 的弱点是**单点**：一个免费出口几小时内就死，或者被门禁标记 /
额度耗尽，网关随即整体 403/429。开了自动池之后，这个出口不再需要人管：

```sh
railway variables set PROXY_POOL=auto
# 可选：先把已知能用的出口喂进去，冷启动立即有货
railway variables set PROXY_POOL_SEED="socks5://1.2.3.4:1083,http://5.6.7.8:8080"
```

| 环节 | 行为 |
| --- | --- |
| **抓列表** | 每次需要补货时并行抓取内置的 15 个公开源（GitHub 原始列表、proxyscrape、geonode…），解析 `ip:port` / `scheme://user:pass@host:port`，去重后 TCP 快速预筛（1.5s 超时） |
| **探活** | 对存活候选逐个发**真实的免费模型请求**：伪装头 + free-lane 形状 + `Bearer public`（不耗你的 key）。判据只有一条：**上游 200** |
| **判定** | `200` → `clean`（带延迟排序）；`429` → `cooling`（出口额度用尽，冷却 2 分钟后重试）；`403 abusive traffic` → `dead`（IP 被门禁拉黑）；隧道失败/超时 → `dead` |
| **选路** | 客户端流量固定走当前 `clean` 出口（保持连接池预热和该出口的额度节奏），一旦真实流量报 429 / abusive 403 就当场退役并换下一个 spare |
| **请求内轮换** | 一次客户端请求最多试 `PROXY_POOL_ATTEMPTS` 个出口：出口死了/被拉黑/额度用尽 → 立刻换下一个重试，客户端仍可能看到 200 |
| **补货** | 出口退役导致库存不足时立即在后台重扫（与进行中的扫描共享同一轮，不重复探测）；池空时 60s 一轮、未满时最多 3 分钟一轮、满员时 10 分钟一轮 |
| **硬约束** | 和固定代理一样**绝不静默回退直连**：池里一个可用出口都没有时请求回 `503 + Retry-After: 15`（而不是把直连的 403 当上游错误报出去）。连接池、看门狗、key 池、`NO_PROXY` 全部照旧 |

**怎么看状态**：启动后日志会出现

```
[proxy-pool] auto egress: scanning 15 public list(s) for clean exits (target=5, refresh=600s, attempts/request=3, probe=mimo-v2.6-flash-free)
[proxy-pool] clean exit: socks5://45.138.157.212:1080 (5652ms)
[proxy-pool] refresh in 41253ms: clean=2 cooling=1 dead=72 pending=0 tracked=75 probes=80 sources=13/15
[proxy-pool] retired socks5://45.138.157.212:1080: exit IP flagged by the abuse gate (403)
```

`GET /health` 的 `egress` 块变成 `mode: "pool"`（依旧**不含**出口地址）：

```jsonc
"egress": {
  "mode": "pool",
  "pool": { "mode": "pool", "targetSize": 5, "clean": 2, "cooling": 1, "dead": 72, "pending": 0,
             "tracked": 75, "probesLastRefresh": 80, "refreshSecondsAgo": 12, "refreshMs": 600000,
             "sources": 15, "lastError": "" },
  "tunnels": { "ok": 3, "failed": 0 }
}
```

完整出口地址只出现在 `STATUS_PATH` 落盘快照里（`pool.current`），公网接口永不回显。

**忠实提醒**：免费公开代理是**共享、易死**的资源——一次实测扫描 520 个候选里最终稳定能用的
只有 1–2 个，而且可能几十秒内就死。自动池把它变成了「不需要你动手」而不是「变得可靠」：
日常请求偶尔会撞上 503（重试即恢复），极端时（公开列表集体失效）需要看日志或重新播种。
要稳定，还是那两条路：向代理商家要**住宅/独享 IP**（先测再买），或者一台干净的小 VPS。

## 部署到 Railway

本目录是**自包含**的：`adapter/` 已拷入插件源码，`railway.json` + `Dockerfile`
都在本目录内。只需把 `railway-server/` 这一个文件夹作为仓库根上传。

方式 A —— GitHub 仓库（推荐）：

1. 新建一个 GitHub 仓库，把**本文件夹的全部内容**（8 项：`Dockerfile`、
   `railway.json`、`package.json`、`server.ts`、`proxy.ts`、`proxy-pool.ts`、`README.md`、`adapter/`）
   放进去（`test/` 可选，只用于本机自测）。
2. Railway → **New Project → Deploy from GitHub repo**，选择该仓库。
   本目录的 `railway.json` 会自动选用 `Dockerfile` 构建。
3. **Settings → Variables** 添加 `API_KEY`（自生成一个强随机串）和
   `ZEN_ACCESS_TOKEN`（`st_…`，必填，见上）。**不要再指望匿名通道**——留空
   `ZEN_ACCESS_TOKEN` 就是全 403（本次改动的目标形态是 `st_…` 通道）。
4. **Settings → Networking → Generate Domain** 生成公网域名。
5. 部署完成后访问 `https://<你的域名>/health` 验证：`upstreamAuth` 应为
   `zen-session`（不是 `anonymous`），`catalog.exposed` 约 10。

方式 B —— Railway CLI（在**本目录内**执行）：

```sh
railway login
railway init      # 在 railway-server/ 目录内初始化
railway up        # railway.json 已配好 Dockerfile
railway variables set API_KEY=<你的强随机密钥>
railway domain    # 生成公网域名
```

匿名免费模式已于 2026-10-14 关闭（`Bearer public` 全 403），以下保留仅作配额说明。
如需用自己 Zen 账户的**付费**配额：

```sh
railway variables set ZEN_API_KEYS=<key1>,<key2>   # 池（付费 key）
```

### 本机测试

```sh
PORT=18080 API_KEY=test-key ZEN_ACCESS_TOKEN=<st_…> node server.ts
curl http://127.0.0.1:18080/health          # 期望 "upstreamAuth":"zen-session"
curl -H "Authorization: Bearer test-key" http://127.0.0.1:18080/v1/models
curl -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:18080/v1/chat/completions   # 期望 200 chat.completion
```

`/health` 里 `upstreamAuth` 应为 `zen-session`；若是 `anonymous` 说明
`ZEN_ACCESS_TOKEN` 没读到。Windows PowerShell 下要先清掉进程环境里的干扰变量：
`Get-ChildItem env: | Where-Object { $_.Name -like 'ZEN*' } | ForEach-Object { Remove-Item "env:$($_.Name)" }`。

要求 Node ≥ 22.18（原生运行 TypeScript，无需 `npm install`）。

**代理与隧道自测**（`test/proxy.test.mjs`、`test/proxy-pool.test.mjs`，零依赖、默认离线）：

```sh
npm test                                             # 全套离线用例（proxy.test.mjs + proxy-pool.test.mjs）
npm test -- --test-name-pattern=tunnel               # 只跑隧道相关用例
$env:SMOKE_LIVE='1'; node --test test/proxy.test.mjs # PowerShell：追加真网关端到端（需外网）
SMOKE_LIVE=1 node --test test/proxy.test.mjs         # bash
```

离线用例自带一个假 CONNECT 代理、一个假 SOCKS5 代理（含 user/pass 认证）和一个
自签证书的本地 HTTPS 源站，覆盖：握手、认证、拒绝码、连接池复用（两次请求一次
CONNECT）、`NO_PROXY` 分流、协议解析与掩码。端到端用例会用 `UPSTREAM_PROXY`
指向本地假代理启动真网关，并断言上游 CONNECT 确实经过隧道。
`test/proxy-pool.test.mjs` 把自动代理池完整跑一遍（列表解析、探活判定、轮换、
冷却重试、补货策略），探针与 TCP 预筛都是注入的假实现——不发一个真实请求。

## 客户端配置（以 OpenWebUI 为例）

1. OpenWebUI → **Admin Panel → Settings → Connections → OpenAI API**：
   - URL：`https://<你的域名>/v1`
   - Key：你在 Railway 设置的 `API_KEY`
2. 保存后模型列表会自动从 `/v1/models` 同步，选择任意 `*-free` 模型即可。

## 稳定性与延迟特性

网关的目标是把**能由网关消除的延迟全部消除**，把上游的抖动如实透传。

**延迟**

- **连接池保活心跳**：每 20s（`POOL_WARM_INTERVAL_MS`）复用池内 TLS 连接发一次 `GET /v1/models`。
  上游边缘会回收空闲连接，没有心跳时"隔一会再发的第一条消息"要重付
  DNS+TCP+TLS（实测 0.4–1.8s）；现在空闲后的首请求与后续请求一样，只等
  上游排队。
- **实测（本机直连）**：`tls=0ms`（连接复用 + 启动预热）、`ttfb≈0ms`
  （上游先回 `: keep-alive` 注释），网关自身端到端 <50ms。每条请求日志
  `[upstream] connect=… (tls=… waitHeaders=…)` 可核对，`waitHeaders`
  就是上游排队时间，网关无法优化。
- **DNS 结果缓存 60s**：socket 轮换时省一次解析；解析失败回退到过期缓存
  （VPN/DNS 抖动时尤其有用）。
- **上游并发 64 路**（`maxSockets=64`），不再出现第 17 个请求排队；
  两端 socket 均关闭 Nagle。
- **非流式请求自动注入 `stream_options.include_usage`**，`usage` 因此
  永远是真实值；上游若不认该字段，会自动去掉后重试一次。

**稳定性**

- **进程不会因客户端消失而崩溃**：`req`/`res` 的 `error` 事件、
  `uncaughtException`、`unhandledRejection` 全部有兜底——此前一个中途断开
  的客户端就足以让进程退出，在 Railway 上表现为"莫名重启"。
- **流式转发尊重背压**：客户端读得慢时按 `drain` 等待（上限一个
  `BODY_IDLE_MS`），不再无限缓冲；客户端断开立即中止上游请求，不浪费配额。
- **错误语义与官方对齐**：请求体超限回 413（而不是裸 TCP RST）；目录
  ready 时请求未列出的模型回 404 `model_not_found`（而不是转发后拿到上游
  的 `401 AuthError "Missing API key."`）；上游 429 的 `retry-after`、
  `x-request-id`、`x-ratelimit-*` 原样透传。
- **可观测**：`/health` 返回 `inflight`、`requests`、最近一次上游
  `connectMs` / `ttfbMs` / `error` 与目录 `lastError`；按节流写
  `STATUS_PATH` 快照（目录每次刷新、停机时强制写）。
- **优雅停机**：SIGTERM 先停收新连接、关掉空闲 keep-alive，给在途流
  `SHUTDOWN_DRAIN_MS` 排空，超时才切断。
- **key 池容错**（配 `ZEN_API_KEYS` 时）：会话粘滞、429/401 指数冷却、
  请求内故障转移、全池冷却回退匿名通道。实测混入 1 把坏 key 跑 11 个请求
  仍 **11/11 全 200**，坏 key 的 401 被三次熔断后冷却到 4 分钟。

## 已知限制（上游决定，非本服务缺陷）

- **模型只有不到十个是正常现象**：Zen 实时列表有 40+ 个模型，付费模型与
  已弃用项被目录滤掉，真正能免费用的约 9–10 个（2026-10-15 实测）。
  名单完全由运行时判定：上游上下架自动跟进（5 分钟刷新），调不通的模型
  （上游 404 / 400 明确报模型不可用）会被自动拉黑几小时到几天、到期自愈，
  2xx 回答则立即解封——无需改代码。
- **延迟主要来自上游**：网关自身开销 <50ms（TLS 连接池复用 + 启动预热）。
  实测单请求 1.7s–20s 不等，大头是上游 opencode.ai 的排队（`waitHeaders`
  1.4–9.7s）和模型生成耗时（快速模型 <1s，思考模型 5–40s）。同样输入连续
  请求波动很大，属于免费共享通道的正常抖动；日志里 `[upstream] connect/…
  ttfb/stream total` 可逐请求核对。
- **地区封锁**：部分模型（如 `muse-spark-*`）对特定出口国家返回
  `403 RegionError`，上游会原样透传。把服务部署在不受限地区（如美国）即可绕过，
  这也是 `muse-spark-*` 能默认列出并直接使用的前提。
- **`st_…` 约 30 天过期**：到期后免费模型开始 401/403，重跑仓库根
  `scripts/get-zen-token.mjs --show` 取新值，更新 Railway Variables 并重部署即可。
  上游返回的 `retry-after` 会原样透传，请让客户端按它退避而不是立刻重试。
- **未列出的模型回 404**：目录 ready 时（`/health` 里 `catalog.total > 0`）
  请求不在 `/v1/models` 里的模型会直接 404，不再转发给上游；目录尚未就绪的
  启动窗口内仍会放行，由上游判定。
- **chat 模型不能走 `/v1/responses`**：上游对该组合返回 500，透传之。
- **上游政策随时可能变化**：这是对 OpenCode 免费通道的复用，不是官方
  公开 API；上游收紧（改凭证/缩白名单）会让服务不可用。生产环境请勿依赖。
