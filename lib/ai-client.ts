import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { resolveAnthropicClient } from './claude-cli-auth'
import { resolveOpenAIClient } from './openai-auth'
import { acpPrompt } from './acp-completion'

export interface AIContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

export interface AIResponse {
  text: string
}

export type AIProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'opencode' | 'acp'

export interface AIClient {
  provider: AIProvider
  createMessage(params: {
    model: string
    max_tokens: number
    messages: AIMessage[]
  }): Promise<AIResponse>
}

// Wrap Anthropic SDK
export class AnthropicAIClient implements AIClient {
  provider = 'anthropic' as const
  constructor(private sdk: Anthropic) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const messages = params.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }
      const blocks = m.content.map(b => {
        if (b.type === 'image' && b.source) {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: b.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: b.source.data,
            },
          }
        }
        return { type: 'text' as const, text: b.text ?? '' }
      })
      return { role: m.role as 'user' | 'assistant', content: blocks }
    })

    const msg = await this.sdk.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    const textBlock = msg.content.find(b => b.type === 'text')
    return { text: textBlock && 'text' in textBlock ? textBlock.text : '' }
  }
}

function toOpenAIMessage(
  message: AIMessage,
): OpenAI.ChatCompletionMessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content } as OpenAI.ChatCompletionMessageParam
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim()
    return { role: 'assistant', content: text } as OpenAI.ChatCompletionMessageParam
  }

  const content: OpenAI.ChatCompletionContentPart[] = message.content.map((block) => {
    if (block.type === 'image' && block.source) {
      return {
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      }
    }
    return { type: 'text', text: block.text ?? '' }
  })

  return { role: 'user', content } as OpenAI.ChatCompletionMessageParam
}

function extractOpenAIText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part): part is { type?: unknown; text?: unknown } => typeof part === 'object' && part !== null)
      .filter((part) => part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
    return textParts.join('\n').trim()
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const maybeText = (content as { text?: unknown }).text
    if (typeof maybeText === 'string') return maybeText
  }
  return ''
}

export class OpenAIAIClient implements AIClient {
  provider: 'openai' | 'openrouter' | 'opencode'
  constructor(private sdk: OpenAI, provider: 'openai' | 'openrouter' | 'opencode' = 'openai') {
    this.provider = provider
  }

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const messages = params.messages.map(toOpenAIMessage)

    const completion = await this.sdk.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    })

    return { text: extractOpenAIText(completion.choices[0]?.message?.content) }
  }
}

export class GeminiAIClient implements AIClient {
  provider = 'gemini' as const

  constructor(
    private apiKey: string,
    private baseURL = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com',
  ) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const contents = params.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.map((block) => {
            if (block.type === 'image' && block.source) {
              return {
                inlineData: {
                  mimeType: block.source.media_type,
                  data: block.source.data,
                },
              }
            }
            return { text: block.text ?? '' }
          }),
    }))

    const url = `${this.baseURL}/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: params.max_tokens },
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Gemini API error ${response.status}: ${body.slice(0, 220)}`)
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('\n')
      .trim() ?? ''

    return { text }
  }
}

export class OpenCodeMessagesAIClient implements AIClient {
  provider = 'opencode' as const

  constructor(
    private apiKey: string,
    private endpoint: string,
  ) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const messages = params.messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content }
      }

      return {
        role: m.role,
        content: m.content.map((block) => {
          if (block.type === 'image' && block.source) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.media_type,
                data: block.source.data,
              },
            }
          }
          return { type: 'text', text: block.text ?? '' }
        }),
      }
    })

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.max_tokens,
        messages,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`OpenCode Messages API error ${response.status}: ${body.slice(0, 220)}`)
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>
    }
    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim() ?? ''

    return { text }
  }
}

export class ACPAIClient implements AIClient {
  provider = 'acp' as const

  constructor(
    private options: {
      command: string
      args: string[]
      authMethodId?: string
      mode?: 'ask' | 'plan' | 'agent'
      timeoutMs?: number
    },
  ) {}

  async createMessage(params: { model: string; max_tokens: number; messages: AIMessage[] }): Promise<AIResponse> {
    const prompt = params.messages
      .map((m) => {
        const content = typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => (b.type === 'text' ? (b.text ?? '') : '[image omitted]'))
              .join('\n')
        return `${m.role.toUpperCase()}:\n${content}`
      })
      .join('\n\n')

    const text = await acpPrompt({
      command: this.options.command,
      args: this.options.args,
      authMethodId: this.options.authMethodId,
      mode: this.options.mode ?? 'ask',
      timeoutMs: this.options.timeoutMs ?? 120_000,
      prompt: `${prompt}\n\nRespond in plain text only.`,
      model: params.model,
      maxTokens: params.max_tokens,
    })

