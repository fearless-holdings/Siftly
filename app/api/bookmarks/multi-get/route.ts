import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

/**
 * POST /api/bookmarks/multi-get
 * Fetch multiple bookmarks by ID in batch.
 * Request: { ids: string[] }
 * Response: { bookmarks: Bookmark[], notFound: string[] }
 * Agent-facing endpoint for efficient bulk fetches.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { ids?: string[] } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }

  if (ids.length > 100) {
    return NextResponse.json({ error: 'Maximum 100 bookmarks per request' }, { status: 400 })
  }

  try {
    const bookmarks = await prisma.bookmark.findMany({
      where: { id: { in: ids } },
      select: {
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
        source: true,
        mediaItems: {
          select: {
            id: true,
            type: true,
            url: true,
            thumbnailUrl: true,
            imageTags: true,
          },
        },
        categories: {
          select: {
            confidence: true,
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
                color: true,
              },
            },
          },
          orderBy: { confidence: 'desc' },
        },
      },
    })

    const foundIds = new Set(bookmarks.map((b) => b.id))
    const notFound = ids.filter((id) => !foundIds.has(id))

    return NextResponse.json({
      bookmarks: bookmarks.map((b) => ({
        id: b.id,
        tweetId: b.tweetId,
        text: b.text,
        authorHandle: b.authorHandle,
        authorName: b.authorName,
        tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
        importedAt: b.importedAt.toISOString(),
        enrichedAt: b.enrichedAt?.toISOString() ?? null,
        source: b.source,
        enrichment: {
          semanticTags: b.semanticTags ? JSON.parse(b.semanticTags) : [],
          entities: b.entities ? JSON.parse(b.entities) : {},
        },
        media: b.mediaItems.map((m) => ({
          id: m.id,
          type: m.type,
          url: m.url,
          thumbnailUrl: m.thumbnailUrl,
          imageTags: m.imageTags ? JSON.parse(m.imageTags) : null,
        })),
        categories: b.categories.map((bc) => ({
          id: bc.category.id,
          name: bc.category.name,
          slug: bc.category.slug,
          color: bc.category.color,
          confidence: bc.confidence,
        })),
      })),
      notFound,
    })
  } catch (err) {
    console.error('Bookmarks multi-get error:', err)
    return NextResponse.json(
      { error: `Failed to fetch bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
