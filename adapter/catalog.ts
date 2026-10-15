import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { opencodeUserAgent } from './ids.ts'

/**
 * Live model directory with a persisted snapshot and dynamic dead-model
 * suppression (no compiled-in model lists — the project judges, nobody
 * prescribes):
 *
 *   S1  GET {zen}/v1/models               live catalog (in-sale ids, free or paid)
 *   S2  GET https://models.dev/api.json   pricing metadata -> free decision
 *   S3  last-known-good snapshot on disk  bootstrap while S1 is pending
 *   S4  probed bans (persisted, expiring) models whose own calls failed dead
 *
 * /v1/models-equivalent exposure = S1 ∩ S2-allowed − S4-banned
 * (or S3 ∩ S2-allowed − S4-banned while S1 is pending).
 *
 * A model lands in S4 only when one of ITS OWN calls answers dead
 * (404, or 400 naming the model unavailable/unsupported/missing — never
 * 401/403/429/5xx, which are credential/gate/quota/capacity and say nothing
 * about the model). Bans back off exponentially and expire, so a revived
 * model returns by itself; any 2xx call clears the ban immediately.
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen'

/** First ban length; doubles per consecutive dead call, capped below. */
export const MODEL_BAN_BASE_MS = 6 * 60 * 60 * 1000
/** Upper bound for the ban backoff (a permanently dead model re-probes weekly). */
export const MODEL_BAN_MAX_MS = 7 * 24 * 60 * 60 * 1000
/** Snapshots older than this are ignored (stale booths must not fossilise). */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Whether an upstream answer proves the MODEL (not the credential, gate,
 * quota or capacity) is dead. Callers pass the upstream HTTP status and the
 * raw body text of a failed call for exactly one model id.
 */
export function isModelDeadSignal(status: number, text: string): boolean {
  if (status === 404) return true
  if (status !== 400) return false
  return /model.{0,60}(unavailable|not supported|not[ -]?supported|not found|does not exist)|no .{0,40}(endpoints|route)|model_not_found|invalid model|unsupported model/i.test(text)
}

export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}

export interface AnonymousDecision {
  allowed: boolean
  source: string
  known: boolean
}

interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
  /** models.dev `reasoning` flag: the model thinks by default. */
  reasoning?: boolean
  /** models.dev `reasoning_options` effort values the model declares (e.g. ["low","high"]). */
  effortValues?: string[]
  /** models.dev `limit.context`: the model's real context window. */
  contextWindow?: number
  /** models.dev `limit.output`: the model's real max output tokens. */
  maxOutput?: number
  /** models.dev `modalities.input`: the input kinds the model accepts
   *  (["text","image","video",…]). Absent when the metadata declares none, so
   *  the adapter keeps its own vision pattern for such a model. */
  modalities?: string[]
}

/** Decide (model_metadata.go Decide, ported with the deprecation fix).
 *
 * The upstream short-circuits on isFreeModel before consulting metadata, so a
 * delisted-but-still-cataloged id like deepseek-v4-flash-free stays exposed
 * forever. Here the order is: a ready metadata verdict (including deprecated)
 * always wins; the name fallback only fires when metadata cannot speak
 * (pending or model missing) — its original documented intent (design.md 4.2).
 */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model)
  const fallback = (source: string): AnonymousDecision => {
    if (nameFree) return { allowed: true, source: 'name_free', known: false }
    return { allowed: false, source, known: false }
  }
  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  const metadataFree = price.input === 0 && price.output === 0
  if (metadataFree) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true }
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
}

/**
 * decodeModelsDev (model_metadata.go:253-335): use the OpenCode provider
 * section of models.dev, preferring the exact `opencode`/`opencode-zen` key.
 */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>()
  if (!data || typeof data !== 'object') return result
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const keys = Object.keys(providers)
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  keys.sort((left, right) => {
    const leftRank = rank(left)
    const rightRank = rank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.localeCompare(right)
  })
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = providers[key]
    if (!provider || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!identity.includes('opencode')) continue
    }
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = (raw.cost ?? {}) as Record<string, unknown>
      const limit = (raw.limit ?? {}) as Record<string, unknown>
      const modalities = (raw.modalities ?? {}) as Record<string, unknown>
      const num = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined
      const contextWindow = num(limit.context)
      const maxOutput = num(limit.output)
      const inputModalities = decodeModalities(modalities.input)
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        ...decodeEffortValues(raw.reasoning_options),
        // Omitted when absent so caches written before limits existed stay valid.
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
        // Same for modalities: a cache written before this field existed carries
        // none, and the adapter then keeps its built-in vision pattern.
        ...(inputModalities !== undefined ? { modalities: inputModalities } : {}),
      })
    }
    if (result.size > 0) return result
  }
  return result
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true
  return model.deprecated_at != null || model.retirement_date != null
}