    return { text }
  }
}

export type ResolvableBackend = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'opencode' | 'acp_cursor' | 'acp_amp'

export interface ResolveAIClientOptions {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
  command?: string
  args?: string[]
}

function getEnvKey(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

export async function resolveAIClientForBackend(
  backend: ResolvableBackend,
  options: ResolveAIClientOptions = {},
): Promise<AIClient> {
  if (backend === 'anthropic') {
    const client = resolveAnthropicClient(options)
    return new AnthropicAIClient(client)
  }

  if (backend === 'openai') {
    const client = resolveOpenAIClient(options)
    return new OpenAIAIClient(client, 'openai')
  }

  if (backend === 'openrouter') {
    const key = options.overrideKey?.trim() || options.dbKey?.trim() || getEnvKey('OPENROUTER_API_KEY')
    if (!key) throw new Error('No OpenRouter API key found (OPENROUTER_API_KEY)')
    const baseURL = options.baseURL?.trim() || process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1'
    const sdk = new OpenAI({
      apiKey: key,
      baseURL,
      defaultHeaders: {
        ...(process.env.OPENROUTER_REFERER?.trim() ? { 'HTTP-Referer': process.env.OPENROUTER_REFERER.trim() } : {}),
        ...(process.env.OPENROUTER_TITLE?.trim() ? { 'X-OpenRouter-Title': process.env.OPENROUTER_TITLE.trim() } : {}),
      },
    })
    return new OpenAIAIClient(sdk, 'openrouter')
  }

  if (backend === 'gemini') {
    const key = options.overrideKey?.trim() || options.dbKey?.trim() || getEnvKey('GEMINI_API_KEY')
    if (!key) throw new Error('No Gemini API key found (GEMINI_API_KEY)')
    return new GeminiAIClient(key, options.baseURL)
  }

  if (backend === 'opencode') {
    const key = options.overrideKey?.trim() || options.dbKey?.trim() || getEnvKey('OPENCODE_API_KEY')
    if (!key) throw new Error('No OpenCode API key found (OPENCODE_API_KEY)')
    const endpoint = options.baseURL?.trim() || process.env.OPENCODE_CHAT_URL?.trim() || 'https://opencode.ai/zen/v1/chat/completions'

    if (endpoint.includes('/messages')) {
      return new OpenCodeMessagesAIClient(key, endpoint)
    }

    if (endpoint.includes('/responses')) {
      throw new Error('OpenCode /responses endpoint is not supported by this adapter yet; use OPENCODE_CHAT_URL with /chat/completions or /messages')
    }

    const baseURL = endpoint.replace(/\/chat\/completions\/?$/, '')
    const sdk = new OpenAI({ apiKey: key, baseURL })
    return new OpenAIAIClient(sdk, 'opencode')
  }

  const experimentalAcp = ['1', 'true', 'yes'].includes((process.env.SIFTLY_EXPERIMENTAL_ACP ?? '').toLowerCase())
  if (!experimentalAcp) {
    throw new Error('ACP backend is disabled. Set SIFTLY_EXPERIMENTAL_ACP=1 to enable.')
  }

  if (backend === 'acp_cursor') {
    const command = options.command?.trim() || process.env.SIFTLY_ACP_CURSOR_COMMAND?.trim() || 'agent'
    const args = options.args ?? (process.env.SIFTLY_ACP_CURSOR_ARGS?.split(',').map((v) => v.trim()).filter(Boolean) ?? ['acp'])
    return new ACPAIClient({
      command,
      args,
      authMethodId: process.env.SIFTLY_ACP_CURSOR_AUTH_METHOD?.trim() || 'cursor_login',
      mode: 'ask',
      timeoutMs: 120_000,
    })
  }

  const command = options.command?.trim() || process.env.SIFTLY_ACP_AMP_COMMAND?.trim() || 'acp-amp'
  const args = options.args ?? (process.env.SIFTLY_ACP_AMP_ARGS?.split(',').map((v) => v.trim()).filter(Boolean) ?? [])
  return new ACPAIClient({
    command,
    args,
    authMethodId: process.env.SIFTLY_ACP_AMP_AUTH_METHOD?.trim() || undefined,
    mode: 'ask',
    timeoutMs: 120_000,
  })
}

export async function resolveAIClient(options: ResolveAIClientOptions = {}): Promise<AIClient> {
  const { getProvider } = await import('./settings')
  const provider = await getProvider()
  return resolveAIClientForBackend(provider, options)
}
