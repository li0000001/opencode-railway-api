/**
 * Free-proxy auto pool — the gateway's self-healing egress for the Zen free lane.
 *
 * Why: the free-lane gate weighs the *requesting* IP, and shared cloud egress
 * (Render/Railway/AWS) is refused outright. A single `UPSTREAM_PROXY` fixes that
 * only until that exit dies or gets flagged. This module keeps a small stock of
 * validated public proxies alive instead:
 *
 *   1. pull candidate lists from a handful of public sources (GitHub raw lists,
 *      proxyscrape, geonode),
 *   2. cheap TCP pre-filter, then a real probe — one shaped free-lane request
 *      (`Bearer public`) through the candidate to the Zen API,
 *   3. keep only the exits that answer 200; 429 marks a temporary quota
 *      cooldown, the abuse 403 marks the IP dead,
 *   4. rotate the moment real client traffic reports an exit as bad, and
 *      rescan in the background when the stock runs low.
 *
 * The probe is the only trustworthy signal: exit-IP reputation cannot be
 * inferred from the proxy's location, ASN or latency. A live chat request is
 * the same check the client would hit, so what passes here is what works.
 *
 * Like the fixed-proxy mode, the pool is a hard requirement once enabled: an
 * empty pool surfaces as an error (mapped to 503 by the server), never as a
 * silent direct connection — the direct route is exactly the flagged one this
 * feature exists to avoid.
 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { request as httpsRequest, type Agent as HttpsAgent } from 'node:https'
import { connect as netConnect } from 'node:net'

import { createTunnelAgent, parseProxyUrl, type TunnelEvent, type UpstreamProxy } from './proxy.ts'
import { deriveRequestIDs, disguiseHeaders } from './adapter/ids.ts'
import { ensureFreeLaneShape } from './adapter/messages.ts'

// ---------------------------------------------------------------------------
// Candidate lists
// ---------------------------------------------------------------------------

export interface ProxyPoolSource {
  url: string
  /** Protocol assumed for plain `host:port` lines of this source. */
  protocol: UpstreamProxy['protocol']
  /** `geonode` rows carry their own protocol list; `text` is `ip:port`/URLs. */
  format?: 'text' | 'geonode'
}

/**
 * Default public sources. Deliberately several independent lists: any single
 * one dries up or rots within days, and the useful rate is ~1 clean exit per
 * 60–100 candidates, so volume is what keeps the pool stocked.
 */
