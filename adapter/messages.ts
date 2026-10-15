import { apiForModel } from './routing.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room version of
 * dsh-llm-pi-ai's textOnlyContext). Unlike the host's text-only projection,
 * user and tool-result image blocks are kept: the adapter declares image
 * input modalities, so dsh-llm forwards them untouched and the bytes load
 * from the harness attachment store here.
 */

export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant'
  content: HarnessBlock[]
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoning?: string
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** pi-ai message vocabulary (subset we emit). */
export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[]; timestamp: number }
  | {
      role: 'assistant'
      content: PiAssistantBlock[]
      api: 'openai-completions' | 'openai-responses'
      provider: string
      model: string
      usage: PiUsage
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: PiContentBlock[]; isError: boolean; timestamp: number }

export type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiTool {
  name: string
  description: string
  parameters: unknown
}

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: PiTool[]
}

export function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}

/**
 * Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
 * DSH_HOME is always set by the harness child; the homedir fallback covers
 * direct invocation (tests, tooling).
 */
function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/**
 * Convert one harness image block to pi-ai ImageContent by reading the
 * content-addressed normalized object (DSH_HOME/attachments/v1/objects/<2>/<sha>).
 * Falls back to stable text on any failure so a missing object can never
 * fail the whole stream.
 */
async function toPiImage(ref: unknown): Promise<PiContentBlock> {
  const attachment = (ref ?? {}) as { attachmentId?: unknown; mediaType?: unknown }
  const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
  const sha = id.startsWith('sha256:') ? id.slice(7) : id
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return { type: 'text', text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]` }
  }
  const path = join(dshHome(), 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  try {
    const bytes = await readFile(path)
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0 ? attachment.mediaType : 'image/png',
    }
  } catch {
    return { type: 'text', text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]` }
  }
}

/**
 * Host-budget-offloaded images were routed out of the request by dsh-llm on
 * purpose (`offloaded: true`); re-reading their bytes from disk would defy the
 * image budget the host already enforced. Emit a stable placeholder instead —
 * the same semantics as the host adapter's projectOffloadedImages.
 */
function offloadedImagePart(ref: unknown): PiContentBlock {
  const id = (ref as { attachmentId?: unknown } | null | undefined)?.attachmentId
  const short = typeof id === 'string' && id.length > 0 ? ` ${id.slice(0, 30)}` : ''
  return { type: 'text', text: `[image omitted: offloaded to fit the request image budget${short}]` }
}

/** One image block, respecting the host's offload flag. */
async function imagePart(block: { type?: unknown; attachment?: unknown; offloaded?: unknown }): Promise<PiContentBlock> {
  return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment)
}

/** Text/image parts of one user message's content, in block order. */
async function userParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    }
  }
  return parts
}

/** Text/image parts of one tool result's content, walking nested results. */
async function toolResultParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    } else if (block.type === 'tool-result') {
      parts.push(...(await toolResultParts(block.content)))
    }
  }
  return parts
}

