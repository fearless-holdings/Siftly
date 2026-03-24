# Phase 4: Integration Guide (Parts A, B, C)

## Architecture Overview

```
User Query
    ↓
Phase 4A: Query Expansion [search-expansion.ts]
├─ Original query
├─ Keyword-reduced variant
├─ AI-paraphrased variant
    ↓
Multi-Recipe Search (Parallel)
├─ Keyword Search (FTS) → ranked IDs
├─ Passage Search (FTS) → ranked IDs
└─ Intent Search (Semantic) → ranked IDs
    ↓
Phase 4B: Hybrid Retrieval [search-fusion.ts]
├─ RRF scoring per recipe
├─ Weight combination (keyword > passage > intent)
├─ Top-3 rank boosting
└─ Merge & rank: top 30 bookmarks
    ↓
Phase 4C: Reranking & Response
├─ Optional: AI reranker (top-10)
├─ Attach passages for context
└─ Return final results + metadata
    ↓
Response to Client
```

## Phase 4 Part A: Query Expansion (DELIVERED)

**File:** `lib/search-expansion.ts`

**What it does:**
- Takes user query
- Produces 3 variants: original, reduced (keywords only), paraphrased (AI)
- Caches paraphrases for 1 hour
- Defensive fallback if AI fails

**Usage in Phase 4C:**
```typescript
import { expandQuery } from '@/lib/search-expansion'

const model = await getAnthropicModel()
const variants = await expandQuery(userQuery, model, 'anthropic')
// variants = { original, reduced, paraphrase?, all: [...] }

// Use variants.all for batch search
const allResults = await Promise.all(
  variants.all.map(v => searchBookmarks(v))
)
```

## Phase 4 Part B: Hybrid Retrieval (DELIVERED)

**File:** `lib/search-fusion.ts`

**What it does:**
- Takes results from keyword, passage, and intent search
- Applies RRF scoring: `1 / (k + rank)` where k=60
- Weights by recipe: keyword=2.0 > passage=1.5 > intent=1.0
- Boosts top-3 ranks by 2x
- Returns top 30 merged results with source tracking

**Usage in Phase 4C:**
```typescript
import { fuse, rankBookmarksByScore } from '@/lib/search-fusion'

// Results from multi-recipe search
const results = [
  {
    recipe: 'keyword' as const,
    hits: keywordIds.map((id, i) => ({ id, rank: i + 1 }))
  },
  {
    recipe: 'passage' as const,
    hits: passageIds.map((id, i) => ({ id, rank: i + 1 }))
  },
  {
    recipe: 'intent' as const,
    hits: semanticIds.map((id, i) => ({ id, rank: i + 1 }))
  }
]

// Fuse with optional custom weights
const fused = fuse(results, {
  keyword: 2.5,   // Emphasize exact matches
  passage: 1.2,   // Lighter weight
  intent: 0.8     // De-emphasize semantic
})

// Get full bookmark objects in fused order
const candidates = await prisma.bookmark.findMany({
  where: { id: { in: fused.map(f => f.bookmarkId) } }
})
const ranked = await rankBookmarksByScore(fused, candidates)
```

## Phase 4 Part C: Reranking & Response (NEXT)

**File:** `/api/search/ai/route.ts` (to be updated)

**What it does:**
- Orchestrates entire pipeline
- Optionally reranks top-10 with AI
- Attaches matched passages
- Returns formatted response with metadata

**Sample Implementation:**

```typescript
// POST /api/search/ai
export async function POST(req: Request) {
  const { query, rerank = false } = await req.json()

  // Step 1: Expand query (Part A)
  const variants = await expandQuery(query, model, provider)

  // Step 2: Multi-recipe search (parallel)
  const [keywordIds, passageIds, semanticIds] = await Promise.all([
    ftsSearchBookmarks(variants.all),           // FTS on all variants
    ftsSearchPassages(variants.all),            // Passage search
    semanticSearch(variants.paraphrase || query) // Semantic search
  ])

  // Step 3: Fuse results (Part B)
  const fused = fuse([
    {
      recipe: 'keyword',
      hits: keywordIds.map((id, i) => ({ id, rank: i + 1 }))
    },
    {
      recipe: 'passage',
      hits: passageIds.map((id, i) => ({ id, rank: i + 1 }))
    },
    {
      recipe: 'intent',
      hits: semanticIds.map((id, i) => ({ id, rank: i + 1 }))
    }
  ])

  // Step 4: Get bookmark objects
  const candidates = await prisma.bookmark.findMany({
    where: { id: { in: fused.map(f => f.bookmarkId) } },
    include: { categories: true, mediaItems: true }
  })
  const ranked = await rankBookmarksByScore(fused, candidates)

  // Step 5: Optional reranking (future)
  if (rerank && ranked.length > 0) {
    const reranked = await rerankerModel.score(ranked.slice(0, 10))
    // Merge reranker scores with RRF scores...
  }

  // Step 6: Attach passages and format response
  const withPassages = await Promise.all(
    ranked.map(async (b) => {
      const passages = await prisma.passage.findMany({
        where: { bookmarkId: b.id }
      })
      return {
        ...b,
        passages: passages.slice(0, 3), // Top 3 for context
        score: fused.find(f => f.bookmarkId === b.id)?.totalScore,
        sources: Array.from(
          fused.find(f => f.bookmarkId === b.id)?.source || []
        )
      }
    })
  )

  return Response.json({
    query,
    variants: variants.all,
    results: withPassages,
    stats: {
      total: withPassages.length,
      keywords: keywordIds.length,
      passages: passageIds.length,
      semantic: semanticIds.length
    }
  })
}
```

