export const RESPONSES_ONLY_PREFIX = 'muse-spark'

export function isResponsesModel(id: string): boolean {
  return String(id ?? '').toLowerCase().startsWith(RESPONSES_ONLY_PREFIX)
}

export function apiForModel(id: string): 'openai-responses' | 'openai-completions' {
  return isResponsesModel(id) ? 'openai-responses' : 'openai-completions'
}