function toPiAssistant(message: HarnessMessage, providerId: string): Extract<PiMessage, { role: 'assistant' }> {
  const content: PiAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      case 'image':
        break // assistant images are not replayable; drop rather than fail the stream
      default:
        break
    }
  }
  const source = message.source
  const model = source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId
  return {
    role: 'assistant',
    content,
    api: apiForModel(model),
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model,
    usage: zeroUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function flattenText(message: HarnessMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/**
 * Convert the harness conversation into a pi-ai Context. User and tool-result
 * messages keep text AND image blocks (images load from the harness
 * attachment store); tool results as toolResult messages, assistant history as
 * pi-ai assistant messages. Async because image bytes are read from disk.
 */
export async function toPiContext(options: HarnessGenerateOptions): Promise<PiContext> {
  const providerId = options.provider
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text.length > 0) messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, providerId)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const parts = await userParts(message.content)
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (parts.length > 0 || results.length === 0) {
      const first = parts[0]
      let content: string | PiContentBlock[]
      if (parts.length === 0) content = ''
      else if (parts.length === 1 && first?.type === 'text') content = first.text
      else content = parts
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      let rparts = await toolResultParts(result.content)
      const hasImage = rparts.some((part) => part.type === 'image')
      const hasText = rparts.some((part) => part.type === 'text' && part.text.length > 0)
      if (!hasImage && !hasText) rparts = [{ type: 'text', text: '(no output)' }]
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: rparts,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const context: PiContext = { messages }
  if (typeof options.system === 'string' && options.system.length > 0) context.systemPrompt = options.system
  const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}

/**
 * The Zen free-lane "content gate" (live-probed 2026-10-14, opencode v2.0.27).
 * A request reaches a `*-free` model only when ALL of these hold:
 *
 *   1. a real OpenCode credential — `Bearer st_…` (an account OAuth access
 *      token). The old anonymous `Bearer public` now answers 403 FreeTierError,
 *      and an `oc_sk_…` Zen key answers 403 permission_error ("Workspace
 *      access denied"). See ids.ts + server.ts `ZEN_ACCESS_TOKEN`.
 *   2. `User-Agent: opencode/latest/<semver>/cli` (ids.ts).
 *   3. `x-opencode-session` AND `x-opencode-session-id` in the same request
 *      (ids.ts disguiseHeaders).
 *   4. an agent-shaped body: `stream: true`, a `tool_choice` that is not
 *      "none", and `tools` carrying OpenCode's own `read` and `shell`
 *      declarations — names, descriptions and parameter schemas included.
 *      Shrunk or fabricated declarations 403, a description that only shares
 *      the first characters 403s too, and a *second* tool under either name
 *      fails as well: the gate wants exactly one official declaration each.
 *
 * GATE_TOOL_BODIES below is the pair captured verbatim from that client and
 * verified 200 against both /zen/v1/chat/completions and /zen/v1/responses.
 * Refreshing it means re-capturing an opencode request (see README, "上游免费
 * 通道与内容门禁"): the gate tracks the real client, so its tool text drifts
 * with each opencode release.
 */
export const FREE_LANE_GATE_TOOL_NAMES = ['read', 'shell'] as const

export interface FreeLaneGateTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict: boolean
  }
}

const GATE_TOOL_BODIES: Record<(typeof FREE_LANE_GATE_TOOL_NAMES)[number], Omit<FreeLaneGateTool['function'], 'name'>> = {
  read: {
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'The line or directory entry to start reading from (1-based)',
        },
        limit: {
          type: 'integer',
          minimum: 0,
          description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: false,
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: {
          type: 'string',
          description:
            'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.',
        },
        timeout: {
          type: 'integer',
          minimum: 0,
          description:
            'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.',
        },
        background: {
          type: 'boolean',
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    strict: false,
  },
}

export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return { type: 'function', function: { name, ...GATE_TOOL_BODIES[name] } }
}

function isGateToolName(name: unknown): boolean {
  return typeof name === 'string' && (FREE_LANE_GATE_TOOL_NAMES as readonly string[]).includes(name)
}

/** Chat-completions tools nest under `function`; responses tools are flat. */
function chatToolName(tool: unknown): unknown {
  const fn = typeof tool === 'object' && tool !== null ? (tool as { function?: { name?: unknown } }).function : undefined
  return typeof fn === 'object' && fn !== null ? fn.name : undefined
}

function responsesToolName(tool: unknown): unknown {
  const candidate = typeof tool === 'object' && tool !== null ? (tool as { type?: unknown; name?: unknown }) : undefined
  return candidate?.type === 'function' ? candidate.name : undefined
}

/**
 * Drop client tools that collide with the gate pair, then append the official
 * declarations. Merging instead of replacing would send two `read`s and fail:
 * the gate matches declarations by name and rejects the whole request when one
 * of them is not OpenCode's own.
 */
function gateTools(tools: unknown[], nameOf: (tool: unknown) => unknown, flatten: boolean): unknown[] {
  const kept = tools.filter((tool) => !isGateToolName(nameOf(tool)))
  const injected = FREE_LANE_GATE_TOOL_NAMES.map((name) =>
    flatten ? { type: 'function', ...freeLaneGateTool(name).function } : freeLaneGateTool(name),
  )
  return [...kept, ...injected]
}

/**
 * The Responses endpoint validates tool JSON schemas: nesting deeper than 10
 * levels is rejected outright ("JSON schema exceeds the maximum nesting depth
 * of 10 levels", live 2026-10-15 on muse-spark-1.3 with the harness/MCP toolset
 * attached — the chat endpoint does not enforce it, so the same tools pass on
 * chat models and only Responses calls fail). Cap foreign schemas at the same
 * depth the genuine gate definitions provably pass (a gate-only Responses
 * request with 5-deep tools clears validation; counted from the tool object);
 * official gate definitions are byte-compared by the free-tier gate and are
 * never touched. Pruned branches become `true` (valid JSON Schema for "any
 * value"). Only object nesting counts toward the cap — `required`/`enum`
 * value lists are transparent, so ordinary tools (whose leaves sit at object
 * depth 4, exactly like the genuine definitions) pass through byte-identical
 * and only genuinely pathological schemas change.
 */
