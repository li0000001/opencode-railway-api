/**
 * opencode2dsh Railway server — an OpenAI-compatible gateway to the OpenCode
 * Zen anonymous free lane, runnable on Railway (or any local machine).
 *
 * Reuses the plugin's already-live-verified adapter sources (copied verbatim
 * from packages/plugin/src/adapter/ into ./adapter/ so this directory is
 * self-contained):
 *   - catalog.ts  S1 (Zen /v1/models) ∩ S2 (models.dev) ∪ S3 (static) list
 *   - ids.ts      per-conversation stable session/request ids + CLI disguise
 *   - messages.ts the free-lane agent-shape gate (bash+read stub tools)
 *   - routing.ts  Responses-only model detection
 *   - proxy.ts    upstream egress tunnels (HTTP CONNECT / HTTPS / SOCKS5) + NO_PROXY
 *
 * Endpoints (all but /health require `Authorization: Bearer <API_KEY>`):
 *   GET  /health            liveness + catalog status
 *   GET  /v1/models         OpenAI model list (every exposed free model; each
 *                           row carries "api": "chat" | "responses")
 *   GET  /v1/models/{id}    single model entry
 *   POST /v1/chat/completions  streaming relay or buffered non-stream
 *                           (Responses-only models are bridged transparently)
 *   POST /v1/responses      Responses-API passthrough (muse-spark-* etc.)
 *
 * Zero runtime dependencies: Node >= 22.18 runs TypeScript natively.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { once } from 'node:events'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ModelCatalog, isModelDeadSignal, ZEN_BASE_URL, type CatalogSnapshot } from './adapter/catalog.ts'
import { deriveRequestIDs, disguiseHeaders } from './adapter/ids.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape } from './adapter/messages.ts'
import { isResponsesModel } from './adapter/routing.ts'
import {
  TUNNEL_LATENCY,
  createEgressFetch,
  createTunnelAgent,
  maskProxy,
  resolveUpstreamProxy,
  type TunnelEvent,
} from './proxy.ts'
import {
  DEFAULT_PROXY_SOURCES,
  ProxyPool,
  createZenProbe,
  proxyRotationReason,
  type ProxyPoolSource,
} from './proxy-pool.ts'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8080)
const API_KEY = process.env.API_KEY ?? randomBytes(24).toString('hex')
if (!process.env.API_KEY) {
  console.warn(
    `[opencode2dsh-railway] API_KEY is not set — generated a one-time key for this boot:\n` +
      `  ${API_KEY}\n` +
      `  Set the API_KEY environment variable (Railway → Variables) to a stable value.`,
  )
}

const ZEN_CHAT_URL = `${ZEN_BASE_URL}/v1/chat/completions`
const ZEN_RESPONSES_URL = `${ZEN_BASE_URL}/v1/responses`

/**
 * Upstream credential. Three spellings, all interchangeable in behaviour
 * (same base URL, same disguise headers, same free-lane shape):
 *
 *   nothing set      → the anonymous free lane (`Bearer public`). Since
 *                      2026-10-14 Zen answers 403 FreeTierError for it: the
 *                      free tier now needs a real OpenCode credential.
 *   ZEN_ACCESS_TOKEN → the account's OpenCode OAuth access token (`st_…`).
 *                      This is what the official client uses and the only
 *                      credential the free models still accept. Read it from
 *                      the client's own store:
 *                        sqlite3 ~/.local/share/opencode/opencode.db
 *                          "select value from credential
 *                           where integration_id='opencode' and active=1"
 *                      and take `access` from the JSON (it lasts ~30 days).
 *   ZEN_API_KEY(S)   → Zen API keys (`oc_sk_…`). They no longer reach the free
 *                      models (403 "Workspace access denied") but still work
 *                      for paid ones.
 *
 * `ZEN_API_KEYS` holds a pool (comma / semicolon / whitespace separated),
 * `ZEN_API_KEY` the single-key spelling and `ZEN_ACCESS_TOKEN` the session
 * token; all may be set, they merge into one pool. Credentials are only ever
 * exposed masked (`oc_sk_c39adb58b31...Bztt`, `st_***`) — never logged whole,
 * never returned by any endpoint.
 */
const ZEN_ACCESS_TOKEN = (process.env.ZEN_ACCESS_TOKEN ?? process.env.ZEN_SESSION_TOKEN ?? '').trim()
const ZEN_API_KEYS = parseKeyList(
  `${process.env.ZEN_API_KEYS ?? ''} ${process.env.ZEN_API_KEY ?? ''} ${ZEN_ACCESS_TOKEN}`,
)
/** Cooldown base for a key that answered 429/401 (exponential, capped). */
const KEY_COOLDOWN_MS = numEnv('KEY_COOLDOWN_MS', 60_000)
/**
 * Every credential cooling down → serve from the anonymous lane (its own
 * quota). Defaults off when a session token is configured: the anonymous
 * `Bearer public` credential is rejected outright now, so falling back to it
 * would only replace a real error with a confusing one.
 */
const KEY_POOL_ANONYMOUS = boolEnv('KEY_POOL_ANONYMOUS', ZEN_ACCESS_TOKEN === '')
/** 429/401 answered by one key → retry once on the next ready credential. */
const KEY_POOL_FAILOVER = boolEnv('KEY_POOL_FAILOVER', true)

