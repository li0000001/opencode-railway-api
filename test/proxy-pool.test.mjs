/**
 * Zero-dependency tests for the free-proxy auto pool (proxy-pool.ts).
 *
 * Fully offline: list parsing is fed from strings, the Zen probe and the TCP
 * liveness gate are injected, so the pool's selection/rotation/refresh policy
 * is exercised without a single outbound connection.
 *
 *   npm test
 *   node --test test/proxy-pool.test.mjs
 *
 * (Node's runner wants the file path last: `node --test [flags] <file>`.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ProxyPool,
  classifyProbeResult,
  parseProxyCandidate,
  parseProxyLines,
  proxyKey,
  proxyRotationReason,
} from '../proxy-pool.ts'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A probe whose answers are looked up by host at call time (mutable). */
function cannedProbe(answers, calls = []) {
  const probe = async (proxy) => {
    calls.push(`${proxy.protocol}://${proxy.host}:${proxy.port}`)
    const answer = answers[proxy.host]
    if (answer === undefined) return { status: 0, text: '', latencyMs: 1, error: 'unconfigured' }
    if (typeof answer === 'function') return answer(proxy)
    return answer
  }
  return { probe, calls }
}

const clean = (latencyMs) => ({ status: 200, text: 'data: hello', latencyMs })
const flagged = (latencyMs = 10) => ({
  status: 403,
  text: '{"type":"error","error":{"type":"FreeTierError","message":"we\'ve detected abusive traffic from this IP address"}}',
  latencyMs,
})
const quota = (latencyMs = 10) => ({ status: 429, text: '{"type":"error","error":{"type":"FreeUsageLimitError"}}', latencyMs })

const seedPool = (hosts, options = {}) =>
  new ProxyPool({
    sources: [],
    seed: hosts.map((host) => `socks5://${host}:1080`),
    targetSize: options.targetSize ?? 2,
    log: () => {},
    ...options,
  })

// ---------------------------------------------------------------------------
// List parsing
// ---------------------------------------------------------------------------

test('parseProxyCandidate accepts every list shape', () => {
  assert.deepEqual(parseProxyCandidate('1.2.3.4:8080', 'socks5'), { protocol: 'socks5', host: '1.2.3.4', port: 8080 })
  assert.deepEqual(parseProxyCandidate('http://1.2.3.4:3128', 'socks5'), { protocol: 'http', host: '1.2.3.4', port: 3128 })
  assert.deepEqual(parseProxyCandidate('socks5h://1.2.3.4:1080', 'http'), { protocol: 'socks5', host: '1.2.3.4', port: 1080 })
  assert.deepEqual(parseProxyCandidate('socks5://user:pa%40ss@1.2.3.4:1080', 'http'), {
    protocol: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: 'user',
    password: 'pa@ss',
  })
})

test('parseProxyCandidate rejects junk without throwing', () => {
  assert.equal(parseProxyCandidate('', 'socks5'), null)
  assert.equal(parseProxyCandidate('# comment', 'socks5'), null)
  assert.equal(parseProxyCandidate('not a proxy', 'socks5'), null)
  assert.equal(parseProxyCandidate('1.2.3.4:99999', 'socks5'), null)
  assert.equal(parseProxyCandidate('ftp://1.2.3.4:21', 'socks5'), null)
})

test('parseProxyLines dedupes and caps', () => {
  const lines = parseProxyLines('1.1.1.1:1\n1.1.1.1:1\n2.2.2.2:2\n\n# x\n3.3.3.3:3\n', 'socks5', 2)
  assert.deepEqual(
    lines.map((candidate) => proxyKey(candidate)),
    ['socks5://1.1.1.1:1', 'socks5://2.2.2.2:2'],
  )
})

// ---------------------------------------------------------------------------
// Probe classification
// ---------------------------------------------------------------------------

