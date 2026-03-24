#!/usr/bin/env npx tsx
import prisma from '@/lib/db'
import { ftsSearch } from '@/lib/fts'
import { extractKeywords } from '@/lib/search-utils'

// ─── Output ──────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
function output(data: unknown): void {
  const json = isTTY ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(json + '\n')
}

function die(message: string): never {
  output({ error: message })
  process.exit(1)
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdQuery(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) die('Usage: siftly query <query>')

  const limit = Math.min(parseInt(flags.limit ?? '20', 10) || 20, 100)
  const keywords = extractKeywords(query)
  if (keywords.length === 0) die('No searchable keywords in query')

  const ftsIds = await ftsSearch(keywords)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let where: any
  if (ftsIds.length > 0) {
    where = { id: { in: ftsIds } }
  } else {
    // Fallback to LIKE
    where = {
      OR: keywords.flatMap((kw) => [
        { text: { contains: kw } },
        { semanticTags: { contains: kw } },
        { entities: { contains: kw } },
      ]),
    }
  }

  const bookmarks = await prisma.bookmark.findMany({
    where,
    take: limit,
    orderBy: ftsIds.length > 0 ? undefined : [{ tweetCreatedAt: 'desc' }],
    include: {
      mediaItems: { select: { id: true, type: true, url: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  output({
    query,
    keywords,
    count: bookmarks.length,
    bookmarks: bookmarks.map(formatBookmark),
  })
}

async function cmdGet(args: string[]) {
  const id = args[0]
  if (!id) die('Usage: siftly get <id|tweetId>')

  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id }, { tweetId: id }] },
    include: {
      mediaItems: true,
      categories: {
        include: { category: { select: { id: true, name: true, slug: true, color: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  if (!bookmark) die(`Bookmark not found: ${id}`)

  output({
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
    importedAt: bookmark.importedAt.toISOString(),
    enrichedAt: bookmark.enrichedAt?.toISOString() ?? null,
    semanticTags: safeParse(bookmark.semanticTags),
    entities: safeParse(bookmark.entities),
    enrichmentMeta: safeParse(bookmark.enrichmentMeta),
    mediaItems: bookmark.mediaItems.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      imageTags: safeParse(m.imageTags),
    })),
    categories: bookmark.categories.map((bc) => ({
      id: bc.category.id,
      name: bc.category.name,
      slug: bc.category.slug,
      color: bc.category.color,
      confidence: bc.confidence,
    })),
  })
}

async function cmdMultiGet(args: string[]) {
  const { flags } = parseArgs(args)
  const idsStr = flags.ids || ''
  const tweetIdsStr = flags.tweetIds || ''

  const ids = idsStr ? idsStr.split(',').map((s) => s.trim()).filter(Boolean) : []
  const tweetIds = tweetIdsStr ? tweetIdsStr.split(',').map((s) => s.trim()).filter(Boolean) : []

  if (ids.length === 0 && tweetIds.length === 0) {
    die('Usage: siftly multi-get --ids id1,id2 --tweetIds tweet1,tweet2')
  }

  const bookmarks = await prisma.bookmark.findMany({
    where: {
      OR: [
        ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
        ...(tweetIds.length > 0 ? [{ tweetId: { in: tweetIds } }] : []),
      ],
    },
    include: {
      mediaItems: { select: { id: true, type: true, url: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  const foundIds = new Set(bookmarks.map((b) => b.id))
  const foundTweetIds = new Set(bookmarks.map((b) => b.tweetId))
  const notFound = [...ids.filter((id) => !foundIds.has(id)), ...tweetIds.filter((tweetId) => !foundTweetIds.has(tweetId))]

  output({
    count: bookmarks.length,
    notFound,
    bookmarks: bookmarks.map(formatBookmark),
  })
}

async function cmdNeighbors(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const id = positional[0] || flags.id
  if (!id) die('Usage: siftly neighbors <id> [--mode similar|adjacent|contrasting]')

  const mode = flags.mode || 'similar'
  if (!['similar', 'adjacent', 'contrasting'].includes(mode)) {
    die(`Invalid mode: ${mode}. Use similar, adjacent, or contrasting.`)
  }

  const source = await prisma.bookmark.findUnique({
    where: { id },
    select: {
      id: true,
      categories: { include: { category: { select: { id: true, slug: true } } } },
      semanticTags: true,
      entities: true,
    },
  })

  if (!source) die(`Bookmark not found: ${id}`)

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
    take: 100,
  })

  // Calculate edge strength
  interface Edge {
    neighborId: string
    strength: number
    evidence: string[]
  }
  const edges: Edge[] = relatedBookmarks.map((b) => {
    const evidence: string[] = []
    let strength = 0

    const aCatIds = source.categories.map((c) => c.category.id)
    const bCatIds = b.categories.map((c) => c.category.id)
    const shared = aCatIds.filter((id) => bCatIds.includes(id))
    if (shared.length > 0) {
      strength += 0.5
      evidence.push(`${shared.length} shared category(ies)`)
    }

    let aTags: string[] = []
    let bTags: string[] = []
    try {
      if (source.semanticTags) aTags = JSON.parse(source.semanticTags)
      if (b.semanticTags) bTags = JSON.parse(b.semanticTags)
    } catch {
      /* ignore */
    }
    if (aTags.length > 0 && bTags.length > 0) {
      const sharedTags = aTags.filter((t) => bTags.includes(t))
      if (sharedTags.length > 0) {
        strength += 0.2
        evidence.push(`${sharedTags.length} shared tag(s)`)
      }
    }

    return {
      neighborId: b.id,
      strength: Math.min(1, strength),
      evidence: evidence.slice(0, 2),
    }
  })

  let filtered: Edge[]
  if (mode === 'similar') {
    filtered = edges.filter((e) => e.strength > 0.5).sort((a, b) => b.strength - a.strength).slice(0, 10)
  } else if (mode === 'adjacent') {
    filtered = edges
      .filter((e) => e.strength >= 0.3 && e.strength <= 0.7)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 15)
  } else {
    filtered = edges.sort((a, b) => a.strength - b.strength).slice(0, 10)
  }

  const neighbors = await prisma.bookmark.findMany({
    where: { id: { in: filtered.map((e) => e.neighborId) } },
    include: {
      mediaItems: { select: { id: true, type: true, url: true } },
      categories: {
        include: { category: { select: { name: true, slug: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  const edgeMap = new Map(filtered.map((e) => [e.neighborId, e]))
  const results = neighbors.map((n) => ({
    ...formatBookmark(n),
    edgeStrength: edgeMap.get(n.id)?.strength ?? 0,
    evidence: edgeMap.get(n.id)?.evidence ?? [],
  }))

  output({
    sourceId: id,
    mode,
    count: results.length,
    neighbors: results,
  })
}

async function cmdList(args: string[]) {
  const { flags } = parseArgs(args)

  const limit = Math.min(parseInt(flags.limit ?? '20', 10) || 20, 100)
  const page = parseInt(flags.page ?? '1', 10) || 1
  const skip = (page - 1) * limit
  const sortDir = flags.sort === 'oldest' ? 'asc' as const : 'desc' as const

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {}

  if (flags.source === 'bookmark' || flags.source === 'like') {
    where.source = flags.source
  }
  if (flags.category) {
    where.categories = { some: { category: { slug: flags.category } } }
  }
  if (flags.author) {
    where.authorHandle = flags.author
  }
  if (flags.media === 'photo' || flags.media === 'video') {
    where.mediaItems = { some: { type: flags.media } }
  }

  const [bookmarks, total] = await Promise.all([
    prisma.bookmark.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ tweetCreatedAt: sortDir }, { importedAt: sortDir }],
      include: {
        mediaItems: { select: { id: true, type: true, url: true } },
        categories: {
          include: { category: { select: { name: true, slug: true } } },
          orderBy: { confidence: 'desc' },
        },
      },
    }),
    prisma.bookmark.count({ where }),
  ])

  output({
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    bookmarks: bookmarks.map(formatBookmark),
  })
}

async function cmdShow(args: string[]) {
  const id = args[0]
  if (!id) die('Usage: siftly show <id|tweetId>')

  const bookmark = await prisma.bookmark.findFirst({
    where: { OR: [{ id }, { tweetId: id }] },
    include: {
      mediaItems: true,
      categories: {
        include: { category: { select: { id: true, name: true, slug: true, color: true } } },
        orderBy: { confidence: 'desc' },
      },
    },
  })

  if (!bookmark) die(`Bookmark not found: ${id}`)

  output({
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    source: bookmark.source,
    tweetCreatedAt: bookmark.tweetCreatedAt?.toISOString() ?? null,
    importedAt: bookmark.importedAt.toISOString(),
    enrichedAt: bookmark.enrichedAt?.toISOString() ?? null,
    semanticTags: safeParse(bookmark.semanticTags),
    entities: safeParse(bookmark.entities),
    enrichmentMeta: safeParse(bookmark.enrichmentMeta),
    mediaItems: bookmark.mediaItems.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      imageTags: safeParse(m.imageTags),
    })),
    categories: bookmark.categories.map((bc) => ({
      id: bc.category.id,
      name: bc.category.name,
      slug: bc.category.slug,
      color: bc.category.color,
      confidence: bc.confidence,
    })),
  })
}

async function cmdCategories() {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { bookmarks: true } } },
    orderBy: { name: 'asc' },
  })

  output({
    count: categories.length,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      bookmarkCount: c._count.bookmarks,
    })),
  })
}