/**
 * models.dev `reasoning_options` (live shape 2026-09-18): an array of
 * `{type: "effort", values: [...]} | {type: "toggle"} | {type: "budget_tokens", ...}`
 * entries, absent when the model never thinks. Only the `effort` entries carry
 * selectable levels; `toggle`/`budget_tokens` map to "reasoning, no declared
 * ladder" and are reported as an empty array. Omitted entirely when the field
 * is absent so cached pre-reasoning metadata stays structurally valid.
 */
function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
  if (!Array.isArray(raw)) return {}
  const values: string[] = []
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue
    const entry = option as { type?: unknown; values?: unknown }
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue
    for (const value of entry.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
    }
  }
  return values.length > 0 ? { effortValues: values } : { effortValues: [] }
}

/**
 * models.dev `modalities.input` (live shape 2026-09-28): an array of lowercase
 * kind strings such as ["text","image","video","pdf","audio"]. Only a non-empty
 * array of non-empty strings is kept, so a malformed or absent field speaks for
 * nothing and the adapter keeps its own vision pattern (isVisionModel).
 */
function decodeModalities(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const kinds: string[] = []
  for (const kind of input) {
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds.length > 0 ? kinds : undefined
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
}

export interface CatalogOptions {
  /** S1 refresh cadence; the agent config uses models.refresh_seconds. */
  refreshSeconds?: number
  /**
   * Credential for the S1 models fetch. Defaults to the anonymous free lane
   * (`Bearer public`). A function is re-evaluated on every refresh (a key
   * pool's cooldowns move underneath us) and may return several credentials:
   * each list is fetched and the ids are unioned, so one source's gaps cancel
   * the other's (the keyed list omits a model a key can still call).
   */
  authorization?: string | (() => string | string[])
  /** Where the models.dev cache lives (agent data dir). */
  cachePath?: string
  /**
   * Where the last-known-good S1 snapshot + probed bans live. Defaults to
   * `<dirname(cachePath)>/catalog-snapshot.json` when a cachePath is set;
   * unset disables persistence (tests). The snapshot is what the picker
   * shows while S1 is still pending — yesterday's live list, not a
   * compile-time prescription.
   */
  snapshotPath?: string | null
  /** Upstream override for tests. */
  zenBaseUrl?: string
  /** models.dev override for tests. */
  metadataUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Observability hook: fired after every refresh round (start + interval). */
  onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  /** Delay between startup retries while the live catalog is empty (default 15s). */
  startupRetryMs?: number
}

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

/**
 * Live model directory with the S1/S2/snapshot/ban chain and the timer-driven
 * refresh loop. Only the models.dev cache and the snapshot/bans file persist.
 *
 * Decision chain: probed bans first, then the ready metadata verdict
 * (deprecated/paid deny, free cost allows); a "free" name never overrides a
 * negative metadata verdict, and the name fallback only fires when metadata
 * cannot speak (pending/missing) — its original documented intent.
 */
export class ModelCatalog {
  #zen: Set<string> = new Set()
  #updatedAt = 0
  #prices: Map<string, ModelPrice> = new Map()
  #pricesReady = false
  /** Last-known-good S1 ids, loaded from disk at start (S3 bootstrap). */
  #snapshotIds: string[] = []
  /** Active probed bans: model -> {ban ends at, consecutive dead calls}. */
  #bans = new Map<string, { until: number; consecutive: number }>()
  #lastError = ''
  #refreshSeconds: number
  #authorization: string | (() => string | string[])
  #cachePath?: string
  #snapshotPath?: string | null
  #zenBaseUrl: string
  #metadataUrl: string
  #fetch: typeof fetch
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  #startupRetryMs: number

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#authorization = options.authorization ?? 'Bearer public'
    this.#cachePath = options.cachePath
    this.#snapshotPath =
      options.snapshotPath === undefined
        ? options.cachePath === undefined
          ? undefined
          : join(dirname(options.cachePath), 'catalog-snapshot.json')
        : (options.snapshotPath ?? undefined)
    this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL
    this.#metadataUrl = options.metadataUrl ?? 'https://models.dev/api.json'
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#onRefresh = options.onRefresh
    this.#startupRetryMs = options.startupRetryMs ?? 15_000
  }

  /**
   * Start the refresh loop: immediate S1+S2, fast retries while the live
   * catalog is still empty (the first fetch often races the machine's network
   * coming up — VPN/TUN reconnect, DNS), then the normal cadence (S2 24h).
   */
  async start(): Promise<void> {
    await this.#loadPersisted()
    await this.refreshOnce()
    let attempts = 0
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async refreshOnce(): Promise<void> {
    await Promise.allSettled([this.refreshZen(), this.refreshMetadata()])
    if (this.#onRefresh) {
      try {
        this.#onRefresh(this.snapshot(), this.#lastError)
      } catch {
        // observers must never break the refresh loop
      }
    }
  }

  async refreshZen(): Promise<void> {
    try {
      const resolved = typeof this.#authorization === 'function' ? this.#authorization() : this.#authorization
      const auths = [...new Set(Array.isArray(resolved) ? resolved : [resolved])].filter((value) => value.length > 0)
      const results = await Promise.allSettled(
        auths.map((authorization) => fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent(), authorization)),
      )
      const lists = results
        .filter((result): result is PromiseFulfilledResult<string[]> => result.status === 'fulfilled')
        .map((result) => result.value)
      if (lists.length === 0) {
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        throw failure ? failure.reason : new Error('models endpoint returned no lists')
      }
      // Union, first source first: a partial failure (one credential refused)
      // still leaves the catalog as complete as the surviving sources allow.
      const union = new Set<string>()
      for (const list of lists) {
        for (const id of list) union.add(id)
      }
      this.#zen = union
      this.#updatedAt = this.#now()
      this.#lastError = ''
      await this.#savePersisted()
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata(): Promise<void> {
    try {
      const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: 'application/json' } }))
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const data = (await response.json()) as unknown
      const prices = decodeModelsDev(data)
      if (prices.size === 0) throw new Error('models.dev contains no OpenCode model metadata')
      this.#prices = prices
      this.#pricesReady = true
      if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now())
    } catch (err) {
      // Network failure with a cached copy is not fatal: load the cache.
      if (this.#cachePath && !this.#pricesReady) {
        const cached = await loadMetadataCache(this.#cachePath).catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  decision(model: string): AnonymousDecision {
    // S4 probed ban: one of this model's own calls already proved it dead.
    // Expired bans evaporate here so revived models return without a restart.
    const ban = this.#bans.get(model)
    if (ban !== undefined) {
      if (ban.until > this.#now()) {
        return { allowed: false, source: 'probed_dead', known: true }
      }
      this.#bans.delete(model)
    }
    const metadata = decide(model, this.#prices, this.#pricesReady)
    // A ready metadata verdict always wins; the name fallback only fires when
    // metadata cannot speak (pending or model missing) — its original
    // documented intent (design.md 4.2). Nobody vouches by name anymore:
    // deprecated stays hidden, delisted stays hidden, dead stays banned.
    return metadata
  }

  /** ids exposed to DSH: S1 ∩ allowed − banned, or the persisted snapshot while S1 is pending. */
  list(): string[] {
    const source = this.#zen.size === 0 ? this.#snapshotIds : [...this.#zen]
    const out: string[] = []
    for (const model of source) {
      if (this.decision(model).allowed) out.push(model)
    }
    return [...new Set(out)].sort()
  }

  /**
   * Record that one call for `model` answered dead (see isModelDeadSignal).
   * The ban starts at 6h and doubles per consecutive dead call (7d cap); any
   * success clears it via reportModelUsable. Expired bans lift themselves.
   */
  reportModelUnusable(model: string): void {
    if (!model) return
    const previous = this.#bans.get(model)
    const consecutive = (previous?.consecutive ?? 0) + 1
    const length = Math.min(MODEL_BAN_BASE_MS * 2 ** (consecutive - 1), MODEL_BAN_MAX_MS)
    this.#bans.set(model, { until: this.#now() + length, consecutive })
    void this.#savePersisted()
  }

  /** A 2xx answer for `model` lifts any probed ban immediately. */
  reportModelUsable(model: string): void {
    if (!model || !this.#bans.has(model)) return
    this.#bans.delete(model)
    void this.#savePersisted()
  }

  /** Currently banned ids (unexpired), for diagnostics. */
  bannedModels(): string[] {
    const now = this.#now()
    return [...this.#bans.entries()].filter(([, ban]) => ban.until > now).map(([model]) => model).sort()
  }

  /** Load the persisted snapshot + bans (start() only; never throws). */
  async #loadPersisted(): Promise<void> {
    if (!this.#snapshotPath) return
    try {
      const raw = JSON.parse(await readFile(this.#snapshotPath, 'utf8')) as {
        updatedAt?: unknown
        ids?: unknown
        bans?: unknown
      }
      const now = this.#now()
      if (typeof raw.updatedAt === 'number' && now - raw.updatedAt <= SNAPSHOT_MAX_AGE_MS && Array.isArray(raw.ids)) {
        this.#snapshotIds = raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      }
      if (raw.bans !== null && typeof raw.bans === 'object' && !Array.isArray(raw.bans)) {
        for (const [model, ban] of Object.entries(raw.bans as Record<string, unknown>)) {
          const record = ban as { until?: unknown; consecutive?: unknown }
          if (typeof record?.until === 'number' && record.until > now) {
            this.#bans.set(model, {
              until: record.until,
              consecutive: typeof record.consecutive === 'number' && record.consecutive > 0 ? Math.floor(record.consecutive) : 1,
            })
          }
        }
      }
    } catch {
      // a missing/corrupt snapshot is not fatal: S1 fills in shortly
    }
  }

  /** Persist the snapshot + bans (best effort; never throws into callers). */
  async #savePersisted(): Promise<void> {
    if (!this.#snapshotPath) return
    try {
      const now = this.#now()
      const bans: Record<string, { until: number; consecutive: number }> = {}
      for (const [model, ban] of this.#bans) {
        if (ban.until > now) bans[model] = ban
      }
      const payload = {
        updatedAt: this.#zen.size > 0 ? this.#updatedAt : now,
        ids: this.#zen.size > 0 ? [...this.#zen] : this.#snapshotIds,
        bans,
      }
      await mkdir(dirname(this.#snapshotPath), { recursive: true })
      const tmp = `${this.#snapshotPath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(payload), 'utf8')
      await rm(this.#snapshotPath, { force: true })
      await rename(tmp, this.#snapshotPath)
    } catch {
      // persistence is advisory; the live catalog is authoritative
    }
  }

  /**
   * models.dev declared limits for one model: `contextWindow` (limit.context)
   * and `maxOutput` (limit.output). undefined when the metadata cannot speak
   * for the model (pending, or id absent) or declares no limits — the caller
   * then keeps its own defaults.
   */
  limits(model: string): { contextWindow?: number; maxOutput?: number } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    if (price.contextWindow === undefined && price.maxOutput === undefined) return undefined
    return {
      ...(price.contextWindow !== undefined ? { contextWindow: price.contextWindow } : {}),
      ...(price.maxOutput !== undefined ? { maxOutput: price.maxOutput } : {}),
    }
  }

  /**
   * models.dev `modalities.input` for one model: the input kinds it accepts
   * (["text","image","video",…]). undefined when the metadata cannot speak for
   * the model (pending, or id absent) or declares no modalities — the caller
   * then keeps its own vision pattern (isVisionModel).
   */
  modalities(model: string): string[] | undefined {
    const modalities = this.#prices.get(model)?.modalities
    return modalities === undefined ? undefined : [...modalities]
  }

  /**
   * models.dev reasoning capability for one model: `reasoning` flags the
   * always-think models, `effortValues` the declared selectable levels
   * (empty array = reasons but declares no ladder). undefined when the
   * metadata cannot speak for the model (pending, or id absent).
   */
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] }
  }

  /** healthz models block (design.md 6.1). */
  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    }
  }

  get lastError(): string {
    return this.#lastError
  }
}

async function withTimeout(promise: Promise<Response>, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await promise
  } finally {
    clearTimeout(timer)
  }
}

/**
 * S1: fetchModels (models.go:587-618) with the CLI disguise headers.
 * `authorization` defaults to the anonymous free lane (`Bearer public`).
 */
export async function fetchZenModels(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
  authorization = 'Bearer public',
): Promise<string[]> {
  const response = await withTimeout(
    fetchImpl(`${zenBaseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        authorization,
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }),
  )
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const models: string[] = []
  for (const item of payload.data ?? []) {
    if (typeof item?.id === 'string' && item.id.length > 0) models.push(item.id)
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list')
  return models
}

interface MetadataCache {
  updatedAt: number
  prices: Array<[string, ModelPrice]>
}

async function saveMetadataCache(path: string, prices: Map<string, ModelPrice>, now: number): Promise<void> {
  const cache: MetadataCache = { updatedAt: now, prices: [...prices] }
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rm(path, { force: true })
  await rename(tmp, path)
}

async function loadMetadataCache(path: string): Promise<Map<string, ModelPrice>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetadataCache
  if (Date.now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) {
    throw new Error('models.dev cache too old')
  }
  return new Map(raw.prices)
}

/** Default cache location next to the agent data dir (config.ts convention). */
export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'agent-config.json.models.dev.json')
}
