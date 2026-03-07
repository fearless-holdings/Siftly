import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

interface MediaVariant {
  content_type?: string
  bitrate?: number
  url?: string
}

interface MediaEntity {
  type?: string
  media_url_https?: string
  video_info?: { variants?: MediaVariant[] }
}

interface TweetResult {
  rest_id?: string
  legacy?: {
    full_text?: string
    created_at?: string
    extended_entities?: { media?: MediaEntity[] }
    entities?: { media?: MediaEntity[] }
  }
  core?: {
    user_results?: {
      result?: { legacy?: { screen_name?: string; name?: string } }
    }
  }
}

function bestVideoUrl(variants: MediaVariant[]): string | null {
  return (
    variants
      .filter((v) => v.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? null
  )
}

function extractMedia(tweet: TweetResult) {
  const entities =
    tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media ?? []
  return entities
    .map((m) => {
      const thumb = m.media_url_https ?? ''
      if (m.type === 'video' || m.type === 'animated_gif') {
        const url = bestVideoUrl(m.video_info?.variants ?? []) ?? thumb
        if (!url) return null
        return { type: m.type === 'animated_gif' ? 'gif' : 'video', url, thumbnailUrl: thumb }
      }
      if (!thumb) return null
      return { type: 'photo' as const, url: thumb, thumbnailUrl: thumb }
    })
    .filter(Boolean) as { type: string; url: string; thumbnailUrl: string }[]
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { tweets?: TweetResult[]; source?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS })
  }

  const source = body.source === 'like' ? 'like' : 'bookmark'
  const tweets = body.tweets ?? []
  if (!Array.isArray(tweets) || tweets.length === 0) {
    return NextResponse.json({ error: 'No tweets provided' }, { status: 400, headers: CORS })
  }

  let imported = 0
  let skipped = 0

  for (const tweet of tweets) {
    if (!tweet.rest_id) continue

    const exists = await prisma.bookmark.findUnique({
      where: { tweetId: tweet.rest_id },
      select: { id: true },
    })

    if (exists) {
      skipped++
      continue
    }

    const userLegacy = tweet.core?.user_results?.result?.legacy ?? {}
    const media = extractMedia(tweet)

    const created = await prisma.bookmark.create({
      data: {
        tweetId: tweet.rest_id,
        text: tweet.legacy?.full_text ?? '',
        authorHandle: userLegacy.screen_name ?? 'unknown',
        authorName: userLegacy.name ?? 'Unknown',
        tweetCreatedAt: tweet.legacy?.created_at
          ? new Date(tweet.legacy.created_at)
          : null,
        rawJson: JSON.stringify(tweet),
        source,
      },
    })

    if (media.length > 0) {
      await prisma.mediaItem.createMany({
        data: media.map((m) => ({
          bookmarkId: created.id,
          type: m.type,
          url: m.url,
          thumbnailUrl: m.thumbnailUrl ?? null,
        })),
      })
    }

    imported++
  }

  return NextResponse.json({ imported, skipped }, { headers: CORS })
}
