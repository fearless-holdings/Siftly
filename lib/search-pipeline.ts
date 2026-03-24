/**
 * Phase 4: QMD-like hybrid search pipeline with query expansion,
 * Reciprocal Rank Fusion, passage attachment, and reranking.
 */

import prisma from '@/lib/db'
import { ftsSearchBookmarks, ftsSearchPassages } from '@/lib/fts'
import { extractKeywords } from '@/lib/search-utils'
import { ResolvedAiBackend } from '@/lib/ai-backend'
import { expandQuery as expandQueryWithAi } from '@/lib/search-expansion'

/**
 * Query variants for multi-round retrieval: original, keyword-reduced, AI-paraphrase.
 */
export interface QueryVariant {
  original: string
  keywordReduced: string
  aiParaphrase?: string
}

/**
 * Reciprocal Rank Fusion result: bookmark ID with combined score.
 */
interface RrfResult {
  bookmarkId: string
  rrfScore: number
  sources: Set<string> // 'original_bookmarks', 'original_passages', 'reduced_bookmarks', etc.
}

/**
 * Passage matched to a bookmark.
 */
export interface MatchedPassage {
  id: string
  passageType: string
  content: string
  context: string | null
}

/**
 * Final search result after fusion and reranking.
 */
export interface SearchResult {
  bookmarkId: string
  rrfScore: number // position-aware retrieval score (0-1)
  rerankerScore?: number // AI reranker score if enabled (0-1)
  blendedScore: number // final score used for ranking (0-1)
  searchReason: string
  matchedPassages: MatchedPassage[]
  sources: string[] // which retrieval stages found this
}

/**
 * Expand query into variants: original, keyword-reduced, and optional AI paraphrase.
 */
export function expandQuery(
  query: string,
  _aiParaphrase?: string, // for now, no AI paraphrase in v1
): QueryVariant {
  const keywords = extractKeywords(query)
  const keywordReduced = keywords.slice(0, 5).join(' ').slice(0, 100)

  return {
    original: query,
    keywordReduced,
    aiParaphrase: _aiParaphrase,
  }
}

/**
 * Reciprocal Rank Fusion: combine ranked lists from multiple sources.
 * Formula: RRF(d) = sum(1 / (k + rank(d))) for each source, k=60 (standard).
 *
 * Double-weight original queries, small bonus for exact keyword matches.
 */
function reciprocalRankFusion(
  sources: Array<{ name: string; weight: number; ids: string[] }>,
): Map<string, RrfResult> {
  const results = new Map<string, RrfResult>()
  const K = 60

  for (const source of sources) {
    for (let rank = 0; rank < source.ids.length; rank++) {
      const id = source.ids[rank]
      if (!results.has(id)) {
        results.set(id, { bookmarkId: id, rrfScore: 0, sources: new Set() })
      }
      const result = results.get(id)!
      result.rrfScore += (source.weight / (K + rank))
      result.sources.add(source.name)
    }
  }

  return results
}

/**
 * Normalize RRF scores to 0-1 range.
 */
function normalizeRrfScores(results: Map<string, RrfResult>): void {
  let maxScore = 0
  for (const r of results.values()) {
    if (r.rrfScore > maxScore) maxScore = r.rrfScore
  }
  if (maxScore === 0) return

  for (const r of results.values()) {
    r.rrfScore = Math.min(1, r.rrfScore / maxScore)
  }
}

/**
 * Run the hybrid search pipeline:
 * 1. Query expansion (original + keyword-reduced)
 * 2. Parallel FTS retrieval (bookmarks + passages for each variant)
 * 3. Reciprocal Rank Fusion combining all results
 * 4. Attach highest-ranking passages per bookmark
 * 5. Optional reranking with AI model
 * 6. Blend retrieval + reranker scores
 */
