import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { findRelatedBookmarks } from '@/lib/relatedness'

/**
 * GET /api/bookmarks/[id]/neighbors?mode=similar&limit=10
 * Find bookmarks related to a given bookmark.
 * Query params:
 *   - mode: 'similar' (tight), 'adjacent' (cross-topic), 'contrasting' (serendipity)
 *   - limit: max results (default 10, max 50)
 * Response: { neighbors: Array<{ targetId, evidence, score, reasons }> }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const searchParams = request.nextUrl.searchParams

  const mode = (searchParams.get('mode') ?? 'similar') as 'similar' | 'adjacent' | 'contrasting'
  const limitStr = searchParams.get('limit') ?? '10'
  const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 10), 50)

  try {
    // Verify bookmark exists
    const exists = await prisma.bookmark.findUnique({
      where: { id },
      select: { id: true },
    })

    if (!exists) {
      return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    }

    // Find neighbors
    const neighbors = await findRelatedBookmarks(id, { limit, mode })

    // Enrich with full bookmark data if requested
    const withDetails = searchParams.get('details') === 'true'

    if (withDetails && neighbors.length > 0) {
      const neighborIds = neighbors.map((n) => n.targetId)
      const bookmarks = await prisma.bookmark.findMany({
        where: { id: { in: neighborIds } },
        select: {
          id: true,
          tweetId: true,
          text: true,
          authorHandle: true,
          authorName: true,
          tweetCreatedAt: true,
          importedAt: true,
        },
      })

      const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))

      return NextResponse.json({
        neighbors: neighbors.map((n) => {
          const b = bookmarkMap.get(n.targetId)
          return {
            id: n.targetId,
            score: n.score,
            reasons: n.reasons,
            evidence: n.evidence,
            ...(b && {
              bookmark: {
                tweetId: b.tweetId,
                text: b.text.slice(0, 200),
                authorHandle: b.authorHandle,
                authorName: b.authorName,
                tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
              },
            }),
          }
        }),
      })
    }

    return NextResponse.json({
      neighbors: neighbors.map((n) => ({
        id: n.targetId,
        score: n.score,
        reasons: n.reasons,
        evidence: n.evidence,
      })),
    })
  } catch (err) {
    console.error('Neighbors GET error:', err)
    return NextResponse.json(
      { error: `Failed to fetch neighbors: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