export const RESPONSES_MAX_SCHEMA_DEPTH = 5

function truncateSchemaDepth(node: unknown, objectDepth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => truncateSchemaDepth(item, objectDepth))
  if (node !== null && typeof node === 'object') {
    if (objectDepth >= RESPONSES_MAX_SCHEMA_DEPTH) return true
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) out[key] = truncateSchemaDepth(value, objectDepth + 1)
    return out
  }
  return node
}

/** Max container-nesting depth of a value (objects/arrays count, scalars 0). */
export function schemaDepth(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((max, item) => Math.max(max, schemaDepth(item)), 0) + (node.length > 0 ? 1 : 0)
  }
  if (node !== null && typeof node === 'object') {
    const keys = Object.keys(node)
    return keys.reduce((max, key) => Math.max(max, schemaDepth((node as Record<string, unknown>)[key])), 0) + (keys.length > 0 ? 1 : 0)
  }
  return 0
}

/**
 * Repair structurally invalid foreign schemas on top of the depth cap. The
 * Responses validator rejects the whole request when one tool's parameters
 * are not a valid function schema ("... is not valid under any of the schemas
 * listed in the 'anyOf' keyword", live 2026-10-15: a harness `question` tool
 * whose `properties` is boolean `true`). The chat endpoint tolerates the same
 * shapes, so this runs on the Responses path only. Rules are minimal and only
 * ever loosen: non-object parameters become `{type:'object'}`; a non-object
 * `properties` is dropped together with its dangling `required`; `required`
 * entries not present in `properties` are filtered out; a non-boolean
 * `additionalProperties` is dropped. Official gate definitions never reach
 * here (returned verbatim above).
 */
function sanitizeResponsesParameters(tool: Record<string, unknown>): Record<string, unknown> {
  const raw = tool.parameters
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...tool, parameters: { type: 'object' } }
  }
  let parameters: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  const properties = parameters.properties
  if (properties !== undefined && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
    delete parameters.properties
    delete parameters.required
  } else if (
    Array.isArray(parameters.required) &&
    properties !== undefined &&
    typeof properties === 'object' &&
    properties !== null &&
    !Array.isArray(properties)
  ) {
    const declared = new Set(Object.keys(properties as Record<string, unknown>))
    const kept = (parameters.required as unknown[]).filter(
      (name): name is string => typeof name === 'string' && declared.has(name),
    )
    if (kept.length !== (parameters.required as unknown[]).length) {
      if (kept.length > 0) parameters.required = kept
      else delete parameters.required
    }
  }
  if (parameters.additionalProperties !== undefined && typeof parameters.additionalProperties !== 'boolean') {
    delete parameters.additionalProperties
  }
  if (typeof parameters.type !== 'string') parameters.type = 'object'
  return { ...tool, parameters: truncateSchemaDepth(parameters, 1) }
}

/**
 * Rewrite a Responses payload (flat function tools) for the free lane. Returns
 * a new payload; the caller sends it as-is. `tool_choice` "auto" is the only
 * accepted value there, so anything else is normalised. Foreign (harness/MCP)
 * tool schemas are depth-capped and structurally repaired so the endpoint's
 * validators pass; recognised official tools keep their genuine definitions
 * verbatim.
 */
export function ensureResponsesFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.input)) return undefined
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const shaped = gateTools(tools, responsesToolName, true).map((tool) => {
    if (isGateToolName(responsesToolName(tool))) return tool
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return tool
    return sanitizeResponsesParameters(truncateSchemaDepth(tool, 0) as Record<string, unknown>)
  })
  const next: Record<string, unknown> = { ...body, tools: shaped }
  if (body.tool_choice !== 'auto') next.tool_choice = 'auto'
  return next
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the free-lane
 * content gate (wired through pi-ai's onPayload). Always returns a shaped copy:
 * the gate inspects the tool declarations themselves, so a payload that merely
 * *has* a `read` tool still has to be replaced with OpenCode's.
 */
export function ensureFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const next: Record<string, unknown> = { ...body, tools: gateTools(tools, chatToolName, false) }
  // "none" was the old way to keep the model off the injected stubs; the gate
  // rejects it outright now, and the injected pair is what satisfies it.
  if (body.tool_choice === 'none') next.tool_choice = 'auto'
  return next
}