## Integration Checklist for Part C

### Prerequisites
- ✅ search-expansion.ts (Part A — delivered)
- ✅ search-fusion.ts (Part B — delivered)
- ✅ FTS bookmarks & passages (already in fts.ts)
- ✅ Semantic search endpoint (existing or todo)

### Implementation Steps

1. **Update `/api/search/ai/route.ts`**
   - Import expandQuery, fuse, rankBookmarksByScore
   - Call expandQuery on user query
   - Run multi-recipe search in parallel
   - Call fuse() to merge results
   - Load full bookmarks and reorder with rankBookmarksByScore

2. **Add reranker stage (optional)**
   - Take top-10 from fusion
   - Score with Claude/OpenAI
   - Blend with RRF scores (e.g., 70% RRF + 30% reranker)

3. **Attach passages**
   - Query Passage table per bookmark
   - Include in response for context

4. **Format response**
   - Include search query variants
   - Include source tracking
   - Include RRF scores
   - Include passage snippets

### Testing Strategy

```bash
# Unit tests (already done)
npx tsx test-expansion.ts   # Query variants
npx tsx test-fusion.ts      # RRF scoring

# Integration test
curl -X POST http://localhost:3000/api/search/ai \
  -H "Content-Type: application/json" \
  -d '{"query": "AI agents", "rerank": false}'

# Expected response
{
  "query": "AI agents",
  "variants": ["AI agents", "ai agents", "AI-powered agent systems"],
  "results": [
    {
      "id": "bm-001",
      "text": "...",
      "score": 0.1137,
      "sources": ["keyword", "passage"],
      "passages": [...]
    },
    ...
  ],
  "stats": {
    "total": 12,
    "keywords": 25,
    "passages": 18,
    "semantic": 10
  }
}
```

## Performance Targets

| Stage | Time | Notes |
|-------|------|-------|
| Query expansion | 1-2ms | Cache hit; 500-1000ms first call |
| Keyword search | 10-50ms | FTS on all variants |
| Passage search | 10-50ms | FTS on passages |
| Semantic search | 100-500ms | AI embedding + vector search |
| RRF fusion | <1ms | O(n) where n~100 |
| Bookmark load | 10-50ms | Prisma query |
| Ranking | <1ms | Map lookup per item |
| Reranker | 1-5s | Optional; only top-10 |
| **Total (w/o rerank)** | **150-600ms** | Mostly network/DB |
| **Total (w/ rerank)** | **1-6s** | Reranker dominates |

## Error Handling Strategy

### Query Expansion Failures
- ✅ CLI unavailable → fall back to SDK
- ✅ SDK timeout → no paraphrase, use original + reduced
- ✅ Network error → use cached result if available
- ✅ Never fails: always returns at least 2 variants

### Search Failures
- Keyword search fails → continue with other recipes
- Passage search fails → continue with other recipes
- Semantic search fails → continue with other recipes
- All fail → return empty results gracefully

### Fusion Failures
- Empty recipes → return empty array
- No candidates → return empty array
- Invalid weights → use defaults
- Never fails: always returns valid FusedResult[]

### Response Failures
- Missing bookmarks → filter out
- Missing passages → return without passages
- Reranker timeout → fall back to RRF scores
- Return partial response if possible

## Caching Strategy

### Query Expansion Cache
- **What:** Paraphrases
- **Duration:** 1 hour
- **Key:** `{provider}:{model}:{query}`
- **Size:** ~1KB per entry

### Search Results Cache (Future)
- **What:** Fused results
- **Duration:** 24 hours (or until next import)
- **Key:** `search:{query}:{provider}`
- **Size:** ~10KB per entry

### Invalidation
- Clear on new bookmarks imported
- Clear on category changes
- Manual clear via admin panel

## Deployment Notes

### No Breaking Changes
- ✅ New files only, no existing file changes
- ✅ Backward compatible with existing search
- ✅ Can be feature-flagged if needed

### Monitoring
- Log fusion source distribution (which recipes win)
- Track query expansion cache hit rate
- Monitor search latency by recipe
- Alert on reranker timeout

### Configuration
```typescript
// In settings or environment
const QUERY_EXPANSION_CACHE_TTL = 3600_000 // 1 hour
const FUSION_RESULT_LIMIT = 30
const RERANKER_ENABLED = false
const RERANKER_TOP_K = 10
const RECIPE_WEIGHTS = {
  keyword: 2.0,
  passage: 1.5,
  intent: 1.0
}
```

## Next Steps

1. **Implement Phase 4 Part C** (`/api/search/ai/route.ts`)
   - Wire up expansion → search → fusion → reranker → response

2. **Add reranker stage** (optional but recommended)
   - Score top-10 with Claude/OpenAI
   - Blend with RRF (70/30 or configurable)

3. **Test end-to-end**
   - Query expansion works
   - RRF ranking correct
   - Response format matches UI expectations

4. **Deploy to production**
   - A/B test against old search
   - Monitor metrics
   - Gather user feedback

5. **Optimize**
   - Tune recipe weights based on metrics
   - Adjust result limit
   - Add caching if needed
   - Consider local reranker if needed
