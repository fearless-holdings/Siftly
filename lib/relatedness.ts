/**
 * Lightweight relatedness graph: compute relationship evidence between bookmarks
 * based on shared categories, overlapping tags, common authors, and visual similarity.
 */

import prisma from '@/lib/db'

export interface RelatednessEdge {
  targetId: string
  evidence: {
    sharedCategories?: { name: string; slug: string; confidence: number }[]
    sharedTags?: string[]
    sharedEntities?: { type: 'tool' | 'mention' | 'hashtag'; value: string }[]
    sameAuthor?: boolean
    visualSimilarity?: number // 0-1, based on shared image tags
  }
  score: number // aggregate relatedness score 0-1
  reasons: string[] // human-readable explanation
}

/**
 * Find bookmarks related to a given bookmark.
 * Returns neighbors ranked by relatedness score.
 */
export async function findRelatedBookmarks(
  bookmarkId: string,
  options: { limit?: number; minScore?: number; mode?: 'similar' | 'adjacent' | 'contrasting' } = {},
): Promise<RelatednessEdge[]> {
  const { limit = 10, minScore = 0.3, mode = 'similar' } = options

  // Fetch the source bookmark
  const source = await prisma.bookmark.findUnique({
    where: { id: bookmarkId },
    select: {
      id: true,
      authorHandle: true,
      semanticTags: true,
      entities: true,
      categories: {
        select: {
          confidence: true,
          category: { select: { id: true, name: true, slug: true } },
        },
      },
      mediaItems: {
        select: { imageTags: true },
      },
    },
  })

  if (!source) return []

  // Parse source enrichment
  const sourceTags = source.semanticTags ? JSON.parse(source.semanticTags) : []
  const sourceEntities = source.entities ? JSON.parse(source.entities) : {}
  const sourceCategoryIds = new Set(source.categories.map((c) => c.category.id))

  // Get all candidate bookmarks (limit to avoid O(n²) comparisons)
  const candidates = await prisma.bookmark.findMany({
    where: { id: { not: bookmarkId } },
    select: {
      id: true,
      authorHandle: true,
      semanticTags: true,
      entities: true,
      categories: {
        select: {
          confidence: true,
          category: { select: { id: true, name: true, slug: true } },
        },
      },
      mediaItems: {
        select: { imageTags: true },
      },
    },
    take: 200, // reasonable upper bound for comparison
  })

  // Compute relatedness scores
  const edges: RelatednessEdge[] = []

  for (const candidate of candidates) {
    const reasons: string[] = []
    const evidence: RelatednessEdge['evidence'] = {}
    let scoreSum = 0
    let scoreCount = 0

    // 1. Shared categories
    const candidateCategoryIds = new Set(candidate.categories.map((c) => c.category.id))
    const sharedCategoryIds = Array.from(sourceCategoryIds).filter((id) => candidateCategoryIds.has(id))

    if (sharedCategoryIds.length > 0) {
      const sharedCats = candidate.categories
        .filter((c) => sharedCategoryIds.includes(c.category.id))
        .map((c) => ({
          name: c.category.name,
          slug: c.category.slug,
          confidence: c.confidence,
        }))

      evidence.sharedCategories = sharedCats
      const catScore = Math.min(sharedCats.length * 0.15, 0.5)
      scoreSum += catScore
      scoreCount++
      reasons.push(`in ${sharedCats.length} shared ${sharedCats.length === 1 ? 'category' : 'categories'}`)
    }

    // 2. Shared semantic tags
    const candidateTags = candidate.semanticTags ? JSON.parse(candidate.semanticTags) : []
    const sharedTagsSet = new Set<string>(
      (sourceTags as string[]).filter((t: string) => candidateTags.includes(t)),
    )

    if (sharedTagsSet.size > 0) {
      evidence.sharedTags = Array.from(sharedTagsSet) as string[]
      const tagScore = Math.min(sharedTagsSet.size * 0.05, 0.3)
      scoreSum += tagScore
      scoreCount++
      reasons.push(`${sharedTagsSet.size} shared semantic tags`)
    }

    // 3. Shared entities (tools, mentions, hashtags)
    const candidateEntities = candidate.entities ? JSON.parse(candidate.entities) : {}
    const sharedEntities: RelatednessEdge['evidence']['sharedEntities'] = []

    for (const type of ['tools', 'mentions', 'hashtags'] as const) {
      const sourceList = sourceEntities[type] || []
      const candidateList = candidateEntities[type] || []
      const shared = sourceList.filter((v: string) => candidateList.includes(v))

      if (shared.length > 0) {
        shared.forEach((v: string) => {
          sharedEntities.push({ type: type.slice(0, -1) as any, value: v })
        })
      }
    }

    if (sharedEntities.length > 0) {
      evidence.sharedEntities = sharedEntities
      const entityScore = Math.min(sharedEntities.length * 0.08, 0.25)
      scoreSum += entityScore
      scoreCount++
      reasons.push(`shared ${sharedEntities.map((e) => `${e.type}: ${e.value}`).join(', ')}`)
    }

    // 4. Same author
    if (source.authorHandle === candidate.authorHandle) {
      evidence.sameAuthor = true
      scoreSum += 0.2
      scoreCount++
      reasons.push('same author')
    }

    // 5. Visual similarity (simplified: shared image tags)
    let visualScore = 0
    const sourceImageTags = source.mediaItems
      .map((m) => (m.imageTags ? JSON.parse(m.imageTags) : null))
      .filter(Boolean)
    const candidateImageTags = candidate.mediaItems
      .map((m) => (m.imageTags ? JSON.parse(m.imageTags) : null))
      .filter(Boolean)

    if (sourceImageTags.length > 0 && candidateImageTags.length > 0) {
      // Simple overlap check on tags array
      const sourceTags = new Set<string>()
      const candidateTags = new Set<string>()

      sourceImageTags.forEach((tags: any) => {
        if (Array.isArray(tags.tags)) tags.tags.forEach((t: string) => sourceTags.add(t))
      })

      candidateImageTags.forEach((tags: any) => {
        if (Array.isArray(tags.tags)) tags.tags.forEach((t: string) => candidateTags.add(t))
      })

      const shared = Array.from(sourceTags).filter((t) => candidateTags.has(t))
      if (shared.length > 0) {
        visualScore = Math.min(shared.length * 0.03, 0.2)
        evidence.visualSimilarity = visualScore
        scoreSum += visualScore
        scoreCount++
        reasons.push(`${shared.length} shared visual tags`)
      }
    }

    // Calculate final score
    const finalScore = scoreCount > 0 ? scoreSum / scoreCount : 0

    if (finalScore >= minScore) {
      edges.push({
        targetId: candidate.id,
        evidence,
        score: Math.min(finalScore, 1),
        reasons,
      })
    }
  }

  // Sort by score, apply mode filter, and limit
  edges.sort((a, b) => b.score - a.score)

  // Apply mode filters
  if (mode === 'similar') {
    // Keep high-confidence matches
    return edges.filter((e) => e.score >= 0.5).slice(0, limit)
  } else if (mode === 'adjacent') {
    // Keep mid-range matches (cross-topic)
    return edges.filter((e) => e.score >= 0.3 && e.score < 0.7).slice(0, limit)
  } else if (mode === 'contrasting') {
    // Keep low-confidence matches for serendipity
    return edges.filter((e) => e.score >= minScore && e.score < 0.4).slice(0, limit)
  }

  return edges.slice(0, limit)
}
