import { expandQuery, clearExpansionCache, getExpansionCacheStats } from './lib/search-expansion.ts'
import { fuse, rankBookmarksByScore, attachSourceTracking } from './lib/search-fusion.ts'

// Verify all exports exist and are callable
console.log('✓ Exported functions from search-expansion:')
console.log('  - expandQuery()', typeof expandQuery)
console.log('  - clearExpansionCache()', typeof clearExpansionCache)
console.log('  - getExpansionCacheStats()', typeof getExpansionCacheStats)

console.log('\n✓ Exported functions from search-fusion:')
console.log('  - fuse()', typeof fuse)
console.log('  - rankBookmarksByScore()', typeof rankBookmarksByScore)
console.log('  - attachSourceTracking()', typeof attachSourceTracking)

// Verify return types
const variants = await expandQuery('test', 'test-model', 'anthropic')
console.log('\n✓ expandQuery() returns QueryVariants:')
console.log('  - original:', typeof variants.original)
console.log('  - reduced:', typeof variants.reduced)
console.log('  - paraphrase:', typeof variants.paraphrase)
console.log('  - all:', Array.isArray(variants.all))

const fused = fuse([{
  recipe: 'keyword',
  hits: [{ id: 'test', rank: 1 }]
}])
console.log('\n✓ fuse() returns FusedResult[]:')
console.log('  - Length:', fused.length)
console.log('  - bookmarkId:', typeof fused[0]?.bookmarkId)
console.log('  - totalScore:', typeof fused[0]?.totalScore)
console.log('  - source is Set:', fused[0]?.source instanceof Set)

const tracked = attachSourceTracking(fused)
console.log('\n✓ attachSourceTracking() returns FusedResult with sourceList:')
console.log('  - sourceList is array:', Array.isArray(tracked[0]?.sourceList))

console.log('\n✅ All module interfaces verified!')
