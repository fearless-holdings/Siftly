/**
 * SQLite FTS5 virtual table for fast full-text search across bookmarks.
 * FTS5 uses Porter stemming and tokenization — much faster than LIKE '%keyword%' table scans.
 *
 * The table is rebuilt after enrichment runs. At search time it provides ranked ID lists
 * that replace the LIKE-based keyword conditions in the search route.
 */

import prisma from '@/lib/db'

const FTS_BOOKMARKS = 'bookmark_fts'
const FTS_PASSAGES = 'passage_fts'

export async function ensureFtsTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_BOOKMARKS} USING fts5(
      bookmark_id UNINDEXED,
      text,
      semantic_tags,
      entities,
      image_tags,
      tokenize='porter unicode61'
    )
  `)
  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_PASSAGES} USING fts5(
      passage_id UNINDEXED,
      bookmark_id UNINDEXED,
      passage_type UNINDEXED,
      content,
      tokenize='porter unicode61'
    )
  `)
}

/**
 * Rebuild the FTS5 tables from all bookmarks and passages. Fast (local SQLite) and idempotent.
 * Call after import or enrichment runs.
 */
export async function rebuildFts(): Promise<void> {
  await ensureFtsTable()
  await prisma.$executeRawUnsafe(`DELETE FROM ${FTS_BOOKMARKS}`)
  await prisma.$executeRawUnsafe(`DELETE FROM ${FTS_PASSAGES}`)

  const bookmarks = await prisma.bookmark.findMany({
    select: {
      id: true,
      text: true,
      semanticTags: true,
      entities: true,
      mediaItems: { select: { imageTags: true } },
    },
  })

  if (bookmarks.length === 0) return

  // Insert in batches of 200 to stay within SQLite variable limits
  const BATCH = 200
  for (let i = 0; i < bookmarks.length; i += BATCH) {
    const batch = bookmarks.slice(i, i + BATCH)
    await prisma.$transaction(
      batch.map((b) => {
        const imageTagsText = b.mediaItems
          .map((m) => m.imageTags ?? '')
          .filter(Boolean)
          .join(' ')
        return prisma.$executeRaw`
          INSERT INTO ${FTS_BOOKMARKS}(bookmark_id, text, semantic_tags, entities, image_tags)
          VALUES (${b.id}, ${b.text}, ${b.semanticTags ?? ''}, ${b.entities ?? ''}, ${imageTagsText})
        `
      }),
    )
  }

  // Also rebuild passage FTS
  const passages = await prisma.passage.findMany({
    select: { id: true, bookmarkId: true, passageType: true, content: true },
  })

  if (passages.length > 0) {
    for (let i = 0; i < passages.length; i += BATCH) {
      const batch = passages.slice(i, i + BATCH)
      await prisma.$transaction(
        batch.map((p) =>
          prisma.$executeRaw`
            INSERT INTO ${FTS_PASSAGES}(passage_id, bookmark_id, passage_type, content)
            VALUES (${p.id}, ${p.bookmarkId}, ${p.passageType}, ${p.content})
          `
        ),
      )
    }
  }
}

/**
 * Search FTS5 bookmarks table for matching keywords.
 * Returns bookmark IDs ordered by relevance rank.
 */
export async function ftsSearchBookmarks(keywords: string[]): Promise<string[]> {
  if (keywords.length === 0) return []

  try {
    await ensureFtsTable()

    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    const matchQuery = terms.join(' OR ')

    const results = await prisma.$queryRaw<{ bookmark_id: string }[]>`
      SELECT bookmark_id FROM ${FTS_BOOKMARKS}
      WHERE ${FTS_BOOKMARKS} MATCH ${matchQuery}
      ORDER BY rank
      LIMIT 150
    `
    return results.map((r) => r.bookmark_id)
  } catch {
    return []
  }
}

/**
 * Search FTS5 passages table for matching keywords.
 * Returns { passageId, bookmarkId } ordered by relevance.
 */
export async function ftsSearchPassages(keywords: string[]): Promise<{ passageId: string; bookmarkId: string }[]> {
  if (keywords.length === 0) return []

  try {
    await ensureFtsTable()

    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    const matchQuery = terms.join(' OR ')

    const results = await prisma.$queryRaw<{ passage_id: string; bookmark_id: string }[]>`
      SELECT passage_id, bookmark_id FROM ${FTS_PASSAGES}
      WHERE ${FTS_PASSAGES} MATCH ${matchQuery}
      ORDER BY rank
      LIMIT 150
    `
    return results.map((r) => ({ passageId: r.passage_id, bookmarkId: r.bookmark_id }))
  } catch {
    return []
  }
}

/**
 * Legacy search function (for backward compat).
 * Uses both bookmarks and passages, returns unique bookmark IDs.
 */
export async function ftsSearch(keywords: string[]): Promise<string[]> {
  const bookmarkIds = await ftsSearchBookmarks(keywords)
  const passageResults = await ftsSearchPassages(keywords)
  const fromPassages = [...new Set(passageResults.map((p) => p.bookmarkId))]
  const merged = [...new Set([...bookmarkIds, ...fromPassages])]
  return merged.slice(0, 150)
}
