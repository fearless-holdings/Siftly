import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { findRelatedBookmarks } from '@/lib/relatedness'

/**
 * POST /api/explore/trail
 * Exploratory traversal starting from a bookmark ID.
 * Request: { startId: string, depth?: number, breadth?: number, preset?: 'similar'|'adjacent'|'contrasting'|'timeline' }
 * Response: { trail: Array<{ id, depth, score, path, evidence }> }
 * Agent-facing endpoint for graph exploration without visual mindmap.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { startId?: string; depth?: number; breadth?: number; preset?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { startId, preset = 'adjacent' } = body
  if (!startId) {
    return NextResponse.json({ error: 'startId required' }, { status: 400 })
  }

  // Default traversal params
  const maxDepth = Math.min(Math.max(1, body.depth ?? 2), 4)
  const breadthPerLevel = Math.min(Math.max(1, body.breadth ?? 5), 20)

  try {
    // Verify start bookmark exists
    const startBookmark = await prisma.bookmark.findUnique({
      where: { id: startId },
      select: { id: true, tweetCreatedAt: true },
    })

    if (!startBookmark) {
      return NextResponse.json({ error: 'Start bookmark not found' }, { status: 404 })
    }

    // BFS-style traversal
    const visited = new Set<string>([startId])
    const trail: Array<{
      id: string
      depth: number
      score: number
      path: string[] // path taken to reach this node
      reasons: string[]
    }> = [{ id: startId, depth: 0, score: 1, path: [startId], reasons: ['start node'] }]

    const queue: Array<{ currentId: string; currentDepth: number; pathToHere: string[] }> = [
      { currentId: startId, currentDepth: 0, pathToHere: [startId] },
    ]

    while (queue.length > 0) {
      const { currentId, currentDepth, pathToHere } = queue.shift()!

      if (currentDepth >= maxDepth) continue

      // Find neighbors based on preset
      const mode = preset === 'timeline' ? 'adjacent' : (preset as any)
      const neighbors = await findRelatedBookmarks(currentId, {
        limit: breadthPerLevel,
        mode,
      })

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.targetId)) continue
        if (visited.size >= 100) break // Reasonable upper bound

        visited.add(neighbor.targetId)

        const newPath = [...pathToHere, neighbor.targetId]
        trail.push({
          id: neighbor.targetId,
          depth: currentDepth + 1,
          score: neighbor.score,
          path: newPath,
          reasons: neighbor.reasons,
        })

        queue.push({
          currentId: neighbor.targetId,
          currentDepth: currentDepth + 1,
          pathToHere: newPath,
        })
      }
    }

    // Apply timeline sort if preset is 'timeline'
    if (preset === 'timeline') {
      const bookmarks = await prisma.bookmark.findMany({
        where: { id: { in: trail.map((t) => t.id) } },
        select: { id: true, tweetCreatedAt: true },
      })

      const dateMap = new Map(bookmarks.map((b) => [b.id, b.tweetCreatedAt]))
      trail.sort((a, b) => {
        const dateA = dateMap.get(a.id) ?? new Date(0)
        const dateB = dateMap.get(b.id) ?? new Date(0)
        return dateA.getTime() - dateB.getTime()
      })
    }

    return NextResponse.json({
      startId,
      nodeCount: visited.size,
      maxDepth: Math.max(...trail.map((t) => t.depth)),
      preset,
      trail: trail.slice(0, 50).map((t) => ({
        id: t.id,
        depth: t.depth,
        score: t.score,
        path: t.path,
        reasons: t.reasons,
      })),
    })
  } catch (err) {
    console.error('Trail POST error:', err)
    return NextResponse.json(
      { error: `Failed to explore trail: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}
