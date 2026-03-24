# Siftly Phases 4-5: Hybrid Search & Agent APIs

## Phase 4: QMD-like Hybrid Search with Passage Indexing

### Architecture

**lib/search-pipeline.ts** implements a 5-stage retrieval pipeline optimized for semantic discovery:

1. **Query Expansion**: Original query + keyword-reduced variant
2. **Parallel FTS Retrieval**: Dual FTS5 tables (bookmarks + passages) searched in parallel
3. **Reciprocal Rank Fusion**: Combine rankings from all sources (formula: ∑ 1/(k+rank), k=60)
   - Double-weight original queries (weight: 2.0) vs. reduced (weight: 1.0)
   - Passages inherit bookmark weight when multiple retrieval sources match same bookmark
4. **Passage Attachment**: Fetch top 3 matching passages per bookmark, prioritized by type (semantic > entities > ocr > text > category_context)
5. **Score Normalization**: RRF scores normalized to 0-1 range, sorted descending

### Passage Generation

When enrichment pipeline completes (`POST /api/categorize`):
- After vision tagging, semantic enrichment, and categorization
- `regeneratePassages(bookmarkIds)` is called with all processed IDs
- Generates 5 passage types per bookmark:
  - **text**: First 500 chars of tweet text (primary signal)
  - **semantic**: AI-computed semantic tags (json array)
  - **ocr**: Extracted text from images (visual content)
  - **entities**: Extracted hashtags, tools, mentions
  - **category_context**: High-confidence categories (>= 0.7)
- Passages are batch-inserted (500 per transaction) and indexed in FTS

### FTS5 Virtual Tables

```sql
-- Existing (enhanced)
CREATE VIRTUAL TABLE bookmark_fts USING fts5(
  bookmark_id UNINDEXED,
  text, semantic_tags, entities, image_tags,
  tokenize='porter unicode61'
)

-- New
CREATE VIRTUAL TABLE passage_fts USING fts5(
  passage_id UNINDEXED,
  bookmark_id UNINDEXED,
  passage_type UNINDEXED,
  content,
  tokenize='porter unicode61'
)
```

### Search API

**POST /api/search/ai** — hybrid search endpoint

```typescript
Body:
  { query: string, category?: string }

Response:
{
  bookmarks: [
    {
      id, tweetId, text, authorHandle, authorName,
      tweetCreatedAt, importedAt, enrichedAt,
      mediaItems: [{ id, type, url, thumbnailUrl, imageTags }],
      categories: [{ id, name, slug, color, confidence }],
      semanticTags: string[],
      entities: { hashtags?, tools?, mentions? },
      searchScore: 0-1,     // RRF normalized score
      searchReason: string,  // evidence: "matched via original_bookmarks, original_passages (semantic/entities)"
      matchedPassages: [
        { id, passageType, content, context }
      ]
    }
  ],
  explanation: string
}
```

**In-process caching**: 5-minute TTL, automatic LRU (max 100 entries).

---

## Phase 5: Agent-Oriented APIs & CLI Expansion

### Bookmark Detail APIs

#### GET /api/bookmarks?id=<id>&tweetId=<tweetId>
Fetch single bookmark with full enrichment data.

```json
{ bookmark: { ...full bookmark detail } }
```

#### POST /api/bookmarks
Batch fetch multiple bookmarks.

```typescript
Body:
  { ids?: string[], tweetIds?: string[] }

Response:
  { bookmarks: [...], notFound: [ids not found], count: number }
```

### Relatedness Graph: Neighbors API

#### GET /api/bookmarks/neighbors?id=<bookmarkId>&mode=<similar|adjacent|contrasting>

Find related bookmarks using weighted edge strength:
- **Shared categories** (>=0.5 weight): primary signal
- **Shared semantic tags** (0.2): AI-computed context
- **Shared tools** (0.15): detected technologies
- **Shared hashtags** (0.1): thematic overlap

