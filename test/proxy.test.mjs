/**
 * Zero-dependency tests for the upstream egress proxy (proxy.ts).
 *
 * Offline and hermetic by default: a local CONNECT proxy, a local SOCKS5 proxy
 * and a local HTTPS origin cover the full path — connect, handshake, TLS,
 * keep-alive reuse, auth, refusal — without touching the real upstream.
 *
 *   npm test                                         the offline suite
 *   node --test test/proxy.test.mjs                  same, without npm
 *   SMOKE_LIVE=1 node --test test/proxy.test.mjs     + the live gateway case
 *
 * (Node's runner wants the file path last: `node --test [flags] <file>`; a
 * bare directory argument is not portable across platforms.)
 *
 * The TLS fixture (`fixtures/localhost-*.pem`) is a throwaway self-signed pair
 * for DNS:localhost + IP:127.0.0.1, valid 10 years, regenerable with:
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=localhost" \
 *     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
 *     -keyout fixtures/localhost-key.pem -out fixtures/localhost-cert.pem
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  NoProxyMatcher,
  createEgressFetch,
  createTunnelAgent,
  maskProxy,
  parseProxyUrl,
  resolveUpstreamProxy,
  socksAddress,
} from '../proxy.ts'

const here = dirname(fileURLToPath(import.meta.url))
const TLS_CERT = readFileSync(join(here, 'fixtures', 'localhost-cert.pem'))
const TLS_KEY = readFileSync(join(here, 'fixtures', 'localhost-key.pem'))

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A plain CONNECT proxy that tunnels to the requested authority. */
async function startConnectProxy({ expectedAuth = null, refuseStatus = null } = {}) {
  const state = { connects: [] }
  const openSockets = new Set()
  const track = (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  }
  const server = createNetServer((client) => {
    track(client)
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      client.off('data', onData)
      const lines = buffer.slice(0, end).split('\r\n')
      const [method, authority] = (lines[0] ?? '').split(' ')
      const auth = lines.find((line) => /^proxy-authorization:/i.test(line))?.split(/:\s*/)[1] ?? null
      state.connects.push({ method, authority, auth })
      if (refuseStatus !== null) {
        client.end(`HTTP/1.1 ${refuseStatus} Denied\r\ncontent-length: 0\r\n\r\n`)
        return
      }
      if (expectedAuth !== null && auth !== expectedAuth) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n')
        return
      }
      if (method !== 'CONNECT') {
        client.end('HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n')
        return
      }
      const separator = authority.lastIndexOf(':')
      const host = authority.slice(0, separator)
      const port = Number(authority.slice(separator + 1))
      const upstream = netConnect({ host, port }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
      track(upstream)
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
    }
    client.on('data', onData)
    client.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Sockets dialled *out* of the proxy are ours to reap: a half-closed */
    /** upstream (Cloudflare keeps its side open) would otherwise pin the runner. */
    close: async () => {
      for (const socket of openSockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A minimal SOCKS5 proxy (RFC 1928 + RFC 1929), enough to exercise the client. */
async function startSocks5Proxy({ credentials = null, replyCode = 0x00 } = {}) {
  const state = { targets: [] }
  const openSockets = new Set()
  const track = (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  }
  const server = createNetServer((client) => {
    track(client)
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    const send = (bytes) => client.write(Buffer.from(bytes))
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (stage === 'greeting' && buffer.length >= 2) {
          const count = buffer[1]
          if (buffer.length < 2 + count) return
          const methods = [...buffer.subarray(2, 2 + count)]
          buffer = buffer.subarray(2 + count)
          const method = credentials === null ? 0x00 : methods.includes(0x02) ? 0x02 : 0xff
          send([0x05, method])
          if (method === 0xff) return client.end()
          stage = method === 0x02 ? 'auth' : 'request'
          continue
        }
        if (stage === 'auth' && buffer.length >= 2) {
          const userLength = buffer[1]
          if (buffer.length < 2 + userLength + 1) return
          const user = buffer.subarray(2, 2 + userLength).toString('utf8')
          const passLength = buffer[2 + userLength]
          if (buffer.length < 3 + userLength + passLength) return
          const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8')
          buffer = buffer.subarray(3 + userLength + passLength)
          const ok = user === credentials.username && pass === credentials.password
          send([0x01, ok ? 0x00 : 0x01])
          if (!ok) return client.end()
          stage = 'request'
          continue
        }
        if (stage === 'request' && buffer.length >= 5) {
          const atyp = buffer[3]
          let host = null
          let cursor = 4
          if (atyp === 0x01) {
            if (buffer.length < 4 + 4 + 2) return
            host = [...buffer.subarray(4, 8)].join('.')
            cursor = 8
          } else if (atyp === 0x03) {
            const length = buffer[4]
            if (buffer.length < 5 + length + 2) return
            host = buffer.subarray(5, 5 + length).toString('utf8')
            cursor = 5 + length
          } else if (atyp === 0x04) {
            if (buffer.length < 4 + 16 + 2) return
            const groups = []
            for (let index = 0; index < 16; index += 2) groups.push(buffer.readUInt16BE(4 + index).toString(16))
            host = groups.join(':')
            cursor = 20
          } else {
            send([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            return client.end()
          }
          const port = buffer.readUInt16BE(cursor)
          buffer = buffer.subarray(cursor + 2)
          state.targets.push(`${host}:${port}`)
          if (replyCode !== 0x00) {
            send([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            return client.end()
          }
          const upstream = netConnect({ host, port }, () => {
            send([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            upstream.pipe(client)
            client.pipe(upstream)
          })
          track(upstream)
          upstream.on('error', () => client.destroy())
          client.on('error', () => upstream.destroy())
          client.on('close', () => upstream.destroy())
          stage = 'tunnel'
          return
        }
        return
      }
    }
    client.on('data', onData)
    client.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    state,
    url: `socks5://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of openSockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function startHttpsOrigin() {
  const server = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `https://localhost:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** One HTTPS request through a tunnel agent, reporting reuse + status. */
function requestThrough(agent, url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port.length > 0 ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        agent,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), reused: req.reusedSocket }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const tunnelOptions = { keepAlive: true, maxSockets: 4, connectTimeoutMs: 5_000, tls: { rejectUnauthorized: false } }

// ---------------------------------------------------------------------------
// Configuration parsing
// ---------------------------------------------------------------------------

test('parseProxyUrl: schemes, defaults, credentials, masking', () => {
  const plain = parseProxyUrl('http://1.2.3.4:3128', 'UPSTREAM_PROXY')
  assert.equal(plain.protocol, 'http')
  assert.equal(plain.host, '1.2.3.4')
  assert.equal(plain.port, 3128)
  assert.equal(plain.username, undefined)
  assert.equal(plain.password, undefined)
  assert.equal(plain.source, 'UPSTREAM_PROXY')
  assert.equal(plain.masked, 'http://1.2.3.4:3128')
  assert.equal(parseProxyUrl('http://proxy.example.com', 'HTTPS_PROXY').port, 8080)
  assert.equal(parseProxyUrl('https://proxy.example.com', 'HTTPS_PROXY').port, 443)
  assert.equal(parseProxyUrl('socks5://proxy.example.com', 'ALL_PROXY').port, 1080)
  assert.equal(parseProxyUrl('socks5h://proxy.example.com:1081', 'ALL_PROXY').protocol, 'socks5')
  assert.equal(parseProxyUrl('socks://proxy.example.com:1081', 'ALL_PROXY').protocol, 'socks5')

  const auth = parseProxyUrl('socks5://user:p%40ss@1.2.3.4:1080', 'HTTPS_PROXY')
  assert.equal(auth.username, 'user')
  assert.equal(auth.password, 'p@ss')
  assert.equal(auth.masked, 'socks5://user:***@1.2.3.4:1080')
  assert.equal(maskProxy(auth), 'socks5://1.2.3.4:1080', 'maskProxy carries no credentials')
  assert.ok(!JSON.stringify(auth.masked).includes('p@ss'))

  const ipv6 = parseProxyUrl('socks5://[::1]:1080', 'HTTPS_PROXY')
  assert.equal(ipv6.host, '::1')
  assert.equal(ipv6.port, 1080)

  assert.throws(() => parseProxyUrl('1.2.3.4:1080', 'HTTPS_PROXY'), /with a scheme/)
  assert.throws(() => parseProxyUrl('ftp://1.2.3.4:21', 'HTTPS_PROXY'), /unsupported scheme/)
  assert.throws(() => parseProxyUrl('http://', 'HTTPS_PROXY'), /valid URL|no host/)
})

test('resolveUpstreamProxy: priority order and error reporting', () => {
  const env = {
    UPSTREAM_PROXY: 'socks5://up:1080',
    HTTPS_PROXY: 'http://https:3128',
    ALL_PROXY: 'http://all:3128',
    HTTP_PROXY: 'http://http:3128',
  }
  assert.equal(resolveUpstreamProxy(env).proxy.masked, 'socks5://up:1080')
  assert.equal(resolveUpstreamProxy({ ...env, UPSTREAM_PROXY: '' }).proxy.masked, 'http://https:3128')
  assert.equal(resolveUpstreamProxy({ ...env, UPSTREAM_PROXY: '', HTTPS_PROXY: '' }).proxy.masked, 'http://all:3128')
  assert.equal(resolveUpstreamProxy({ HTTP_PROXY: 'http://http:3128' }).proxy.masked, 'http://http:3128')
  assert.equal(resolveUpstreamProxy({}).proxy, null)

  const broken = resolveUpstreamProxy({ HTTPS_PROXY: 'not-a-url' })
  assert.equal(broken.proxy, null)
  assert.match(broken.error, /with a scheme/)
})

test('NoProxyMatcher: wildcard, exact, subdomains and ports', () => {
  assert.equal(new NoProxyMatcher(undefined).matches('opencode.ai'), false)
  assert.equal(new NoProxyMatcher('*').matches('anything.example'), true)
  const list = new NoProxyMatcher('opencode.ai, .example.com, internal:8443')
  assert.equal(list.matches('opencode.ai'), true)
  assert.equal(list.matches('opencode.ai', 443), true)
  assert.equal(list.matches('sub.opencode.ai'), true)
  assert.equal(list.matches('notopencode.ai'), false)
  assert.equal(list.matches('example.com'), true)
  assert.equal(list.matches('deep.sub.example.com'), true)
  assert.equal(list.matches('internal', 8443), true)
  assert.equal(list.matches('internal', 443), false)
  assert.equal(list.matches('models.dev'), false)
})

test('socksAddress: IPv4, IPv6 and domain encodings', () => {
  assert.deepEqual([...socksAddress('127.0.0.1')], [0x01, 127, 0, 0, 1])
  assert.deepEqual([...socksAddress('::1')], [0x04, ...new Array(15).fill(0), 1])
  assert.deepEqual(
    [...socksAddress('2001:db8::ff00:42:8329')],
    [0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0xff, 0x00, 0x00, 0x42, 0x83, 0x29],
  )
  assert.deepEqual([...socksAddress('::ffff:1.2.3.4')], [0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4])
  const domain = socksAddress('opencode.ai')
  assert.equal(domain[0], 0x03)
  assert.equal(domain[1], 'opencode.ai'.length)
  assert.equal(domain.subarray(2).toString('utf8'), 'opencode.ai')
  assert.throws(() => socksAddress('x'.repeat(256)), /1-255 bytes/)
})

// ---------------------------------------------------------------------------
// Tunnels (hermetic: local proxies + local TLS origin)
// ---------------------------------------------------------------------------

test('HTTP CONNECT tunnel: request, keep-alive reuse, no credential leak', async () => {
  const proxy = await startConnectProxy()
  const origin = await startHttpsOrigin()
  const tunnel = createTunnelAgent(parseProxyUrl(proxy.url, 'UPSTREAM_PROXY'), tunnelOptions)
  try {
    const first = await requestThrough(tunnel, `${origin.url}/one`)
    assert.equal(first.status, 200)
    assert.deepEqual(JSON.parse(first.body), { ok: true, path: '/one' })
    assert.equal(first.reused, false)

    const second = await requestThrough(tunnel, `${origin.url}/two`)
    assert.equal(second.status, 200)
    assert.equal(second.reused, true, 'the tunnel socket is pooled and reused')
    assert.deepEqual(JSON.parse(second.body), { ok: true, path: '/two' })

    assert.equal(proxy.state.connects.length, 1, 'one CONNECT for two pooled requests')
    assert.equal(proxy.state.connects[0].method, 'CONNECT')
    assert.equal(proxy.state.connects[0].authority, `localhost:${new URL(origin.url).port}`)
    assert.equal(proxy.state.connects[0].auth, null)
  } finally {
    tunnel.destroy()
    await origin.close()
    await proxy.close()
  }
})

test('HTTP CONNECT tunnel: Basic proxy auth succeeds, missing auth fails', async () => {
  const credentials = Buffer.from('user:secret', 'utf8').toString('base64')
  const proxy = await startConnectProxy({ expectedAuth: `Basic ${credentials}` })
  const origin = await startHttpsOrigin()
  try {
    const authorized = createTunnelAgent(parseProxyUrl(`http://user:secret@${proxy.url.slice('http://'.length)}`, 'HTTPS_PROXY'), tunnelOptions)
    const ok = await requestThrough(authorized, `${origin.url}/ok`)
    assert.equal(ok.status, 200)
    assert.equal(proxy.state.connects.at(-1).auth, `Basic ${credentials}`)
    authorized.destroy()

    const anonymous = createTunnelAgent(parseProxyUrl(proxy.url, 'HTTPS_PROXY'), tunnelOptions)
    await assert.rejects(requestThrough(anonymous, `${origin.url}/nope`), /proxy refused CONNECT \(HTTP 407\)/)
    anonymous.destroy()
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('HTTP CONNECT tunnel: a refused CONNECT surfaces as an error', async () => {
  const proxy = await startConnectProxy({ refuseStatus: 403 })
  const tunnel = createTunnelAgent(parseProxyUrl(proxy.url, 'UPSTREAM_PROXY'), tunnelOptions)
  try {
    await assert.rejects(requestThrough(tunnel, 'https://localhost:9/whatever'), /proxy refused CONNECT \(HTTP 403\)/)
  } finally {
    tunnel.destroy()
    await proxy.close()
  }
})

test('SOCKS5 tunnel: plain and authenticated', async () => {
  const proxy = await startSocks5Proxy()
  const origin = await startHttpsOrigin()
  const tunnel = createTunnelAgent(parseProxyUrl(proxy.url, 'ALL_PROXY'), tunnelOptions)
  try {
    const response = await requestThrough(tunnel, `${origin.url}/socks`)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), { ok: true, path: '/socks' })
    assert.deepEqual(proxy.state.targets, [`localhost:${new URL(origin.url).port}`])

    // An IP-literal target exercises the other SOCKS5 address encoding (ATYP 1)
    // and skips SNI, exactly like a hand-configured ZEN_BASE_URL would.
    const viaIp = await requestThrough(tunnel, `${origin.url.replace('localhost', '127.0.0.1')}/ip`)
    assert.equal(viaIp.status, 200)
    assert.equal(proxy.state.targets.at(-1), `127.0.0.1:${new URL(origin.url).port}`)
  } finally {
    tunnel.destroy()
    await origin.close()
    await proxy.close()
  }

  const authed = await startSocks5Proxy({ credentials: { username: 'u', password: 'p' } })
  const authedOrigin = await startHttpsOrigin()
  try {
    const url = `socks5://u:p@${authed.url.slice('socks5://'.length)}`
    const agent = createTunnelAgent(parseProxyUrl(url, 'ALL_PROXY'), tunnelOptions)
    const response = await requestThrough(agent, `${authedOrigin.url}/authed`)
    assert.equal(response.status, 200)
    agent.destroy()

    const wrong = createTunnelAgent(parseProxyUrl(url.replace('u:p@', 'u:wrong@'), 'ALL_PROXY'), tunnelOptions)
    await assert.rejects(requestThrough(wrong, `${authedOrigin.url}/denied`), /rejected the username\/password/)
    wrong.destroy()

    const missing = createTunnelAgent(parseProxyUrl(authed.url, 'ALL_PROXY'), tunnelOptions)
    await assert.rejects(requestThrough(missing, `${authedOrigin.url}/denied`), /requires authentication/)
    missing.destroy()
  } finally {
    await authedOrigin.close()
    await authed.close()
  }
})

test('SOCKS5 tunnel: a refusal code becomes a readable error', async () => {
  const proxy = await startSocks5Proxy({ replyCode: 0x05 })
  const tunnel = createTunnelAgent(parseProxyUrl(proxy.url, 'ALL_PROXY'), tunnelOptions)
  try {
    await assert.rejects(requestThrough(tunnel, 'https://localhost:9/x'), /socks5 CONNECT localhost:9 failed: connection refused/)
  } finally {
    tunnel.destroy()
    await proxy.close()
  }
})

test('createEgressFetch: routes per host and honours NO_PROXY', async () => {
  const proxy = await startConnectProxy()
  const origin = await startHttpsOrigin()
  const directCalls = []
  const fetchImpl = createEgressFetch({
    proxy: parseProxyUrl(proxy.url, 'UPSTREAM_PROXY'),
    noProxy: new NoProxyMatcher('exempt.localhost'),
    connectTimeoutMs: 5_000,
    tls: { rejectUnauthorized: false },
    directFetch: async (input) => {
      directCalls.push(String(input))
      return new Response('direct', { status: 200 })
    },
  })
  try {
    const exempt = await fetchImpl(`${origin.url.replace('localhost', 'exempt.localhost')}/direct`)
    assert.equal(await exempt.text(), 'direct')
    assert.equal(proxy.state.connects.length, 0, 'a NO_PROXY match never opens a tunnel')

    const tunneled = await fetchImpl(`${origin.url}/tunneled?q=1`)
    assert.equal(tunneled.status, 200)
    assert.deepEqual(await tunneled.json(), { ok: true, path: '/tunneled?q=1' })
    assert.equal(proxy.state.connects.at(-1).authority, `localhost:${new URL(origin.url).port}`)
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('createEgressFetch: a stalled tunnel is bounded by the request timeout', async () => {
  const proxy = await startConnectProxy()
  // An origin that accepts the tunnel + TLS but never answers the request.
  const silent = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, () => {})
  silent.listen(0, '127.0.0.1')
  await once(silent, 'listening')
  const fetchImpl = createEgressFetch({
    proxy: parseProxyUrl(proxy.url, 'UPSTREAM_PROXY'),
    noProxy: new NoProxyMatcher(),
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 700,
    tls: { rejectUnauthorized: false },
  })
  try {
    await assert.rejects(fetchImpl(`https://localhost:${silent.address().port}/stall`), /proxied request timed out after 700ms/)
  } finally {
    silent.closeAllConnections?.()
    await new Promise((resolve) => silent.close(resolve))
    await proxy.close()
  }
})

// ---------------------------------------------------------------------------
// The real gateway, with a proxy in front of its upstream calls (opt-in)
// ---------------------------------------------------------------------------

test('gateway: upstream traffic leaves through the configured proxy', { skip: process.env.SMOKE_LIVE !== '1' }, async () => {
  const proxy = await startConnectProxy()
  const port = 18_000 + Math.floor(Math.random() * 1_000)
  const child = spawn(process.execPath, [join(here, '..', 'server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: 'test-key',
      UPSTREAM_PROXY: proxy.url,
      NO_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      HTTP_PROXY: '',
      ZEN_API_KEY: '',
      ZEN_API_KEYS: '',
      ZEN_ACCESS_TOKEN: '',
      // Keep the live run's status snapshot out of the repository.
      STATUS_PATH: join(tmpdir(), `opencode2dsh-gateway-smoke-${process.pid}.json`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')))
  try {
    // Wait for the listener (poll /health rather than parsing stdout).
    let health = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        if (response.ok) {
          health = await response.json()
          break
        }
      } catch {
        // not up yet
      }
    }
    assert.ok(health !== null, `gateway did not come up:\n${logs.join('')}`)
    assert.equal(health.egress.proxy.protocol, 'http')
    assert.equal(health.egress.proxy.appliesToUpstream, true)
    assert.equal(health.egress.proxy.source, 'UPSTREAM_PROXY')

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: `smoke ${Date.now()}` }], stream: false }),
      signal: AbortSignal.timeout(90_000),
    })
    const payload = await chat.text()
    assert.ok([200, 401, 403, 429, 500, 502].includes(chat.status), `unexpected status ${chat.status}: ${payload.slice(0, 200)}`)
    const targets = proxy.state.connects.map((entry) => entry.authority)
    assert.ok(
      targets.some((authority) => authority.startsWith('opencode.ai:443')),
      `upstream traffic did not use the tunnel (CONNECTs seen: ${JSON.stringify(targets)})\n${logs.join('')}`,
    )
  } finally {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    child.kill('SIGKILL')
    await proxy.close()
  }
})
