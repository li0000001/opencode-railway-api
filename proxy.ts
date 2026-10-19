/**
 * Upstream egress proxy — zero dependencies, one tunnel per upstream connection.
 *
 * Why this exists: OpenCode Zen weighs the *requesting IP* for the free lane.
 * A gateway hosted on shared cloud egress (Render, Railway, AWS, …) lives in
 * datacenter space, which the gate treats exactly like a VPN/proxy, so it can
 * be refused outright even with perfectly valid credentials:
 *
 *   403 FreeTierError "we've detected abusive traffic from this IP address.
 *   This isn't related to your account. If you're on a VPN or proxy, turn it
 *   off and try again."
 *
 * Routing the upstream calls through a proxy with a clean exit address fixes
 * that without touching any other part of the relay.
 *
 * Design notes
 * - The tunnel is created *inside* `https.Agent.createConnection`, so every
 *   existing behaviour survives: keep-alive pooling, maxSockets/maxFreeSockets,
 *   the stale pooled-socket watchdog (server.ts arms it on `req.reusedSocket`),
 *   the DNS cache (it now resolves the proxy host), request watchdogs and the
 *   key pool's failover.
 * - Zero dependencies: HTTP CONNECT (plain or over TLS to the proxy) and SOCKS5
 *   (RFC 1928 + RFC 1929 user/pass) are implemented here. `socks5h` is treated
 *   as `socks5` — the hostname is always sent to the proxy, never resolved
 *   locally, so remote DNS is the default.
 * - One proxy for every upstream host, minus `NO_PROXY`, evaluated per host: a
 *   deployment can tunnel `opencode.ai` while letting `models.dev` go direct.
 * - Once configured, the proxy is a hard requirement: there is no silent
 *   fallback to a direct connection, because the direct route is exactly the
 *   flagged one this feature exists to avoid. Failures surface as request
 *   errors (and a 502 to the client), never as "quietly leaked" traffic.
 */

import { Buffer } from 'node:buffer'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket, type ConnectionOptions as TlsConnectionOptions } from 'node:tls'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UpstreamProxy {
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
  /** Env var that supplied the value (`UPSTREAM_PROXY`, `HTTPS_PROXY`, …). */
  source: string
  /** `socks5://user:***@host:1080` — the only form that ever reaches a log. */
  masked: string
}

export interface UpstreamProxyResolution {
  proxy: UpstreamProxy | null
  /** Environment variable the proxy came from, or null when none is set. */
  source: string | null
  /** Hosts that must stay direct (`NO_PROXY`). */
  noProxy: NoProxyMatcher
  /** Human-readable configuration problem; the proxy is then ignored. */
  error: string | null
}

/** Ports used when the proxy URL omits one (explicit ports always win). */
const DEFAULT_PORTS: Record<UpstreamProxy['protocol'], number> = { http: 8080, https: 443, socks5: 1080 }

/** Accepted URL schemes; `socks`/`socks5h` are the same client. */
const PROXY_SCHEMES: Record<string, UpstreamProxy['protocol'] | undefined> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
}

/**
 * Recognised env spellings, most specific first. `UPSTREAM_PROXY` exists so a
 * deployment can aim *only* this server at a clean exit without inheriting an
 * unrelated global `HTTPS_PROXY`; the generic spellings follow the usual
 * convention (`HTTPS_PROXY` first for an HTTPS target, then `ALL_PROXY`).
 */
const PROXY_ENV_ORDER = ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

/**
 * Parse one proxy URL. Accepted schemes: `http://` and `https://` (CONNECT,
 * the latter over a TLS connection to the proxy itself), `socks5://`,
 * `socks5h://` and the `socks://` shorthand (equivalent here). Credentials are
 * optional; a port may be omitted and falls back to the scheme's usual one.
 */
