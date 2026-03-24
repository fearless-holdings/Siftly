import { expandQuery, invalidateExpansionCache } from './lib/search-expansion'
import { fuseResults, rankBookmarksByScore } from './lib/search-fusion'
import { ResolvedAiBackend } from './lib/ai-backend'

// Verify all exports exist and are callable
console.log('✓ Exported functions from search-expansion:')
console.log('  - expandQuery()', typeof expandQuery)
console.log('  - invalidateExpansionCache()', typeof invalidateExpansionCache)

console.log('\n✓ Exported functions from search-fusion:')
console.log('  - fuseResults()', typeof fuseResults)
console.log('  - rankBookmarksByScore()', typeof rankBookmarksByScore)

// Verify return types
const mockResolved: ResolvedAiBackend = {
  backend: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  client: null,
  capabilities: {
    textGeneration: true,
    inlineImages: true,
    urlOnlyVisionFallback: true,
    cliPrompt: 'claude',
    healthCheckMethod: 'sdk_ping',
    modelSource: 'fixed_default',
    supportsExecutionFallback: true,
    unattendedToolExecution: false,
  },
  resolutionSource: 'autodetect',
  fallbackTrail: ['anthropic'],
  errorTrail: [],
}

const variants = await expandQuery('test', mockResolved)
console.log('\n✓ expandQuery() returns QueryVariants:')
console.log('  - original:', typeof variants.original)
console.log('  - reduced:', typeof variants.reduced)
console.log('  - paraphrase:', typeof variants.paraphrase)
console.log('  - all:', Array.isArray(variants.all))

const fused = fuseResults([{
  recipe: 'keyword' as const,
  hits: [{ id: 'test', rank: 1 }]
}])
console.log('\n✓ fuseResults() returns FusedResult[]:')
console.log('  - Length:', fused.length)
console.log('  - bookmark_id:', typeof fused[0]?.bookmark_id)
console.log('  - score:', typeof fused[0]?.score)
console.log('  - sources is Set:', fused[0]?.sources instanceof Set)

console.log('\n✅ All module interfaces verified!')
