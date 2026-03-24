/**
 * Phase 5: Agent-oriented bookmark retrieval endpoints.
 * GET - fetch single bookmark by id or tweetId
 * POST - batch retrieve multiple bookmarks
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

/**
 * GET /api/bookmarks?id=<id>&tweetId=<tweetId>
 * Fetch a single bookmark by its ID or tweetId.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get('id')
  const tweetId = request.nextUrl.searchParams.get('tweetId')

  if (!id && !tweetId) {
    return NextResponse.json({ error: 'id or tweetId required' }, { status: 400 })
  }

  try {
    const bookmark = await prisma.bookmark.findFirst({
      where: id ? { id } : { tweetId: tweetId! },
      select: BOOKMARK_SELECT,
    })

    if (!bookmark) {
      return NextResponse.json({ error: 'Bookmark not found' }, { status: 404 })
    }

    return NextResponse.json({ bookmark: buildBookmarkResponse(bookmark) })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Bookmark fetch error:', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}

/**
 * POST /api/bookmarks
 * Batch fetch multiple bookmarks by IDs or tweetIds.
 *
 * Body: { ids?: string[], tweetIds?: string[] }
 * Response: { bookmarks: [...], notFound: [...] }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { ids?: string[]; tweetIds?: string[] } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { ids = [], tweetIds = [] } = body
  if (ids.length === 0 && tweetIds.length === 0) {
    return NextResponse.json({ error: 'ids or tweetIds required' }, { status: 400 })
  }

  try {
    const bookmarks = await prisma.bookmark.findMany({
      where: {
        OR: [
          ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
          ...(tweetIds.length > 0 ? [{ tweetId: { in: tweetIds } }] : []),
        ],
      },
      select: BOOKMARK_SELECT,
    })

    const foundIds = new Set(bookmarks.map((b) => b.id))
    const foundTweetIds = new Set(bookmarks.map((b) => b.tweetId))
    const notFound = [
      ...ids.filter((id) => !foundIds.has(id)),
      ...tweetIds.filter((tweetId) => !foundTweetIds.has(tweetId)),
    ]

    return NextResponse.json({
      bookmarks: bookmarks.map(buildBookmarkResponse),
      notFound,
      count: bookmarks.length,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Batch fetch error:', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