export function parseProxyUrl(raw: string, source: string): UpstreamProxy {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error(`${source} is empty`)
  const match = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(trimmed)
  if (match === null) {
    throw new Error(`${source} must be a proxy URL with a scheme (http://, https://, socks5://) — got "${redact(trimmed)}"`)
  }
  const scheme = match[1].toLowerCase()
  const protocol = PROXY_SCHEMES[scheme]
  if (protocol === undefined) {
    throw new Error(`${source} uses unsupported scheme "${scheme}://" (supported: http://, https://, socks5://, socks5h://)`)
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${source} is not a valid URL: ${redact(trimmed)}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host.length === 0) throw new Error(`${source} has no host: ${redact(trimmed)}`)
  const port = parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_PORTS[protocol]
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${source} has an invalid port: ${redact(trimmed)}`)
  }
  const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined
  const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined
  return {
    protocol,
    host,
    port,
    username,
    password,
    source,
    masked: `${protocol}://${username === undefined ? '' : `${encodeURIComponent(username)}:***@`}${host}:${port}`,
  }
}

/** Proxy identity for logs and `/health` — never contains credentials. */
export function maskProxy(proxy: UpstreamProxy): string {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`
}

function redact(value: string): string {
  // A URL that failed to parse may still carry `user:pass@`; trim it away.
  return value.length > 80 ? `${value.slice(0, 77)}...` : value.replace(/\/\/[^@/]*@/, '//***@')
}

/** First non-empty proxy variable wins; a broken value is reported, not fatal. */
export function resolveUpstreamProxy(env: NodeJS.ProcessEnv = process.env): UpstreamProxyResolution {
  const noProxy = new NoProxyMatcher(env.NO_PROXY ?? env.no_proxy)
  for (const name of PROXY_ENV_ORDER) {
    const raw = env[name]
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    try {
      return { proxy: parseProxyUrl(raw, name), source: name, noProxy, error: null }
    } catch (err) {
      return { proxy: null, source: name, noProxy, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { proxy: null, source: null, noProxy, error: null }
}

/**
 * `NO_PROXY` matcher: `*` disables proxying entirely; otherwise a comma/space
 * separated list of hosts (a leading `.` or `*.` means "this domain and its
 * subdomains"), each optionally restricted to one port.
 */
export class NoProxyMatcher {
  readonly #all: boolean
  readonly #entries: Array<{ host: string; port: number | null }> = []

  constructor(raw: string | undefined) {
    const list = (raw ?? '').split(/[\s,]+/).filter((part) => part.length > 0)
    this.#all = list.includes('*')
    for (const part of list) {
      if (part === '*') continue
      const colon = part.lastIndexOf(':')
      const hasPort = colon > 0 && /^\d+$/.test(part.slice(colon + 1)) && part.indexOf(']') < colon
      const hostPart = (hasPort ? part.slice(0, colon) : part).replace(/^\*\./, '.').replace(/^\./, '').toLowerCase()
      if (hostPart.length === 0) continue
      this.#entries.push({ host: hostPart, port: hasPort ? Number(part.slice(colon + 1)) : null })
    }
  }

  /** True when `host` (optionally with `port`) must bypass the proxy. */
  matches(host: string, port?: number): boolean {
    if (this.#all) return true
    const target = host.replace(/^\[|\]$/g, '').toLowerCase()
    for (const entry of this.#entries) {
      if (entry.port !== null && entry.port !== port) continue
      if (target === entry.host || target.endsWith(`.${entry.host}`)) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Tunnel agent: https.Agent whose connections are built through the proxy
// ---------------------------------------------------------------------------

export interface TunnelEvent {
  ok: boolean
  /** `host:port` the tunnel was opened towards. */
  target: string
  ms: number
  error?: Error
}

export interface TunnelAgentOptions {
  keepAlive: boolean
  maxSockets?: number
  maxFreeSockets?: number
  keepAliveMsecs?: number
  /** Connect + CONNECT/SOCKS5 handshake + TLS budget (default 20s). */
  connectTimeoutMs?: number
  /** `net.connect` lookup override (the server's DNS cache) — resolves the proxy host. */
  lookup?: unknown
  /** TLS options for the tunnel's outer layer (tests use rejectUnauthorized:false). */
  tls?: { rejectUnauthorized?: boolean }
  /** Per-tunnel telemetry (first success, failures) — never sees credentials. */
  onTunnel?: (event: TunnelEvent) => void
}

/** Marker property carrying the tunnel establishment cost on the TLSSocket. */
export const TUNNEL_LATENCY = Symbol.for('opencode2dsh.tunnelLatencyMs')

interface ConnectOptions {
  host?: string
  port?: number | string
  servername?: string
  family?: number
  localAddress?: string
  lookup?: unknown
  /** Set by the agent when `keepAlive` is on: TCP keep-alive for the tunnel. */
  keepAlive?: boolean
  keepAliveInitialDelay?: number
}

/**
 * An `https.Agent` that opens every connection through `proxy` and then runs
 * TLS over the tunnel. Reused sockets keep working exactly like the direct
 * agent's: the pooling, limits and keep-alive semantics live in the base class,
 * only the transport is replaced.
 */
export function createTunnelAgent(proxy: UpstreamProxy, options: TunnelAgentOptions): HttpsAgent {
  const agent = new HttpsAgent({
    keepAlive: options.keepAlive,
    maxSockets: options.maxSockets,
    maxFreeSockets: options.maxFreeSockets,
    keepAliveMsecs: options.keepAliveMsecs,
  })
  const connectTimeoutMs = options.connectTimeoutMs ?? 20_000
  const createConnection = (rawOptions: ConnectOptions, callback: (err: Error | null, socket?: Socket) => void): void => {
    const target = { host: String(rawOptions.host ?? ''), port: Number(rawOptions.port ?? 443) }
    const started = Date.now()
    openTunnel(proxy, target, { ...rawOptions, tls: options.tls }, connectTimeoutMs)
      .then((socket) => {
        const ms = Date.now() - started
        Object.defineProperty(socket, TUNNEL_LATENCY, { value: ms, enumerable: false, configurable: true })
        options.onTunnel?.({ ok: true, target: `${target.host}:${target.port}`, ms })
        callback(null, socket)
      })
      .catch((err: Error) => {
        options.onTunnel?.({ ok: false, target: `${target.host}:${target.port}`, ms: Date.now() - started, error: err })
        callback(err)
      })
  }
  // http.Agent calls createConnection(options, oncreate) and accepts an async
  // callback (it only inspects a *returned* socket) — the same contract the
  // built-in tunneling in Node 24 relies on.
  agent.createConnection = createConnection as unknown as typeof agent.createConnection
  return agent
}

async function openTunnel(
  proxy: UpstreamProxy,
  target: { host: string; port: number },
  options: ConnectOptions & { tls?: { rejectUnauthorized?: boolean } },
  timeoutMs: number,
): Promise<TLSSocket> {
  if (target.host.length === 0) throw new Error('tunnel target host is missing')
  let live: Socket | null = null
  const timer = setTimeout(() => {
    live?.destroy(new Error(`proxy handshake timed out after ${timeoutMs}ms (${maskProxy(proxy)})`))
  }, timeoutMs)
  timer.unref?.()
  try {
    live = await connectToProxy(proxy, options, (socket) => {
      live = socket // catch the window between TCP connect and the handshake
    })
    const leftover =
      proxy.protocol === 'socks5'
        ? await socks5Handshake(proxy, target, live)
        : await httpConnectHandshake(proxy, target, live)
    const tlsSocket = await startTls(live, target, leftover, options.tls)
    live = tlsSocket
    return tlsSocket
  } catch (err) {
    live?.destroy()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Reach the proxy itself: TCP for http/socks5, TLS for an https:// proxy. */
function connectToProxy(proxy: UpstreamProxy, options: ConnectOptions, onSocket?: (socket: Socket) => void): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const base = {
      host: proxy.host,
      port: proxy.port,
      // The agent hands these down for keep-alive agents; the tunnel's TCP
      // socket gets the same SO_KEEPALIVE treatment as a direct connection.
      ...(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive, keepAliveInitialDelay: options.keepAliveInitialDelay }),
      ...(options.lookup === undefined ? {} : { lookup: options.lookup as never }),
      ...(options.family === undefined ? {} : { family: options.family }),
      ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
    }
    let socket: Socket
    const onError = (err: Error): void => {
      socket.destroy()
      reject(err)
    }
    const onReady = (): void => {
      socket.removeListener('error', onError)
      resolve(socket)
    }
    socket =
      proxy.protocol === 'https'
        ? tlsConnect(
            { ...base, ...(isIP(proxy.host) === 0 ? { servername: proxy.host } : {}), ALPNProtocols: ['http/1.1'] } as TlsConnectionOptions,
            onReady,
          )
        : netConnect(base, onReady)
    socket.once('error', onError)
    onSocket?.(socket)
  })
}

/** `CONNECT host:port HTTP/1.1` + optional Proxy-Authorization: Basic. */
async function httpConnectHandshake(
  proxy: UpstreamProxy,
  target: { host: string; port: number },
  socket: Socket,
): Promise<Buffer> {
  const reader = new HandshakeReader(socket)
  const authority = `${target.host}:${target.port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
  if (proxy.username !== undefined) {
    const credentials = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
    lines.push(`Proxy-Authorization: Basic ${credentials}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const { head, rest } = await reader.takeHead()
  reader.detach()
  const statusLine = head.toString('latin1').split('\r\n', 1)[0] ?? ''
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
  if (status === null) throw new Error(`proxy answered a malformed CONNECT reply: ${statusLine.slice(0, 80)}`)
  const code = Number(status[1])
  if (code !== 200) throw new Error(`proxy refused CONNECT (HTTP ${code})`)
  return rest
}

/** RFC 1928 CONNECT with the optional RFC 1929 username/password exchange. */
async function socks5Handshake(
  proxy: UpstreamProxy,
  target: { host: string; port: number },
  socket: Socket,
): Promise<Buffer> {
  const reader = new HandshakeReader(socket)
  try {
    const methods = proxy.username === undefined ? [0x00] : [0x00, 0x02]
    socket.write(Buffer.from([0x05, methods.length, ...methods]))
    const greeting = await reader.take(2)
    if (greeting[0] !== 0x05) throw new Error(`socks5 proxy answered version ${greeting[0]} (expected 5)`)
    if (greeting[1] === 0x02) {
      // Only offered when credentials are configured, so the username is set.
      const user = Buffer.from(proxy.username ?? '', 'utf8')
      const pass = Buffer.from(proxy.password ?? '', 'utf8')
      if (user.length > 255 || pass.length > 255) throw new Error('socks5 username and password must be at most 255 bytes each')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await reader.take(2)
      if (auth[1] !== 0x00) throw new Error('socks5 proxy rejected the username/password')
    } else if (greeting[1] === 0xff) {
      throw new Error('socks5 proxy accepts no offered auth method — it likely requires authentication, use socks5://user:pass@host:port')
    } else if (greeting[1] !== 0x00) {
      throw new Error(`socks5 proxy chose an unsupported auth method (0x${greeting[1].toString(16)})`)
    }

    const port = Buffer.alloc(2)
    port.writeUInt16BE(target.port)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(target.host), port]))

    const reply = await reader.take(4)
    if (reply[1] !== 0x00) {
      const reason = SOCKS5_ERRORS[reply[1]] ?? `code 0x${reply[1].toString(16)}`
      throw new Error(`socks5 CONNECT ${target.host}:${target.port} failed: ${reason}`)
    }
    // Consume the BND.ADDR/BND.PORT the reply carries; nothing else follows.
    if (reply[3] === 0x01) await reader.take(4 + 2)
    else if (reply[3] === 0x04) await reader.take(16 + 2)
    else if (reply[3] === 0x03) {
      const length = (await reader.take(1))[0]
      await reader.take(length + 2)
    } else {
      throw new Error(`socks5 proxy returned an unknown address type 0x${reply[3].toString(16)}`)
    }
    return reader.detach()
  } catch (err) {
    reader.detach()
    throw err
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  0x01: 'general failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

/** SOCKS5 address field: IPv4/IPv6 literal or the hostname as DOMAINNAME. */
export function socksAddress(host: string): Buffer {
  const family = isIP(host)
  if (family === 4) return Buffer.from([0x01, ...host.split('.').map(Number)])
  if (family === 6) return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)])
  const bytes = Buffer.from(host, 'utf8')
  if (bytes.length === 0 || bytes.length > 255) throw new Error(`cannot send host "${host}" through socks5 (1-255 bytes required)`)
  return Buffer.concat([Buffer.from([0x03, bytes.length]), bytes])
}

function ipv6Bytes(host: string): Buffer {
  const address = host.split('%')[0] // strip a zone id (fe80::1%eth0)
  const halves = address.split('::')
  if (halves.length > 2) throw new Error(`cannot parse IPv6 address ${host}`)
  const expand = (part: string): number[] => {
    if (part.length === 0) return []
    const groups = part.split(':')
    const out: number[] = []
    groups.forEach((group, index) => {
      if (index === groups.length - 1 && group.includes('.')) {
        const octets = group.split('.').map(Number)
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error(`cannot parse IPv6 address ${host}`)
        }
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        return
      }
      const value = Number.parseInt(group, 16)
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`cannot parse IPv6 address ${host}`)
      out.push(value)
    })
    return out
  }
  const head = expand(halves[0] ?? '')
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : []
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = halves.length === 2 ? [...head, ...new Array(Math.max(zeros, 0)).fill(0), ...tail] : head
  if (groups.length !== 8) throw new Error(`cannot parse IPv6 address ${host}`)
  const bytes = Buffer.alloc(16)
  groups.forEach((value, index) => bytes.writeUInt16BE(value, index * 2))
  return bytes
}

/** TLS over the tunnel: SNI for hostnames, ALPN pinned to HTTP/1.1. */
function startTls(
  socket: Socket,
  target: { host: string; port: number },
  leftover: Buffer,
  tls?: { rejectUnauthorized?: boolean },
): Promise<TLSSocket> {
  if (leftover.length > 0) socket.unshift(leftover)
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      socket.destroy()
      reject(err)
    }
    let tlsSocket: TLSSocket
    tlsSocket = tlsConnect(
      {
        socket,
        ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: tls?.rejectUnauthorized ?? true,
      },
      () => {
        tlsSocket.removeListener('error', onError)
        resolve(tlsSocket)
      },
    )
    tlsSocket.once('error', onError)
  })
}

// ---------------------------------------------------------------------------
// Byte-exact handshake reader
// ---------------------------------------------------------------------------

const CRLFCRLF = Buffer.from('\r\n\r\n', 'latin1')

/**
 * Buffered reader over the raw tunnel socket. It owns the socket's 'data'
 * events until `detach()`; bytes read past a reply are handed back so the TLS
 * layer still sees them (`socket.unshift`).
 */
class HandshakeReader {
  readonly #socket: Socket
  #buffer = Buffer.alloc(0)
  #failure: Error | null = null
  #wake: (() => void) | null = null

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    this.#notify()
  }
  readonly #onEnd = (): void => this.#fail(new Error('proxy closed the connection during the handshake'))
  readonly #onError = (err: Error): void => this.#fail(err)

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on('data', this.#onData)
    socket.on('end', this.#onEnd)
    socket.on('error', this.#onError)
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  #fail(err: Error): void {
    if (this.#failure === null) this.#failure = err
    this.#notify()
  }

  async #wait(): Promise<void> {
    if (this.#failure !== null) throw this.#failure
    await new Promise<void>((resolve) => {
      this.#wake = resolve
    })
    if (this.#failure !== null) throw this.#failure
  }

  /** Consume exactly `count` bytes. */
  async take(count: number): Promise<Buffer> {
    while (this.#buffer.length < count) await this.#wait()
    const out = this.#buffer.subarray(0, count)
    this.#buffer = this.#buffer.subarray(count)
    return out
  }

  /** Consume through the first CRLFCRLF; the terminator is part of `head`. */
  async takeHead(limit = 16 * 1024): Promise<{ head: Buffer; rest: Buffer }> {
    for (;;) {
      const end = this.#buffer.indexOf(CRLFCRLF)
      if (end !== -1) {
        const head = this.#buffer.subarray(0, end + CRLFCRLF.length)
        const rest = this.#buffer.subarray(end + CRLFCRLF.length)
        this.#buffer = Buffer.alloc(0)
        return { head, rest }
      }
      if (this.#buffer.length > limit) this.#fail(new Error('proxy reply header exceeds 16 KiB'))
      await this.#wait()
    }
  }

  /** Stop reading and return whatever is still buffered. */
  detach(): Buffer {
    this.#socket.off('data', this.#onData)
    this.#socket.off('end', this.#onEnd)
    this.#socket.off('error', this.#onError)
    const rest = this.#buffer
    this.#buffer = Buffer.alloc(0)
    return rest
  }
}

// ---------------------------------------------------------------------------
// Fetch router (the catalog's models list / models.dev metadata go the same way)
// ---------------------------------------------------------------------------

export interface EgressFetchOptions {
  proxy: UpstreamProxy | null
  noProxy: NoProxyMatcher
  connectTimeoutMs?: number
  /** Hard bound for one proxied request (default 30s). */
  requestTimeoutMs?: number
  /** DNS lookup override for the proxy host (server.ts's cache). */
  lookup?: unknown
  /** TLS options for the tunnel's outer layer (self-signed upstreams/tests). */
  tls?: { rejectUnauthorized?: boolean }
  /** Tunable for tests; production always uses the global fetch. */
  directFetch?: typeof fetch
}

/**
 * A `fetch` that honours the egress configuration per request: proxied hosts
 * go through the tunnel agent, everything else (or `NO_PROXY` matches) uses the
 * global fetch unchanged. The tunnel agent is created on first use and pooled
 * for the lifetime of the router.
 */
export function createEgressFetch(options: EgressFetchOptions): typeof fetch {
  const direct = options.directFetch ?? fetch
  let agent: HttpsAgent | null = null
  const agentFor = (): HttpsAgent => {
    agent ??= createTunnelAgent(options.proxy as UpstreamProxy, {
      keepAlive: true,
      maxSockets: 4,
      keepAliveMsecs: 30_000,
      connectTimeoutMs: options.connectTimeoutMs,
      lookup: options.lookup,
      tls: options.tls,
    })
    return agent
  }
  const router = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input)
    if (options.proxy === null || options.noProxy.matches(url.hostname, url.port.length > 0 ? Number(url.port) : 443)) {
      return await direct(input, init)
    }
    return await proxiedRequest(agentFor(), url, init, options.requestTimeoutMs ?? 30_000)
  }
  return router as typeof fetch
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

/** One HTTPS request over the tunnel, materialised as a `Response`. */
async function proxiedRequest(agent: HttpsAgent, url: URL, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  if (url.protocol !== 'https:') throw new Error(`the egress proxy supports https targets only (got ${url.protocol}//)`)
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? {})
  const body = toRequestBody(init?.body)
  if (body !== null && !headers.has('content-length')) headers.set('content-length', String(body.length))
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port.length > 0 ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers: Object.fromEntries(headers.entries()),
        agent,
      },
      (res) => {
        if (timer !== null) clearTimeout(timer)
        resolve(res)
      },
    )
    // A tunnel can stall in ways the agent cannot see (proxy up, upstream
    // silent); the catalog would then never refresh again, so bound it here.
    timer = setTimeout(() => req.destroy(new Error(`proxied request timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    req.on('error', (err) => {
      if (timer !== null) clearTimeout(timer)
      reject(err)
    })
    const signal = init?.signal ?? null
    if (signal !== null) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        return
      }
      const onAbort = (): void => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.end(body ?? undefined)
  })
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  const payload = Buffer.concat(chunks)
  const status = response.statusCode ?? 0
  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value))
  }
  const source = status === 204 || status === 304 || method === 'HEAD' ? null : payload
  return new Response(source, { status, statusText: response.statusMessage ?? '', headers: responseHeaders })
}

function toRequestBody(body: BodyInit | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new Error('the egress proxy accepts string/Buffer request bodies only')
}
