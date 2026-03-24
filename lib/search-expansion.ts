/**
 * Query expansion: generates multiple query variants (original, keyword-reduced, AI paraphrase)
 * for improved search coverage without changing the original user intent.
 */

import { executeWithBackendFallback, ResolvedAiBackend } from '@/lib/ai-backend'
import { claudePrompt, modelNameToCliAlias, getCliAvailability } from '@/lib/claude-cli-auth'
import { getCodexCliAvailability, codexPrompt } from '@/lib/codex-cli'

export interface QueryVariants {
  original: string
  reduced: string
  paraphrase: string
  all: string[]
}

interface QueryCacheEntry {
  variants: QueryVariants
  expiresAt: number
}

// Module-level expansion cache (1 hour TTL)
const _expansionCache: Map<string, QueryCacheEntry> = new Map()
let _cacheCleanup = 0
const CACHE_TTL_MS = 60 * 60 * 1000

function cleanExpiredCache(): void {
  const now = Date.now()
  if (now - _cacheCleanup < 5 * 60 * 1000) return // Clean every 5 minutes

  for (const [key, value] of Array.from(_expansionCache.entries())) {
    if (now > value.expiresAt) {
      _expansionCache.delete(key)
    }
  }
  _cacheCleanup = now
}

function getCachedExpansion(query: string): QueryVariants | null {
  cleanExpiredCache()
  const entry = _expansionCache.get(query)
  return entry?.variants ?? null
}

function setCachedExpansion(query: string, variants: QueryVariants): void {
  _expansionCache.set(query, {
    variants,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

/**
 * Reduce query to essential keywords: remove common stop words and extract entities.
 */
function reduceQuery(query: string): string {
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'can', 'how', 'what', 'when', 'where',
    'which', 'why', 'who', 'that', 'this', 'these', 'those', 'from', 'by', 'with', 'as', 'if',
  ])

  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stopwords.has(t))

  return tokens.slice(0, 8).join(' ')
}

/**
 * Generate an AI paraphrase of the query using Claude or OpenAI.
 * Tries CLI first, falls back to SDK, returns original if both fail.
 */
async function generateParaphrase(
  query: string,
  resolved: ResolvedAiBackend,
): Promise<string> {
  const prompt = `Rewrite this search query as a short, natural question (10 words max). Use different phrasing but keep the intent:

Query: "${query}"

Response (just the rephrased question, no quotes):`

  try {
    // Try CLI first if available
    if (resolved.capabilities.cliPrompt === 'codex' && (await getCodexCliAvailability())) {
      try {
        const result = await codexPrompt(prompt, { timeoutMs: 15_000 })
        if (result.success && result.data?.trim()) {
          return result.data.trim().slice(0, 150)
        }
      } catch { /* fall through */ }
    }

    if (resolved.capabilities.cliPrompt === 'claude' && (await getCliAvailability())) {
      try {
        const cliModel = modelNameToCliAlias(resolved.model)
        const result = await claudePrompt(prompt, { model: cliModel, timeoutMs: 15_000 })
        if (result.success && result.data?.trim()) {
          return result.data.trim().slice(0, 150)
        }
      } catch { /* fall through */ }
    }

    // Fall back to SDK if available
    if (resolved.client) {
      const response = await executeWithBackendFallback(resolved, async (ctx) => {
        if (!ctx.client) throw new Error(`No AI client available for backend "${ctx.backend}"`)
        return ctx.client.createMessage({
          model: ctx.model,
          max_tokens: 50,
          messages: [{ role: 'user', content: prompt }],
        })
      })
      const text = response.text?.trim() ?? ''
      if (text) return text.slice(0, 150)
    }
  } catch { /* fall through */ }

  // Fallback: return original query
  return query
}

/**
 * Expand a single query into multiple variants for better search coverage.
 */
export async function expandQuery(
  query: string,
  resolved: ResolvedAiBackend,
): Promise<QueryVariants> {
  const cached = getCachedExpansion(query)
  if (cached) return cached

  const original = query.trim()
  const reduced = reduceQuery(original)
  const paraphrase = await generateParaphrase(original, resolved)

  const variants: QueryVariants = {
    original,
    reduced,
    paraphrase,
    all: [original, reduced, paraphrase].filter((q) => q && q !== original),
  }

  setCachedExpansion(query, variants)
  return variants
}

/**
 * Clear expansion cache (if needed for testing or settings change).
 */
export function invalidateExpansionCache(): void {
  _expansionCache.clear()
  _cacheCleanup = 0
}
