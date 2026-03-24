import prisma from '@/lib/db'
import { getCliAuthStatus, getCliAvailability } from '@/lib/claude-cli-auth'
import { getCodexCliAuthStatus, getCodexCliAvailability } from '@/lib/openai-auth'
import { AIClient, type ResolvableBackend, resolveAIClientForBackend } from './ai-client'
import { ensureServerEnvLoaded } from './env-loader'

ensureServerEnvLoaded()

export type AiBackendId = ResolvableBackend
export type LegacyProvider = 'anthropic' | 'openai'
export type ResolutionSource = 'override' | 'env' | 'db' | 'autodetect' | 'fallback'

export interface AiCapabilities {
  textGeneration: boolean
  inlineImages: boolean
  urlOnlyVisionFallback: boolean
  cliPrompt: 'none' | 'claude' | 'codex'
  healthCheckMethod: 'sdk_ping' | 'http_head' | 'cli_version' | 'none'
  modelSource: 'env' | 'db' | 'fixed_default' | 'mixed'
  supportsExecutionFallback: boolean
  unattendedToolExecution: boolean
}

export interface ResolvedAiBackend {
  backend: AiBackendId
  model: string
  client: AIClient | null
  capabilities: AiCapabilities
  resolutionSource: ResolutionSource
  fallbackTrail: AiBackendId[]
  errorTrail: string[]
}

interface ResolveAiBackendOptions {
  preferredBackend?: AiBackendId
  allowFallback?: boolean
  overrideKey?: string
}

interface StoredSettings {
  aiProvider: string | null
  anthropicModel: string | null
  openaiModel: string | null
  anthropicApiKey: string | null
  openaiApiKey: string | null
  openrouterApiKey: string | null
  geminiApiKey: string | null
  opencodeApiKey: string | null
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

export function normalizeBackend(value: string | null | undefined): AiBackendId | null {
  if (!value) return null
  switch (value.trim().toLowerCase()) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
    case 'gemini':
    case 'opencode':
    case 'acp_cursor':
    case 'acp_amp':
      return value.trim().toLowerCase() as AiBackendId
    default:
      return null
  }
}

export function parseBackendList(input: string | undefined): AiBackendId[] {
  if (!input?.trim()) return []
  return input
    .split(',')
    .map((raw) => normalizeBackend(raw))
    .filter((v): v is AiBackendId => v !== null)
}

function parseBooleanEnv(name: string): boolean | null {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return null
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return null
}