test('classifyProbeResult maps probe outcomes to pool states', () => {
  assert.equal(classifyProbeResult(clean(5)).status, 'clean')
  assert.equal(classifyProbeResult(quota()).status, 'cooling')
  assert.equal(classifyProbeResult(flagged()).status, 'dead')
  assert.equal(classifyProbeResult({ status: 407, text: '', latencyMs: 1 }).status, 'dead')
  assert.equal(classifyProbeResult({ status: 0, text: '', latencyMs: 1, error: 'boom' }).status, 'dead')
  // A 403 about the client shape is not the exit's fault, but it cannot be used
  // as a clean exit either: it is parked as dead with a readable reason.
  const shape = classifyProbeResult({ status: 403, text: 'free tier can only be used from within OpenCode', latencyMs: 1 })
  assert.equal(shape.status, 'dead')
})

test('proxyRotationReason only blames the exit for 429 and the abuse 403', () => {
  assert.match(proxyRotationReason(429, ''), /quota/)
  assert.match(proxyRotationReason(403, 'detected abusive traffic from this IP address'), /flagged/)
  assert.equal(proxyRotationReason(403, 'Workspace access denied'), null)
  assert.equal(proxyRotationReason(401, ''), null)
  assert.equal(proxyRotationReason(500, ''), null)
})

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

test('pool keeps the fastest clean exit current and leases agents', async () => {
  const { probe, calls } = cannedProbe({
    '10.0.0.1': clean(900),
    '10.0.0.2': clean(120),
    '10.0.0.3': flagged(50),
  })
  const pool = seedPool(['10.0.0.1', '10.0.0.2', '10.0.0.3'], { targetSize: 2, probe })
  const summary = await pool.refreshNow()

  assert.equal(summary.probes, 3)
  assert.equal(summary.clean, 2)
  assert.equal(summary.dead, 1)
  assert.equal(calls.length, 3)
  assert.equal(pool.current().host, '10.0.0.2')
  assert.equal(pool.count('clean'), 2)

  const lease = pool.lease()
  assert.equal(lease.entry.host, '10.0.0.2')
  assert.ok(lease.pooled && lease.fresh, 'both tunnel agents are created on demand')
  pool.stop()
})

test('a 429 retires the exit and the next spare takes over', async () => {
  const { probe } = cannedProbe({ '10.0.0.1': clean(100), '10.0.0.2': clean(200) })
  const pool = seedPool(['10.0.0.1', '10.0.0.2'], { targetSize: 2, probe })
  await pool.refreshNow()

  const first = pool.current()
  assert.equal(first.host, '10.0.0.1')
  pool.reportStatus(first, 429, quota().text)

  assert.equal(first.status, 'cooling')
  const second = pool.current()
  assert.equal(second.host, '10.0.0.2')
  pool.stop()
})

test('the abuse 403 kills the exit and empties the pool when it was the last one', async () => {
  const { probe } = cannedProbe({ '10.0.0.1': clean(100) })
  const pool = seedPool(['10.0.0.1'], { targetSize: 1, probe })
  await pool.refreshNow()

  const only = pool.current()
  pool.reportStatus(only, 403, flagged().text)
  assert.equal(only.status, 'dead')
  assert.equal(pool.current(), null)
  assert.equal(pool.snapshot().clean, 0)
  pool.stop()
})

test('a healthy pool spends no probes on refresh', async () => {
  const { probe, calls } = cannedProbe({ '10.0.0.1': clean(100) })
  const pool = seedPool(['10.0.0.1'], { targetSize: 1, probe })
  await pool.refreshNow()
  assert.equal(calls.length, 1)

  const second = await pool.refreshNow()
  assert.equal(second.probes, 0)
  assert.equal(calls.length, 1)
  pool.stop()
})

test('cooling exits are retried once their cooldown expires', async () => {
  const answers = { '10.0.0.1': quota() }
  const { probe, calls } = cannedProbe(answers)
  const pool = seedPool(['10.0.0.1'], { targetSize: 1, coolingMs: 1, probe })

  await pool.refreshNow()
  assert.equal(pool.count('cooling'), 1)
  assert.equal(pool.current(), null)
  assert.equal(calls.length, 1, 'a fresh cooldown is not retried inside the same refresh')

  await new Promise((resolve) => setTimeout(resolve, 20))
  answers['10.0.0.1'] = clean(30)
  await pool.refreshNow()
  assert.equal(pool.count('clean'), 1)
  assert.equal(pool.current().host, '10.0.0.1')
  assert.equal(calls.length, 2)
  pool.stop()
})

