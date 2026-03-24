import { describe, expect, it } from 'vitest'
import {
  buildResolutionCandidates,
  executeWithBackendFallback,
  normalizeBackend,
  parseBackendList,
  type ResolvedAiBackend,
} from '@/lib/ai-backend'

function mockResolved(backend: ResolvedAiBackend['backend']): ResolvedAiBackend {
  return {
    backend,
    model: 'test-model',
    client: null,
    capabilities: {
      textGeneration: true,
      inlineImages: true,
      urlOnlyVisionFallback: true,
      cliPrompt: 'none',
      healthCheckMethod: 'none',
      modelSource: 'fixed_default',
      supportsExecutionFallback: true,
      unattendedToolExecution: false,
    },
    resolutionSource: 'autodetect',
    fallbackTrail: [backend],
    errorTrail: [],
  }
}

describe('ai-backend utils', () => {
  it('normalizes valid backends and rejects unknown values', () => {
    expect(normalizeBackend('OPENAI')).toBe('openai')
    expect(normalizeBackend(' acp_cursor ')).toBe('acp_cursor')
    expect(normalizeBackend('unknown')).toBeNull()
  })

  it('parses fallback env list and ignores invalid entries', () => {
    expect(parseBackendList('openrouter,gemini,invalid,openai')).toEqual([
      'openrouter',
      'gemini',
      'openai',
    ])
  })

  it('builds resolution candidates with deduped order', () => {
    expect(buildResolutionCandidates('openai', ['openrouter', 'openai', 'gemini'])).toEqual([
      'openai',
      'openrouter',
      'gemini',
    ])
  })

  it('retries primary backend before failing', async () => {
    const resolved = mockResolved('openrouter')
    let attempts = 0

    const result = await executeWithBackendFallback(
      resolved,
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('429 rate limit')
        return 'ok'
      },
      { maxPrimaryRetries: 2 },
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })
})