export const DEFAULT_PROXY_SOURCES: ProxyPoolSource[] = [
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', protocol: 'http' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt', protocol: 'http' },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt', protocol: 'http' },
  { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt', protocol: 'socks5' },
  { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt', protocol: 'http' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text', protocol: 'socks5' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text', protocol: 'http' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=socks5', protocol: 'socks5' },
  { url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5%2Chttp', protocol: 'socks5', format: 'geonode' },
]

export interface ProxyPoolCandidate {
  protocol: UpstreamProxy['protocol']
  host: string
  port: number
  username?: string
  password?: string
}

export function proxyKey(candidate: ProxyPoolCandidate): string {
  return `${candidate.protocol}://${candidate.host}:${candidate.port}`
}

/** Parse one list line: `ip:port`, `scheme://user:pass@host:port`, `host:port`. */
export function parseProxyCandidate(line: string, defaultProtocol: UpstreamProxy['protocol']): ProxyPoolCandidate | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `${defaultProtocol}://${trimmed}`
  let proxy: UpstreamProxy
  try {
    proxy = parseProxyUrl(withScheme, 'proxy-list')
  } catch {
    return null
  }
  if (proxy.username === undefined) return { protocol: proxy.protocol, host: proxy.host, port: proxy.port }
  return { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
}

export function parseProxyLines(text: string, defaultProtocol: UpstreamProxy['protocol'], limit = 150): ProxyPoolCandidate[] {
  const out: ProxyPoolCandidate[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (out.length >= limit) break
    const candidate = parseProxyCandidate(line, defaultProtocol)
    if (candidate === null) continue
    const key = proxyKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

// ---------------------------------------------------------------------------
// Probe: the only trustworthy signal
// ---------------------------------------------------------------------------

export interface ProbeResult {
  /** HTTP status from the Zen API; 0 = the tunnel itself failed. */
  status: number
  text: string
  latencyMs: number
  error?: string
}

export interface ProxyVerdict {
  status: 'clean' | 'cooling' | 'dead'
  reason: string
}

/** 403 reached with the shaped request → the exit IP works and is not flagged. */
export function classifyProbeResult(result: ProbeResult): ProxyVerdict {
  if (result.status >= 200 && result.status < 300) return { status: 'clean', reason: `HTTP ${result.status}` }
  if (result.status === 429) return { status: 'cooling', reason: 'exit quota exhausted (429)' }
  if (result.status === 403 && /abusive traffic/i.test(result.text)) return { status: 'dead', reason: 'IP flagged by the abuse gate (403)' }
  if (result.status === 407) return { status: 'dead', reason: 'proxy demands authentication (407)' }
  if (result.status === 0) return { status: 'dead', reason: result.error ?? 'tunnel unreachable' }
  return { status: 'dead', reason: `HTTP ${result.status}` }
}

/**
 * A real client response says the same thing as a probe: 429 = this exit's
 * quota is spent (rotate, it may recover), the abuse 403 = this IP is on the
 * list (dead for this cycle). Anything else (400/401/403-shape) is about the
 * request, not the exit.
 */
export function proxyRotationReason(status: number, text: string): string | null {
  if (status === 429) return 'free-tier quota on this exit (429)'
  if (status === 403 && /abusive traffic/i.test(text)) return 'exit IP flagged by the abuse gate (403)'
  return null
}

export interface ZenProbeOptions {
  zenBaseUrl: string
  model: string
  connectTimeoutMs: number
  timeoutMs: number
  /** Forwarded tunnel telemetry (server.ts counts/logs these). */
  onTunnel?: (event: TunnelEvent) => void
}

/**
 * One shaped free-lane chat through the candidate, `Bearer public` so no user
 * credential is involved. The response body is capped: only the first chunk of
 * the error JSON / SSE prefix matters for classification.
 */
export function createZenProbe(options: ZenProbeOptions): (proxy: UpstreamProxy) => Promise<ProbeResult> {
  const url = new URL(`${options.zenBaseUrl}/v1/chat/completions`)
  return async function probe(proxy: UpstreamProxy): Promise<ProbeResult> {
    const t0 = Date.now()
    const agent = createTunnelAgent(proxy, {
      keepAlive: false,
      maxSockets: 1,
      connectTimeoutMs: options.connectTimeoutMs,
      onTunnel: options.onTunnel,
    })
    const ids = deriveRequestIDs([{ role: 'user', content: `pool-${randomBytes(6).toString('hex')}` }])
    const body = JSON.stringify(ensureFreeLaneShape({ model: options.model, messages: [{ role: 'user', content: 'hi' }], stream: true }))
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false
      const finish = (result: ProbeResult): void => {
        if (settled) return
        settled = true
        agent.destroy()
        resolve(result)
      }
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port.length > 0 ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          agent,
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            authorization: 'Bearer public',
            'content-length': String(Buffer.byteLength(body)),
            ...disguiseHeaders(ids),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            if (size >= 16 * 1024) return
            chunks.push(chunk)
            size += chunk.length
          })
          res.on('end', () => finish({ status, text: Buffer.concat(chunks).toString('utf8'), latencyMs: Date.now() - t0 }))
          res.on('error', (err) => finish({ status, text: '', latencyMs: Date.now() - t0, error: err.message }))
        },
      )
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`probe timed out after ${options.timeoutMs}ms`)))
      req.on('error', (err) => finish({ status: 0, text: '', latencyMs: Date.now() - t0, error: err.message }))
      req.end(body)
    })
  }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export interface ProxyPoolEntry extends ProxyPoolCandidate {
  key: string
  /** `socks5://host:port` — never carries credentials. */
  masked: string
  /** `pending` only while a probe is in flight; the snapshot shows it as such. */
  status: 'clean' | 'cooling' | 'dead' | 'pending'
  latencyMs: number
  lastStatus: number
  lastError: string
  checkedAt: number
  coolingUntil: number
  failures: number
  lastUsedAt: number
}

