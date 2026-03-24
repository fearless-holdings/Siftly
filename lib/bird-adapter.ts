/**
 * Bird CLI adapter - converts Bird's output format to Siftly internal format
 */

interface BirdMediaVariant {
  bitrate?: number
  content_type?: string
  url?: string
}

interface BirdMediaEntity {
  type?: string
  media_url?: string
  media_url_https?: string
  video_info?: {
    variants?: BirdMediaVariant[]
  }
}

interface BirdTweet {
  id?: string | number
  id_str?: string
  text?: string
  full_text?: string
  created_at?: string
  author?: {
    username?: string
    name?: string
    screen_name?: string
  }
  user?: {
    screen_name?: string
    name?: string
  }
  media?: BirdMediaEntity[]
  entities?: {
    media?: BirdMediaEntity[]
    hashtags?: Array<{ text?: string }>
    urls?: Array<{ expanded_url?: string; url?: string }>
  }
  extended_entities?: {
    media?: BirdMediaEntity[]
  }
  [key: string]: unknown
}

interface ParsedBookmark {
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
}

interface ExtractedEntities {
  hashtags?: string[]
  tools?: string[]
}

/**
 * Parse Bird CLI JSON output - supports multiple response formats
 */
export function parseBirdOutput(jsonString: string): BirdTweet[] {
  if (!jsonString || jsonString.trim() === '') {
    throw new Error('Empty JSON string from Bird')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonString)
  } catch (err) {
    throw new Error(`Invalid JSON from Bird: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Handle various response shapes
  if (Array.isArray(parsed)) {
    return parsed
  }

  if (typeof parsed === 'object' && parsed !== null) {
    // Try common wrappers
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.tweets)) return obj.tweets as BirdTweet[]
    if (Array.isArray(obj.data)) return obj.data as BirdTweet[]
    if (Array.isArray(obj.bookmarks)) return obj.bookmarks as BirdTweet[]
  }

  throw new Error('Bird output is not an array or object with array data')
}

/**
 * Convert Bird tweet to Siftly ParsedBookmark format
 */
export function adaptBirdTweet(tweet: BirdTweet): ParsedBookmark {
  const tweetId = tweet.id_str ?? String(tweet.id ?? '')
  if (!tweetId) {
    throw new Error('Tweet has no id')
  }

  const text = tweet.full_text ?? tweet.text ?? ''
  const authorHandle = tweet.author?.username ?? tweet.user?.screen_name ?? 'unknown'
  const authorName = tweet.author?.name ?? tweet.user?.name ?? authorHandle

  let tweetCreatedAt: Date | null = null
  if (tweet.created_at) {
    const parsed = new Date(tweet.created_at)
    if (!isNaN(parsed.getTime())) {
      tweetCreatedAt = parsed
    }
  }

  // Extract media
  const mediaEntities = tweet.extended_entities?.media ?? tweet.entities?.media ?? tweet.media ?? []
  const media = mediaEntities
    .map((m): ParsedBookmark['media'][0] | null => {
      const mediaType = m.type === 'video' ? 'video' : m.type === 'animated_gif' ? 'gif' : 'photo'
      const thumbnailUrl = m.media_url_https ?? m.media_url

      if (mediaType === 'video' || mediaType === 'gif') {
        const variants = m.video_info?.variants ?? []
        const videoVariants = variants.filter((v) => v.content_type === 'video/mp4' && v.url)
        if (videoVariants.length === 0) return null
        const sorted = [...videoVariants].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        const url = sorted[0].url
        if (!url) return null
        return { type: mediaType, url, thumbnailUrl }
      }

      if (!thumbnailUrl) return null
      return { type: 'photo', url: thumbnailUrl, thumbnailUrl }
    })
    .filter((m): m is ParsedBookmark['media'][0] => m !== null)

  return {
    tweetId,
    text,
    authorHandle,
    authorName,
    tweetCreatedAt,
    media,
    rawJson: JSON.stringify(tweet),
  }
}

/**
 * Extract entities from Bird tweet that can be used for categorization hints
 */
export function extractBirdEntities(tweet: BirdTweet): ExtractedEntities {
  const entities: ExtractedEntities = {}

  // Extract hashtags
  const hashtags = tweet.entities?.hashtags ?? []
  if (hashtags.length > 0) {
    entities.hashtags = hashtags
      .map((h) => h.text)
      .filter((t): t is string => t != null && t.length > 0)
  }

  return entities
}
