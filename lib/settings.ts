import prisma from '@/lib/db'
import { resolveAiBackend, toLegacyProvider, type ResolvedAiBackend } from '@/lib/ai-backend'

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null
let _modelCacheExpiry = 0

let _cachedSavedProvider: 'anthropic' | 'openai' | null | undefined = undefined
let _savedProviderCacheExpiry = 0

let _cachedResolvedBackend: ResolvedAiBackend | null = null
let _resolvedBackendCacheExpiry = 0

let _cachedOpenAIModel: string | null = null
let _openAIModelCacheExpiry = 0

const CACHE_TTL = 5 * 60 * 1000

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(): Promise<string> {
  if (_cachedModel && Date.now() < _modelCacheExpiry) return _cachedModel
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicModel' } })
  _cachedModel = setting?.value ?? 'claude-haiku-4-5-20251001'
  _modelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedModel
}

/**
 * Get the manually-saved AI provider preference, or null if not set.
 */
export async function getSavedProvider(): Promise<'anthropic' | 'openai' | null> {
  if (_cachedSavedProvider !== undefined && Date.now() < _savedProviderCacheExpiry) {
    return _cachedSavedProvider
  }
  const setting = await prisma.setting.findUnique({ where: { key: 'aiProvider' } })
  _cachedSavedProvider = setting?.value === 'openai' ? 'openai' : (setting?.value === 'anthropic' ? 'anthropic' : null)
  _savedProviderCacheExpiry = Date.now() + CACHE_TTL
  return _cachedSavedProvider
}

/**
 * Get the effective AI provider after backend resolution.
 */
export async function getProvider(): Promise<'anthropic' | 'openai'> {
  try {
    const backend = await getResolvedBackend()
    return toLegacyProvider(backend.backend)
  } catch {
    const saved = await getSavedProvider()
    return saved ?? 'anthropic'
  }
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedOpenAIModel = setting?.value ?? 'gpt-5.4-mini'
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedOpenAIModel
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(): Promise<string> {
  try {
    const backend = await getResolvedBackend()
    return backend.model
  } catch {
    const provider = await getProvider()
    return provider === 'openai' ? getOpenAIModel() : getAnthropicModel()
  }
}

/**
 * Full backend context resolved once per request lifecycle.
 */
export async function getResolvedBackend(): Promise<ResolvedAiBackend> {
  if (_cachedResolvedBackend && Date.now() < _resolvedBackendCacheExpiry) {
    return _cachedResolvedBackend
  }
  _cachedResolvedBackend = await resolveAiBackend()
  _resolvedBackendCacheExpiry = Date.now() + CACHE_TTL
  return _cachedResolvedBackend
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedModel = null
  _modelCacheExpiry = 0
  _cachedSavedProvider = undefined
  _savedProviderCacheExpiry = 0
  _cachedResolvedBackend = null
  _resolvedBackendCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
}