export interface ProxyPoolOptions {
  sources?: ProxyPoolSource[]
  seed?: string[]
  /** How many clean exits to keep at hand (rotation spares). */
  targetSize?: number
  /** Probe budget for one refresh that has to find new exits. */
  maxProbe?: number
  refreshMs?: number
  connectTimeoutMs?: number
  probeTimeoutMs?: number
  /** Concurrent probes / list fetches. */
  concurrency?: number
  /** 429 cooldown before an exit is tried again. */
  coolingMs?: number
  /** DNS lookup override for tunnel agents (server.ts's cache). */
  lookup?: unknown
  /** Cheap TCP liveness pre-filter (tests inject a stub). */
  liveness?: (host: string, port: number) => Promise<boolean>
  onTunnel?: (event: TunnelEvent) => void
  probe: (proxy: UpstreamProxy, candidate: ProxyPoolEntry) => Promise<ProbeResult>
  fetchText?: (url: string) => Promise<string>
  log?: (line: string) => void
}

export interface ProxyPoolSnapshot {
  mode: 'pool'
  targetSize: number
  clean: number
  cooling: number
  dead: number
  /** Probe verdicts still in flight during a scan. */
  pending: number
  tracked: number
  probesLastRefresh: number
  refreshSecondsAgo: number | null
  refreshMs: number
  sources: number
  lastError: string
  /** Only for the status file — never the public /health. */
  current?: string | null
}

/**
 * Free exits die by the minute (a live smoke lost both clean candidates within
 * ~30s), so the stock is deliberately a handful deep and probes are short:
 * an exit that cannot answer a chat in 15s is not worth waiting for.
 */
