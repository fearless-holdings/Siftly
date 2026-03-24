import prisma from '@/lib/db'
import { getCliAuthStatus, getCliAvailability } from '@/lib/claude-cli-auth'
import { getCodexCliAuthStatus, getCodexCliAvailability } from '@/lib/openai-auth'

// Module-level caches — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null
let _modelCacheExpiry = 0

let _cachedSavedProvider: 'anthropic' | 'openai' | null | undefined = undefined
let _savedProviderCacheExpiry = 0

let _cachedEffectiveProvider: 'anthropic' | 'openai' | null = null
let _effectiveProviderCacheExpiry = 0

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
 * Get the effective AI provider using autodetection:
 * 1. If aiProvider is explicitly saved, use it
 * 2. Otherwise prefer Anthropic if Claude CLI auth is available
 * 3. Otherwise use OpenAI if Codex/OpenAI auth is available
 * 4. Default to Anthropic as fallback
 * 
 * Cached for 5 minutes to avoid repeated auth checks.
 */
export async function getProvider(): Promise<'anthropic' | 'openai'> {
  if (_cachedEffectiveProvider && Date.now() < _effectiveProviderCacheExpiry) {
    return _cachedEffectiveProvider
  }

  const saved = await getSavedProvider()
  if (saved) {
    _cachedEffectiveProvider = saved
    _effectiveProviderCacheExpiry = Date.now() + CACHE_TTL
    return _cachedEffectiveProvider
  }

  // No manual override — autodetect
  // Prefer Anthropic if Claude CLI is available
  const claudeStatus = getCliAuthStatus()
  if (claudeStatus.available && !claudeStatus.expired) {
    _cachedEffectiveProvider = 'anthropic'
    _effectiveProviderCacheExpiry = Date.now() + CACHE_TTL
    return _cachedEffectiveProvider
  }

  // Otherwise try Codex/OpenAI
  const codexStatus = getCodexCliAuthStatus()
  if (codexStatus.available && !codexStatus.expired && await getCodexCliAvailability()) {
    _cachedEffectiveProvider = 'openai'
    _effectiveProviderCacheExpiry = Date.now() + CACHE_TTL
    return _cachedEffectiveProvider
  }

  // Default to Anthropic as fallback
  _cachedEffectiveProvider = 'anthropic'
  _effectiveProviderCacheExpiry = Date.now() + CACHE_TTL
  return _cachedEffectiveProvider
}

/**
 * Get the configured OpenAI model from settings (cached for 5 minutes).
 */
export async function getOpenAIModel(): Promise<string> {
  if (_cachedOpenAIModel && Date.now() < _openAIModelCacheExpiry) return _cachedOpenAIModel
  const setting = await prisma.setting.findUnique({ where: { key: 'openaiModel' } })
  _cachedOpenAIModel = setting?.value ?? 'gpt-4.1-mini'
  _openAIModelCacheExpiry = Date.now() + CACHE_TTL
  return _cachedOpenAIModel
}

/**
 * Get the model for the currently active provider.
 */
export async function getActiveModel(): Promise<string> {
  const provider = await getProvider()
  return provider === 'openai' ? getOpenAIModel() : getAnthropicModel()
}

/**
 * Clear all settings caches (call after settings are changed).
 */
export function invalidateSettingsCache(): void {
  _cachedModel = null
  _modelCacheExpiry = 0
  _cachedSavedProvider = undefined
  _savedProviderCacheExpiry = 0
  _cachedEffectiveProvider = null
  _effectiveProviderCacheExpiry = 0
  _cachedOpenAIModel = null
  _openAIModelCacheExpiry = 0
}
