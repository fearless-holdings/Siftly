# Phase 4 Part B: Query Expansion & Hybrid Retrieval

## Overview

Phase 4 Part B implements two core modules for advanced search:

1. **lib/search-expansion.ts** — Query expansion with keyword reduction and AI paraphrasing
2. **lib/search-fusion.ts** — Reciprocal Rank Fusion (RRF) for combining multiple search recipes

## lib/search-expansion.ts

### Purpose
Expands a user's search query into multiple variants to improve recall:
- **Original**: The exact user query
- **Reduced**: Keyword-only version (stop words removed)
- **Paraphrase**: Optional AI-generated semantic variant (short & fast)

### Key Features

**QueryVariants Interface**
```typescript
export interface QueryVariants {
  original: string      // User's exact query
  reduced: string       // Stop words removed, keywords only
  paraphrase?: string   // AI-generated variant (optional, defensive)
  all: string[]         // Array of all variants for batch retrieval
}
```

**expandQuery() Function**
```typescript
export async function expandQuery(
  query: string,
  model: string,
  provider: 'anthropic' | 'openai',
  client: AIClient | null = null,
): Promise<QueryVariants>
```

- **Input**: User query, AI model, provider, optional pre-initialized client
- **Output**: QueryVariants with all query forms
- **Behavior**:
  - CLI-first for Anthropic (tries Claude Code CLI before SDK)
  - SDK fallback (uses passed client if CLI unavailable)
  - Defensive: if AI fails, returns just original + reduced
  - Caches paraphrases for 1 hour (module-level Map)

**Implementation Details**

1. **Keyword Reduction**: Uses `extractKeywords()` from search-utils.ts
   - Removes stop words (a, the, and, etc.)
   - Filters short terms (<2 chars)
   - Keeps domain terms (AI, KYC, ML)
   - Returns top 5 keywords

2. **AI Paraphrasing**:
   - Prompt: "Rephrase in 10 words or less, preserving intent"
   - Max tokens: 50 (minimal latency)
   - Designed for Haiku-class models
   - Try/catch with null return on failure

3. **Caching**:
   - Module-level Map with cache key: `{provider}:{model}:{query}`
   - TTL: 1 hour (3600 seconds)
   - Checked on every call, expired entries auto-skipped
   - `clearExpansionCache()` for testing/debug

### Usage Example

```typescript
import { expandQuery } from '@/lib/search-expansion'
import { resolveAnthropicClient } from '@/lib/claude-cli-auth'
import { getAnthropicModel } from '@/lib/settings'

// Simple: let it try CLI first
const model = await getAnthropicModel()
const variants = await expandQuery('AI agents', model, 'anthropic', null)
// Returns: { original: 'AI agents', reduced: 'ai agents', paraphrase: '...', all: [...] }

// Advanced: pass explicit client
const client = new AnthropicAIClient(resolveAnthropicClient())
const variants = await expandQuery('query', model, 'anthropic', client)
```

## lib/search-fusion.ts

### Purpose
Combines ranked results from multiple search recipes (keyword, passage, intent) into a single merged ranking using Reciprocal Rank Fusion (RRF).

### Key Features

**RRFScore Interface** (for reference/diagnostics)
```typescript
export interface RRFScore {
  bookmark_id: string
  recipe: 'keyword' | 'intent' | 'passage'
  rank: number
  count: number
}
```

**FusedResult Interface**
```typescript
export interface FusedResult {
  bookmarkId: string
  totalScore: number          // Sum of RRF contributions across recipes
  source: Set<'keyword' | 'intent' | 'passage'>  // Which recipes contributed
}
```

**fuse() Function**
```typescript
export function fuse(
  results: Array<{
    recipe: 'keyword' | 'intent' | 'passage'
    hits: Array<{ id: string; rank: number }>
  }>,
  weights: Partial<Record<'keyword' | 'intent' | 'passage', number>> = {},
): FusedResult[]
```

### RRF Algorithm

**Formula**: `RRF(rank) = 1 / (k + rank)` where k=60

**Steps**:
1. For each search recipe (keyword, passage, intent):
   - Iterate through ranked hits
   - Compute: `baseScore = 1 / (60 + rank)`
   - Apply recipe weight: `weighted = baseScore * weight[recipe]`
   - Boost top-3 ranks: multiply by 2 if `rank <= 3`
   - Accumulate per `bookmark_id`

2. Track source recipes per bookmark

3. Sort by `totalScore` descending, return top 30

**Default Weights**:
- `keyword`: 2.0 (strongest signal)
- `passage`: 1.5 (medium signal)
- `intent`: 1.0 (baseline)

**Top-3 Boosting**:
- Ranks 1-3 in any recipe get 2x multiplier
- Encourages early results from any source
- Prevents deep-ranked items from scoring too high

### Example Calculation