function parseKeyList(raw: string): string[] {
  const keys: string[] = []
  for (const part of raw.split(/[\s,;]+/)) {
    const key = part.trim()
    if (key.length > 0 && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Appended to the gate's own 403 FreeTierError. Its text is written for a
 * human running the official client ("use it from within OpenCode"), which
 * says nothing useful to a gateway, so the four checks are spelled out.
 */
const FREE_TIER_HINT =
  ' [gateway hint: the free tier now matches the client fingerprint - it needs ZEN_ACCESS_TOKEN (an OpenCode account session token, renewed every ~30 days), User-Agent opencode/latest/<version>/cli, both x-opencode-session and x-opencode-session-id, and the official read/shell tool declarations in the body]'

/** Watchdogs mirror the adapter's defaults (first stream event / body idle). */
const FIRST_EVENT_MS = numEnv('FIRST_EVENT_MS', 30_000)
const BODY_IDLE_MS = numEnv('BODY_IDLE_MS', 120_000)
const MAX_BODY_BYTES = numEnv('MAX_BODY_BYTES', 10 * 1024 * 1024)

/**
 * Send the SSE 200 head as soon as the request passes validation, instead of
 * waiting for the upstream response headers (measured waitHeaders 1.4-6s).
 * Off by default: committing to 200 early means an upstream 401/429/403 has to
 * travel as an inline `data: {"error":…}` event instead of a real HTTP status,
 * which breaks clients that retry on status codes. Enable it when a client or
 * proxy times out waiting for response headers.
 */
const EARLY_SSE_HEADERS = boolEnv('EARLY_SSE_HEADERS', false)
/** Dual-write `reasoning` <-> `reasoning_content` on streamed deltas. */
const REASONING_DUAL_WRITE = boolEnv('REASONING_DUAL_WRITE', true)
/** Health snapshot path (same convention as the plugin's adapter-status.json). */
const STATUS_PATH = process.env.STATUS_PATH || join(homedir(), '.opencode2dsh', 'railway-server.status.json')
/** Grace window for in-flight streams on SIGTERM before sockets are cut. */
const SHUTDOWN_DRAIN_MS = numEnv('SHUTDOWN_DRAIN_MS', 5_000)
/** Upstream DNS result cache TTL (avoids a lookup per fresh socket). */
const DNS_TTL_MS = numEnv('DNS_TTL_MS', 60_000)
/** Pool keep-alive heartbeat: keeps a warm TLS socket across idle periods. */
const POOL_WARM_INTERVAL_MS = numEnv('POOL_WARM_INTERVAL_MS', 20_000)
/**
 * Stale pooled-socket watchdog. A reused keep-alive socket whose peer vanished
 * silently (no FIN/RST) accepts the write and then stalls on TCP retransmits
 * (measured ~6.4s spikes in production). No response headers within this window
 * on a *reused* socket means it is stale: zenFetch then retries on a fresh
 * connection. Fresh sockets are never watched — they legitimately spend
 * DNS+TCP+TLS first.
 *
 * Local patch (2026-10-13): default raised 2_500 -> 10_000. Zen routinely needs
 * 2.6-7.2s to emit response headers, so a 2.5s window read live-but-slow
 * upstreams as dead and returned 502 (`stale pooled socket (no response
 * headers)`) whenever the retry also landed on a pooled socket. The OS-level
 * RST (~6s) already catches genuinely reaped sockets, so this is a backstop now.
 */
const POOLED_HEADER_TIMEOUT_MS = numEnv('POOLED_HEADER_TIMEOUT_MS', 10_000)
/** Minimum spacing between health snapshot writes (requests use the throttle). */
const STATUS_WRITE_INTERVAL_MS = numEnv('STATUS_WRITE_INTERVAL_MS', 60_000)

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true
  if (['0', 'false', 'off', 'no'].includes(raw)) return false
  return fallback
}

// ---------------------------------------------------------------------------
// Upstream credential pool (ZEN_API_KEYS): sticky per conversation + cooldowns
// ---------------------------------------------------------------------------

/** A configured key. `key` never leaves memory; `masked` is the only form shown. */
interface PoolEntry {
  key: string
  masked: string
  index: number
  cooldownUntil: number
  consecutiveFailures: number
  used: number
  rejected: number
  lastStatus: number
}

interface PoolPick {
  auth: string
  entry: PoolEntry | null
}

const ANONYMOUS_AUTH = 'Bearer public'
/** Upper bound for the exponential cooldown backoff (401 on a revoked key). */
const MAX_KEY_COOLDOWN_MS = 10 * 60_000

/**
 * `oc_sk_c39adb58b31...Bztt`: account id + last 4 chars, no secret material.
 * Session tokens (`st_…`/`rt_…`) get no fingerprint at all — they are account
 * logins, and `st_<uuid>` would expose most of the UUID.
 */
function maskKey(key: string): string {
  if (key.startsWith('st_') || key.startsWith('rt_')) return `${key.slice(0, 3)}***`
  return key.length <= 20 ? '***' : `${key.slice(0, 16)}...${key.slice(-4)}`
}

/** Stable bucket for a seed: sha256 is uniform, the seed is the conversation. */
function hashIndex(seed: string, modulo: number): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % modulo
}

/** `retry-after` in seconds (or an HTTP date) → milliseconds, floored at 1s. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(seconds * 1000, 1_000)
  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.max(at - Date.now(), 1_000)
  return null
}

/**
 * The key pool. Empty pool = the anonymous free lane, exactly as before.
 *
 * Sticky pick: sha256(conversation) picks a preferred key and linear probing
 * walks to the next ready one, so a conversation keeps one key for its whole
 * life (stable prompt-cache affinity upstream) and only shifts while that key
 * is cooling. Cooldowns are raised only by credential (401) and quota (429)
 * failures — a 403 free-tier gate or a 503 capacity error is not the key's
 * fault, and cooling it would shrink the pool for nothing.
 */
class KeyPool {
  readonly #keys: PoolEntry[]
  readonly #cooldownMs: number
  readonly #anonymous: boolean
  readonly #failover: boolean
  #roundRobin = 0

  constructor(
    keys: string[],
    options: { cooldownMs: number; anonymousFallback: boolean; failover: boolean },
  ) {
    this.#keys = keys.map((key, index) => ({
      key,
      masked: maskKey(key),
      index,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      used: 0,
      rejected: 0,
      lastStatus: 0,
    }))
    this.#cooldownMs = options.cooldownMs
    this.#anonymous = options.anonymousFallback
    this.#failover = options.failover
  }

  get size(): number {
    return this.#keys.length
  }

  get failover(): boolean {
    return this.#failover
  }

  get mode(): 'anonymous' | 'zen-key' | 'zen-key-pool' | 'zen-session' {
    if (this.#keys.length === 0) return 'anonymous'
    if (this.#keys.length === 1) return this.#keys[0].key.startsWith('st_') ? 'zen-session' : 'zen-key'
    return 'zen-key-pool'
  }

  #ready(now: number): PoolEntry[] {
    return this.#keys.filter((entry) => entry.cooldownUntil <= now)
  }

  #claim(entry: PoolEntry): PoolPick {
    entry.used += 1
    return { auth: `Bearer ${entry.key}`, entry }
  }

  /** Sticky pick keyed on the conversation (ids.session), for chat/responses. */
  pick(seed: string): PoolPick {
    if (this.#keys.length === 0) return { auth: ANONYMOUS_AUTH, entry: null }
    const now = Date.now()
    const preferred = hashIndex(seed, this.#keys.length)
    for (let step = 0; step < this.#keys.length; step += 1) {
      const entry = this.#keys[(preferred + step) % this.#keys.length]
      if (entry.cooldownUntil <= now) return this.#claim(entry)
    }
    // Everything is cooling: the anonymous lane bills against the exit IP and
    // is therefore a genuinely different route — fall back to it when allowed,
    // otherwise take the key whose cooldown expires first (best effort).
    if (this.#anonymous) return { auth: ANONYMOUS_AUTH, entry: null }
    const leastBad = this.#keys.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b))
    return this.#claim(leastBad)
  }

  /** Rotating pick for context-less calls (pool warm-up). */
  pickRotating(): PoolPick {
    if (this.#keys.length === 0) return { auth: ANONYMOUS_AUTH, entry: null }
    const ready = this.#ready(Date.now())
    if (ready.length === 0) return this.pick('rotating')
    this.#roundRobin = (this.#roundRobin + 1) % ready.length
    return this.#claim(ready[this.#roundRobin])
  }

  /** Keep-alive warm-up credential: never touches the usage counters. */
  warmAuth(): string {
    if (this.#keys.length === 0) return ANONYMOUS_AUTH
    const ready = this.#ready(Date.now())
    return `Bearer ${(ready[0] ?? this.#keys[0]).key}`
  }

  /**
   * Models-listing credentials, re-evaluated on every catalog refresh: always
   * the anonymous public list (order-stable, 87 ids) plus one ready key (the
   * account's own 42 ids). Unioned and then filtered to free models this is
   * the full 13 — a keyed list alone would hide `nemotron-3-ultra-free`, which
   * a key demonstrably can call.
   */
  catalogAuthorizations(): string[] {
    const out = [ANONYMOUS_AUTH]
    const picked = this.pickRotating()
    if (picked.entry !== null && !out.includes(picked.auth)) out.push(picked.auth)
    return out
  }

  /** Observe an upstream answer for the credential that produced it. */
  report(entry: PoolEntry | null, status: number, retryAfter: string | null): void {
    if (entry === null) return
    entry.lastStatus = status
    if (status >= 200 && status < 300) {
      entry.consecutiveFailures = 0
      entry.cooldownUntil = 0
      return
    }
    // 403 = free-tier gate (body/region policy), 5xx = upstream capacity:
    // neither is the key's fault, so the key stays in rotation.
    if (status !== 401 && status !== 429) return
    entry.rejected += 1
    entry.consecutiveFailures += 1
    const base = status === 429 ? (parseRetryAfter(retryAfter) ?? this.#cooldownMs) : this.#cooldownMs
    const backoff = Math.min(base * 2 ** (entry.consecutiveFailures - 1), MAX_KEY_COOLDOWN_MS)
    entry.cooldownUntil = Date.now() + backoff
    console.warn(`[key] ${entry.masked} cooling ${Math.round(backoff / 1000)}s after HTTP ${status}`)
  }

  /**
   * Is there somewhere else to send this request? True when another key is
   * ready, or when the failing credential was a key and the anonymous lane
   * (separate quota) is allowed as the escape hatch.
   */
  canFailover(from: PoolEntry | null): boolean {
    if (this.#keys.length === 0) return false
    if (this.#keys.some((entry) => entry !== from && entry.cooldownUntil <= Date.now())) return true
    return this.#anonymous && from !== null
  }

  /** /health + status-file view: masked fingerprints only, never raw keys. */
  snapshot(): {
    size: number
    ready: number
    cooldown: number
    cooldownMs: number
    failover: boolean
    anonymousFallback: boolean
    keys: Array<{ fingerprint: string; ready: boolean; cooldownSeconds: number; used: number; rejected: number; lastStatus: number | null }>
  } {
    const now = Date.now()
    return {
      size: this.#keys.length,
      ready: this.#keys.filter((entry) => entry.cooldownUntil <= now).length,
      cooldown: this.#keys.filter((entry) => entry.cooldownUntil > now).length,
      cooldownMs: this.#cooldownMs,
      failover: this.#failover,
      anonymousFallback: this.#anonymous,
      keys: this.#keys.map((entry) => ({
        fingerprint: entry.masked,
        ready: entry.cooldownUntil <= now,
        cooldownSeconds: entry.cooldownUntil > now ? Math.ceil((entry.cooldownUntil - now) / 1000) : 0,
        used: entry.used,
        rejected: entry.rejected,
        lastStatus: entry.lastStatus || null,
      })),
    }
  }
}

const keyPool = new KeyPool(ZEN_API_KEYS, {
  cooldownMs: KEY_COOLDOWN_MS,
  anonymousFallback: KEY_POOL_ANONYMOUS,
  failover: KEY_POOL_FAILOVER,
})

// ---------------------------------------------------------------------------
// Upstream egress proxy (UPSTREAM_PROXY / HTTPS_PROXY / ALL_PROXY)
// ---------------------------------------------------------------------------

/**
 * Why a proxy exists here at all: the free-lane gate weighs the *requesting
 * IP*. Shared cloud egress (Render, Railway, AWS, …) is datacenter space, which
 * the gate treats like a VPN/proxy and refuses outright — even with valid
 * credentials ("we've detected abusive traffic from this IP address"). Pointing
 * the upstream calls at a clean exit address is the fix; proxy.ts carries the
 * tunnel implementations (HTTP CONNECT, HTTPS CONNECT, SOCKS5).
 *
 * `NO_PROXY` still wins per host, so a configuration can tunnel `opencode.ai`
 * while leaving `models.dev` direct.
 *
 * Declared up here because the catalog (below) is the first consumer of the
 * egress fetch; the transport agents it needs are declared further down.
 */
const egress = resolveUpstreamProxy()
const PROXY_CONNECT_TIMEOUT_MS = numEnv('PROXY_CONNECT_TIMEOUT_MS', 20_000)
/** The host the Zen API lives on: the egress decision that matters most. */
const UPSTREAM_HOST = new URL(ZEN_BASE_URL).hostname
const proxyTunnels = { ok: 0, failed: 0 }

/** Tunnel telemetry: first success once, failures throttled to every 50th. */
function noteTunnel(event: TunnelEvent): void {
  if (event.ok) {
    proxyTunnels.ok += 1
    if (proxyTunnels.ok === 1) {
      console.log(`[proxy] tunnel up: ${event.target} in ${event.ms}ms`)
    }
    return
  }
  proxyTunnels.failed += 1
  if (proxyTunnels.failed === 1 || proxyTunnels.failed % 50 === 0) {
    console.warn(`[proxy] tunnel to ${event.target} failed (${proxyTunnels.failed} so far): ${event.error?.message ?? 'unknown error'}`)
  }
}

/** Tunnel agents, mirroring the direct pair (pooled + fresh-socket retry). */
const proxiedAgents =
  egress.proxy === null
    ? null
    : {
        pooled: createTunnelAgent(egress.proxy, {
          keepAlive: true,
          maxSockets: 64,
          maxFreeSockets: 2,
          keepAliveMsecs: 30_000,
          connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
          lookup: cachedLookup,
          onTunnel: noteTunnel,
        }),
        fresh: createTunnelAgent(egress.proxy, {
          keepAlive: false,
          maxSockets: 64,
          connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
          lookup: cachedLookup,
          onTunnel: noteTunnel,
        }),
      }

/**
 * The agent for one upstream host: the pool's current exit when auto mode is
 * on, the fixed tunnel when a proxy is configured, the direct agent otherwise
 * (`NO_PROXY` wins in every mode).
 */
function upstreamAgentFor(host: string, fresh: boolean): https.Agent {
  if (proxyPool !== null && !egress.noProxy.matches(host, 443)) {
    const lease = proxyPool.lease()
    if (lease === null) throw new PoolWarmingError('the free-proxy pool has no clean exit yet')
    return fresh ? lease.fresh : lease.pooled
  }
  if (proxiedAgents !== null && !egress.noProxy.matches(host, 443)) {
    return fresh ? proxiedAgents.fresh : proxiedAgents.pooled
  }
  return fresh ? freshAgent : upstreamAgent
}

/** True when the configured egress actually carries the Zen traffic. */
function proxyAppliesToUpstream(): boolean {
  if (proxyPool !== null) return !egress.noProxy.matches(UPSTREAM_HOST, 443)
  return proxiedAgents !== null && !egress.noProxy.matches(UPSTREAM_HOST, 443)
}

// ---------------------------------------------------------------------------
// Free-proxy auto pool (PROXY_POOL=auto)
// ---------------------------------------------------------------------------

/**
 * `PROXY_POOL=auto` replaces the single fixed exit with a self-managed stock:
 * the gateway pulls public proxy lists, probes every candidate with a real
 * free-lane request and rotates on 403 (flagged IP) / 429 (spent quota).
 * proxy-pool.ts owns the scanning and selection; here we only read the
 * environment and hand over the tunnel telemetry + DNS cache.
 *
 * `UPSTREAM_PROXY` is ignored in this mode (the pool is the egress), but
 * `NO_PROXY` still exempts hosts. `PROXY_POOL_SEED` short-circuits the first
 * scan with known-good exits.
 */
const PROXY_POOL_FLAG = (process.env.PROXY_POOL ?? process.env.FREE_PROXY_POOL ?? '').trim().toLowerCase()
const PROXY_POOL_ENABLED = ['auto', '1', 'on', 'true', 'yes'].includes(PROXY_POOL_FLAG)
const PROXY_POOL_TARGET = numEnv('PROXY_POOL_TARGET', 5)
const PROXY_POOL_REFRESH_MS = numEnv('PROXY_POOL_REFRESH_MS', 600_000)
const PROXY_POOL_MAX_PROBE = numEnv('PROXY_POOL_MAX_PROBE', 120)
/** How many different exits one client request may try before giving up. */
const PROXY_POOL_ATTEMPTS = Math.max(1, Math.min(4, numEnv('PROXY_POOL_ATTEMPTS', 3)))
const PROXY_POOL_PROBE_TIMEOUT_MS = numEnv('PROXY_POOL_PROBE_TIMEOUT_MS', 25_000)
const PROXY_POOL_PROBE_MODEL = (process.env.PROXY_POOL_PROBE_MODEL ?? 'mimo-v2.6-flash-free').trim()

function parsePoolSources(): ProxyPoolSource[] {
  const raw = (process.env.PROXY_POOL_SOURCES ?? '').trim()
  if (raw === '') return DEFAULT_PROXY_SOURCES
  const out: ProxyPoolSource[] = []
  for (const url of raw.split(/[\s,;]+/)) {
    if (url.length === 0) continue
    const protocol: 'http' | 'socks5' = /socks/i.test(url) ? 'socks5' : 'http'
    out.push({ url, protocol, format: /json|geonode/i.test(url) ? 'geonode' : 'text' })
  }
  return out.length > 0 ? out : DEFAULT_PROXY_SOURCES
}

/** Raised while auto mode has no validated exit yet (mapped to 503 + Retry-After). */
class PoolWarmingError extends Error {}

const proxyPool: ProxyPool | null = PROXY_POOL_ENABLED
  ? new ProxyPool({
      sources: parsePoolSources(),
      seed: (process.env.PROXY_POOL_SEED ?? '').split(/[\s,;]+/).filter((part) => part.trim().length > 0),
      targetSize: PROXY_POOL_TARGET,
      maxProbe: PROXY_POOL_MAX_PROBE,
      refreshMs: PROXY_POOL_REFRESH_MS,
      coolingMs: numEnv('PROXY_POOL_COOLING_MS', 120_000),
      connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
      probeTimeoutMs: PROXY_POOL_PROBE_TIMEOUT_MS,
      concurrency: numEnv('PROXY_POOL_CONCURRENCY', 8),
      lookup: cachedLookup,
      onTunnel: noteTunnel,
      probe: createZenProbe({
        zenBaseUrl: ZEN_BASE_URL,
        model: PROXY_POOL_PROBE_MODEL,
        connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
        timeoutMs: PROXY_POOL_PROBE_TIMEOUT_MS,
        onTunnel: noteTunnel,
      }),
    })
  : null

// ---------------------------------------------------------------------------
// Model catalog (S1 live ∩ S2 free-decision, S3 static fallback)
// ---------------------------------------------------------------------------

const catalog = new ModelCatalog({
  refreshSeconds: 300,
  // Listing identity is re-evaluated on every refresh: the anonymous public
  // list plus one ready pool key, so neither source's omissions hide a model
  // (chat still only ever uses the free ones the catalog exposes).
  authorization: () => keyPool.catalogAuthorizations(),
  // Same egress as the chat path: the Zen models list rides the tunnel when a
  // proxy is configured (models.dev follows the same per-host NO_PROXY rule).
  // In pool mode the catalog stays direct on purpose: `GET /v1/models` is not
  // gated by the IP check (only the chat lane is), and the proxy stock should
  // be spent on chat traffic, not on a 5-minute listing refresh.
  fetchImpl: createEgressFetch({
    proxy: proxyPool !== null ? null : egress.proxy,
    noProxy: egress.noProxy,
    connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
    lookup: cachedLookup,
  }),
  cachePath: process.env.CACHE_PATH || join(homedir(), '.opencode2dsh', 'railway-server.models.dev.json'),
  onRefresh: (status, lastError) => {
    console.log(
      `[catalog] status=${status.status} total=${status.total} exposed=${status.exposed}` +
        (lastError ? ` error=${lastError}` : ''),
    )
    // Snapshot after every refresh so a post-mortem has a durable record
    // (writeStatusFile is idempotent and never throws into the refresh loop).
    scheduleStatusWrite(true)
  },
})

// ---------------------------------------------------------------------------
// Process-wide observability counters (surfaced by /health and the status file)
// ---------------------------------------------------------------------------

const stats = {
  inflight: 0,
  requests: 0,
  /** Last upstream connect (DNS+TCP+TLS+headers) and first-byte latency, ms. */
  lastConnectMs: 0,
  lastTtfbMs: 0,
  lastUpstreamStatus: 0,
  lastUpstreamError: '',
  lastRequestAt: '',
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, { error: { message, type, code: null, param: null } }, extraHeaders)
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  return timingSafeStringEqual(match[1].trim(), API_KEY)
}

/**
 * Read the request body. On overflow the stream is only paused — the socket is
 * left intact so the caller can still answer with a real 413 (destroying it
 * first, as before, made the client see a bare TCP reset instead).
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      req.pause()
      reject(err)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

/** Build the upstream request body: force stream, satisfy the free-lane gate. */
function buildChatUpstreamBody(clientBody: Record<string, unknown>): Record<string, unknown> {
  const forced = { ...clientBody, stream: true }
  const shaped = ensureFreeLaneShape(forced)
  return (shaped ?? forced) as Record<string, unknown>
}

function buildResponsesUpstreamBody(clientBody: Record<string, unknown>): Record<string, unknown> {
  const forced = { ...clientBody, stream: true }
  const shaped = ensureResponsesFreeLaneShape(forced)
  return (shaped ?? forced) as Record<string, unknown>
}

/**
 * Persistent upstream connection pool. global fetch (undici) tears its
 * sockets down after a short idle window, so every chat paid a full
 * DNS+TCP+TLS round trip (measured 0.4-1.8s per request from this network).
 * A keep-alive https.Agent reuses the TLS socket and cuts that to ~0ms.
 *
 * maxSockets is deliberately generous: with 16 the 17th concurrent chat just
 * queued behind the others. maxFreeSockets caps how many idle sockets stay hot.
 */
const upstreamAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  // Only the heartbeat's socket(s) stay hot. Keeping 8 idle sockets around
  // meant most of them outlived the peer's idle reap and came back half-open
  // (see POOLED_HEADER_TIMEOUT_MS); two is enough for a single-user lane.
  maxFreeSockets: 2,
  keepAliveMsecs: 30_000,
})

/**
 * Escape hatch for the stale-socket retry: `keepAlive:false` guarantees a brand
 * new socket, so the attempt starts from `socket.connecting` and is never
 * itself subject to POOLED_HEADER_TIMEOUT_MS. Without it a single slow upstream
 * header phase could kill two pooled attempts in a row and surface a 502.
 */
const freshAgent = new https.Agent({ keepAlive: false, maxSockets: 64 })

/**
 * DNS cache for upstream requests. net.connect's default lookup hits the OS
 * resolver on every *new* socket, and sockets rotate whenever the peer reaps
 * an idle connection — so a fresh connection paid DNS+TCP+TLS. Caching the
 * answer for DNS_TTL_MS (falling back to the stale entry when the resolver
 * itself fails) removes that round trip without pinning us to a dead IP for
 * long: one minute is well inside any sane failover window.
 */
interface CachedDnsRecord {
  address: string
  family: number
}
const dnsCache = new Map<string, { at: number; records: CachedDnsRecord[] }>()

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | number, family?: number) => void

