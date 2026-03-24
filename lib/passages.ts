/**
 * Passage indexing for QMD-like search.
 * Generates semantically meaningful passages from bookmarks after enrichment.
 * Passages are indexed in FTS5 for hybrid retrieval.
 */

import prisma from '@/lib/db'

type PassageType = 'text' | 'ocr' | 'semantic' | 'entities' | 'category_context'

interface Passage {
  bookmarkId: string
  passageType: PassageType
  content: string
  context?: string
}

/**
 * Generate passages from a bookmark's enriched fields.
 */
export function generatePassagesFromBookmark(b: {
  id: string
  text: string
  semanticTags: string | null
  entities: string | null
  mediaItems: { imageTags: string | null }[]
  categories: { category: { name: string; slug: string }; confidence: number }[]
}): Passage[] {
  const passages: Passage[] = []

  // Passage 1: Main text (primary signal)
  if (b.text.length > 0) {
    passages.push({
      bookmarkId: b.id,
      passageType: 'text',
      content: b.text.slice(0, 500),
    })
  }

  // Passage 2: Semantic tags (AI-computed context)
  if (b.semanticTags && b.semanticTags !== '[]') {
    try {
      const tags = JSON.parse(b.semanticTags) as string[]
      if (tags.length > 0) {
        passages.push({
          bookmarkId: b.id,
          passageType: 'semantic',
          content: tags.slice(0, 20).join(' '),
          context: 'Semantic tags extracted via AI enrichment',
        })
      }
    } catch {
      // ignore
    }
  }

  // Passage 3: OCR text from images
  if (b.mediaItems.length > 0) {
    const ocrTexts: string[] = []
    for (const m of b.mediaItems) {
      if (m.imageTags) {
        try {
          const tags = JSON.parse(m.imageTags) as Record<string, unknown>
          if (Array.isArray(tags.text_ocr)) {
            ocrTexts.push(...(tags.text_ocr as string[]))
          }
        } catch {
          // ignore
        }
      }
    }
    if (ocrTexts.length > 0) {
      passages.push({
        bookmarkId: b.id,
        passageType: 'ocr',
        content: ocrTexts.slice(0, 15).join(' | ').slice(0, 300),
        context: 'Text extracted from images via OCR',
      })
    }
  }

  // Passage 4: Extracted entities (hashtags, tools, mentions)
  if (b.entities) {
    try {
      const ent = JSON.parse(b.entities) as {
        hashtags?: string[]
        tools?: string[]
        mentions?: string[]
      }
      const parts: string[] = []
      if (ent.hashtags?.length) parts.push(`hashtags: ${ent.hashtags.slice(0, 10).join(' ')}`)
      if (ent.tools?.length) parts.push(`tools: ${ent.tools.join(' ')}`)
      if (ent.mentions?.length) parts.push(`mentions: ${ent.mentions.slice(0, 5).join(' ')}`)
      if (parts.length > 0) {
        passages.push({
          bookmarkId: b.id,
          passageType: 'entities',
          content: parts.join(' | '),
          context: 'Extracted entities: hashtags, tools, mentions',
        })
      }
    } catch {
      // ignore
    }
  }

  // Passage 5: Category context (high-confidence categories as context)
  if (b.categories.length > 0) {
    const highConf = b.categories
      .filter((c) => c.confidence >= 0.7)
      .map((c) => `${c.category.name}(${c.category.slug})`)
    if (highConf.length > 0) {
      passages.push({
        bookmarkId: b.id,
        passageType: 'category_context',
        content: highConf.slice(0, 8).join(' '),
        context: `Categories (confidence >= 0.7): ${highConf.slice(0, 3).join(', ')}`,
      })
    }
  }

  return passages
}

/**
 * Regenerate passages for specific bookmarks (after enrichment).
 * Clears old passages and writes new ones.
 */
export async function regeneratePassages(bookmarkIds: string[]): Promise<void> {
  if (bookmarkIds.length === 0) return

  // Delete old passages
  await prisma.passage.deleteMany({
    where: { bookmarkId: { in: bookmarkIds } },
  })

  // Fetch full bookmark context
  const bookmarks = await prisma.bookmark.findMany({
    where: { id: { in: bookmarkIds } },
    select: {
      id: true,
      text: true,
      semanticTags: true,
      entities: true,
      mediaItems: { select: { imageTags: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
      },
    },
  })

  // Generate and batch-insert passages
  const passages: Passage[] = []
  for (const b of bookmarks) {
    passages.push(...generatePassagesFromBookmark(b))
  }

  if (passages.length === 0) return

  // Insert in batches
  const BATCH = 500
  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH)
    await prisma.passage.createMany({
      data: batch.map((p) => ({
        bookmarkId: p.bookmarkId,
        passageType: p.passageType,
        content: p.content,
        context: p.context || null,
      })),
    })
  }
}