test('network failures only retire an exit after they repeat', async () => {
  const { probe } = cannedProbe({ '10.0.0.1': clean(10), '10.0.0.2': clean(20) })
  const pool = seedPool(['10.0.0.1', '10.0.0.2'], { targetSize: 2, probe })
  await pool.refreshNow()

  const first = pool.current()
  pool.reportError(first, new Error('socket hang up'))
  assert.equal(first.status, 'clean', 'one transient failure keeps the exit usable')

  pool.reportError(first, new Error('socket hang up'))
  assert.equal(first.status, 'cooling')
  assert.equal(pool.current().host, '10.0.0.2')
  pool.stop()
})

// ---------------------------------------------------------------------------
// Source collection
// ---------------------------------------------------------------------------

test('pool collects text and geonode sources through the TCP gate', async () => {
  const fetched = []
  const { probe, calls } = cannedProbe({ '10.9.9.9': clean(70), '10.8.8.8': clean(20) })
  const pool = new ProxyPool({
    sources: [
      { url: 'https://lists.test/socks.txt', protocol: 'socks5' },
      { url: 'https://lists.test/geonode.json', protocol: 'socks5', format: 'geonode' },
    ],
    targetSize: 2,
    probe,
    liveness: async () => true,
    fetchText: async (url) => {
      fetched.push(url)
      if (url.endsWith('.json')) {
        return JSON.stringify({ data: [{ ip: '10.9.9.9', port: '1080', protocols: ['socks5'] }] })
      }
      return '10.8.8.8:1080\nnot a proxy\n'
    },
    log: () => {},
  })

  const summary = await pool.refreshNow()
  assert.equal(fetched.length, 2)
  assert.equal(summary.sourcesOk, 2)
  assert.equal(summary.sourcesFailed, 0)
  assert.equal(summary.clean, 2)
  assert.equal(pool.current().host, '10.8.8.8', 'lowest latency wins')
  assert.deepEqual(calls.sort(), ['socks5://10.8.8.8:1080', 'socks5://10.9.9.9:1080'])
  pool.stop()
})

test('a failed source does not abort the refresh', async () => {
  const { probe } = cannedProbe({ '10.8.8.8': clean(20) })
  const pool = new ProxyPool({
    sources: [
      { url: 'https://lists.test/dead.txt', protocol: 'socks5' },
      { url: 'https://lists.test/ok.txt', protocol: 'socks5' },
    ],
    targetSize: 1,
    probe,
    liveness: async () => true,
    fetchText: async (url) => {
      if (url.includes('dead')) throw new Error('HTTP 503')
      return '10.8.8.8:1080\n'
    },
    log: () => {},
  })

  const summary = await pool.refreshNow()
  assert.equal(summary.sourcesOk, 1)
  assert.equal(summary.sourcesFailed, 1)
  assert.equal(summary.clean, 1)
  pool.stop()
})

test('refreshNow is serialized: concurrent callers share one scan', async () => {
  let probes = 0
  const pool = new ProxyPool({
    sources: [],
    seed: ['socks5://10.0.0.1:1080'],
    targetSize: 1,
    log: () => {},
    probe: async () => {
      probes += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return clean(10)
    },
  })
  await Promise.all([pool.refreshNow(), pool.refreshNow(), pool.refreshNow()])
  assert.equal(probes, 1)
  pool.stop()
})

test('in-flight probes show as pending, never as dead', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const pool = new ProxyPool({
    sources: [],
    seed: ['socks5://10.0.0.1:1080'],
    targetSize: 1,
    log: () => {},
    probe: async () => {
      await gate
      return clean(10)
    },
  })
  const refreshing = pool.refreshNow()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const during = pool.snapshot()
  assert.equal(during.pending, 1)
  assert.equal(during.dead, 0)
  assert.equal(during.clean, 0)

  release()
  await refreshing
  const after = pool.snapshot()
  assert.equal(after.pending, 0)
  assert.equal(after.clean, 1)
  pool.stop()
})
