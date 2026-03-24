import { NextRequest, NextResponse } from 'next/server'
import { resolveAiBackend, type AiBackendId } from '@/lib/ai-backend'

function normalizeBackend(value: string | undefined): AiBackendId | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'anthropic' ||
    normalized === 'openai' ||
    normalized === 'openrouter' ||
    normalized === 'gemini' ||
    normalized === 'opencode' ||
    normalized === 'acp_cursor' ||
    normalized === 'acp_amp'
  ) {
    return normalized
  }
  return null
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { provider?: string } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const requested = normalizeBackend(body.provider)
  if (body.provider && !requested && body.provider !== 'auto') {
    return NextResponse.json({ error: 'Unknown provider/backend' }, { status: 400 })
  }

  try {
    const resolved = await resolveAiBackend({
      ...(requested ? { preferredBackend: requested } : {}),
      ...(requested ? { allowFallback: false } : {}),
    })

    if (!resolved.client) {
      if (resolved.capabilities.cliPrompt !== 'none') {
        return NextResponse.json({
          working: true,
          backend: resolved.backend,
          mode: 'cli-only',
          model: resolved.model,
          resolutionSource: resolved.resolutionSource,
        })
      }
      return NextResponse.json({
        working: false,
        backend: resolved.backend,
        mode: 'no-client',
        error: `No API client available for backend "${resolved.backend}".`,
      })
    }

    await resolved.client.createMessage({
      model: resolved.model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with only OK' }],
    })

    return NextResponse.json({
      working: true,
      backend: resolved.backend,
      mode: 'api',
      model: resolved.model,
      resolutionSource: resolved.resolutionSource,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const friendly = msg.includes('401') || msg.includes('invalid_api_key')
      ? 'Invalid API key'
      : msg.includes('403')
      ? 'Key/account does not have permission'
      : msg.slice(0, 180)
    return NextResponse.json({ working: false, error: friendly })
  }
}
