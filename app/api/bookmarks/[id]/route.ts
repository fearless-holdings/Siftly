import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

/**
 * GET /api/bookmarks/[id]
 * Fetch a single bookmark with full enrichment data, including semantic tags, entities, and categories.
 * Agent-facing endpoint: returns JSON with all metadata and enrichment.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params

  try {
    const bookmark = await prisma.bookmark.findUnique({
      where: { id },
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
        rawJson: true,
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

    if (!bookmark) {
      return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    }

    return NextResponse.json({
      id: bookmark.id,
      tweetId: bookmark.tweetId,
      text: bookmark.text,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
      tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
      importedAt: bookmark.importedAt.toISOString(),
      enrichedAt: bookmark.enrichedAt?.toISOString() ?? null,
      source: bookmark.source,
      enrichment: {
        semanticTags: bookmark.semanticTags ? JSON.parse(bookmark.semanticTags) : [],
        entities: bookmark.entities ? JSON.parse(bookmark.entities) : {},
      },
      media: bookmark.mediaItems.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbnailUrl: m.thumbnailUrl,
        imageTags: m.imageTags ? JSON.parse(m.imageTags) : null,
      })),
      categories: bookmark.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
      rawJson: bookmark.rawJson ? JSON.parse(bookmark.rawJson) : null,
    })
  } catch (err) {
    console.error('Bookmark GET error:', err)
    return NextResponse.json(
      { error: `Failed to fetch bookmark: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
