import { NextRequest, NextResponse } from 'next/server'
import { hybridSearchPipeline, buildBookmarkResponse, type SearchResult } from '@/lib/search-pipeline'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getProvider } from '@/lib/settings'

// ─── Cache ────────────────────────────────────────────────────────────────────
interface CacheEntry {
  results: unknown
  expiresAt: number
}
const searchCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCached(key: string): unknown | null {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key)
    return null
  }
  return entry.results
}

function setCache(key: string, results: unknown): void {
  if (searchCache.size >= 100) {
    searchCache.delete(searchCache.keys().next().value!)
  }
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { query?: string; category?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { query, category } = body
  if (!query?.trim()) {
    return NextResponse.json({ error: 'Query required' }, { status: 400 })
  }

  const cacheKey = `${query.trim().toLowerCase()}::${category ?? ''}`
  const cached = getCached(cacheKey)
  if (cached) {
    return NextResponse.json(cached)
  }

  try {
    // Get active model and provider for potential reranking
    const model = await getActiveModel()
    const provider = await getProvider()

    let client: AIClient | null = null
    try {
      client = await resolveAIClient({})
    } catch {
      // Will use retrieval-only results
    }

    // Run the hybrid search pipeline
    const searchResults = await hybridSearchPipeline(query, category, client, model)

    if (searchResults.length === 0) {
      const response = { bookmarks: [], explanation: 'No bookmarks found matching your query.' }
      setCache(cacheKey, response)
      return NextResponse.json(response)
    }

    // Format results with bookmark data
    const bookmarkIds = searchResults.map((r) => r.bookmarkId)
    const bookmarks = await Promise.all(
      searchResults.map(async (searchResult) => {
        // Fetch full bookmark data
        const b = await (async () => {
          const prisma = (await import('@/lib/db')).default
          return prisma.bookmark.findUnique({
            where: { id: searchResult.bookmarkId },
            select: {
              id: true,
              tweetId: true,
              text: true,
              authorHandle: true,
              authorName: true,
              tweetCreatedAt: true,
              importedAt: true,
              semanticTags: true,
              entities: true,
              enrichedAt: true,
              mediaItems: { select: { id: true, type: true, url: true, thumbnailUrl: true, imageTags: true } },
              categories: {
                include: { category: { select: { id: true, name: true, slug: true, color: true } } },
                orderBy: { confidence: 'desc' as const },
              },
            },
          })
        })()

        if (!b) return null

        return {
          ...buildBookmarkResponse(b),
          searchScore: searchResult.blendedScore,
          searchReason: searchResult.searchReason,
          matchedPassages: searchResult.matchedPassages,
        }
      })
    )

    const validResults = bookmarks.filter(Boolean)

    // Build explanation
    const explanation =
      validResults.length > 0
        ? `Found ${validResults.length} relevant bookmark${validResults.length === 1 ? '' : 's'} using hybrid retrieval.`
        : 'No bookmarks found.'

    const response = { bookmarks: validResults, explanation }
    setCache(cacheKey, response)
    return NextResponse.json(response)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Search pipeline error:', errMsg)
    return NextResponse.json({ error: `Search failed: ${errMsg}` }, { status: 500 })
  }
}
