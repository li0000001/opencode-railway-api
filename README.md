# opencode2dsh Railway Server

一个**零依赖**的 OpenAI 兼容网关，把 OpenCode Zen 的匿名免费通道暴露为标准
`/v1/*` 端点，可部署到 [Railway](https://railway.app)，供 OpenWebUI、Cherry
Studio 或任何支持 `base_url + API key` 的客户端调用。

> **默认不需要任何上游 key。** 不设置 `ZEN_API_KEY` / `ZEN_API_KEYS` 即走匿名
> 免费通道（上游凭证是 `Authorization: Bearer public`）。`API_KEY` 只是**调用方**
> 访问本服务用的密钥，和 OpenCode 账号无关；想改用自己 Zen 账户的配额时再填
> `ZEN_API_KEY`。详见下方[本地补丁](#本地补丁2026-10-13必须保留)——不打补丁时
> 匿名通道会**每个请求都 403**。

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

## 本地补丁（2026-10-13，必须保留）

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

本机验证（受限国家 + 匿名通道）：`/v1/models` → 11 个（9 个 chat + 2 个
responses）；在 chat 接口请求 `muse-spark-1.2-contributor-free` 能通过门禁直达
上游，只被国家限制拦回 `RegionError`（**不是** `FreeTierError` 或 400，说明请求
形状正确）；同一时刻 `big-pickle` 仍正常 200。转换逻辑另有 33 条离线单测
（请求翻译、流式增量、工具调用、无增量兜底、错误映射、非流式聚合）全绿。

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
| `ZEN_API_KEY` | 否 | —（空 = 匿名免费通道） | **上游凭证**。留空就是 `Bearer public` 匿名免费通道；填入 [OpenCode Zen](https://opencode.ai/zen) 的 API key 后，对话与 Responses 都改用你的 key。key 不写日志、不被任何接口回显 |
| `ZEN_API_KEYS` | 否 | — | **key 池**：逗号 / 分号 / 空白分隔多个 key（与 `ZEN_API_KEY` 同时设置会合并）。多于 1 个即启用池化行为，见下节 |
| `KEY_COOLDOWN_MS` | 否 | `60000` | key 撞 429/401 后的冷却基准时长；按连续失败次数指数递增（60s→120s→240s…），上限 10 分钟 |
| `KEY_POOL_ANONYMOUS` | 否 | `true` | 所有 key 都在冷却时，是否回退到匿名免费通道（它按出口 IP 计量，是另一份配额） |
| `KEY_POOL_FAILOVER` | 否 | `true` | 某个 key 回 429/401 时，是否在**同一次请求内**改用下一个就绪 key 重试一次（仅池模式生效；匿名单通道的 429 依旧原样透传） |

## 上游两种通道与 key 池（`ZEN_API_KEY` / `ZEN_API_KEYS`）

一个变量切换，其余行为完全一致（伪装头、free-lane 形状门禁、目录过滤都保留）：

| | key 留空（默认） | 配置 1 个 key | 配置 ≥2 个 key（池） |
| --- | --- | --- | --- |
| 凭证 | `Authorization: Bearer public` | `Authorization: Bearer <你的key>` | 每次请求按粘滞规则取一个 key |
| base URL | `https://opencode.ai/zen/v1` | 同一个 | 同一个 |
| 暴露的模型 | 十余个 `*-free` | **同样十余个 `*-free`**（目录仍只放行免费模型；要放开付费模型需要再加开关） | 同左 |
| 配额来源 | 出口 IP 的匿名额度（实测约 450–766 请求/天，UTC 00:00 重置，另有约 250 请求/小时的短时限速） | 你 Zen 账户的限额 | 各 key 的限额相加 |
| 启动日志 | `upstream auth: anonymous free lane` | `upstream auth: zen-key (1 key: oc_sk_…)` | `upstream auth: zen-key-pool (N keys: oc_sk_…, …)` + 池参数行 |
| `/health` | `"upstreamAuth": "anonymous"` | `"upstreamAuth": "zen-key"` | `"upstreamAuth": "zen-key-pool"` + `pool` 块 |

### key 池怎么工作

```sh
railway variables set ZEN_API_KEYS="key1,key2,key3,key4"
```

| 机制 | 行为 |
| --- | --- |
| **会话粘滞** | `sha256(会话种子)` 选首选 key，冷却中则顺延到下一个就绪 key。同一对话全程固定一把 key（上游 prompt 缓存亲和稳定），只有首选 key 进冷却才漂移 |
| **冷却熔断** | key 回 **429**（读 `retry-after`）或 **401** → 冷却 60s 起、指数递增到 10 分钟上限。403（free-tier 门禁）与 5xx（上游容量）**不算** key 的错，不冷却，避免白白缩小池子 |
| **请求内故障转移** | 池模式下 429/401 会立刻在**同一次请求**里改用下一个就绪 key 重试一次，客户端只看到 200（实测：混入 1 个坏 key，11/11 请求全部 200，坏 key 三次 401 后被指数冷却到 4 分钟） |
| **匿名兜底** | 所有 key 都在冷却 → 回退 `Bearer public`（出口 IP 是另一份配额）；`KEY_POOL_ANONYMOUS=false` 可关 |
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

拿到 key：登录 [opencode.ai/zen](https://opencode.ai/zen) → 绑卡充值（最低 $20，另有 4.4%+$0.30 卡费）→ 复制 API key。

```sh
railway variables set ZEN_API_KEY=<你的Zen key>    # 单 key
railway variables set ZEN_API_KEYS=<key1>,<key2>   # 池
# 清除：railway variables unset ZEN_API_KEY
```

**两点提醒**

1. **`-free` 模型是"限时免费"档**：社区报告过"有余额仍撞 `FreeUsageLimitError`"
   （[anomalyco/opencode#33318](https://github.com/anomalyco/opencode/issues/33318)），
   即免费模型的 IP/日限额**不一定**随 key 解除。上游返回 401/429 时，错误文案里会
   明确标注是 `ZEN_API_KEY` 被拒还是匿名通道限流，便于判断。
2. **key 只放 Railway 的 Variables**，不要提交进仓库；下游客户端用的仍是自己的
   `API_KEY`，两者互不相干。上游 key 不会出现在日志、`/health` 或任何响应里。

## 部署到 Railway

本目录是**自包含**的：`adapter/` 已拷入插件源码，`railway.json` + `Dockerfile`
都在本目录内。只需把 `railway-server/` 这一个文件夹作为仓库根上传。

方式 A —— GitHub 仓库（推荐）：

1. 新建一个 GitHub 仓库，把**本文件夹的全部内容**（6 项：`Dockerfile`、
   `railway.json`、`package.json`、`server.ts`、`README.md`、`adapter/`）放进去。
2. Railway → **New Project → Deploy from GitHub repo**，选择该仓库。
   本目录的 `railway.json` 会自动选用 `Dockerfile` 构建。
3. **Settings → Variables** 添加 `API_KEY`（自生成一个强随机串）。
   **不要设置 `ZEN_API_KEY` / `ZEN_API_KEYS`**——留空就是匿名免费通道（本次改动
   的目标形态）；填了会把请求切到你 Zen 账户的配额。上游策略收紧时再填它们作为
   备用，代码路径一直都在。
4. **Settings → Networking → Generate Domain** 生成公网域名。
5. 部署完成后访问 `https://<你的域名>/health` 验证。

方式 B —— Railway CLI（在**本目录内**执行）：

```sh
railway login
railway init      # 在 railway-server/ 目录内初始化
railway up        # railway.json 已配好 Dockerfile
railway variables set API_KEY=<你的强随机密钥>
railway domain    # 生成公网域名
```

匿名免费模式（默认）**不需要**再设置 `ZEN_API_*`。若之后想用自己 Zen 账户的配额：

```sh
railway variables set ZEN_API_KEYS=<key1>,<key2>   # 池
railway variables unset ZEN_API_KEYS               # 退回匿名
```

### 本机测试

默认即匿名免费模式（**无需任何上游 key**）：

```sh
PORT=18080 API_KEY=test-key node server.ts
curl http://127.0.0.1:18080/health          # 期望 "upstreamAuth":"anonymous"
curl -H "Authorization: Bearer test-key" http://127.0.0.1:18080/v1/models
curl -H "Authorization: Bearer test-key" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:18080/v1/chat/completions
```

`/health` 里 `upstreamAuth` 必须是 `anonymous`（不是 `zen-key`），否则说明环境变量里
残留了 `ZEN_API_*`。Windows PowerShell 下要先清掉进程环境里的同名变量：
`Get-ChildItem env: | Where-Object { $_.Name -like 'ZEN*' } | ForEach-Object { Remove-Item "env:$($_.Name)" }`。

要求 Node ≥ 22.18（原生运行 TypeScript，无需 `npm install`）。

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

- **模型只有十来个是正常现象**：Zen 实时列表有 80+ 个模型，绝大多数是
  **付费模型**（实测匿名调用返回 `401 AuthError "Missing API key."`），另有若干
  已弃用 / 缺元数据项，真正能匿名免费用的只有十来个（2026-10-13 实测：84 个
  模型中 11 个可用）。数量随上游上下架浮动。本服务已按三级回退目录如实暴露
  全部可用项，不是过滤 bug。
- **延迟主要来自上游**：网关自身开销 <50ms（TLS 连接池复用 + 启动预热）。
  实测单请求 1.7s–20s 不等，大头是上游 opencode.ai 的排队（`waitHeaders`
  1.4–9.7s）和模型生成耗时（快速模型 <1s，思考模型 5–40s）。同样输入连续
  请求波动很大，属于免费共享通道的正常抖动；日志里 `[upstream] connect/…
  ttfb/stream total` 可逐请求核对。
- **地区封锁**：部分模型（如 `muse-spark-*`）对特定出口国家返回
  `403 RegionError`，上游会原样透传。把服务部署在不受限地区（如美国）即可绕过，
  这也是 `muse-spark-*` 能默认列出并直接使用的前提。
- **匿名配额按出口 IP 限流**：触发 429 需等待窗口恢复；Railway 出口 IP 是
  共享的，高峰期可能更容易撞限。上游返回的 `retry-after` 会原样透传，
  请让客户端按它退避而不是立刻重试。
- **未列出的模型回 404**：目录 ready 时（`/health` 里 `catalog.total > 0`）
  请求不在 `/v1/models` 里的模型会直接 404，不再转发给上游；目录尚未就绪的
  启动窗口内仍会放行，由上游判定。
- **chat 模型不能走 `/v1/responses`**：上游对该组合返回 500，透传之。
- **上游政策随时可能变化**：这是对 OpenCode 匿名免费通道的复用，不是官方
  公开 API；上游收紧（改凭证/缩白名单）会让服务不可用。生产环境请勿依赖。