async function cmdStats() {
  const [totalBookmarks, totalCategories, totalMedia, sourceGroups, enrichedCount] =
    await Promise.all([
      prisma.bookmark.count(),
      prisma.category.count(),
      prisma.mediaItem.count(),
      prisma.bookmark.groupBy({ by: ['source'], _count: true }),
      prisma.bookmark.count({ where: { enrichedAt: { not: null } } }),
    ])

  const sources: Record<string, number> = {}
  for (const g of sourceGroups) {
    sources[g.source] = g._count
  }

  output({
    totalBookmarks,
    enrichedBookmarks: enrichedCount,
    unenrichedBookmarks: totalBookmarks - enrichedCount,
    totalCategories,
    totalMediaItems: totalMedia,
    sources,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(json: string | null): unknown {
  if (!json) return null
  try { return JSON.parse(json) } catch { return json }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatBookmark(b: any) {
  return {
    id: b.id,
    tweetId: b.tweetId,
    text: b.text,
    authorHandle: b.authorHandle,
    authorName: b.authorName,
    source: b.source,
    tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
    mediaItems: b.mediaItems.map((m: { id: string; type: string; url: string }) => ({
      id: m.id,
      type: m.type,
      url: m.url,
    })),
    categories: b.categories.map(
      (bc: { category: { name: string; slug: string }; confidence: number }) => ({
        name: bc.category.name,
        slug: bc.category.slug,
        confidence: bc.confidence,
      })
    ),
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  query: 'query <query>             FTS5 keyword search (hybrid retrieval)',
  get: 'get <id|tweetId>          Full bookmark detail',
  'multi-get': 'multi-get --ids id1,id2 --tweetIds tweetId1,tweetId2  Batch fetch',
  neighbors: 'neighbors <id> [--mode similar|adjacent|contrasting]     Related bookmarks',
  list: 'list [--source] [--category] [--author] [--media] [--sort] [--limit] [--page]',
  show: 'show <id|tweetId>         Full bookmark detail (legacy)',
  categories: 'categories                List categories with counts',
  stats: 'stats                     Library statistics',
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const rest = args.slice(1)

  if (!command || command === '--help' || command === '-h') {
    output({
      usage: 'siftly <command> [options]',
      commands: COMMANDS,
    })
    process.exit(0)
  }

  try {
    switch (command) {
      case 'query':
        await cmdQuery(rest)
        break
      case 'get':
        await cmdGet(rest)
        break
      case 'multi-get':
        await cmdMultiGet(rest)
        break
      case 'neighbors':
        await cmdNeighbors(rest)
        break
      case 'search': // backward compat
        await cmdQuery(rest)
        break
      case 'list':
        await cmdList(rest)
        break
      case 'show':
        await cmdShow(rest)
        break
      case 'categories':
        await cmdCategories()
        break
      case 'stats':
        await cmdStats()
        break
      default:
        die(`Unknown command: ${command}. Run 'siftly --help' for usage.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table')) {
      die('Prisma client not generated or database not set up. Run: npx prisma generate && npx prisma db push')
    }
    throw err
  } finally {
    await prisma.$disconnect()
  }
}

main()