/**
 * Deliberately loose parameter types: net.connect calls this with either
 * (hostname, callback) or (hostname, {all:true,…}, callback) depending on
 * autoSelectFamily, and http.ClientRequestArgs['lookup'] does not model both.
 */
function cachedLookup(hostname: string, options: unknown, callback?: unknown): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback
  const opts = (typeof options === 'function' ? {} : (options ?? {})) as { all?: boolean; family?: number }
  const key = `${hostname}|${opts.family ?? 0}`

  const emit = (records: CachedDnsRecord[]): void => {
    if (records.length === 0) {
      const err: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`)
      err.code = 'ENOTFOUND'
      cb(err, '', 0)
      return
    }
    if (opts.all) {
      cb(null, records as unknown as string, 0)
      return
    }
    cb(null, records[0].address, records[0].family)
  }

  const hit = dnsCache.get(key)
  if (hit && Date.now() - hit.at < DNS_TTL_MS) {
    emit(hit.records)
    return
  }

  dnsLookup(hostname, { ...(opts.family ? { family: opts.family } : {}), all: true }, (err, addresses) => {
    if (err) {
      // Resolver failed: a stale-but-recently-working answer beats a hard
      // failure (VPN/DNS blips are exactly when we need the pool most).
      if (hit) {
        emit(hit.records)
      } else {
        cb(err as NodeJS.ErrnoException, '', 0)
      }
      return
    }
    const records = (addresses ?? []) as unknown as CachedDnsRecord[]
    dnsCache.set(key, { at: Date.now(), records })
    emit(records)
  })
}

/** Minimal Response-like wrapper over node:https (streaming + buffered reads). */
interface UpstreamResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: AsyncGenerator<Uint8Array> | null
  text(): Promise<string>
  /** Time from request start: tls = socket+TLS established, headers = response headers in. */
  timings: { tlsMs: number | null; headersMs: number }
}

/** A non-2xx response, read whole so it can be inspected *and* relayed. */
async function bufferedResponse(response: UpstreamResponse): Promise<UpstreamResponse> {
  const text = await response.text().catch(() => '')
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: null,
    text: async () => text,
    timings: response.timings,
  }
}

/**
 * A pooled keep-alive socket may have been closed by the upstream edge while
 * idle; the first POST on it dies with ECONNRESET/socket hang up before any
 * byte was processed. Retry that case exactly once on a fresh socket.
 */
function isStaleSocketError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || /socket hang up/i.test(String((err as Error).message))
}

async function zenFetch(
  url: string,
  upstreamBody: Record<string, unknown>,
  messages: unknown,
  signal: AbortSignal,
): Promise<UpstreamResponse> {
  // Holds whichever credential the attempt below picked, so the failover pass
  // can tell whether there is anywhere else to go.
  const attempt: { entry: PoolEntry | null } = { entry: null }
  // Pool mode: one attempt per available exit, so a flagged/quota-dead exit is
  // swapped for a spare instead of surfacing to the client.
  const proxyAttempts = proxyPool === null ? 1 : PROXY_POOL_ATTEMPTS
  let keyFailoverUsed = false
  let lastError: unknown = null
  let lastResponse: UpstreamResponse | null = null

  for (let attemptIndex = 0; attemptIndex < proxyAttempts; attemptIndex += 1) {
    // Each iteration leases the *current* exit: a bad report below retires it,
    // so the next iteration naturally walks to the next ready spare.
    const lease = proxyPool === null ? null : proxyPool.lease()
    if (proxyPool !== null && lease === null) throw new PoolWarmingError('the free-proxy pool has no clean exit yet')

    let response: UpstreamResponse | null = null
    try {
      response = await zenFetchOnce(url, upstreamBody, messages, signal, attempt, lease?.pooled)
    } catch (err) {
      if (signal.aborted) throw err
      lastError = err
      proxyPool?.reportError(lease?.entry ?? null, err)
      if (isStaleSocketError(err)) {
        console.warn(`[upstream] stale pooled socket (${(err as NodeJS.ErrnoException).code ?? 'hang up'}), retrying once on a fresh connection`)
        try {
          const fresh = lease === null ? upstreamAgentFor(new URL(url).hostname, true) : lease.fresh
          response = await zenFetchOnce(url, upstreamBody, messages, signal, attempt, fresh)
        } catch (retryErr) {
          if (signal.aborted) throw retryErr
          lastError = retryErr
          proxyPool?.reportError(lease?.entry ?? null, retryErr)
          response = null
        }
      }
    }

    if (response === null) {
      if (lease !== null && attemptIndex + 1 < proxyAttempts) {
        console.warn(`[proxy-pool] rotating after a connection failure through ${lease.entry.masked}`)
        continue
      }
      throw lastError ?? new Error('upstream request failed')
    }

    if (response.ok) {
      proxyPool?.reportSuccess(lease?.entry ?? null)
      return response
    }

    const buffered = await bufferedResponse(response)
    const text = await buffered.text()
    proxyPool?.reportStatus(lease?.entry ?? null, buffered.status, text)
    lastResponse = buffered

    // Auto mode: a spent quota (429) or an abuse-gate 403 is about the *exit*,
    // not the credential — retire it and retry through the next spare.
    const rotation = proxyRotationReason(buffered.status, text)
    if (lease !== null && rotation !== null && attemptIndex + 1 < proxyAttempts) {
      console.warn(`[proxy-pool] rotating after HTTP ${buffered.status} (${rotation}) through ${lease.entry.masked}`)
      continue
    }

    // Credential failover: the 429/401 above already put that key in cooldown,
    // so the retry walks to the next ready key (or the anonymous lane). One
    // extra hop, pool only — the anonymous lane has nowhere to fail over to,
    // which keeps its 429s passing through untouched as before.
    if (
      keyPool.failover &&
      (buffered.status === 429 || buffered.status === 401) &&
      !keyFailoverUsed &&
      keyPool.canFailover(attempt.entry)
    ) {
      keyFailoverUsed = true
      console.warn(
        `[key] failing over after HTTP ${buffered.status} from ${attempt.entry ? attempt.entry.masked : 'anonymous'}`,
      )
      try {
        const retried = await zenFetchOnce(url, upstreamBody, messages, signal, attempt, lease?.pooled)
        if (retried.ok) {
          proxyPool?.reportSuccess(lease?.entry ?? null)
          return retried
        }
        const bufferedRetry = await bufferedResponse(retried)
        proxyPool?.reportStatus(lease?.entry ?? null, bufferedRetry.status, await bufferedRetry.text())
        return bufferedRetry
      } catch (err) {
        if (signal.aborted) throw err
        lastError = err
        proxyPool?.reportError(lease?.entry ?? null, err)
        throw err
      }
    }

    return buffered
  }

  if (lastResponse !== null) return lastResponse
  throw lastError ?? new Error('upstream request failed')
}

async function zenFetchOnce(
  url: string,
  upstreamBody: Record<string, unknown>,
  messages: unknown,
  signal: AbortSignal,
  attempt: { entry: PoolEntry | null },
  agentOverride?: https.Agent,
): Promise<UpstreamResponse> {
  const ids = deriveRequestIDs(
    Array.isArray(messages) ? (messages as Array<{ role: string; content: unknown }>) : [],
  )
  const target = new URL(url)
  // Direct or tunnelled, decided per host: a configured proxy carries the Zen
  // traffic unless NO_PROXY exempts this host (proxy.ts / upstreamAgentFor).
  const agent = agentOverride ?? upstreamAgentFor(target.hostname, false)
  const payload = JSON.stringify(upstreamBody)
  // Sticky credential: the session id is derived from the conversation's first
  // user turn, so one conversation always rides the same key (and the same
  // upstream prompt-cache affinity) for as long as that key stays ready.
  const pick = keyPool.pick(ids.session)
  attempt.entry = pick.entry
  if (keyPool.size > 0) {
    console.log(`[key] ${pick.entry ? `${pick.entry.masked} (${pick.entry.index + 1}/${keyPool.size})` : 'anonymous fallback'}`)
  }
  const headerBag: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    authorization: pick.auth,
    'content-length': String(Buffer.byteLength(payload)),
    ...disguiseHeaders(ids),
  }

  return new Promise<UpstreamResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t0 = Date.now()
    let tlsMs: number | null = null
    let pooledHeaderTimer: NodeJS.Timeout | null = null
    const clearPooledHeaderTimer = (): void => {
      if (pooledHeaderTimer !== null) {
        clearTimeout(pooledHeaderTimer)
        pooledHeaderTimer = null
      }
    }
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent,
        lookup: cachedLookup,
        headers: headerBag,
      },
      (res) => {
        clearPooledHeaderTimer()
        const headersMs = Date.now() - t0
        const get = (name: string): string | null => {
          const raw = res.headers[name.toLowerCase()]
          if (raw === undefined) return null
          return Array.isArray(raw) ? raw.join(', ') : raw
        }
        const body = (async function* stream() {
          for await (const chunk of res) yield chunk as Uint8Array
        })()
        const readAll = async (): Promise<string> => {
          const chunks: Uint8Array[] = []
          for await (const chunk of body) chunks.push(chunk)
          return Buffer.concat(chunks).toString('utf8')
        }
        const status = res.statusCode ?? 0
        // Feed the credential back into the pool: 429/401 cool that key, 2xx
        // clears any cooldown it may have been carrying.
        keyPool.report(pick.entry, status, get('retry-after'))
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get },
          body,
          text: readAll,
          timings: { tlsMs, headersMs },
        })
      },
    )
    req.on('socket', (socket) => {
      // Small SSE chunks must leave immediately; Nagle only adds latency.
      socket.setNoDelay(true)
      // A tunnel agent hands over a socket that is *already connected* (the
      // CONNECT/SOCKS5 handshake and TLS completed inside createConnection), so
      // "connecting" is no longer a reliable proxy for "fresh". `reusedSocket`
      // (set by the agent when the socket came out of the keep-alive pool) is:
      // it is true exactly for sockets that can be silently half-dead.
      const tunnelMs = (socket as unknown as Record<symbol, number | undefined>)[TUNNEL_LATENCY]
      if (tunnelMs !== undefined) {
        tlsMs = tunnelMs // fresh tunnel: report what the proxy hop actually cost
      } else if (socket.connecting) {
        socket.once('secureConnect', () => { tlsMs = Date.now() - t0 })
      } else {
        tlsMs = 0 // pooled socket reused: no handshake at all
      }
      if (req.reusedSocket) {
        // A reused socket may have been reaped by the peer *silently*: the
        // write succeeds and we would then wait on TCP retransmits (~6s
        // measured) before the RST. Flag it ECONNRESET so zenFetch retries
        // once on a fresh connection instead of stalling.
        pooledHeaderTimer = setTimeout(() => {
          const stale = new Error('stale pooled socket (no response headers)') as NodeJS.ErrnoException
          stale.code = 'ECONNRESET'
          req.destroy(stale)
        }, POOLED_HEADER_TIMEOUT_MS)
        pooledHeaderTimer.unref?.()
      }
    })
    // Cover the connect/prefix phase: our watchdogs take over once headers land.
    req.setTimeout(Math.max(FIRST_EVENT_MS, BODY_IDLE_MS), () => {
      req.destroy(new Error('upstream connect/idle timeout'))
    })
    const onAbort = (): void => req.destroy(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      clearPooledHeaderTimer()
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.end(payload)
  })
}

/** Error headers worth handing to the client (429 retry cadence, tracing id). */
const PASSTHROUGH_ERROR_HEADERS = [
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

function pickUpstreamHeaders(upstream: UpstreamResponse): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PASSTHROUGH_ERROR_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) out[name] = value
  }
  return out
}

/**
 * Map a thrown zenFetch to a client-visible status. Pool mode has one extra
 * state worth its own answer: while it has no clean exit yet (boot, or every
 * known exit just died) nothing was attempted at all, so 503 + Retry-After is
 * honest where 502 would read like an upstream failure.
 */
function upstreamUnreachable(err: unknown): {
  status: number
  message: string
  type: string
  headers?: Record<string, string>
} {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof PoolWarmingError) {
    return {
      status: 503,
      message: `free-proxy pool is still scanning for a clean exit — retry shortly (${message})`,
      type: 'upstream_error',
      headers: { 'retry-after': '15' },
    }
  }
  return { status: 502, message: `cannot reach Zen upstream: ${message}`, type: 'upstream_error' }
}

/**
 * Turn a non-2xx upstream response into (a) an OpenAI-shaped payload when the
 * upstream already sent one and (b) a human-readable message either way, so
 * the JSON path and the inline SSE path report identical information.
 */
function describeUpstreamError(
  upstream: UpstreamResponse,
  text: string,
): { payload: unknown; message: string; type: string } {
  // 401 is the one status whose meaning depends on *our* configuration, so the
  // context is appended to the upstream's own explanation rather than replaced.
  const authHint =
    upstream.status !== 401
      ? ''
      : keyPool.size > 0
        ? ' (a configured Zen credential was rejected - for a session token, it expired: paste a fresh ZEN_ACCESS_TOKEN; for oc_sk_ keys, check ZEN_API_KEY(S) and your balance)'
        : ' (no credential configured: the anonymous free lane was closed on 2026-10-14 - set ZEN_ACCESS_TOKEN)'
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const hasOpenAiError =
    parsed !== null && typeof parsed === 'object' && parsed !== undefined && 'error' in (parsed as object)
  if (hasOpenAiError) {
    const err = (parsed as { error?: { message?: unknown; type?: unknown } }).error
    const base =
      typeof err?.message === 'string' && err.message.length > 0 ? err.message : text.slice(0, 400)
    // 403 FreeTierError is the gate's own verdict: say what it wants instead of
    // leaving the caller with "use it from within OpenCode".
    const gateHint = err?.type === 'FreeTierError' ? FREE_TIER_HINT : ''
    const note = authHint || gateHint
    const message = note ? `${base}${note}` : base
    const type = typeof err?.type === 'string' && err.type.length > 0 ? err.type : 'upstream_error'
    const payload = { ...(parsed as object), error: { ...(err as object), message } }
    return { payload, message, type }
  }
  const hint =
    upstream.status === 403
      ? ' (upstream 403: region block or free-tier gate rejection)'
      : upstream.status === 429
        ? ' (upstream 429: anonymous-lane rate limit, retry later)'
        : ''
  const message = `Zen upstream HTTP ${upstream.status}${hint}${authHint}${text ? `: ${text.slice(0, 400)}` : ''}`
  return {
    payload: { error: { message, type: 'upstream_error', code: null, param: null } },
    message,
    type: 'upstream_error',
  }
}

/**
 * Upstream failure → the client. OpenAI-shaped error bodies pass through
 * untouched (now with retry-after / x-request-id preserved); anything else is
 * wrapped so clients always see a valid error. A dead-model signal additionally
 * records a probed ban in the catalog (self-healing roster); successes clear
 * bans at their own call sites.
 */
async function relayUpstreamError(upstream: UpstreamResponse, res: ServerResponse, model: string): Promise<void> {
  const text = await upstream.text().catch(() => '')
  if (model && isModelDeadSignal(upstream.status, text)) catalog.reportModelUnusable(model)
  const { payload, message } = describeUpstreamError(upstream, text)
  stats.lastUpstreamError = message
  sendJson(res, upstream.status, payload, pickUpstreamHeaders(upstream))
}

// ---------------------------------------------------------------------------
// Streaming relay with the adapter's watchdogs
// ---------------------------------------------------------------------------

/** SSE response head (200). */
function writeSseHead(res: ServerResponse, contentType?: string | null): void {
  res.writeHead(200, {
    'content-type': contentType || 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  })
  // writeHead alone only queues the header block — Node flushes it together
  // with the first body write. Without this the client still waits for the
  // first upstream byte, which defeats the whole point of an early head.
  res.flushHeaders()
}

/**
 * An error that has to travel *inside* an already-open stream (watchdog fired,
 * upstream refused after the head went out, transport broke). OpenAI stream
 * error shape, always terminated with [DONE] so clients close cleanly.
 */
function emitSseError(res: ServerResponse, message: string, type = 'server_error'): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify({ error: { message, type, code: null, param: null } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  } catch {
    // the client is already gone — nothing left to report
  }
}

/**
 * Clients read only one of the two reasoning field names (DeepSeek-style
 * `reasoning_content` vs the newer `reasoning`), so a model emitting just one
 * shows up to the user as "no thinking". Duplicate the value onto the other
 * name. Lines without the substring come back byte-identical.
 */
function dualWriteReasoning(line: string): string {
  if (line.indexOf('reasoning') === -1) return line
  const match = /^(data:\s*)(\{.*\})(\r?)$/.exec(line)
  if (!match) return line
  let event: Record<string, unknown>
  try {
    event = JSON.parse(match[2]) as Record<string, unknown>
  } catch {
    return line
  }
  const choices = event.choices
  if (!Array.isArray(choices) || choices.length === 0) return line
  const choice = choices[0] as { delta?: unknown } | null | undefined
  const delta = choice?.delta
  if (!delta || typeof delta !== 'object') return line
  const fields = delta as Record<string, unknown>
  const reasoning = fields.reasoning
  const reasoningContent = fields.reasoning_content
  if (typeof reasoning === 'string' && typeof reasoningContent !== 'string') {
    fields.reasoning_content = reasoning
  } else if (typeof reasoningContent === 'string' && typeof reasoning !== 'string') {
    fields.reasoning = reasoningContent
  } else {
    return line
  }
  return `${match[1]}${JSON.stringify(event)}${match[3]}`
}

/**
 * Line-buffered SSE transformer: SSE frames are newline-delimited, so a
 * chunk boundary can land mid-event. Complete lines are rewritten, the tail
 * stays pending until the next push (or flush at end of stream).
 */
function makeSseLineTransformer(): { push(chunk: string): string; flush(): string } {
  let pending = ''
  return {
    push(chunk: string): string {
      const combined = pending + chunk
      const cut = combined.lastIndexOf('\n')
      if (cut === -1) {
        pending = combined
        return ''
      }
      const complete = combined.slice(0, cut + 1)
      pending = combined.slice(cut + 1)
      if (complete.indexOf('reasoning') === -1) return complete
      return complete
        .split('\n')
        .map(dualWriteReasoning)
        .join('\n')
    },
    flush(): string {
      const tail = pending
      pending = ''
      return dualWriteReasoning(tail)
    },
  }
}

/**
 * Relay the upstream SSE body to the client, enforcing the first-event and
 * body-idle windows and honouring client-side backpressure. Returns nothing;
 * on timeout the connection ends with an inline OpenAI-style error event.
 *
 * @param headersSent true when the caller already wrote the SSE head
 *   (EARLY_SSE_HEADERS mode); otherwise the head goes out here, right after
 *   the upstream answered — which is what preserves real HTTP status codes.
 */
async function relayStream(
  upstream: UpstreamResponse,
  res: ServerResponse,
  controller: AbortController,
  headersSent = false,
): Promise<void> {
  if (!headersSent) writeSseHead(res, upstream.headers.get('content-type'))

  let firstEvent = true
  let idleTimer: NodeJS.Timeout | undefined
  let timedOut = false
  const t0 = Date.now()
  let ttfbLogged = false
  const decoder = new TextDecoder('utf-8')
  const transform = REASONING_DUAL_WRITE ? makeSseLineTransformer() : null

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, firstEvent ? FIRST_EVENT_MS : BODY_IDLE_MS)
    idleTimer.unref?.()
  }

  /**
   * Write with backpressure: res.write() returning false means the client is
   * not draining, and blindly pushing on used to balloon the process buffer.
   * The wait is bounded by BODY_IDLE_MS so a dead client cannot pin a relay.
   */
  const write = async (data: string): Promise<boolean> => {
    if (res.destroyed || res.writableEnded) return false
    let flushed: boolean
    try {
      flushed = res.write(data)
    } catch {
      return false
    }
    if (!flushed) {
      await Promise.race([
        once(res, 'drain').then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), BODY_IDLE_MS)
          timer.unref?.()
        }),
      ])
    }
    return !res.destroyed && !res.writableEnded
  }

  armIdle()
  try {
    if (!upstream.body) throw new Error('upstream response has no body')
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (!ttfbLogged) {
        ttfbLogged = true
        stats.lastTtfbMs = Date.now() - t0
        console.log(`[upstream] ttfb=${Date.now() - t0}ms`)
      }
      firstEvent = false
      armIdle()
      const text = decoder.decode(chunk, { stream: true })
      const out = transform ? transform.push(text) : text
      if (out && !(await write(out))) {
        // Client went away mid-stream: stop pulling from upstream instead of
        // decoding the rest of the answer into a dead socket.
        controller.abort()
        break
      }
    }
    // Order matters: the decoder's trailing bytes continue the text that is
    // already sitting in the transformer's pending buffer.
    const decoderTail = decoder.decode()
    const tail = transform ? transform.push(decoderTail) + transform.flush() : decoderTail
    if (tail) await write(tail)
    if (!res.writableEnded && !res.destroyed) res.end()
    console.log(`[upstream] stream total=${Date.now() - t0}ms`)
  } catch (err) {
    if (timedOut) {
      // Headers are already out: surface the timeout as an inline error event.
      emitSseError(res, `stream watchdog fired (first event ${FIRST_EVENT_MS}ms / body idle ${BODY_IDLE_MS}ms)`)
    } else if (!res.writableEnded && !res.destroyed) {
      const message = err instanceof Error ? err.message : String(err)
      emitSseError(res, `upstream stream broken: ${message}`)
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

// ---------------------------------------------------------------------------
// Non-stream aggregation: SSE in, one JSON out
// ---------------------------------------------------------------------------

interface ChatAggregate {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason: string | null
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    [key: string]: unknown
  }
}

/** Parse a buffered SSE body and fold it into one chat.completion object. */
function aggregateChatCompletion(sse: string, fallbackModel: string): ChatAggregate {
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let id = `chatcmpl-${randomBytes(8).toString('hex')}`
  let created = Math.floor(Date.now() / 1000)
  let model = fallbackModel
  const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()
  let usage: ChatAggregate['usage'] | undefined

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof event.id === 'string') id = event.id
    if (typeof event.created === 'number') created = event.created
    if (typeof event.model === 'string') model = event.model
    if (event.usage && typeof event.usage === 'object') usage = event.usage as ChatAggregate['usage']
    const choices = event.choices
    if (!Array.isArray(choices)) continue
    const choice = choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown } | undefined
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
    const calls = delta.tool_calls
    if (Array.isArray(calls)) {
      for (const raw of calls) {
        const call = raw as { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }
        const index = typeof call.index === 'number' ? call.index : 0
        const prev = toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (typeof call.id === 'string' && call.id) prev.id = call.id
        if (typeof call.type === 'string' && call.type) prev.type = call.type
        if (typeof call.function?.name === 'string' && call.function.name) prev.function.name = call.function.name
        if (typeof call.function?.arguments === 'string') prev.function.arguments += call.function.arguments
        toolCalls.set(index, prev)
      }
    }
  }

  const message: ChatAggregate['choices'][0]['message'] = { role: 'assistant', content: content || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
    if (!message.content) finishReason = finishReason ?? 'tool_calls'
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/** Read a whole SSE body into text (for aggregation), respecting the idle watchdog. */
async function readSse(upstream: UpstreamResponse, controller: AbortController): Promise<string> {
  const chunks: Uint8Array[] = []
  let firstEvent = true
  let timedOut = false
  let idleTimer: NodeJS.Timeout | undefined
  const t0 = Date.now()
  const arm = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, firstEvent ? FIRST_EVENT_MS : BODY_IDLE_MS)
    idleTimer.unref?.()
  }
  arm()
  try {
    if (!upstream.body) throw new Error('upstream response has no body')
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      firstEvent = false
      arm()
      chunks.push(chunk)
    }
    console.log(`[upstream] buffered total=${Date.now() - t0}ms`)
  } catch (err) {
    if (timedOut) throw new Error(`upstream stream watchdog fired after ${firstEvent ? FIRST_EVENT_MS : BODY_IDLE_MS}ms`)
    throw err
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Only the anonymous free models are exposed. Once the live catalog is known,
 * anything else is rejected up front with the official 404 model_not_found
 * shape — forwarding it would surface the upstream's 401 AuthError
 * ("Missing API key.") and read like a gateway bug. While the catalog is still
 * pending (total === 0) we let the request through: the upstream is the only
 * authority then, and refusing would break boot-time requests.
 */
function modelExposureError(model: string): string | null {
  if (catalog.snapshot().total === 0) return null
  if (catalog.list().includes(model)) return null
  return `model "${model}" is not available on this gateway - this endpoint only exposes the free models listed by GET /v1/models`
}

/**
 * Responses API `input` → the {role, content} pairs the id derivation wants.
 * Same seed rule as the chat path: the first user turn, so one conversation
 * keeps one stable session across turns.
 */
function responsesSeedMessages(input: unknown): Array<{ role: string; content: unknown }> {
  if (!Array.isArray(input)) return []
  const out: Array<{ role: string; content: unknown }> = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const { role, content } = item as { role?: unknown; content?: unknown }
    if (typeof role === 'string' && role.length > 0) out.push({ role, content })
  }
  return out
}

/**
 * `GET /v1/models` — every exposed free model, byte-identical to the OpenAI
 * shape plus an extra `"api"` field so a consumer can route:
 *   `"chat"`      fully native on POST /v1/chat/completions
 *   `"responses"` Responses-only (`muse-spark-*`): also usable on
 *                 /v1/chat/completions (the gateway bridges the protocol),
 *                 and native clients should prefer POST /v1/responses.
 *
 * Local change (2026-10-13): Responses-only models used to be hidden unless
 * `?include_responses=true`, because the upstream answers a bare 500 when they
 * reach /chat/completions speaking the chat protocol. Two things changed: they
 * are no longer region-blocked once the service runs outside the restricted
 * country, and the chat path now bridges them instead of rejecting them. They
 * are therefore listed by default; `?include_responses=true` still parses as a
 * no-op for backwards compatibility.
 */
function handleModels(res: ServerResponse): void {
  const created = Math.floor(Date.now() / 1000)
  sendJson(res, 200, {
    object: 'list',
    data: catalog.list().map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'opencode-zen',
      api: isResponsesModel(id) ? 'responses' : 'chat',
    })),
  })
}

/**
 * `GET /v1/models/{id}` answers for any exposed model, Responses-only ones
 * included — knowing that a model exists (and which API it speaks) is not the
 * same as being able to call it through /v1/chat/completions.
 */
function handleModel(res: ServerResponse, id: string): void {
  if (!catalog.list().includes(id)) {
    apiError(res, 404, `model "${id}" is not available on this endpoint`, 'model_not_found')
    return
  }
  sendJson(res, 200, {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'opencode-zen',
    api: isResponsesModel(id) ? 'responses' : 'chat',
  })
}

async function handleChatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (err) {
    apiError(res, 413, err instanceof Error ? err.message : 'request body too large', 'payload_too_large', {
      connection: 'close',
    })
    return
  }
  let clientBody: Record<string, unknown>
  try {
    clientBody = JSON.parse(raw) as Record<string, unknown>
  } catch {
    apiError(res, 400, 'request body is not valid JSON')
    return
  }
  const model = typeof clientBody.model === 'string' ? clientBody.model : ''
  if (!model) {
    apiError(res, 400, 'missing required parameter: model')
    return
  }
  if (!Array.isArray(clientBody.messages) || clientBody.messages.length === 0) {
    apiError(res, 400, 'missing required parameter: messages (must be a non-empty array)')
    return
  }
  const exposure = modelExposureError(model)
  if (exposure) {
    apiError(res, 404, exposure, 'model_not_found')
    return
  }
  // Responses-only models (muse-spark-*) make the upstream answer a bare 500
  // when the chat protocol reaches it, so the gateway translates rather than
  // rejects: chat request in, /v1/responses upstream, chat response out.
  if (isResponsesModel(model)) {
    await handleChatViaResponses(req, res, clientBody, model)
    return
  }

  const wantsStream = clientBody.stream === true
  // Guarantee real usage numbers on the buffered path: like the official API,
  // the upstream only puts usage in the final chunk when it is asked to.
  const injectedUsage = !wantsStream && clientBody.stream_options === undefined
  let upstreamBody: Record<string, unknown>
  try {
    upstreamBody = buildChatUpstreamBody(clientBody)
    if (injectedUsage) upstreamBody.stream_options = { include_usage: true }
  } catch (err) {
    apiError(res, 400, err instanceof Error ? err.message : 'invalid request body')
    return
  }
  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  req.on('close', onClose)

  // EARLY_SSE_HEADERS: commit the 200 before the upstream answers (see the
  // const's doc comment for why this is opt-in).
  const earlyHead = wantsStream && EARLY_SSE_HEADERS
  if (earlyHead) writeSseHead(res)
  const fail = (status: number, message: string, type: string, headers?: Record<string, string>): void => {
    if (earlyHead) emitSseError(res, message, type)
    else apiError(res, status, message, type, headers)
  }

  const tReq = Date.now()
  let upstream: UpstreamResponse
  try {
    upstream = await zenFetch(ZEN_CHAT_URL, upstreamBody, clientBody.messages, controller.signal)
    // An upstream that does not know stream_options answers 400 — retry once
    // without it instead of failing a call that would otherwise have worked.
    if (!upstream.ok && injectedUsage && (upstream.status === 400 || upstream.status === 422)) {
      await upstream.text().catch(() => '')
      delete upstreamBody.stream_options
      upstream = await zenFetch(ZEN_CHAT_URL, upstreamBody, clientBody.messages, controller.signal)
    }
  } catch (err) {
    const described = upstreamUnreachable(err)
    fail(described.status, described.message, described.type, described.headers)
    req.off('close', onClose)
    return
  }
  stats.lastConnectMs = Date.now() - tReq
  stats.lastUpstreamStatus = upstream.status
  console.log(
    `[upstream] connect=${stats.lastConnectMs}ms (tls=${upstream.timings.tlsMs ?? '-'}ms waitHeaders=${upstream.timings.headersMs}ms)`,
  )
  try {
    if (!upstream.ok) {
      if (earlyHead) {
        const text = await upstream.text().catch(() => '')
        const described = describeUpstreamError(upstream, text)
        stats.lastUpstreamError = described.message
        emitSseError(res, described.message, described.type)
        return
      }
      await relayUpstreamError(upstream, res, model)
      return
    }
    stats.lastUpstreamError = ''
    catalog.reportModelUsable(model)
    if (wantsStream) {
      await relayStream(upstream, res, controller, earlyHead)
      return
    }
    const sse = await readSse(upstream, controller)
    const completion = aggregateChatCompletion(sse, model)
    sendJson(res, 200, completion)
  } finally {
    req.off('close', onClose)
  }
}

// ---------------------------------------------------------------------------
// Chat <-> Responses bridge for Responses-only models (muse-spark-*)
//
// Zen answers a bare 500 when these models arrive over the chat protocol, and
// their region block is what used to make them invisible from inside a
// restricted country. A chat client must therefore never see the protocol
// difference: the request is translated on the way out, the response (deltas
// included, so the typewriter effect survives) on the way back.
// ---------------------------------------------------------------------------

/** Flatten an OpenAI chat `content` (string or parts array) into plain text. */
function chatText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as Record<string, unknown>
        return typeof p?.text === 'string' ? p.text : ''
      })
      .join('')
  }
  return ''
}

/**
 * Chat content -> Responses input content, preserving images. Text-only
 * content stays a plain string (compact, exactly as before); any image part
 * produces the parts array with `input_text` / `input_image` items. Without
 * this the bridge flattened images to '' and the model never saw them
 * (live 2026-10-15: muse-spark-1.3 via render "sent but blind").
 */
function chatContentToResponses(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let hasImage = false
  const parts: Array<Record<string, unknown>> = []
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>
    if (typeof part.text === 'string' && (part.type === 'text' || part.type === undefined)) {
      if (part.text) parts.push({ type: 'input_text', text: part.text })
      continue
    }
    if (part.type === 'image_url') {
      const imageUrl = part.image_url as Record<string, unknown> | string | undefined
      const url = typeof imageUrl === 'string' ? imageUrl : typeof imageUrl?.url === 'string' ? imageUrl.url : ''
      if (!url) continue
      hasImage = true
      const detail = typeof imageUrl === 'object' && imageUrl !== null && typeof imageUrl.detail === 'string' ? imageUrl.detail : 'auto'
      parts.push({ type: 'input_image', image_url: url, detail })
      continue
    }
    if (typeof part.text === 'string' && part.text) {
      parts.push({ type: 'input_text', text: part.text })
    }
  }
  if (!hasImage) return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('')
  return parts
}

/**
 * Chat Completions request -> Responses request. Every field with a Responses
 * spelling is translated: system/developer turns become `instructions`,
 * assistant tool calls and tool results become `function_call` /
 * `function_call_output` items, and the nested chat tool schema is flattened
 * (which is also what the free-lane gate expects).
 */
function chatRequestToResponsesBody(clientBody: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(clientBody.messages)
    ? (clientBody.messages as Array<Record<string, unknown>>)
    : []
  const input: Record<string, unknown>[] = []
  const instructions: string[] = []

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user'
    if (role === 'system' || role === 'developer') {
      const text = chatText(message.content)
      if (text) instructions.push(text)
      continue
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        output: chatText(message.content),
      })
      continue
    }
    if (role === 'assistant') {
      const content = chatContentToResponses(message.content)
      if (content !== '' && !(Array.isArray(content) && content.length === 0)) {
        input.push({ role: 'assistant', content })
      }
      if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls as Array<Record<string, unknown>>) {
          const fn = (raw.function ?? {}) as Record<string, unknown>
          input.push({
            type: 'function_call',
            call_id: typeof raw.id === 'string' ? raw.id : '',
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments:
              typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          })
        }
      }
      continue
    }
    input.push({ role, content: chatContentToResponses(message.content) })
  }

  const tools = Array.isArray(clientBody.tools)
    ? (clientBody.tools as Array<Record<string, unknown>>)
        .filter((tool) => tool?.type === 'function' && tool.function)
        .map((tool) => {
          const fn = tool.function as Record<string, unknown>
          return {
            type: 'function',
            name: fn.name,
            ...(fn.description === undefined ? {} : { description: fn.description }),
            ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
          }
        })
    : []

  const out: Record<string, unknown> = { model: clientBody.model, input, stream: true }
  const instructionText = instructions.join('\n\n')
  if (instructionText) out.instructions = instructionText
  if (tools.length > 0) {
    out.tools = tools
    // Zen's Responses gateway accepts `auto` only (see ensureResponsesFreeLaneShape).
    out.tool_choice = 'auto'
  }
  if (typeof clientBody.temperature === 'number') out.temperature = clientBody.temperature
  if (typeof clientBody.top_p === 'number') out.top_p = clientBody.top_p
  if (typeof clientBody.max_completion_tokens === 'number') {
    out.max_output_tokens = clientBody.max_completion_tokens
  } else if (typeof clientBody.max_tokens === 'number') {
    out.max_output_tokens = clientBody.max_tokens
  }
  if (clientBody.reasoning !== undefined) out.reasoning = clientBody.reasoning
  else if (typeof clientBody.reasoning_effort === 'string') {
    out.reasoning = { effort: clientBody.reasoning_effort }
  }
  return out
}

interface ChatToolCallOut {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Responses `output` items -> the chat message they are equivalent to. */
function responsesOutputToChat(output: unknown): {
  content: string
  reasoning: string
  toolCalls: ChatToolCallOut[]
} {
  let content = ''
  let reasoning = ''
  const toolCalls: ChatToolCallOut[] = []
  if (!Array.isArray(output)) return { content, reasoning, toolCalls }

  for (const raw of output) {
    const item = raw as Record<string, unknown>
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : []
      for (const rawPart of parts) {
        const part = rawPart as Record<string, unknown>
        if (part?.type === 'output_text' && typeof part.text === 'string') content += part.text
        else if (typeof part?.refusal === 'string') content += part.refusal
      }
    } else if (item.type === 'reasoning') {
      const parts = Array.isArray(item.summary)
        ? item.summary
        : Array.isArray(item.content)
          ? item.content
          : []
      for (const rawPart of parts) {
        const part = rawPart as Record<string, unknown>
        if (typeof part?.text === 'string') reasoning += part.text
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id:
          typeof item.call_id === 'string' && item.call_id
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        },
      })
    }
  }
  return { content, reasoning, toolCalls }
}

/** Responses usage -> chat usage (`input_tokens`/`output_tokens` are the names). */
function responsesUsageToChat(usage: unknown): ChatAggregate['usage'] {
  const u = (usage ?? {}) as Record<string, unknown>
  const prompt = typeof u.input_tokens === 'number' ? u.input_tokens : 0
  const completion = typeof u.output_tokens === 'number' ? u.output_tokens : 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : prompt + completion,
  }
}

/** The final Responses object -> one Chat Completions object. */
function responsesToChatCompletion(
  response: Record<string, unknown>,
  fallbackModel: string,
): ChatAggregate {
  const { content, reasoning, toolCalls } = responsesOutputToChat(response.output)
  const message: ChatAggregate['choices'][0]['message'] = {
    role: 'assistant',
    content: content || null,
  }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  let finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
  if (response.status === 'incomplete') finishReason = 'length'
  return {
    id:
      typeof response.id === 'string' && response.id
        ? response.id
        : `chatcmpl-${randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof response.model === 'string' ? response.model : fallbackModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: responsesUsageToChat(response.usage),
  }
}

interface ResponsesChatStreamState {
  id: string
  model: string
  created: number
  roleSent: boolean
  /** Responses output_index -> chat tool_calls index (function_call items only). */
  toolIndexes: Map<number, number>
  nextToolIndex: number
  /** True once any real payload (text/reasoning/tool call) has been emitted. */
  sawPayload: boolean
  finished: boolean
}

function newResponsesChatStreamState(model: string): ResponsesChatStreamState {
  return {
    id: `chatcmpl-${randomBytes(8).toString('hex')}`,
    model,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    toolIndexes: new Map(),
    nextToolIndex: 0,
    sawPayload: false,
    finished: false,
  }
}

function chatStreamChunk(
  state: ResponsesChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: ChatAggregate['usage'],
): string {
  const payload: Record<string, unknown> = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage) payload.usage = usage
  return `data: ${JSON.stringify(payload)}\n\n`
}

