# Phase 4-5 Deployment Checklist

## Pre-Deployment Verification

### Build & Type Safety
- [x] `npx tsc --noEmit` passes
- [x] `npm run build` succeeds (Next.js production build)
- [x] No import errors or circular dependencies
- [x] All route handlers properly typed (NextRequest → NextResponse)

### Database & Schema
- [x] Prisma schema valid (Passage model exists from Phase 3)
- [x] `npx prisma generate` successful
- [x] `npx prisma db push` syncs schema
- [x] FTS virtual tables auto-created by ensureFtsTable()

### API Routes
- [x] POST /api/search/ai (hybrid search pipeline)
- [x] GET /api/bookmarks?id=... (single bookmark)
- [x] POST /api/bookmarks (batch retrieval)
- [x] GET /api/bookmarks/neighbors (relatedness graph)
- [x] POST /api/explore/trail (traversal)

### CLI Commands
- [x] `npx tsx cli/siftly.ts query <query>` (hybrid search)
- [x] `npx tsx cli/siftly.ts get <id|tweetId>` (full detail)
- [x] `npx tsx cli/siftly.ts multi-get --ids ... --tweetIds ...` (batch)
- [x] `npx tsx cli/siftly.ts neighbors <id> --mode ...` (relatedness)
- [x] Backward compat: `search` → `query`, `show` → `show` (legacy preserved)

### Enrichment Pipeline Integration
- [x] POST /api/categorize imports regeneratePassages
- [x] Passages regenerated after categorization completes
- [x] FTS rebuild happens after passages (ensures freshness)

### Response Serialization
- [x] buildBookmarkResponse() formats all bookmark detail consistently
- [x] All APIs return standard bookmark shape with optional enrichment fields
- [x] Passage format: { id, passageType, content, context }
- [x] Edge strength format: { edgeStrength, evidence }

---

## Pre-Launch Testing

### 1. Indexing Flow
```bash
# Ensure DB is fresh
rm -f prisma/dev.db
npx prisma generate && npx prisma db push

# Add a few test bookmarks (via import or direct DB insert)
# Then run categorization with small batch
curl -X POST http://localhost:3000/api/categorize \
  -H "Content-Type: application/json" \
  -d '{ "bookmarkIds": ["<id1>", "<id2>"] }'

# Verify passages were created
npx tsx cli/siftly.ts show <id1>  # Should show semanticTags, entities
```

Expected: passages table populated, FTS tables indexed.

### 2. Search Quality
```bash
# Query with original search endpoint
curl -X POST http://localhost:3000/api/search/ai \
  -H "Content-Type: application/json" \
  -d '{ "query": "AI agents" }'

# CLI equivalent
npx tsx cli/siftly.ts query "AI agents"

# Check results include:
# - searchScore (0-1)
# - searchReason (evidence string)
# - matchedPassages (array of passage details)
```

Expected: RRF ranking visible, passages attached, scores normalized.

### 3. Neighbors Graph
```bash
# Get a bookmark ID from search results
curl "http://localhost:3000/api/bookmarks/neighbors?id=<id>&mode=similar"

# CLI equivalent
npx tsx cli/siftly.ts neighbors <id> --mode similar

# Verify:
# - edgeStrength values between 0-1
# - evidence array contains shared category/tag/tool names
# - results sorted by strength descending
```

Expected: similar mode returns ≤10 results with high confidence.

### 4. Batch Operations
```bash
# POST /api/bookmarks
curl -X POST http://localhost:3000/api/bookmarks \
  -H "Content-Type: application/json" \
  -d '{ "ids": ["<id1>", "<id2>"], "tweetIds": ["<tweet1>"] }'

# CLI equivalent
npx tsx cli/siftly.ts multi-get --ids <id1>,<id2> --tweetIds <tweet1>

# Verify:
# - count matches retrieved
# - notFound lists missing items
# - all enrichment fields present
```

Expected: fast batch retrieval with no N+1 queries.

