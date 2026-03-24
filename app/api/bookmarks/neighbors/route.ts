/**
 * GET /api/bookmarks/neighbors?id=<bookmarkId>&mode=<similar|adjacent|contrasting>
 *
 * Find related bookmarks using shared categories, tags, tools, author, visual style.
 * Modes:
 * - similar: tight thematic clustering (high shared category confidence)
 * - adjacent: cross-topic discovery (shared tools/hashtags but different primary category)
 * - contrasting: serendipity mode (maximize visual/thematic diversity while maintaining some connection)
 */

import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { buildBookmarkResponse } from '@/lib/search-pipeline'

const BOOKMARK_SELECT = {
  id: true,
  tweetId: true,
  text: true,
  authorHandle: true,
  authorName: true,
  tweetCreatedAt: true,
  importedAt: true,
  enrichedAt: true,
  semanticTags: true,
  entities: true,
  enrichmentMeta: true,
  mediaItems: { select: { id: true, type: true, url: true, thumbnailUrl: true, imageTags: true } },
  categories: {
    include: { category: { select: { id: true, name: true, slug: true, color: true } } },
    orderBy: { confidence: 'desc' as const },
  },
} as const

interface Edge {
  neighborId: string
  strength: number
  evidence: string[]
}

/**
 * Calculate relatedness between two bookmarks.
 * Returns edge strength (0-1) and evidence of connection.
 */
function calculateEdgeStrength(
  a: {
    id: string
    categories: Array<{ category: { id: string; slug: string }; confidence: number }>
    semanticTags: string | null
    entities: string | null
  },
  b: {
    id: string
    categories: Array<{ category: { id: string; slug: string }; confidence: number }>
    semanticTags: string | null
    entities: string | null
  },
): Edge {
  const evidence: string[] = []
  let strength = 0

  // Shared categories (high weight)
  const aCategoryIds = a.categories.map((c) => c.category.id)
  const bCategoryIds = b.categories.map((c) => c.category.id)
  const sharedCategories = aCategoryIds.filter((id) => bCategoryIds.includes(id))
  if (sharedCategories.length > 0) {
    strength += 0.5
    evidence.push(`${sharedCategories.length} shared category(ies)`)
  }

  // Shared semantic tags
  let aTags: string[] = []
  let bTags: string[] = []
  try {
    if (a.semanticTags) aTags = JSON.parse(a.semanticTags)
    if (b.semanticTags) bTags = JSON.parse(b.semanticTags)
  } catch {
    /* ignore */
  }
  if (aTags.length > 0 && bTags.length > 0) {
    const shared = aTags.filter((t) => bTags.includes(t))
    if (shared.length > 0) {
      strength += 0.2
      evidence.push(`${shared.length} shared semantic tag(s)`)
    }
  }

  // Shared tools/hashtags
  let aTools: string[] = []
  let bTools: string[] = []
  let aHashtags: string[] = []
  let bHashtags: string[] = []
  try {
    if (a.entities) {
      const ent = JSON.parse(a.entities) as { tools?: string[]; hashtags?: string[] }
      aTools = ent.tools ?? []
      aHashtags = ent.hashtags ?? []
    }
    if (b.entities) {
      const ent = JSON.parse(b.entities) as { tools?: string[]; hashtags?: string[] }
      bTools = ent.tools ?? []
      bHashtags = ent.hashtags ?? []
    }
  } catch {
    /* ignore */
  }
  const sharedTools = aTools.filter((t) => bTools.includes(t))
  const sharedHashtags = aHashtags.filter((h) => bHashtags.includes(h))
  if (sharedTools.length > 0) {
    strength += 0.15
    evidence.push(`shared tools: ${sharedTools.slice(0, 2).join(', ')}`)
  }
  if (sharedHashtags.length > 0) {
    strength += 0.1
    evidence.push(`shared hashtags: ${sharedHashtags.slice(0, 2).join(', ')}`)
  }

  return {
    neighborId: b.id,
    strength: Math.min(1, strength),
    evidence: evidence.slice(0, 3),
  }
}

/**
 * Filter edges based on mode.
 */
function filterEdgesByMode(
  edges: Edge[],
  mode: 'similar' | 'adjacent' | 'contrasting',
): Edge[] {
  if (mode === 'similar') {
    // Keep only strong connections (strength > 0.5)
    return edges.filter((e) => e.strength > 0.5).sort((a, b) => b.strength - a.strength).slice(0, 10)
  } else if (mode === 'adjacent') {
    // Keep medium connections (0.3-0.7), prefer diverse sources
    return edges
      .filter((e) => e.strength >= 0.3 && e.strength <= 0.7)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 15)
  } else {
    // contrasting: keep all, prefer lower strength (more diverse)
    return edges.sort((a, b) => a.strength - b.strength).slice(0, 10)
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get('id')
  const mode = (request.nextUrl.searchParams.get('mode') ?? 'similar') as 'similar' | 'adjacent' | 'contrasting'

  if (!id) {
    return NextResponse.json({ error: 'id parameter required' }, { status: 400 })
  }

  try {
    // Fetch the source bookmark
    const source = await prisma.bookmark.findUnique({
      where: { id },
      select: {
        id: true,
        categories: { include: { category: { select: { id: true, slug: true } } } },
        semanticTags: true,
        entities: true,
      },
    })

    if (!source) {
      return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    }

    // Fetch related bookmarks (category-based, with optional expansion)
    const categoryIds = source.categories.map((c) => c.category.id)
    const relatedBookmarks = await prisma.bookmark.findMany({
      where: {
        id: { not: source.id },
        categories: categoryIds.length > 0 ? { some: { categoryId: { in: categoryIds } } } : {},
      },
      select: {
        id: true,
        categories: { include: { category: { select: { id: true, slug: true } } } },
        semanticTags: true,
        entities: true,
      },
      take: 100, // Fetch more candidates for filtering
    })

    // Calculate edge strength for each neighbor
    const edges = relatedBookmarks.map((neighbor) => calculateEdgeStrength(source, neighbor))

    // Filter by mode
    const filtered = filterEdgesByMode(edges, mode)

    if (filtered.length === 0) {
      return NextResponse.json({
        neighbors: [],
        mode,
        explanation: `No ${mode} neighbors found for this bookmark.`,
      })
    }

    // Fetch full neighbor bookmarks
    const neighborIds = filtered.map((e) => e.neighborId)
    const neighbors = await prisma.bookmark.findMany({
      where: { id: { in: neighborIds } },
      select: BOOKMARK_SELECT,
    })

    // Reconstruct with edge data
    const neighborMap = new Map(neighbors.map((n) => [n.id, n]))
    const results = filtered
      .map((edge) => {
        const neighbor = neighborMap.get(edge.neighborId)
        return neighbor ? { ...buildBookmarkResponse(neighbor), edgeStrength: edge.strength, evidence: edge.evidence } : null
      })
      .filter(Boolean)

    return NextResponse.json({
      neighbors: results,
      mode,
      count: results.length,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Neighbors lookup error:', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