function isBackendEnabled(backend: AiBackendId): boolean {
  const envName = `SIFTLY_AI_ENABLE_${backend.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const value = parseBooleanEnv(envName)
  if (value === null) return true
  return value
}

function isAcpEnabled(): boolean {
  const value = parseBooleanEnv('SIFTLY_EXPERIMENTAL_ACP')
  return value === true
}

function getCapabilities(backend: AiBackendId, modelSource: AiCapabilities['modelSource']): AiCapabilities {
  if (backend === 'anthropic') {
    return {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'claude',
      healthCheckMethod: 'sdk_ping',
      modelSource,
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    }
  }

  if (backend === 'openai') {
    return {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'codex',
      healthCheckMethod: 'sdk_ping',
      modelSource,
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    }
  }

  if (backend === 'openrouter') {
    return {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'none',
      healthCheckMethod: 'sdk_ping',
      modelSource,
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    }
  }

  if (backend === 'gemini') {
    return {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'none',
      healthCheckMethod: 'http_head',
      modelSource,
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    }
  }

  if (backend === 'opencode') {
    return {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'none',
      healthCheckMethod: 'http_head',
      modelSource,
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    }
  }

  return {
    textGeneration: true,
    inlineImages: false,
    urlOnlyVisionFallback: true,
    cliPrompt: 'none',
    healthCheckMethod: 'cli_version',
    modelSource,
    supportsExecutionFallback: false,
    unattendedToolExecution: false,
  }
}

async function loadStoredSettings(): Promise<StoredSettings> {
  const keys = [
    'aiProvider',
    'anthropicModel',
    'openaiModel',
    'anthropicApiKey',
    'openaiApiKey',
    'openrouterApiKey',
    'geminiApiKey',
    'opencodeApiKey',
  ]
  const rows = await prisma.setting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    aiProvider: map.get('aiProvider') ?? null,
    anthropicModel: map.get('anthropicModel') ?? null,
    openaiModel: map.get('openaiModel') ?? null,
    anthropicApiKey: map.get('anthropicApiKey') ?? null,
    openaiApiKey: map.get('openaiApiKey') ?? null,
    openrouterApiKey: map.get('openrouterApiKey') ?? null,
    geminiApiKey: map.get('geminiApiKey') ?? null,
    opencodeApiKey: map.get('opencodeApiKey') ?? null,
  }
}

async function autodetectBackend(): Promise<AiBackendId> {
  const claudeStatus = getCliAuthStatus()
  if (claudeStatus.available && !claudeStatus.expired) return 'anthropic'

  const codexStatus = getCodexCliAuthStatus()
  if (codexStatus.available && !codexStatus.expired && await getCodexCliAvailability()) {
    return 'openai'
  }
  return 'anthropic'
}

function resolveModel(
  backend: AiBackendId,
  settings: StoredSettings,
): { model: string; modelSource: AiCapabilities['modelSource'] } {
  if (backend === 'anthropic') {
    if (process.env.SIFTLY_ANTHROPIC_MODEL?.trim()) {
      return { model: process.env.SIFTLY_ANTHROPIC_MODEL.trim(), modelSource: 'env' }
    }
    if (settings.anthropicModel?.trim()) {
      return { model: settings.anthropicModel.trim(), modelSource: 'db' }
    }
    return { model: 'claude-haiku-4-5-20251001', modelSource: 'fixed_default' }
  }

  if (backend === 'openai') {
    if (process.env.SIFTLY_OPENAI_MODEL?.trim()) {
      return { model: process.env.SIFTLY_OPENAI_MODEL.trim(), modelSource: 'env' }
    }
    if (settings.openaiModel?.trim()) {
      return { model: settings.openaiModel.trim(), modelSource: 'db' }
    }
    return { model: 'gpt-5.4-mini', modelSource: 'fixed_default' }
  }

  if (backend === 'openrouter') {
    return {
      model: process.env.OPENROUTER_MODEL?.trim() || 'openai/gpt-5.4-mini',
      modelSource: process.env.OPENROUTER_MODEL?.trim() ? 'env' : 'fixed_default',
    }
  }

  if (backend === 'gemini') {
    return {
      model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
      modelSource: process.env.GEMINI_MODEL?.trim() ? 'env' : 'fixed_default',
    }
  }

  if (backend === 'opencode') {
    return {
      model: process.env.OPENCODE_MODEL?.trim() || 'gpt-5.4-mini',
      modelSource: process.env.OPENCODE_MODEL?.trim() ? 'env' : 'fixed_default',
    }
  }

  if (backend === 'acp_cursor') {
    return {
      model: process.env.SIFTLY_ACP_CURSOR_MODEL?.trim() || process.env.SIFTLY_ACP_MODEL?.trim() || 'gpt-5.4-mini',
      modelSource: process.env.SIFTLY_ACP_CURSOR_MODEL?.trim() || process.env.SIFTLY_ACP_MODEL?.trim() ? 'env' : 'fixed_default',
    }
  }

  return {
    model: process.env.SIFTLY_ACP_AMP_MODEL?.trim() || process.env.SIFTLY_ACP_MODEL?.trim() || 'gpt-5.4-mini',
    modelSource: process.env.SIFTLY_ACP_AMP_MODEL?.trim() || process.env.SIFTLY_ACP_MODEL?.trim() ? 'env' : 'fixed_default',
  }
}

function getDbKeyForBackend(backend: AiBackendId, settings: StoredSettings): string | undefined {
  if (backend === 'anthropic') return settings.anthropicApiKey?.trim() || undefined
  if (backend === 'openai') return settings.openaiApiKey?.trim() || undefined
  if (backend === 'openrouter') return settings.openrouterApiKey?.trim() || undefined
  if (backend === 'gemini') return settings.geminiApiKey?.trim() || undefined
  if (backend === 'opencode') return settings.opencodeApiKey?.trim() || undefined
  return undefined
}

async function hasPromptCli(backend: AiBackendId): Promise<boolean> {
  if (backend === 'anthropic') {
    return getCliAvailability()
  }
  if (backend === 'openai') {
    return getCodexCliAvailability()
  }
  return false
}

function uniqueOrder(list: AiBackendId[]): AiBackendId[] {
  const seen = new Set<AiBackendId>()
  const out: AiBackendId[] = []
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

export function buildResolutionCandidates(primary: AiBackendId, fallbackList: AiBackendId[]): AiBackendId[] {
  return uniqueOrder([primary, ...fallbackList])
}

export async function resolveAiBackend(options: ResolveAiBackendOptions = {}): Promise<ResolvedAiBackend> {
  const settings = await loadStoredSettings()
  const fallbackTrail: AiBackendId[] = []
  const errorTrail: string[] = []

  let primary: AiBackendId
  let source: ResolutionSource
  if (options.preferredBackend) {
    primary = options.preferredBackend
    source = 'override'
  } else {
    const envBackend = normalizeBackend(process.env.SIFTLY_AI_BACKEND)
    if (envBackend) {
      primary = envBackend
      source = 'env'
    } else {
      const saved = normalizeBackend(settings.aiProvider)
      if (saved && (saved === 'anthropic' || saved === 'openai')) {
        primary = saved
        source = 'db'
      } else {
        primary = await autodetectBackend()
        source = 'autodetect'
      }
    }
  }

  const fallbackList = options.allowFallback === false
    ? []
    : parseBackendList(process.env.SIFTLY_AI_FALLBACK)

  const candidates = buildResolutionCandidates(primary, fallbackList)

  for (const candidate of candidates) {
    fallbackTrail.push(candidate)

    if (!isBackendEnabled(candidate)) {
      errorTrail.push(`${candidate}: disabled by env toggle`)
      continue
    }
    if ((candidate === 'acp_cursor' || candidate === 'acp_amp') && !isAcpEnabled()) {
      errorTrail.push(`${candidate}: ACP disabled (set SIFTLY_EXPERIMENTAL_ACP=1)`)
      continue
    }

    const { model, modelSource } = resolveModel(candidate, settings)
    const capabilities = getCapabilities(candidate, modelSource)

    try {
      const client = await resolveAIClientForBackend(candidate, {
        overrideKey: options.overrideKey,
        dbKey: getDbKeyForBackend(candidate, settings),
      })
      return {
        backend: candidate,
        model,
        client,
        capabilities,
        resolutionSource: candidate === primary ? source : 'fallback',
        fallbackTrail,
        errorTrail,
      }
    } catch (err) {
      if (await hasPromptCli(candidate)) {
        return {
          backend: candidate,
          model,
          client: null,
          capabilities,
          resolutionSource: candidate === primary ? source : 'fallback',
          fallbackTrail,
          errorTrail: [
            ...errorTrail,
            `${candidate}: SDK unavailable, using CLI-only path`,
          ],
        }
      }
      errorTrail.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  throw new Error(`No AI backend available. Tried: ${errorTrail.join(' | ') || 'none'}`)
}

export function toLegacyProvider(backend: AiBackendId): LegacyProvider {
  return backend === 'openai' ? 'openai' : 'anthropic'
}

export async function getEffectiveBackendSummary(): Promise<{
  backend: AiBackendId
  model: string
  resolutionSource: ResolutionSource
  fallbackTrail: AiBackendId[]
  errorTrail: string[]
}> {
  try {
    const resolved = await resolveAiBackend()
    return {
      backend: resolved.backend,
      model: resolved.model,
      resolutionSource: resolved.resolutionSource,
      fallbackTrail: resolved.fallbackTrail,
      errorTrail: resolved.errorTrail,
    }
  } catch (err) {
    const fallbackBackend = normalizeBackend(process.env.SIFTLY_AI_BACKEND) ?? 'anthropic'
    const settings = await loadStoredSettings()
    const fallbackModel = resolveModel(fallbackBackend, settings).model
    return {
      backend: fallbackBackend,
      model: fallbackModel,
      resolutionSource: process.env.SIFTLY_AI_BACKEND?.trim() ? 'env' : 'autodetect',
      fallbackTrail: [fallbackBackend],
      errorTrail: [err instanceof Error ? err.message : String(err)],
    }
  }
}

function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('500') ||
    msg.toLowerCase().includes('rate') ||
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('network') ||
    msg.toLowerCase().includes('overload')
  )
}

export async function executeWithBackendFallback<T>(
  resolved: ResolvedAiBackend,
  execute: (ctx: ResolvedAiBackend, attempt: number, mode: 'primary' | 'execution_fallback') => Promise<T>,
  options: {
    maxPrimaryRetries?: number
  } = {},
): Promise<T> {
  const maxPrimaryRetries = options.maxPrimaryRetries ?? 2
  let lastError: unknown

  for (let attempt = 0; attempt <= maxPrimaryRetries; attempt++) {
    try {
      return await execute(resolved, attempt, 'primary')
    } catch (err) {
      lastError = err
      if (!isRetryableError(err) || attempt >= maxPrimaryRetries) break
    }
  }

  const executionFallbacks = parseBackendList(process.env.SIFTLY_AI_EXECUTION_FALLBACK)
  for (const fallbackBackend of executionFallbacks) {
    if (fallbackBackend === resolved.backend) continue
    try {
      const fallback = await resolveAiBackend({ preferredBackend: fallbackBackend, allowFallback: false })
      return await execute(fallback, 0, 'execution_fallback')
    } catch (err) {
      lastError = err
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError)))
}
