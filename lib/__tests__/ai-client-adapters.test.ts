import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GeminiAIClient,
  OpenAIAIClient,
  OpenCodeMessagesAIClient,
  type AIMessage,
} from '@/lib/ai-client'
import type OpenAI from 'openai'

const SAMPLE_MESSAGES: AIMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'abc123',
        },
      },
    ],
  },
]

describe('ai-client adapters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps content for OpenAI-compatible clients', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    })
    const sdk = {
      chat: { completions: { create } },
    } as unknown as OpenAI

    const client = new OpenAIAIClient(sdk, 'openrouter')
    const res = await client.createMessage({
      model: 'openai/gpt-5.4-mini',
      max_tokens: 64,
      messages: SAMPLE_MESSAGES,
    })

    expect(res.text).toBe('ok')
    expect(create).toHaveBeenCalledTimes(1)
    const payload = create.mock.calls[0][0]
    expect(payload.model).toBe('openai/gpt-5.4-mini')
    expect(payload.messages[0].content[0].type).toBe('text')
    expect(payload.messages[0].content[1].type).toBe('image_url')
  })

  it('parses Gemini generateContent response text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: 'gemini ok' }] } },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new GeminiAIClient('gemini-key')
    const res = await client.createMessage({
      model: 'gemini-2.5-flash',
      max_tokens: 64,
      messages: SAMPLE_MESSAGES,
    })

    expect(res.text).toBe('gemini ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses OpenCode messages endpoint response text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'opencode ok' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenCodeMessagesAIClient('opencode-key', 'https://opencode.ai/zen/v1/messages')
    const res = await client.createMessage({
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      messages: SAMPLE_MESSAGES,
    })

    expect(res.text).toBe('opencode ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
