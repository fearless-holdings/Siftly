/**
 * Passage Index Infrastructure
 * 
 * FTS5 virtual table for semantic/entity/context-aware passage-level search.
 * Bookmarks are split into passages (text chunks, OCR, visual, semantic tags, entities, categories)
 * Each passage is indexed with context labels (e.g., "image:meme", "category:ai-resources")
 * 
 * Used by AI search (semantic reranking) and import/enrichment hooks for incremental updates.
 */

import prisma from '@/lib/db'

const PASSAGE_FTS_TABLE = 'passage_fts'

/**
 * Passage search result from FTS5 + reranking
 */
export interface PassageSearchResult {
  bookmark_id: string
  passage_type: string
  snippet: string
  context_labels: string[]
}

/**
 * Create PASSAGE_FTS virtual table if not exists.
 * Columns:
 *   - id (UNINDEXED): FTS internal rowid, not searchable
 *   - bookmark_id (UNINDEXED): reference to Bookmark
 *   - passage_type: "text" | "ocr" | "visual" | "semantic" | "entities" | "category_context"
 *   - content: the actual passage text
 *   - context_labels: JSON string of context markers
 *   - created_at (UNINDEXED): timestamp
 */
export async function ensurePassageFtsTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${PASSAGE_FTS_TABLE} USING fts5(
      id UNINDEXED,
      bookmark_id UNINDEXED,
      passage_type,
      content,
      context_labels UNINDEXED,
      created_at UNINDEXED,
      tokenize='porter unicode61'
    )
  `)
}

/**
 * Parse JSON defensively. Return empty array on error.
 */
function safeJsonParse<T>(json: string | null | undefined): T[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Extract passages from a single bookmark.
 * Returns array of {passageType, content, contextLabels} objects.
 */
export interface PassageCandidate {
  passageType: 'text' | 'ocr' | 'visual' | 'semantic' | 'entities' | 'category_context'
  content: string
  contextLabels: string[]
}

export async function extractPassagesFromBookmark(
  bookmarkId: string
): Promise<PassageCandidate[]> {
  const bookmark = await prisma.bookmark.findUniqueOrThrow({
    where: { id: bookmarkId },
    include: {
      mediaItems: true,
      categories: {
        include: { category: true },
      },
    },
  })

  const passages: PassageCandidate[] = []

  // 1. TEXT passages: split bookmark.text into sentences
  if (bookmark.text && bookmark.text.trim().length > 0) {
    // Simple sentence splitter — naive but works for tweets
    const sentences = bookmark.text
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10)

    sentences.forEach((sentence) => {
      passages.push({
        passageType: 'text',
        content: sentence,
        contextLabels: [`author:${bookmark.authorHandle}`],
      })
    })
  }

  // 2. OCR passages: from mediaItems[].imageTags
  bookmark.mediaItems.forEach((media) => {
    const imageTags = safeJsonParse<string>(media.imageTags)
    imageTags.forEach((tag) => {
      if (tag && tag.trim().length > 0) {
        passages.push({
          passageType: 'ocr',
          content: tag,
          contextLabels: [`image:${media.type}`],
        })
      }
    })
  })

  // 3. SEMANTIC passages: from semanticTags
  const semanticTags = safeJsonParse<string>(bookmark.semanticTags)
  semanticTags.forEach((tag) => {
    if (tag && tag.trim().length > 0) {
      passages.push({
        passageType: 'semantic',
        content: tag,
        contextLabels: ['source:ai-tag'],
      })
    }
  })

  // 4. ENTITIES passages: from entities JSON
  const entities = safeJsonParse<{
    hashtags?: string[]
    urls?: string[]
    mentions?: string[]
    tools?: string[]
    tweetType?: string
  }>(bookmark.entities)

  if (entities.length > 0) {
    const entity = entities[0]
    if (entity.hashtags?.length) {
      const hashtags = entity.hashtags.join(' ')
      passages.push({
        passageType: 'entities',
        content: hashtags,
        contextLabels: ['entity:hashtag'],
      })
    }
    if (entity.mentions?.length) {
      const mentions = entity.mentions.join(' ')
      passages.push({
        passageType: 'entities',
        content: mentions,
        contextLabels: ['entity:mention'],
      })
    }
    if (entity.tools?.length) {
      const tools = entity.tools.join(' ')
      passages.push({
        passageType: 'entities',
        content: tools,
        contextLabels: ['entity:tool'],
      })
    }
    if (entity.tweetType) {
      passages.push({
        passageType: 'entities',
        content: entity.tweetType,
        contextLabels: ['entity:type'],
      })
    }
  }

  // 5. CATEGORY_CONTEXT passages: from associated categories
  bookmark.categories.forEach((bc) => {
    const categoryText = `${bc.category.name} - ${bc.category.description || bc.category.name}`
    passages.push({
      passageType: 'category_context',
      content: categoryText,
      contextLabels: [`category:${bc.category.slug}`],
    })
  })

  return passages.filter((p) => p.content && p.content.trim().length > 0)
}

/**
 * Full rebuild of PASSAGE_FTS from all bookmarks.
 * Idempotent and fast (local SQLite).
 * Call after import or enrichment runs.
 */
export async function rebuildPassageFts(): Promise<void> {
  await ensurePassageFtsTable()
  await prisma.$executeRawUnsafe(`DELETE FROM ${PASSAGE_FTS_TABLE}`)

  const bookmarks = await prisma.bookmark.findMany({
    select: { id: true },
  })

  if (bookmarks.length === 0) return

  const BATCH = 50
  for (let i = 0; i < bookmarks.length; i += BATCH) {
    const batch = bookmarks.slice(i, i + BATCH)
    const allPassages: Array<{
      id: string
      bookmark_id: string
      passage_type: string
      content: string
      context_labels: string
      created_at: string
    }> = []

    for (const b of batch) {
      const passages = await extractPassagesFromBookmark(b.id)
      const now = new Date().toISOString()

      passages.forEach((p) => {
        allPassages.push({
          id: `${b.id}_${p.passageType}_${Math.random()}`,
          bookmark_id: b.id,
          passage_type: p.passageType,
          content: p.content,
          context_labels: JSON.stringify(p.contextLabels),
          created_at: now,
        })
      })
    }

    if (allPassages.length > 0) {
      // Use transaction to batch-insert
      await prisma.$transaction(
        allPassages.map((p) =>
          prisma.$executeRaw`
            INSERT INTO passage_fts(id, bookmark_id, passage_type, content, context_labels, created_at)
            VALUES (${p.id}, ${p.bookmark_id}, ${p.passage_type}, ${p.content}, ${p.context_labels}, ${p.created_at})
          `
        )
      )
    }
  }
}

/**
 * Incremental update: add passages for a single bookmark to PASSAGE_FTS.
 * Call when a bookmark is imported or enriched.
 */
export async function addPassagesToBookmark(bookmarkId: string): Promise<void> {
  await ensurePassageFtsTable()

  const passages = await extractPassagesFromBookmark(bookmarkId)
  const now = new Date().toISOString()

  if (passages.length === 0) return

  // Delete existing passages for this bookmark
  await prisma.$executeRawUnsafe(
    `DELETE FROM ${PASSAGE_FTS_TABLE} WHERE bookmark_id = ?`,
    bookmarkId
  )

  // Insert new passages
  const passageRecords = passages.map((p) => ({
    id: `${bookmarkId}_${p.passageType}_${Math.random()}`,
    bookmark_id: bookmarkId,
    passage_type: p.passageType,
    content: p.content,
    context_labels: JSON.stringify(p.contextLabels),
    created_at: now,
  }))

  await prisma.$transaction(
    passageRecords.map((p) =>
      prisma.$executeRaw`
        INSERT INTO passage_fts(id, bookmark_id, passage_type, content, context_labels, created_at)
        VALUES (${p.id}, ${p.bookmark_id}, ${p.passage_type}, ${p.content}, ${p.context_labels}, ${p.created_at})
      `
    )
  )
}

/**
 * Search PASSAGE_FTS table for passages matching keywords.
 * Returns passages with bookmark_id, passage_type, snippet, and context_labels.
 * Ranked by FTS5 relevance (shorter passages + higher rank preferred).
 */
export async function passageSearch(
  keywords: string[]
): Promise<PassageSearchResult[]> {
  if (keywords.length === 0) return []

  try {
    await ensurePassageFtsTable()

    // Sanitize keywords: remove FTS5 special chars, filter short terms
    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    // Build FTS5 MATCH query: OR between terms for broad recall
    const matchQuery = terms.join(' OR ')

    // Query the FTS table, ranked by relevance
    const ftsResults = await prisma.$queryRawUnsafe<
      { id: string; bookmark_id: string; passage_type: string; content: string; context_labels: string }[]
    >(`
      SELECT id, bookmark_id, passage_type, content, context_labels FROM ${PASSAGE_FTS_TABLE}
      WHERE ${PASSAGE_FTS_TABLE} MATCH ?
      ORDER BY rank, length(content) ASC
      LIMIT 200
    `, matchQuery)

    // Format results
    const results: PassageSearchResult[] = ftsResults.map((r) => ({
      bookmark_id: r.bookmark_id,
      passage_type: r.passage_type,
      snippet: r.content.substring(0, 200), // Truncate for display
      context_labels: safeJsonParse<string>(r.context_labels),
    }))

    return results
  } catch (error) {
    console.error('Passage search error:', error)
    return []
  }
}

/**
 * Helper: format context labels for display in UI.
 * Input: ["image:meme", "category:ai-resources"]
 * Output: "📷 Meme • 📂 AI Resources"
 */
export function formatContextLabels(labels: string[]): string {
  const icons: Record<string, string> = {
    'image:': '📷',
    'category:': '📂',
    'author:': '👤',
    'entity:': '🏷',
    'source:': '💫',
  }

  return labels
    .map((label) => {
      const icon = Object.entries(icons).find(([prefix]) => label.startsWith(prefix))?.[1] ?? '•'
      const text = label.split(':')[1]?.replace(/-/g, ' ') || label
      return `${icon} ${text.charAt(0).toUpperCase()}${text.slice(1)}`
    })
    .join(' • ')
}
