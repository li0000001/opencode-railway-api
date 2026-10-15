import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids (opencode2api ids.go, verbatim semantics):
 * stable session/project ids derived from the conversation's first user turn,
 * and a per-request random id. The upstream sees CLI-identical correlation
 * headers built from these (zen-adapter.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  }
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
 * characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
 * rejects any other session shape with 403 FreeTierError ("free tier can
 * only be used from within OpenCode") — the plain User-Agent gate stopped
 * being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
 * Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
 * + bash/read tools, adapter/messages.ts); both must pass.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{9}ffe[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session passes through unchanged (preserving upstream prompt-cache
 * affinity); any other identity — the conversation seed in adapter mode,
 * foreign client sessions, admission probes — is deterministically hashed
 * into the canonical shape, so the same conversation keeps a stable session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  // Local patch (2026-10-13): the free-lane gate pins the session id's 12 hex
  // characters to the "ffe" tail that every real OpenCode session carries —
  // `ses_<9 hex>ffe<14 base62>` -> 200, any other tail -> 403 FreeTierError
  // (verified live on both `Bearer public` and a valid account token). Hashing
  // straight into 12 random hex passed only 1-in-4096 of the time, so every
  // request 403'd. Keep 9 hash-derived hex digits, then append the marker.
  const timePart = sum.subarray(0, 5).toString('hex').slice(0, 9) + 'ffe'
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${timePart}${randomPart}`
}

/**
 * OpenCode's client version, as reported in the User-Agent. The Zen free-lane
 * gate (2026-10-14) reads it from there and accepts only the official
 * "latest" spelling — `opencode/latest/<semver>/cli`. The older
 * `opencode/<semver> (<platform> ...)` shape now answers 403 FreeTierError.
 * Any current semver passes, so `ZEN_CLIENT_VERSION` is only there to follow
 * OpenCode's releases without a code change.
 */
const ZEN_CLIENT_VERSION = (process.env.ZEN_CLIENT_VERSION ?? '').trim() || '2.0.29'

/** Gate-valid user agent: the shape opencode v2 actually sends upstream. */
export function opencodeUserAgent(): string {
  return `opencode/latest/${ZEN_CLIENT_VERSION}/cli`
}

/**
 * The header set sent with every upstream request — byte-mirrored from the
 * official client's model-request.ts (live-verified 200 on 2026-10-15,
 * opencode v2.0.29 source + matrix probes):
 *
 * - session under `x-opencode-session` + `x-opencode-session-id` (+ the two
 *   affinity spellings the client also sends). `x-opencode-session` alone 403s.
 * - `x-opencode-project: global`: the literal the client sends outside a git
 *   project. Canonical `prj_*` ids 403 since 2026-10-14; bare 40-hex also
 *   passes, but `global` is exactly what a gateway (no single project) means.
 * - NO `x-opencode-request`: the gateway's own correlation header is rejected
 *   with 403 FreeTierError since 2026-10-14 (bisected live: identical request
 *   403s with it, 200s without). Request ids stay local-only (logs/pool).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-project': 'global',
  }
}