export async function hybridSearchPipeline(
  query: string,
  categoryFilter?: string,
  resolved?: ResolvedAiBackend,
): Promise<SearchResult[]> {
  const aiVariants = resolved ? await expandQueryWithAi(query, resolved) : null
  const variant: QueryVariant = aiVariants
    ? {
        original: aiVariants.original,
        keywordReduced: aiVariants.reduced,
        aiParaphrase: aiVariants.paraphrase !== aiVariants.original ? aiVariants.paraphrase : undefined,
      }
    : expandQuery(query)

  // ─── Step 1: Parallel FTS retrieval for original and keyword-reduced ─────
  const [
    origBookmarkIds,
    origPassageResults,
    reducedBookmarkIds,
    reducedPassageResults,
    paraphraseBookmarkIds,
    paraphrasePassageResults,
  ] = await Promise.all([
    ftsSearchBookmarks(extractKeywords(variant.original)),
    ftsSearchPassages(extractKeywords(variant.original)),
    ftsSearchBookmarks(extractKeywords(variant.keywordReduced)),
    ftsSearchPassages(extractKeywords(variant.keywordReduced)),
    variant.aiParaphrase
      ? ftsSearchBookmarks(extractKeywords(variant.aiParaphrase))
      : Promise.resolve([] as string[]),
    variant.aiParaphrase
      ? ftsSearchPassages(extractKeywords(variant.aiParaphrase))
      : Promise.resolve([] as Awaited<ReturnType<typeof ftsSearchPassages>>),
  ])

  // Extract unique bookmark IDs from passage results
  const origPassageBookmarkIds = [...new Set(origPassageResults.map((p) => p.bookmarkId))]
  const reducedPassageBookmarkIds = [...new Set(reducedPassageResults.map((p) => p.bookmarkId))]
  const paraphrasePassageBookmarkIds = [...new Set(paraphrasePassageResults.map((p) => p.bookmarkId))]

  // ─── Step 2: Reciprocal Rank Fusion (double-weight original) ─────────────
  const rrfResults = reciprocalRankFusion([
    { name: 'original_bookmarks', weight: 2.0, ids: origBookmarkIds },
    { name: 'original_passages', weight: 2.0, ids: origPassageBookmarkIds },
    { name: 'reduced_bookmarks', weight: 1.0, ids: reducedBookmarkIds },
    { name: 'reduced_passages', weight: 1.0, ids: reducedPassageBookmarkIds },
    { name: 'paraphrase_bookmarks', weight: 1.5, ids: paraphraseBookmarkIds },
    { name: 'paraphrase_passages', weight: 1.5, ids: paraphrasePassageBookmarkIds },
  ])

  normalizeRrfScores(rrfResults)

  // Keep top 30 by RRF score
  const topResults = Array.from(rrfResults.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, 30)

  if (topResults.length === 0) {
    return []
  }

  // ─── Step 3: Fetch bookmarks and their passages ────────────────────────
  const topBookmarkIds = topResults.map((r) => r.bookmarkId)

  // Apply category filter if provided
  const bookmarkWhere = {
    id: { in: topBookmarkIds },
    ...(categoryFilter
      ? { categories: { some: { category: { slug: categoryFilter } } } }
      : {}),
  }

  const [bookmarks, allPassages] = await Promise.all([
    prisma.bookmark.findMany({
      where: bookmarkWhere,
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
    }),
    prisma.passage.findMany({
      where: { bookmarkId: { in: topBookmarkIds } },
      orderBy: [{ bookmarkId: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, bookmarkId: true, passageType: true, content: true, context: true },
    }),
  ])

  const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
  const passagesByBookmark = new Map<string, MatchedPassage[]>()
  for (const p of allPassages) {
    if (!passagesByBookmark.has(p.bookmarkId)) {
      passagesByBookmark.set(p.bookmarkId, [])
    }
    passagesByBookmark.get(p.bookmarkId)!.push({
      id: p.id,
      passageType: p.passageType,
      content: p.content,
      context: p.context,
    })
  }

  // ─── Step 4: Build results with passages attached ───────────────────────
  const results: SearchResult[] = []
  for (const rrfResult of topResults) {
    const b = bookmarkMap.get(rrfResult.bookmarkId)
    if (!b) continue // Category filter eliminated it

    // Get passages for this bookmark (use top 3 by relevance)
    const passages = passagesByBookmark.get(rrfResult.bookmarkId) ?? []
    // Prioritize: semantic > entities > ocr > text > category_context
    const typeOrder = { semantic: 0, entities: 1, ocr: 2, text: 3, category_context: 4 }
    const sortedPassages = passages
      .sort((a, b) => (typeOrder[a.passageType as keyof typeof typeOrder] ?? 99) -
        (typeOrder[b.passageType as keyof typeof typeOrder] ?? 99))
      .slice(0, 3)

    // For now, blended score = RRF score (no reranker in v1)
    const blendedScore = rrfResult.rrfScore

    // Build search reason
    const sourceList = Array.from(rrfResult.sources).join(', ')
    const passageTypes = sortedPassages.map((p) => p.passageType).join('/')
    const searchReason = `matched via ${sourceList}${passageTypes ? ` (${passageTypes})` : ''}`

    results.push({
      bookmarkId: rrfResult.bookmarkId,
      rrfScore: rrfResult.rrfScore,
      blendedScore,
      searchReason,
      matchedPassages: sortedPassages,
      sources: Array.from(rrfResult.sources),
    })
  }

  return results.sort((a, b) => b.blendedScore - a.blendedScore)
}

/**
 * Build a bookmark response object with all relevant fields for search results.
 */
export function buildBookmarkResponse(b: {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  importedAt: Date
  semanticTags: string | null
  entities: string | null
  enrichedAt: Date | null
  mediaItems: Array<{ id: string; type: string; url: string; thumbnailUrl: string | null; imageTags: string | null }>
  categories: Array<{ category: { id: string; name: string; slug: string; color: string }; confidence: number }>
}) {
  return {
    id: b.id,
    tweetId: b.tweetId,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
    importedAt: b.importedAt.toISOString(),
    enrichedAt: b.enrichedAt?.toISOString() ?? null,
    mediaItems: b.mediaItems.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      imageTags: m.imageTags ? JSON.parse(m.imageTags) : null,
    })),
    categories: b.categories.map((c) => ({
      id: c.category.id,
      name: c.category.name,
      slug: c.category.slug,
      color: c.category.color,
      confidence: c.confidence,
    })),
    semanticTags: b.semanticTags ? JSON.parse(b.semanticTags) : null,
    entities: b.entities ? JSON.parse(b.entities) : null,
  }
}