**Modes**:
- **similar** (strength > 0.5): tight thematic clustering, max 10 results
- **adjacent** (0.3-0.7): cross-topic discovery, max 15 results
- **contrasting** (low strength): serendipity mode, diverse topics, max 10 results

```json
{
  neighbors: [
    {
      ...bookmark detail,
      edgeStrength: 0-1,
      evidence: ["2 shared categories", "shared tools: GitHub, TypeScript"]
    }
  ],
  mode: "similar",
  count: number
}
```

### Exploratory Traversal: Trail API

#### POST /api/explore/trail
Generate a curated path through related bookmarks.

```typescript
Body:
  { seedId: string, preset: 'timeline'|'thematic'|'author'|'tools', limit?: 20 }

Response:
  {
    trail: [
      { ...bookmark, trailReason: string, trailDepth: 0|1 }
    ],
    preset: string,
    count: number
  }
```

**Presets**:
- **timeline**: Chronological sequence from same author
- **thematic**: Bookmarks sharing primary categories, grouped by thematic drift
- **author**: All bookmarks from source author
- **tools**: Cross-reference shared technologies

---

## CLI Expansion (lib/siftly.ts)

### New Commands

```bash
# Query with hybrid retrieval (replaces 'search')
npx tsx cli/siftly.ts query "transformer model training"

# Get full bookmark detail
npx tsx cli/siftly.ts get <id|tweetId>

# Batch retrieval
npx tsx cli/siftly.ts multi-get --ids id1,id2 --tweetIds t1,t2

# Find related bookmarks
npx tsx cli/siftly.ts neighbors <id> [--mode similar|adjacent|contrasting]
```

### Backward Compatibility

- `search` command still works (routes to `query`)
- `show` command preserved (legacy)
- All new commands follow consistent JSON output format

---

## Bookmark Response Standardization

All APIs return bookmarks in this shape:

```typescript
{
  // Identity
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string

  // Temporal
  tweetCreatedAt: ISO8601 | null
  importedAt: ISO8601
  enrichedAt: ISO8601 | null

  // Enrichment
  semanticTags: string[] | null
  entities: {
    hashtags?: string[]
    tools?: string[]
    mentions?: string[]
  } | null

  // Media
  mediaItems: Array<{
    id: string
    type: 'photo' | 'video' | 'gif'
    url: string
    thumbnailUrl: string | null
    imageTags: { style?, scene?, action?, mood?, meme_template?, text_ocr?, people?, objects?, tags? } | null
  }>

  // Categorization
  categories: Array<{
    id: string
    name: string
    slug: string
    color: string
    confidence: number
  }>

  // Optional (search-specific)
  searchScore?: 0-1
  searchReason?: string
  matchedPassages?: Array<{ id, passageType, content, context }>

  // Optional (neighbors/trail-specific)
  edgeStrength?: 0-1
  evidence?: string[]
  trailReason?: string
  trailDepth?: 0|1
}
```

---

## Implementation Notes

### Performance

- **FTS5 ranking**: Pre-computed, O(log N) retrieval via binary tree
- **Passage batch insert**: 500 at a time, single transaction per batch
- **Neighbors graph**: On-demand computation, no persistent graph storage (computed edges cached during request)
- **Search caching**: 5-minute TTL per query-category pair

### Data Integrity

- **Passages**: Deleted and regenerated wholesale per bookmark (no incremental updates)
- **FTS rebuild**: Full rebuild after pipeline, ensures consistency
- **Category proposal reconciliation**: Happens before assignments written (atomicity via transaction)

### Future Extensions

- **Reranking stage** (Phase 4.5): AI-powered reranker with `blendedScore = 0.7*rrfScore + 0.3*rerankerScore`
- **Vector search**: Embedding-based retrieval as alternative/complement to FTS
- **Time-decay**: Temporal weighting for recency (high for timeline, low for semantic)
- **User feedback loop**: Click-through data → passage relevance calibration