const DEFAULT_TARGET = 5
const DEFAULT_MAX_PROBE = 120
const DEFAULT_REFRESH_MS = 600_000
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000
const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const DEFAULT_CONCURRENCY = 16
const DEFAULT_COOLING_MS = 120_000
const TCP_PROBE_TIMEOUT_MS = 1_500
const TCP_PROBE_CONCURRENCY = 32
const MAX_PER_SOURCE = 150
const MAX_TRACKED_ENTRIES = 512
/** While the pool is empty the loop rescans fast; a partial stock waits longer. */
const EMPTY_POOL_RETRY_MS = 60_000
const LOW_POOL_RETRY_MS = 180_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export class ProxyPool {
  readonly #options: Required<Pick<ProxyPoolOptions, 'targetSize' | 'maxProbe' | 'refreshMs' | 'connectTimeoutMs' | 'probeTimeoutMs' | 'concurrency' | 'coolingMs'>> & ProxyPoolOptions
  #entries = new Map<string, ProxyPoolEntry>()
  #agents = new Map<string, HttpsAgent>()
  #current: string | null = null
  #seed: ProxyPoolCandidate[] = []
  #refreshing: Promise<ProxyPoolRefresh> | null = null
  #stopped = false
  #lastRefreshAt = 0
  #lastRefreshMs = 0
  #lastProbes = 0
  #lastError = ''

  constructor(options: ProxyPoolOptions) {
    this.#options = {
      ...options,
      targetSize: options.targetSize ?? DEFAULT_TARGET,
      maxProbe: options.maxProbe ?? DEFAULT_MAX_PROBE,
      refreshMs: options.refreshMs ?? DEFAULT_REFRESH_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      coolingMs: options.coolingMs ?? DEFAULT_COOLING_MS,
    }
    const seedProtocol: UpstreamProxy['protocol'] = 'socks5'
    for (const line of options.seed ?? []) {
      const candidate = parseProxyCandidate(line, seedProtocol)
      if (candidate !== null) this.#seed.push(candidate)
    }
  }

  get sources(): ProxyPoolSource[] {
    return this.#options.sources ?? DEFAULT_PROXY_SOURCES
  }

  /** Kick the background refresh loop (idempotent). */
  start(): void {
    this.#stopped = false
    void this.#loop()
  }

  stop(): void {
    this.#stopped = true
    for (const agent of this.#agents.values()) agent.destroy()
    this.#agents.clear()
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.refreshNow()
      } catch (err) {
        this.#lastError = err instanceof Error ? err.message : String(err)
        this.#log(`[proxy-pool] refresh failed: ${this.#lastError}`)
      }
      const clean = this.count('clean')
      const wait =
        clean === 0
          ? EMPTY_POOL_RETRY_MS
          : clean < this.#options.targetSize
            ? Math.min(this.#options.refreshMs, LOW_POOL_RETRY_MS)
            : this.#options.refreshMs
      await sleep(wait)
    }
  }

  hasClean(): boolean {
    return this.count('clean') > 0
  }

  count(status: ProxyPoolEntry['status']): number {
    let n = 0
    for (const entry of this.#entries.values()) if (entry.status === status) n += 1
    return n
  }

  /**
   * The exit client traffic should use: sticky while it stays clean (keeps the
   * TLS pool warm and the exit's quota pattern stable), otherwise the
   * lowest-latency ready spare.
   */
  current(): ProxyPoolEntry | null {
    if (this.#current !== null) {
      const entry = this.#entries.get(this.#current)
      if (entry !== undefined && entry.status === 'clean') {
        entry.lastUsedAt = Date.now()
        return entry
      }
      this.#current = null
    }
    let best: ProxyPoolEntry | null = null
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'clean') continue
      if (best === null || entry.latencyMs < best.latencyMs) best = entry
    }
    if (best !== null) {
      this.#current = best.key
      best.lastUsedAt = Date.now()
    }
    return best
  }

  /** Current exit plus its pooled/fresh tunnel agents (created on demand). */
  lease(): { entry: ProxyPoolEntry; pooled: HttpsAgent; fresh: HttpsAgent } | null {
    const entry = this.current()
    if (entry === null) return null
    return { entry, pooled: this.#agentFor(entry, false), fresh: this.#agentFor(entry, true) }
  }

  #agentFor(entry: ProxyPoolEntry, fresh: boolean): HttpsAgent {
    const key = `${entry.key}|${fresh ? 'fresh' : 'pooled'}`
    let agent = this.#agents.get(key)
    if (agent === undefined) {
      agent = createTunnelAgent(this.#toProxy(entry), {
        keepAlive: !fresh,
        maxSockets: 64,
        maxFreeSockets: 2,
        keepAliveMsecs: 30_000,
        connectTimeoutMs: this.#options.connectTimeoutMs,
        lookup: this.#options.lookup,
        onTunnel: this.#options.onTunnel,
      })
      this.#agents.set(key, agent)
    }
    return agent
  }

  #toProxy(entry: ProxyPoolEntry): UpstreamProxy {
    return {
      protocol: entry.protocol,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      password: entry.password,
      source: 'PROXY_POOL',
      masked: entry.masked,
    }
  }

  // --- feedback from real traffic ------------------------------------------

  reportSuccess(entry: ProxyPoolEntry | null): void {
    if (entry === null) return
    entry.status = 'clean'
    entry.failures = 0
    entry.lastError = ''
    entry.checkedAt = Date.now()
  }

  reportStatus(entry: ProxyPoolEntry | null, status: number, text: string): void {
    if (entry === null) return
    entry.lastStatus = status
    entry.checkedAt = Date.now()
    if (status >= 200 && status < 300) {
      this.reportSuccess(entry)
      return
    }
    if (status === 429) {
      entry.status = 'cooling'
      entry.coolingUntil = Date.now() + this.#options.coolingMs
      entry.lastError = 'exit quota exhausted (429)'
      this.#retire(entry)
      return
    }
    if (status === 403 && /abusive traffic/i.test(text)) {
      entry.status = 'dead'
      entry.lastError = 'exit IP flagged by the abuse gate (403)'
      this.#retire(entry)
      return
    }
    // Anything else (400/401/403-shape/5xx) is not this exit's fault; only a
    // streak of hard failures retires it.
    if (status >= 500) {
      entry.failures += 1
      if (entry.failures >= 3) {
        entry.status = 'cooling'
        entry.coolingUntil = Date.now() + this.#options.coolingMs
        entry.lastError = `HTTP ${status} x${entry.failures}`
        this.#retire(entry)
      }
    }
  }

  reportError(entry: ProxyPoolEntry | null, err: unknown): void {
    if (entry === null) return
    entry.lastStatus = 0
    entry.lastError = err instanceof Error ? err.message : String(err)
    entry.checkedAt = Date.now()
    entry.failures += 1
    if (entry.failures >= 2) {
      entry.status = 'cooling'
      entry.coolingUntil = Date.now() + this.#options.coolingMs
      this.#retire(entry)
    }
  }

  /** Drop the current exit after a bad report so the next pick is a spare. */
  #retire(entry: ProxyPoolEntry): void {
    if (this.#current === entry.key) this.#current = null
    this.#log(`[proxy-pool] retired ${entry.masked}: ${entry.lastError}`)
    this.#kickRefreshIfLow()
  }

  /**
   * A retirement that dips the stock below target must not wait for the next
   * loop tick: the running scan is reused (refreshes are serialized), a fresh
   * one starts in the background otherwise. Failures here only mean the
   * already-logged problem persists — never surfaced as an unhandled rejection.
   */
  #kickRefreshIfLow(): void {
    if (this.count('clean') >= this.#options.targetSize) return
    void this.refreshNow().catch((err: unknown) => {
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#log(`[proxy-pool] rescan failed: ${this.#lastError}`)
    })
  }

  // --- refresh --------------------------------------------------------------

  async refreshNow(): Promise<ProxyPoolRefresh> {
    if (this.#refreshing !== null) return await this.#refreshing
    const run = this.#refreshOnce().finally(() => {
      this.#refreshing = null
    })
    this.#refreshing = run
    return await run
  }

  async #refreshOnce(): Promise<ProxyPoolRefresh> {
    const t0 = Date.now()
    this.#lastError = ''
    let probes = 0
    let clean = this.count('clean')

    if (clean < this.#options.targetSize && this.#seed.length > 0) {
      const untried = this.#seed.filter((candidate) => !this.#entries.has(proxyKey(candidate)))
      probes += await this.#probeCandidates(untried.slice(0, this.#options.targetSize * 2))
      clean = this.count('clean')
    }

    if (clean >= this.#options.targetSize) {
      // Healthy: spend nothing. Real traffic drives the retirement decisions.
      const summary = this.#finishRefresh(t0, probes, 0, 0)
      return summary
    }

    // Give cooling exits that served time another chance before hunting.
    const expired = [...this.#entries.values()].filter((e) => e.status === 'cooling' && e.coolingUntil <= Date.now())
    if (expired.length > 0) {
      probes += await this.#probeEntries(expired.slice(0, 2))
      clean = this.count('clean')
    }

    let sourcesOk = 0
    let sourcesFailed = 0
    if (clean < this.#options.targetSize) {
      const collected = await this.#collectCandidates()
      sourcesOk = collected.sourcesOk
      sourcesFailed = collected.sourcesFailed
      const fresh = collected.candidates.filter((candidate) => !this.#entries.has(proxyKey(candidate)))
      const alive = await tcpFilter(fresh, TCP_PROBE_TIMEOUT_MS, TCP_PROBE_CONCURRENCY, this.#options.liveness)
      const budget = Math.max(0, this.#options.maxProbe - probes)
      probes += await this.#probeCandidates(alive.slice(0, budget))
    }

    this.#prune()
    return this.#finishRefresh(t0, probes, sourcesOk, sourcesFailed)
  }

  #finishRefresh(t0: number, probes: number, sourcesOk: number, sourcesFailed: number): ProxyPoolRefresh {
    this.#lastRefreshAt = Date.now()
    this.#lastRefreshMs = this.#lastRefreshAt - t0
    this.#lastProbes = probes
    const summary: ProxyPoolRefresh = {
      candidates: this.#entries.size,
      clean: this.count('clean'),
      cooling: this.count('cooling'),
      dead: this.count('dead'),
      pending: this.count('pending'),
      probes,
      sourcesOk,
      sourcesFailed,
      ms: this.#lastRefreshMs,
      error: this.#lastError,
    }
    this.#log(
      `[proxy-pool] refresh in ${summary.ms}ms: clean=${summary.clean} cooling=${summary.cooling} dead=${summary.dead} pending=${summary.pending} tracked=${summary.candidates} probes=${probes}` +
        (sourcesOk + sourcesFailed > 0 ? ` sources=${sourcesOk}/${sourcesOk + sourcesFailed}` : ''),
    )
    return summary
  }

  async #collectCandidates(): Promise<{ candidates: ProxyPoolCandidate[]; sourcesOk: number; sourcesFailed: number }> {
    const jobs = this.sources.map(async (source) => {
      const text = await this.#fetchText(source.url)
      if (source.format === 'geonode') {
        const parsed = JSON.parse(text) as { data?: Array<{ ip?: string; port?: string | number; protocols?: string[] }> }
        const out: ProxyPoolCandidate[] = []
        for (const row of parsed.data ?? []) {
          if (out.length >= MAX_PER_SOURCE) break
          if (typeof row.ip !== 'string' || row.port === undefined) continue
          const protocol = Array.isArray(row.protocols) && row.protocols.includes('socks5') ? 'socks5' : 'http'
          const candidate = parseProxyCandidate(`${protocol}://${row.ip}:${row.port}`, protocol)
          if (candidate !== null) out.push(candidate)
        }
        return out
      }
      return parseProxyLines(text, source.protocol)
    })
    const settled = await Promise.allSettled(jobs)
    const candidates: ProxyPoolCandidate[] = []
    let sourcesOk = 0
    let sourcesFailed = 0
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        sourcesOk += 1
        candidates.push(...result.value)
      } else {
        sourcesFailed += 1
      }
    }
    return { candidates, sourcesOk, sourcesFailed }
  }

  async #fetchText(url: string): Promise<string> {
    if (this.#options.fetchText !== undefined) return await this.#options.fetchText(url)
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }

  /** Probe candidates concurrently, adding/refreshing their entries. */
  async #probeCandidates(candidates: ProxyPoolCandidate[]): Promise<number> {
    return await this.#probe(candidates.map((candidate) => this.#entryFor(candidate)))
  }

  async #probeEntries(entries: ProxyPoolEntry[]): Promise<number> {
    return await this.#probe(entries)
  }

  async #probe(entries: ProxyPoolEntry[]): Promise<number> {
    if (entries.length === 0) return 0
    let done = 0
    let index = 0
    const workers = Array.from({ length: Math.min(this.#options.concurrency, entries.length) }, async () => {
      for (;;) {
        const at = index++
        if (at >= entries.length) return
        const entry = entries[at]
        let result: ProbeResult
        try {
          result = await this.#options.probe(this.#toProxy(entry), entry)
        } catch (err) {
          result = { status: 0, text: '', latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
        }
        done += 1
        this.#applyVerdict(entry, result)
      }
    })
    await Promise.all(workers)
    return done
  }

  #applyVerdict(entry: ProxyPoolEntry, result: ProbeResult): void {
    const verdict = classifyProbeResult(result)
    entry.latencyMs = result.latencyMs
    entry.lastStatus = result.status
    entry.lastError = verdict.status === 'clean' ? '' : verdict.reason
    entry.checkedAt = Date.now()
    entry.status = verdict.status
    entry.failures = 0
    if (verdict.status === 'cooling') entry.coolingUntil = Date.now() + this.#options.coolingMs
    if (verdict.status === 'clean') {
      this.#log(`[proxy-pool] clean exit: ${entry.masked} (${entry.latencyMs}ms)`)
    }
    if (verdict.status === 'dead' && this.#current === entry.key) this.#current = null
  }

  #entryFor(candidate: ProxyPoolCandidate): ProxyPoolEntry {
    const key = proxyKey(candidate)
    const existing = this.#entries.get(key)
    if (existing !== undefined) return existing
    const entry: ProxyPoolEntry = {
      ...candidate,
      key,
      masked: `${candidate.protocol}://${candidate.host}:${candidate.port}`,
      status: 'pending',
      latencyMs: Number.MAX_SAFE_INTEGER,
      lastStatus: 0,
      lastError: '',
      checkedAt: 0,
      coolingUntil: 0,
      failures: 0,
      lastUsedAt: 0,
    }
    this.#entries.set(key, entry)
    return entry
  }

  #prune(): void {
    if (this.#entries.size <= MAX_TRACKED_ENTRIES) return
    const dead = [...this.#entries.values()]
      .filter((entry) => entry.status === 'dead' && entry.key !== this.#current)
      .sort((a, b) => a.checkedAt - b.checkedAt)
    let excess = this.#entries.size - MAX_TRACKED_ENTRIES
    for (const entry of dead) {
      if (excess <= 0) break
      this.#entries.delete(entry.key)
      const pooled = this.#agents.get(`${entry.key}|pooled`)
      const fresh = this.#agents.get(`${entry.key}|fresh`)
      pooled?.destroy()
      fresh?.destroy()
      this.#agents.delete(`${entry.key}|pooled`)
      this.#agents.delete(`${entry.key}|fresh`)
      excess -= 1
    }
  }

  snapshot(includeCurrent = false): ProxyPoolSnapshot {
    const snapshot: ProxyPoolSnapshot = {
      mode: 'pool',
      targetSize: this.#options.targetSize,
      clean: this.count('clean'),
      cooling: this.count('cooling'),
      dead: this.count('dead'),
      pending: this.count('pending'),
      tracked: this.#entries.size,
      probesLastRefresh: this.#lastProbes,
      refreshSecondsAgo: this.#lastRefreshAt === 0 ? null : Math.round((Date.now() - this.#lastRefreshAt) / 1000),
      refreshMs: this.#options.refreshMs,
      sources: this.sources.length,
      lastError: this.#lastError,
    }
    if (includeCurrent) snapshot.current = this.#current
    return snapshot
  }

  #log(line: string): void {
    if (this.#options.log !== undefined) this.#options.log(line)
    else console.log(line)
  }
}

export interface ProxyPoolRefresh {
  candidates: number
  clean: number
  cooling: number
  dead: number
  pending: number
  probes: number
  sourcesOk: number
  sourcesFailed: number
  ms: number
  error: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cheap liveness gate before spending a probe on a candidate. */
async function tcpFilter(
  candidates: ProxyPoolCandidate[],
  timeoutMs: number,
  concurrency: number,
  liveness?: (host: string, port: number) => Promise<boolean>,
): Promise<ProxyPoolCandidate[]> {
  const alive: ProxyPoolCandidate[] = []
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    for (;;) {
      const at = index++
      if (at >= candidates.length) return
      const candidate = candidates[at]
      const ok = liveness !== undefined ? await liveness(candidate.host, candidate.port) : await tcpAlive(candidate.host, candidate.port, timeoutMs)
      if (ok) alive.push(candidate)
    }
  })
  await Promise.all(workers)
  return alive
}

function tcpAlive(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}
