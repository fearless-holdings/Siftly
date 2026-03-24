/**
 * RRF-based hybrid search fusion: combines results from multiple retrieval recipes
 * (keyword FTS, passage FTS, category intent) using Reciprocal Rank Fusion with weights.
 */

export interface RRFResult {
  bookmark_id: string
  recipe: 'keyword' | 'passage' | 'intent'
  rank: number // 1-indexed
}

export interface FusedResult {
  bookmark_id: string
  score: number // RRF-based fusion score
  sources: Set<'keyword' | 'passage' | 'intent'> // which recipes contributed
  topRank: number // best (lowest) rank across all recipes
}

export interface FusionWeights {
  keyword?: number
  passage?: number
  intent?: number
}

const DEFAULT_WEIGHTS: Required<FusionWeights> = {
  keyword: 2.0,
  passage: 1.5,
  intent: 1.0,
}

const K = 60 // RRF smoothing constant

/**
 * RRF formula: 1 / (k + rank) where rank is 1-indexed
 */
function rrfScore(rank: number): number {
  return 1 / (K + rank)
}

/**
 * Fuse multiple retrieval results using Reciprocal Rank Fusion.
 * Applies per-recipe weights, boosts top-3 ranks, and sorts by total score.
 */
export function fuseResults(
  results: Array<{ recipe: 'keyword' | 'passage' | 'intent'; hits: Array<{ id: string; rank: number }> }>,
  weights: FusionWeights = {},
): FusedResult[] {
  const mergedWeights = { ...DEFAULT_WEIGHTS, ...weights }

  // Accumulate RRF scores per bookmark
  const scoreMap = new Map<string, { score: number; sources: Set<string>; ranks: number[] }>()

  for (const { recipe, hits } of results) {
    const weight = mergedWeights[recipe] || DEFAULT_WEIGHTS[recipe]

    for (const { id, rank } of hits) {
      const baseScore = rrfScore(rank)
      // Boost top-3 by 2x (double weight for high-rank results)
      const boostedScore = rank <= 3 ? baseScore * 2 : baseScore
      const weightedScore = boostedScore * weight

      const existing = scoreMap.get(id) || { score: 0, sources: new Set(), ranks: [] }
      existing.score += weightedScore
      existing.sources.add(recipe)
      existing.ranks.push(rank)
      scoreMap.set(id, existing)
    }
  }

  // Convert to FusedResult array and sort by score (descending)
  const fused = Array.from(scoreMap.entries())
    .map(([bookmark_id, { score, sources, ranks }]) => ({
      bookmark_id,
      score,
      sources: sources as Set<'keyword' | 'passage' | 'intent'>,
      topRank: Math.min(...ranks),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30) // Return top 30

  return fused
}

/**
 * Reorder an array of bookmarks according to fused scores.
 * Filters to only bookmarks present in the fused results.
 */
export function rankBookmarksByScore<T extends { id: string }>(
  fused: FusedResult[],
  candidates: T[],
): T[] {
  const scoreMap = new Map(fused.map((f) => [f.bookmark_id, f]))
  const result: T[] = []

  for (const bookmark of candidates) {
    if (scoreMap.has(bookmark.id)) {
      result.push(bookmark)
    }
  }

  // Sort by fused score order
  result.sort((a, b) => {
    const scoreA = scoreMap.get(a.id)?.score ?? 0
    const scoreB = scoreMap.get(b.id)?.score ?? 0
    return scoreB - scoreA
  })

  return result
}
