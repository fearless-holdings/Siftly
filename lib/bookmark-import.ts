import prisma from '@/lib/db'

interface BookmarkWithRawJson {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: Date | null
  rawJson: string
  media: Array<{
    type: 'photo' | 'video' | 'gif'
    url: string
    thumbnailUrl?: string
  }>
  source: 'bookmark' | 'like' | string
}

interface ImportResult {
  imported: number
  skipped: number
  parsed: number
  errors: Array<{ tweetId: string; reason: string }>
}

/**
 * Import bookmarks through standard dedup/persistence path
 * Shared by file import, Bird import, and other sources
 */
export async function importBookmarks(
  bookmarks: BookmarkWithRawJson[],
  source: string,
  importJobId: string,
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    parsed: bookmarks.length,
    errors: [],
  }

  for (const bookmark of bookmarks) {
    try {
      const existing = await prisma.bookmark.findUnique({
        where: { tweetId: bookmark.tweetId },
        select: { id: true },
      })

      if (existing) {
        result.skipped++
        continue
      }

      const created = await prisma.bookmark.create({
        data: {
          tweetId: bookmark.tweetId,
          text: bookmark.text,
          authorHandle: bookmark.authorHandle,
          authorName: bookmark.authorName,
          tweetCreatedAt: bookmark.tweetCreatedAt,
          rawJson: bookmark.rawJson ?? JSON.stringify({}),
          source: bookmark.source || source,
        },
      })

      if (bookmark.media && bookmark.media.length > 0) {
        await prisma.mediaItem.createMany({
          data: bookmark.media.map((m) => ({
            bookmarkId: created.id,
            type: m.type,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl ?? null,
          })),
        })
      }

      result.imported++
    } catch (err) {
      console.error(`[importBookmarks] Failed to import tweet ${bookmark.tweetId}:`, err)
      result.errors.push({
        tweetId: bookmark.tweetId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