For a bookmark appearing in 2 recipes:

```
Recipe 1 (keyword, weight 2.0):
  Rank 1: 1/(60+1) = 0.01639 * 2.0 * 2.0 boost = 0.06557

Recipe 2 (passage, weight 1.5):
  Rank 2: 1/(60+2) = 0.01613 * 1.5 * 2.0 boost = 0.04839

Total Score: 0.06557 + 0.04839 = 0.11396
Source: {keyword, passage}
```

### rankBookmarksByScore() Function

```typescript
export async function rankBookmarksByScore(
  fused: FusedResult[],
  candidates: Array<{ id: string; [key: string]: unknown }>,
): Promise<Array<{ id: string; [key: string]: unknown }>>
```

- **Input**: Fused results + candidate Bookmark objects
- **Output**: Candidates reordered by fused scores, filtered to only those in fused
- **Behavior**: Maintains all bookmark properties, just reorders

### attachSourceTracking() Function

```typescript
export function attachSourceTracking(
  fused: FusedResult[],
): Array<FusedResult & { sourceList: string[] }>
```

- Converts `source: Set<string>` to `sourceList: string[]` for JSON serialization
- Useful for logging, debugging, explaining why a result was returned

### Usage Example

```typescript
import { fuse, rankBookmarksByScore } from '@/lib/search-fusion'
import { ftsSearchBookmarks, ftsSearchPassages } from '@/lib/fts'
import prisma from '@/lib/db'

// Search with multiple recipes
const keywordIds = await ftsSearchBookmarks(['AI', 'agents'])
const passageIds = await ftsSearchPassages(['AI', 'agents'])
const intentIds = [/* from semantic search */]

// Prepare results for fusion
const results = [
  {
    recipe: 'keyword' as const,
    hits: keywordIds.map((id, idx) => ({ id, rank: idx + 1 }))
  },
  {
    recipe: 'passage' as const,
    hits: passageIds.map((id, idx) => ({ id, rank: idx + 1 }))
  },
  {
    recipe: 'intent' as const,
    hits: intentIds.map((id, idx) => ({ id, rank: idx + 1 }))
  }
]

// Fuse with custom weights
const fused = fuse(results, {
  keyword: 2.5,     // Emphasize exact matches
  passage: 1.2,     // Light weight on passages
  intent: 0.8       // De-emphasize intent
})

// Rank full bookmark objects
const bookmarks = await prisma.bookmark.findMany({
  where: { id: { in: fused.map(f => f.bookmarkId) } }
})
const ranked = await rankBookmarksByScore(fused, bookmarks)

// Track sources for debugging
const tracked = attachSourceTracking(fused)
tracked.forEach(r => {
  console.log(`${r.bookmarkId}: score=${r.totalScore} sources=${r.sourceList}`)
})
```

## Integration Points

### With search-pipeline.ts
- Phase 4 Part A already has a basic `expandQuery()` — this module supersedes it
- Next phase will wire up `expandQuery()` + `fuse()` into the full pipeline

### With FTS (Full-Text Search)
- `ftsSearchBookmarks()` and `ftsSearchPassages()` provide ranked ID lists
- These feed directly into `fuse()`

### With AI Pipeline
- `expandQuery()` integrates with Claude CLI auth and SDK clients
- Reuses `extractKeywords()` from search-utils.ts

## Error Handling & Resilience

**Query Expansion**:
- CLI timeout → falls back to SDK
- SDK API error → no paraphrase, uses original + reduced
- Network error → cached results if available
- Always returns at least original + reduced (never fails)

**Fusion**:
- Empty results → empty array (safe)
- Duplicate ranks → first occurrence wins
- Missing bookmarks → silently filtered in rankBookmarksByScore
- Invalid weights → uses defaults

## Performance Notes

- **Expansion caching**: 1 hour TTL, in-memory Map
  - ~1-2ms for cache hit
  - ~500-1000ms for CLI/SDK call (first time)
  
- **RRF fusion**: O(n) where n = total hits across recipes
  - Typically < 100 hits per recipe → < 1ms
  - Top-30 limit prevents memory bloat
  
- **rankBookmarksByScore**: O(n log n) for bookmark lookup
  - Uses Map for O(1) lookups
  - Filtering is O(n)

## Testing

Run:
```bash
npx tsx lib/search-expansion.ts  # imports & basic compilation check
npx tsx lib/search-fusion.ts     # same

# Add to app/api/search/ai/route.ts when ready
# Add to test suite (Phase 4 Part C)
```

## Future Work (Phase 4 Part C+)

- [ ] Integrate into `/api/search/ai` pipeline
- [ ] Add reranker stage (optional AI reranking after fusion)
- [ ] Passage attachment (return matched passages with results)
- [ ] Caching fused results (search cache at HTTP layer)
- [ ] Analytics (track which recipes contributed to successful searches)
