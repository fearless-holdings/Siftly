/**
 * Bird CLI importer for Siftly
 * Wraps bird CLI execution and adapts output to Siftly's import format
 */

import { execSync } from 'child_process'
import { ImportedBookmark } from '@/lib/bookmark-importer'
import { parseBirdOutput, adaptBirdTweet } from '@/lib/bird-adapter'

/**
 * Check if bird CLI is available
 */
export function isBirdCliAvailable(): boolean {
  try {
    execSync('bird --version', {
      stdio: 'ignore',
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Import bookmarks or likes from Bird CLI
 * @param command 'bookmarks' or 'likes'
 * @returns Parsed ImportedBookmark array
 * @throws Error if bird CLI not installed or command fails
 */
export function importFromBird(command: 'bookmarks' | 'likes'): ImportedBookmark[] {
  if (command !== 'bookmarks' && command !== 'likes') {
    throw new Error(`Invalid bird command: ${command}`)
  }

  let output: string
  try {
    output = execSync(`bird ${command} --all --json`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large exports
    })
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        throw new Error('Bird CLI not found. Install from: https://github.com/pkamenarsky/bird')
      }
      if (err.message.includes('Unauthorized') || err.message.includes('401')) {
        throw new Error('Bird/X credentials not configured. Run: bird login')
      }
      throw new Error(`Bird CLI failed: ${err.message}`)
    }
    throw err
  }

  if (!output.trim()) {
    throw new Error('Bird CLI returned empty output')
  }

  let tweets
  try {
    tweets = parseBirdOutput(output)
  } catch (err) {
    throw new Error(
      `Failed to parse Bird JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const bookmarks: ImportedBookmark[] = []
  for (const tweet of tweets) {
    try {
      const adapted = adaptBirdTweet(tweet)
      bookmarks.push({
        tweetId: adapted.tweetId,
        text: adapted.text,
        authorHandle: adapted.authorHandle,
        authorName: adapted.authorName,
        tweetCreatedAt: adapted.tweetCreatedAt,
        rawJson: adapted.rawJson,
        media: adapted.media,
      })
    } catch (err) {
      console.warn('Failed to adapt bird tweet:', err instanceof Error ? err.message : String(err))
    }
  }

  if (bookmarks.length === 0) {
    throw new Error('No valid tweets found in Bird output')
  }

  return bookmarks
}