### 5. Trail Generation
```bash
curl -X POST http://localhost:3000/api/explore/trail \
  -H "Content-Type: application/json" \
  -d '{ "seedId": "<id>", "preset": "thematic", "limit": 20 }'

# Verify:
# - trail array ordered by traversal depth
# - trailReason explains connection (shared category, author, tool)
# - trailDepth is 0 (seed) or 1 (neighbors)
```

Expected: cohesive theme or author sequence.

---

## Post-Deployment Validation

### Monitoring

```bash
# Check DB health
npx tsx cli/siftly.ts stats

# Expected output:
# - totalBookmarks > 0
# - enrichedBookmarks ≥ totalBookmarks (all should be processed)
# - totalCategories > 0 (should see both default + AI-generated)
# - sources: { bookmark, like } with counts
```

### Smoke Tests (run daily)

```bash
# Search returns results
npx tsx cli/siftly.ts query "test" | jq '.count'

# Neighbors work for random bookmark
RANDOM_ID=$(npx tsx cli/siftly.ts list --limit 1 | jq -r '.bookmarks[0].id')
npx tsx cli/siftly.ts neighbors "$RANDOM_ID" | jq '.count'

# Batch operations complete without error
npx tsx cli/siftly.ts multi-get --ids $RANDOM_ID | jq '.count'
```

### Performance Baselines

Measure on first run (cold cache):

```bash
# Search baseline (new query, no cache hit)
time curl -X POST http://localhost:3000/api/search/ai \
  -H "Content-Type: application/json" \
  -d '{ "query": "unique-query-string-12345" }'

# Expected: <2s for ≤1000 bookmarks (FTS + RRF + fetch)

# Neighbors baseline (fresh calculation)
time curl "http://localhost:3000/api/bookmarks/neighbors?id=<id>"

# Expected: <500ms for typical library

# Cache hit baseline (repeat query)
time curl -X POST http://localhost:3000/api/search/ai \
  -H "Content-Type: application/json" \
  -d '{ "query": "unique-query-string-12345" }'

# Expected: <10ms (in-memory cache)
```

---

## Rollback Plan

If critical issues discovered post-deploy:

### Option 1: Revert to Phase 3
```bash
git revert <commit for Phase 4-5>
# Removes: search-pipeline.ts, new routes, CLI commands
# Falls back to old search (lib/claude-cli-auth + Anthropic SDK)
# Loses: passage indexing, hybrid search, neighbors API
# Time: ~5min
```

### Option 2: Disable New Search Only
```bash
# Keep enrichment + passages, disable new search endpoint
# Restore old /api/search/ai from Phase 3
# Bookmarks still indexed, just slower retrieval
# Time: ~2min
```

### Option 3: Disable Passage Regeneration
```bash
# If passages cause memory issues or slowdown:
# Comment out regeneratePassages() call in categorize route
# Keep FTS5 bookmarks table (faster, less data)
# Passages still searchable if already generated
# Time: ~1min
```

---

## Known Limitations & Future Work

### Current (v1)
- No reranking (all scores are pure RRF)
- Neighbors graph computed on-demand (no precomputation)
- Trail generation is single-pass, deterministic
- No temporal decay weighting
- No user feedback loop

### Deferred to Phase 4.5+
- AI-powered reranker (slow but higher quality)
- Persistent relatedness graph (enables bulk analytics)
- Time-decay scoring (recency for timeline preset)
- Click-through tracking (implicit relevance feedback)

---

## Documentation

- ✅ PHASES-4-5.md: Architecture & API reference
- ✅ IMPLEMENTATION-LOG.md: Code changes & design decisions
- ✅ This checklist: Deployment & testing guide

**For users**:
- Update README.md with new CLI commands
- Add neighbors/trail sections to UI guide

**For developers**:
- search-pipeline.ts has inline comments for RRF formula
- API route handlers document request/response shape
- CLI commands have usage strings in --help output

---

## Deployment Sign-Off

- [ ] All checklist items verified
- [ ] Build & tests passing
- [ ] Performance baselines acceptable
- [ ] Rollback plan understood
- [ ] Team briefed on new features
- [ ] Ready for production deploy

**Deployed by**: _______________  
**Date**: _______________  
**Build tag**: v4.5-YYMMDD  