function reasoningStreamDelta(text: string): Record<string, unknown> {
  return REASONING_DUAL_WRITE
    ? { reasoning_content: text, reasoning: text }
    : { reasoning_content: text }
}

function failedEvent(type: string, message: string): string {
  return `event: ${type}\ndata: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`
}

/**
 * One Responses stream event -> zero or more Chat Completions chunks. Unknown
 * event types are ignored on purpose: the Responses protocol keeps growing and
 * an unrecognised event must never break an otherwise healthy stream.
 */
function responsesEventToChatChunks(
  event: Record<string, unknown>,
  state: ResponsesChatStreamState,
): string[] {
  const out: string[] = []
  const type = typeof event.type === 'string' ? event.type : ''
  const ensureRole = (): void => {
    if (state.roleSent) return
    state.roleSent = true
    out.push(chatStreamChunk(state, { role: 'assistant', content: '' }))
  }

  if (type === 'response.created' || type === 'response.in_progress') {
    const response = event.response as Record<string, unknown> | undefined
    if (response) {
      if (typeof response.id === 'string' && response.id) state.id = response.id
      if (typeof response.model === 'string' && response.model) state.model = response.model
    }
    ensureRole()
    return out
  }

  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    ensureRole()
    state.sawPayload = true
    out.push(chatStreamChunk(state, { content: event.delta }))
    return out
  }

  if (
    (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
    typeof event.delta === 'string'
  ) {
    ensureRole()
    state.sawPayload = true
    out.push(chatStreamChunk(state, reasoningStreamDelta(event.delta)))
    return out
  }

  if (type === 'response.output_item.added') {
    const item = event.item as Record<string, unknown> | undefined
    if (item?.type === 'function_call') {
      ensureRole()
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0
      const index = state.nextToolIndex++
      state.toolIndexes.set(outputIndex, index)
      state.sawPayload = true
      out.push(
        chatStreamChunk(state, {
          tool_calls: [
            {
              index,
              id:
                typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${index}`,
              type: 'function',
              function: { name: typeof item.name === 'string' ? item.name : '', arguments: '' },
            },
          ],
        }),
      )
    }
    return out
  }

  if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
    ensureRole()
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0
    const index = state.toolIndexes.get(outputIndex) ?? 0
    state.sawPayload = true
    out.push(
      chatStreamChunk(state, { tool_calls: [{ index, function: { arguments: event.delta } }] }),
    )
    return out
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = (event.response ?? {}) as Record<string, unknown>
    ensureRole()
    if (!state.sawPayload) {
      // No delta events arrived (or this gateway names them differently): fall
      // back to the aggregated final answer so the client still gets the text.
      const { content, reasoning, toolCalls } = responsesOutputToChat(response.output)
      if (content) {
        out.push(chatStreamChunk(state, { content }))
        state.sawPayload = true
      }
      if (reasoning) {
        out.push(chatStreamChunk(state, reasoningStreamDelta(reasoning)))
        state.sawPayload = true
      }
      if (toolCalls.length > 0) {
        out.push(
          chatStreamChunk(state, {
            tool_calls: toolCalls.map((call, index) => ({ index, ...call })),
          }),
        )
        state.sawPayload = true
      }
    }
    const finishReason =
      state.toolIndexes.size > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop'
    state.finished = true
    out.push(chatStreamChunk(state, {}, finishReason, responsesUsageToChat(response.usage)))
    out.push('data: [DONE]\n\n')
    return out
  }

  if (type === 'response.failed') {
    const response = (event.response ?? {}) as Record<string, unknown>
    const error = (response.error ?? {}) as Record<string, unknown>
    const message =
      typeof error.message === 'string' ? error.message : 'Responses upstream failed the request'
    state.finished = true
    out.push(failedEvent('error', message))
    out.push('data: [DONE]\n\n')
    return out
  }

  if (type === 'error') {
    const error = (event.error ?? event) as Record<string, unknown>
    const message = typeof error.message === 'string' ? error.message : 'Responses upstream error'
    state.finished = true
    out.push(failedEvent('error', message))
    out.push('data: [DONE]\n\n')
  }
  return out
}

/** SSE relay that rewrites a Responses stream into a chat.completion stream. */
async function relayResponsesAsChatStream(
  upstream: UpstreamResponse,
  res: ServerResponse,
  controller: AbortController,
  model: string,
  headersSent = false,
): Promise<void> {
  if (!headersSent) writeSseHead(res)
  const state = newResponsesChatStreamState(model)

  let firstEvent = true
  let idleTimer: NodeJS.Timeout | undefined
  let timedOut = false
  const t0 = Date.now()
  let ttfbLogged = false
  const decoder = new TextDecoder('utf-8')
  let pending = ''

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => {
        timedOut = true
        controller.abort()
      },
      firstEvent ? FIRST_EVENT_MS : BODY_IDLE_MS,
    )
    idleTimer.unref?.()
  }

  const write = async (data: string): Promise<boolean> => {
    if (res.destroyed || res.writableEnded) return false
    let flushed: boolean
    try {
      flushed = res.write(data)
    } catch {
      return false
    }
    if (!flushed) {
      await Promise.race([
        once(res, 'drain').then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), BODY_IDLE_MS)
          timer.unref?.()
        }),
      ])
    }
    return !res.destroyed && !res.writableEnded
  }

  /** Only `data:` lines matter: every Responses payload carries its own type. */
  const handleLine = async (line: string): Promise<boolean> => {
    if (!line.startsWith('data:')) return true
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return true
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return true
    }
    for (const chunk of responsesEventToChatChunks(event, state)) {
      if (!(await write(chunk))) return false
    }
    return true
  }

  armIdle()
  try {
    if (!upstream.body) throw new Error('upstream response has no body')
    for await (const raw of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (!ttfbLogged) {
        ttfbLogged = true
        stats.lastTtfbMs = Date.now() - t0
        console.log(`[upstream] ttfb=${Date.now() - t0}ms (responses->chat bridge)`)
      }
      firstEvent = false
      armIdle()
      pending += decoder.decode(raw, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (!(await handleLine(line))) {
          controller.abort()
          return
        }
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    for (const line of pending.split('\n')) {
      if (!(await handleLine(line.replace(/\r$/, '')))) break
    }
    if (!state.finished) {
      // Upstream ended without a terminal event: close the stream cleanly
      // rather than leaving the client waiting on a half-finished answer.
      await write(chatStreamChunk(state, {}, 'stop', responsesUsageToChat(undefined)))
      await write('data: [DONE]\n\n')
    }
    if (!res.writableEnded && !res.destroyed) res.end()
    console.log(`[upstream] stream total=${Date.now() - t0}ms (responses->chat bridge)`)
  } catch (err) {
    if (timedOut) {
      emitSseError(
        res,
        `stream watchdog fired (first event ${FIRST_EVENT_MS}ms / body idle ${BODY_IDLE_MS}ms)`,
      )
    } else if (!res.writableEnded && !res.destroyed) {
      const message = err instanceof Error ? err.message : String(err)
      emitSseError(res, `upstream stream broken: ${message}`)
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

/**
 * Serve a Chat Completions request for a Responses-only model: translate in,
 * call /v1/responses, translate back (streaming deltas or one aggregated JSON).
 */
async function handleChatViaResponses(
  req: IncomingMessage,
  res: ServerResponse,
  clientBody: Record<string, unknown>,
  model: string,
): Promise<void> {
  const wantsStream = clientBody.stream === true
  let upstreamBody: Record<string, unknown>
  try {
    upstreamBody = buildResponsesUpstreamBody(chatRequestToResponsesBody(clientBody))
  } catch (err) {
    apiError(res, 400, err instanceof Error ? err.message : 'invalid request body')
    return
  }

  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  req.on('close', onClose)

  const earlyHead = wantsStream && EARLY_SSE_HEADERS
  if (earlyHead) writeSseHead(res)
  const fail = (
    status: number,
    message: string,
    type: string,
    headers?: Record<string, string>,
  ): void => {
    if (earlyHead) emitSseError(res, message, type)
    else apiError(res, status, message, type, headers)
  }

  const tReq = Date.now()
  let upstream: UpstreamResponse
  try {
    upstream = await zenFetch(
      ZEN_RESPONSES_URL,
      upstreamBody,
      responsesSeedMessages(upstreamBody.input),
      controller.signal,
    )
  } catch (err) {
    const described = upstreamUnreachable(err)
    fail(described.status, described.message, described.type, described.headers)
    req.off('close', onClose)
    return
  }
  stats.lastConnectMs = Date.now() - tReq
  stats.lastUpstreamStatus = upstream.status
  console.log(
    `[upstream] connect=${stats.lastConnectMs}ms (tls=${upstream.timings.tlsMs ?? '-'}ms waitHeaders=${upstream.timings.headersMs}ms)`,
  )
  try {
    if (!upstream.ok) {
      if (earlyHead) {
        const text = await upstream.text().catch(() => '')
        const described = describeUpstreamError(upstream, text)
        stats.lastUpstreamError = described.message
        emitSseError(res, described.message, described.type)
        return
      }
      await relayUpstreamError(upstream, res, model)
      return
    }
    stats.lastUpstreamError = ''
    catalog.reportModelUsable(model)
    if (wantsStream) {
      await relayResponsesAsChatStream(upstream, res, controller, model, earlyHead)
      return
    }
    const sse = await readSse(upstream, controller)
    let final: Record<string, unknown> | undefined
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const event = JSON.parse(data) as Record<string, unknown>
        if (
          (event.type === 'response.completed' || event.type === 'response.incomplete') &&
          event.response &&
          typeof event.response === 'object'
        ) {
          final = event.response as Record<string, unknown>
        }
        if (event.type === 'response.failed') {
          apiError(res, 502, 'Responses upstream reported a failed response', 'upstream_error')
          return
        }
      } catch {
        // skip malformed lines
      }
    }
    if (!final) {
      apiError(res, 502, 'upstream produced no response.completed event', 'upstream_error')
      return
    }
    sendJson(res, 200, responsesToChatCompletion(final, model))
  } finally {
    req.off('close', onClose)
  }
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (err) {
    apiError(res, 413, err instanceof Error ? err.message : 'request body too large', 'payload_too_large', {
      connection: 'close',
    })
    return
  }
  let clientBody: Record<string, unknown>
  try {
    clientBody = JSON.parse(raw) as Record<string, unknown>
  } catch {
    apiError(res, 400, 'request body is not valid JSON')
    return
  }
  const model = typeof clientBody.model === 'string' ? clientBody.model : ''
  if (!model) {
    apiError(res, 400, 'missing required parameter: model')
    return
  }
  const exposure = modelExposureError(model)
  if (exposure) {
    apiError(res, 404, exposure, 'model_not_found')
    return
  }

  const wantsStream = clientBody.stream === true
  let upstreamBody: Record<string, unknown>
  try {
    upstreamBody = buildResponsesUpstreamBody(clientBody)
  } catch (err) {
    apiError(res, 400, err instanceof Error ? err.message : 'invalid request body')
    return
  }
  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  req.on('close', onClose)

  const earlyHead = wantsStream && EARLY_SSE_HEADERS
  if (earlyHead) writeSseHead(res)
  const fail = (status: number, message: string, type: string, headers?: Record<string, string>): void => {
    if (earlyHead) emitSseError(res, message, type)
    else apiError(res, status, message, type, headers)
  }

  const tReq = Date.now()
  let upstream: UpstreamResponse
  try {
    // Session identity for the Responses path: without it every call arrived
    // under a fresh random session (the chat path derives one from the first
    // user turn), so the upstream never saw a stable conversation — no prompt
    // cache affinity and a body shape no CLI would ever produce.
    upstream = await zenFetch(
      ZEN_RESPONSES_URL,
      upstreamBody,
      responsesSeedMessages(clientBody.input),
      controller.signal,
    )
  } catch (err) {
    const described = upstreamUnreachable(err)
    fail(described.status, described.message, described.type, described.headers)
    req.off('close', onClose)
    return
  }
  stats.lastConnectMs = Date.now() - tReq
  stats.lastUpstreamStatus = upstream.status
  console.log(
    `[upstream] connect=${stats.lastConnectMs}ms (tls=${upstream.timings.tlsMs ?? '-'}ms waitHeaders=${upstream.timings.headersMs}ms)`,
  )
  try {
    if (!upstream.ok) {
      if (earlyHead) {
        const text = await upstream.text().catch(() => '')
        const described = describeUpstreamError(upstream, text)
        stats.lastUpstreamError = described.message
        emitSseError(res, described.message, described.type)
        return
      }
      await relayUpstreamError(upstream, res, model)
      return
    }
    stats.lastUpstreamError = ''
    catalog.reportModelUsable(model)
    if (wantsStream) {
      await relayStream(upstream, res, controller, earlyHead)
      return
    }
    const sse = await readSse(upstream, controller)
    // The final response.completed event carries the full response object.
    let final: Record<string, unknown> | undefined
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const event = JSON.parse(data) as Record<string, unknown>
        if (event.type === 'response.completed' && event.response && typeof event.response === 'object') {
          final = event.response as Record<string, unknown>
        }
        if (event.type === 'response.failed') {
          apiError(res, 502, 'Responses upstream reported a failed response', 'upstream_error')
          return
        }
      } catch {
        // skip malformed lines
      }
    }
    if (final) {
      sendJson(res, 200, final)
    } else {
      apiError(res, 502, 'upstream produced no response.completed event', 'upstream_error')
    }
  } finally {
    req.off('close', onClose)
  }
}

function handleHealth(res: ServerResponse, snapshot: CatalogSnapshot): void {
  sendJson(res, 200, {
    status: 'ok',
    service: 'opencode2dsh-railway',
    uptimeSeconds: Math.floor(process.uptime()),
    // Never a key itself — only which lane (and how many keys) is configured.
    upstreamAuth: keyPool.mode,
    ...(keyPool.size > 0 ? { pool: keyPool.snapshot() } : {}),
    // Which route the upstream calls actually take. The proxy address itself is
    // deliberately absent from this public endpoint (the status file and the
    // logs carry it) — a leaked proxy endpoint invites exactly the abuse the
    // abuse gate already suspects.
    egress: {
      mode: proxyPool !== null ? 'pool' : egress.proxy === null ? 'direct' : 'fixed',
      ...(proxyPool !== null
        ? { pool: proxyPool.snapshot(false) }
        : {
            proxy: egress.proxy === null ? null : {
              protocol: egress.proxy.protocol,
              authenticated: egress.proxy.username !== undefined,
              source: egress.proxy.source,
              appliesToUpstream: proxyAppliesToUpstream(),
            },
            // A misconfigured value is flagged here but never echoed: the startup
            // log and the status file carry the (redacted) message.
            ...(egress.error === null ? {} : { proxyConfigError: true }),
          }),
      tunnels: { ok: proxyTunnels.ok, failed: proxyTunnels.failed },
    },
    inflight: stats.inflight,
    requests: stats.requests,
    lastRequestAt: stats.lastRequestAt || null,
    upstream: {
      status: stats.lastUpstreamStatus || null,
      connectMs: stats.lastConnectMs || null,
      ttfbMs: stats.lastTtfbMs || null,
      error: stats.lastUpstreamError || null,
    },
    catalog: { ...snapshot, lastError: catalog.lastError || null },
    zenBaseUrl: ZEN_BASE_URL,
  })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    })
    res.end()
    return
  }

  if (path === '/health' || path === '/healthz') {
    handleHealth(res, catalog.snapshot())
    return
  }

  if (!authorized(req)) {
    apiError(res, 401, 'invalid or missing API key (Authorization: Bearer <API_KEY>)', 'authentication_error')
    return
  }

  if (req.method === 'GET' && path === '/v1/models') {
    handleModels(res)
    return
  }
  const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(path)
  if (req.method === 'GET' && modelMatch) {
    handleModel(res, decodeURIComponent(modelMatch[1]))
    return
  }
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    await handleChatCompletion(req, res)
    return
  }
  if (req.method === 'POST' && path === '/v1/responses') {
    await handleResponses(req, res)
    return
  }

  apiError(res, 404, `unknown route: ${req.method} ${path}`, 'not_found')
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * A gateway must not die because a single client vanished mid-response: an
 * 'error' event with no listener is thrown by EventEmitter, and unhandled
 * promise rejections otherwise take the process down too. Railway then reports
 * it as a random restart with nothing in the logs. Log, count, stay up.
 */
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException (kept alive):', err))
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection (kept alive):', reason))

/** Persist a health snapshot (same idea as the plugin's adapter-status.json). */
async function writeStatusFile(): Promise<void> {
  try {
    const snap = catalog.snapshot()
    await mkdir(dirname(STATUS_PATH), { recursive: true })
    const payload = {
      status: snap.status,
      total: snap.total,
      exposed: snap.exposed,
      lastRefresh: snap.lastRefresh ?? null,
      lastError: catalog.lastError || '',
      inflight: stats.inflight,
      requests: stats.requests,
      ...(keyPool.size > 0 ? { pool: keyPool.snapshot() } : {}),
      // The private snapshot may name the proxy (host:port only, credentials
      // never leave memory) — it stays on the deployment's own disk.
      egress: {
        mode: proxyPool !== null ? 'pool' : egress.proxy === null ? 'direct' : 'fixed',
        ...(proxyPool !== null
          ? { pool: proxyPool.snapshot(true) }
          : {
              proxy: egress.proxy === null ? null : maskProxy(egress.proxy),
              source: egress.source,
              appliesToUpstream: proxyAppliesToUpstream(),
              error: egress.error,
            }),
        tunnels: { ok: proxyTunnels.ok, failed: proxyTunnels.failed },
      },
      upstream: {
        status: stats.lastUpstreamStatus,
        connectMs: stats.lastConnectMs,
        ttfbMs: stats.lastTtfbMs,
        error: stats.lastUpstreamError,
      },
      writtenAt: new Date().toISOString(),
    }
    const tmp = `${STATUS_PATH}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, STATUS_PATH)
  } catch (err) {
    console.warn(`[status] cannot write ${STATUS_PATH}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

let statusWriteChain = Promise.resolve()
let lastStatusWriteAt = 0

/**
 * Throttled status snapshot: fresh enough for post-mortems without paying a
 * file write on every request. force=true bypasses the interval (catalog
 * refresh, shutdown). Writes are serialized so two callers can never race on
 * the same temp path.
 */
function scheduleStatusWrite(force = false): void {
  const now = Date.now()
  if (!force && now - lastStatusWriteAt < STATUS_WRITE_INTERVAL_MS) return
  lastStatusWriteAt = now
  statusWriteChain = statusWriteChain.then(writeStatusFile)
}

const server = createServer((req, res) => {
  // Client-side socket errors are business as usual for a long-lived SSE
  // proxy; without these listeners they become uncaught exceptions.
  req.on('error', () => {})
  res.on('error', () => {})
  const started = Date.now()
  const path = req.url ?? '/'
  stats.inflight += 1
  stats.requests += 1
  stats.lastRequestAt = new Date().toISOString()
  handle(req, res)
    .catch((err) => {
      if (!res.writableEnded) {
        const message = err instanceof Error ? err.message : String(err)
        apiError(res, 500, `internal error: ${message}`, 'server_error')
      }
      console.error(`[error] ${req.method} ${path}:`, err)
    })
    .finally(() => {
      stats.inflight -= 1
      scheduleStatusWrite()
      console.log(`[req] ${req.method} ${path} -> ${res.statusCode} ${Date.now() - started}ms`)
    })
})
// Nagle off: SSE deltas are small and latency-sensitive.
server.on('connection', (socket) => socket.setNoDelay(true))

catalog.start().catch((err) => {
  console.error('[catalog] start failed:', err)
})

/**
 * Warm (and keep warm) the upstream TLS pool. A pooled socket is free, but
 * the peer reaps idle connections after a few minutes — which is exactly the
 * "first request after a pause costs DNS+TCP+TLS" spike. A cheap GET every
 * POOL_WARM_INTERVAL_MS keeps one hot socket in the pool; the very first call
 * also pre-warms before any chat arrives.
 */
let poolWarmed = false
function warmUpstreamPool(): void {
  let agent: https.Agent
  try {
    agent = upstreamAgentFor(UPSTREAM_HOST, false)
  } catch {
    return // pool mode before the first clean exit: nothing to warm yet
  }
  https
    .get(
      `${ZEN_BASE_URL}/v1/models`,
      { agent, lookup: cachedLookup, headers: { authorization: keyPool.warmAuth(), 'x-opencode-client': 'cli' } },
      (r) => {
        r.resume()
        r.on('end', () => {
          if (!poolWarmed) {
            poolWarmed = true
            console.log('[upstream] connection pool warmed')
          }
        })
      },
    )
    .on('error', (err) => console.warn(`[upstream] pool warm-up failed: ${err.message}`))
}

const warmTimer = setInterval(warmUpstreamPool, POOL_WARM_INTERVAL_MS)
warmTimer.unref?.()

server.listen(PORT, () => {
  console.log(`[opencode2dsh-railway] listening on :${PORT}`)
  console.log(`[opencode2dsh-railway] upstream: ${ZEN_BASE_URL}`)
  if (proxyPool !== null) {
    console.log(
      `[proxy-pool] auto egress: scanning ${proxyPool.sources.length} public list(s) for clean exits ` +
        `(target=${PROXY_POOL_TARGET}, refresh=${Math.round(PROXY_POOL_REFRESH_MS / 1000)}s, ` +
        `attempts/request=${PROXY_POOL_ATTEMPTS}, probe=${PROXY_POOL_PROBE_MODEL})`,
    )
    if (egress.proxy !== null) {
      console.log(`[proxy-pool] note: UPSTREAM_PROXY (${maskProxy(egress.proxy)}) is ignored while auto mode is on`)
    }
    proxyPool.start()
  } else if (egress.error !== null) {
    console.warn(`[proxy] ${egress.error} — continuing with a direct upstream connection`)
  } else if (egress.proxy === null) {
    console.log('[proxy] upstream egress: direct (set UPSTREAM_PROXY / HTTPS_PROXY / ALL_PROXY to route it through a clean exit)')
  } else if (proxyAppliesToUpstream()) {
    console.log(`[proxy] upstream egress: ${maskProxy(egress.proxy)} via ${egress.proxy.source}`)
  } else {
    console.warn(
      `[proxy] ${egress.proxy.source}=${maskProxy(egress.proxy)} is configured but NO_PROXY exempts ${UPSTREAM_HOST} — upstream traffic stays direct`,
    )
  }
  if (keyPool.size === 0) {
    console.log(
      '[opencode2dsh-railway] upstream auth: anonymous free lane "Bearer public" - ' +
        'rejected with 403 FreeTierError since 2026-10-14. Set ZEN_ACCESS_TOKEN ' +
        'to the OpenCode account session token (st_...) to use the free models.',
    )
  } else {
    const fingerprints = ZEN_API_KEYS.map(maskKey).join(', ')
    console.log(
      `[opencode2dsh-railway] upstream auth: ${keyPool.mode} ` +
        `(${keyPool.size} credential${keyPool.size === 1 ? '' : 's'}: ${fingerprints})`,
    )
    if (ZEN_ACCESS_TOKEN === '' && ZEN_API_KEYS.length > 0) {
      console.log(
        '[opencode2dsh-railway] note: only oc_sk_ keys configured - the free models ' +
          'answer 403 "Workspace access denied" for them; ZEN_ACCESS_TOKEN is required there.',
      )
    }
    console.log(
      `[opencode2dsh-railway] key pool: sticky=session-hash, cooldown=${KEY_COOLDOWN_MS}ms, ` +
        `failover=${KEY_POOL_FAILOVER ? 'on' : 'off'}, anonymous-fallback=${KEY_POOL_ANONYMOUS ? 'on' : 'off'}`,
    )
  }
  console.log(`[opencode2dsh-railway] auth: ${process.env.API_KEY ? 'API_KEY from env' : 'generated one-time key (see warning above)'}`)
  warmUpstreamPool()
})

function shutdown(signal: string): void {
  console.log(`[opencode2dsh-railway] ${signal} — draining ${stats.inflight} in-flight request(s)`)
  catalog.stop()
  clearInterval(warmTimer)
  proxyPool?.stop()
  scheduleStatusWrite(true)
  void statusWriteChain
  server.close(() => process.exit(0))
  // Idle keep-alive sockets would otherwise hold server.close() open; running
  // streams get SHUTDOWN_DRAIN_MS to finish before everything is cut.
  server.closeIdleConnections?.()
  const force = setTimeout(() => {
    server.closeAllConnections?.()
    upstreamAgent.destroy()
    freshAgent.destroy()
    proxiedAgents?.pooled.destroy()
    proxiedAgents?.fresh.destroy()
    process.exit(0)
  }, SHUTDOWN_DRAIN_MS)
  force.unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
