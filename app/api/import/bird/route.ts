import { NextRequest, NextResponse } from 'next/server'
import { execSync } from 'child_process'
import prisma from '@/lib/db'
import { parseBirdOutput, adaptBirdTweet } from '@/lib/bird-adapter'
import { importBookmarks } from '@/lib/bookmark-import'

/**
 * POST /api/import/bird
 * 
 * Request body: { source: 'bookmark' | 'like' }
 * 
 * Runs the Bird CLI to fetch bookmarks or likes, parses the output,
 * and imports them through the standard dedup/persistence path.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { source?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const source = (body.source === 'like' || body.source === 'bookmark')
    ? body.source
    : 'bookmark'

  // Create import job to track progress
  const importJob = await prisma.importJob.create({
    data: {
      filename: `bird-${source}s`,
      status: 'processing',
      totalCount: 0,
      processedCount: 0,
    },
  })

  try {
    // Determine CLI command
    const birdCommand = source === 'like' ? 'likes' : 'bookmarks'

    let birdOutput: string
    try {
      // Run bird CLI: bird bookmarks --all --json or bird likes --all --json
      birdOutput = execSync(`bird ${birdCommand} --all --json`, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024, // 50MB for large exports
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`Bird CLI failed (${birdCommand}):`, errMsg)

      // Check for common errors
      if (errMsg.includes('not found') || errMsg.includes('ENOENT')) {
        throw new Error('Bird CLI not found. Install it first: https://github.com/pkamenarsky/bird')
      }
      if (errMsg.includes('Unauthorized') || errMsg.includes('401')) {
        throw new Error('Bird/X credentials not configured. Run: bird login')
      }
      throw new Error(`Bird CLI failed: ${errMsg}`)
    }

    // Parse Bird output
    let tweets
    try {
      tweets = parseBirdOutput(birdOutput)
    } catch (err) {
      throw new Error(`Failed to parse Bird output: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (tweets.length === 0) {
      await prisma.importJob.update({
        where: { id: importJob.id },
        data: { status: 'done', totalCount: 0, processedCount: 0 },
      })
      return NextResponse.json({
        jobId: importJob.id,
        imported: 0,
        skipped: 0,
        parsed: 0,
      })
    }

    // Adapt Bird tweets to Siftly format
    const bookmarks = tweets.map((tweet) => adaptBirdTweet(tweet))

    await prisma.importJob.update({
      where: { id: importJob.id },
      data: { totalCount: bookmarks.length },
    })

    // Import with shared logic
    const result = await importBookmarks(
      bookmarks.map((b) => ({
        ...b,
        source: source as 'bookmark' | 'like',
      })),
      source,
      importJob.id,
    )

    return NextResponse.json({
      jobId: importJob.id,
      imported: result.imported,
      skipped: result.skipped,
      parsed: result.parsed,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('Bird import error:', errMsg)

    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: 'error',
        errorMessage: errMsg,
      },
    })

    return NextResponse.json(
      { error: errMsg },
      { status: 400 },
    )
  }
}

/**
 * GET /api/import/bird
 * Check if Bird CLI is available
 */
export async function GET(): Promise<NextResponse> {
  try {
    execSync('bird --version', {
      stdio: 'ignore',
      timeout: 5000,
    })
    return NextResponse.json({ available: true })
  } catch {
    return NextResponse.json({ available: false })
  }
}
