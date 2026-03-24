# Siftly Agent API Guide

This guide describes the agent-facing APIs and CLI commands for programmatic access to Siftly's bookmark knowledge base. All endpoints return JSON; CLI commands output pretty-printed JSON when run in a TTY, compact JSON when piped.

## Core Concepts

### Bookmark Model
Every endpoint returns bookmarks with:
- **Core**: `id`, `tweetId`, `text`, `authorHandle`, `authorName`
- **Dates**: `tweetCreatedAt` (ISO string), `importedAt`, `enrichedAt`
- **Enrichment**: `semanticTags[]`, `entities` (tools, hashtags, mentions)
- **Media**: `mediaItems[]` with type, URL, imageTags (scene, mood, objects, OCR, etc.)
- **Categories**: `categories[]` with name, slug, color, confidence score

### Graph Model
Bookmarks are connected via:
- **Shared categories**: Same topic classification
- **Overlapping tags**: AI-generated semantic tags
- **Common entities**: Same tools, mentions, or hashtags
- **Author**: Tweets from same person
- **Visual similarity**: Shared image tags from vision analysis

Relationships are scored 0-1 and include human-readable reasons.

## HTTP API

All endpoints require a running Next.js dev server or production build at `http://localhost:3000` (dev) or your deployment URL.

### Bookmark Detail
```
GET /api/bookmarks/[id]
```
Fetch a single bookmark with full enrichment.

**Response:**
```json
{
  "id": "uuid",
  "tweetId": "123456789",
  "text": "Tweet text...",
  "authorHandle": "@author",
  "authorName": "Author Name",
  "tweetCreatedAt": "2024-01-15T10:30:00Z",
  "importedAt": "2024-01-16T08:00:00Z",
  "enrichedAt": "2024-01-16T08:05:00Z",
  "source": "bookmark",
  "enrichment": {
    "semanticTags": ["ai", "llm", "claude"],
    "entities": {
      "tools": ["claude", "gpt"],
      "hashtags": ["ai", "openai"],
      "mentions": ["openai", "anthropic"]
    }
  },
  "media": [
    {
      "id": "mid",
      "type": "photo",
      "url": "...",
      "thumbnailUrl": "...",
      "imageTags": {
        "scene": "office",
        "mood": "professional",
        "objects": ["laptop", "screen"],
        "text_ocr": ["Prompt:", "Response:"]
      }
    }
  ],
  "categories": [
    {
      "id": "cid",
      "name": "AI Resources",
      "slug": "ai-resources",
      "color": "#0066cc",
      "confidence": 0.95
    }
  ],
  "rawJson": { ... } // optional original tweet JSON
}
```

### Batch Fetch
```
POST /api/bookmarks/multi-get
Content-Type: application/json

{
  "ids": ["id1", "id2", "id3"]
}
```

**Response:**
```json
{
  "bookmarks": [ ... ],
  "notFound": ["id-that-doesnt-exist"]
}
```

Max 100 IDs per request.

### Find Related Bookmarks
```
GET /api/bookmarks/[id]/neighbors?mode=similar&limit=10
```

**Query Parameters:**
- `mode`: `'similar'` (tight matches, score ≥0.5), `'adjacent'` (cross-topic, 0.3-0.7), `'contrasting'` (serendipity, <0.4)
- `limit`: 1-50, default 10
- `details`: Pass `true` to include snippet of each neighbor bookmark

**Response:**
```json
{
  "neighbors": [
    {
      "id": "neighbor-id",
      "score": 0.75,
      "reasons": ["in 2 shared categories", "same author", "3 shared semantic tags"],
      "evidence": {
        "sharedCategories": [
          { "name": "AI Resources", "slug": "ai-resources", "confidence": 0.95 }
        ],
        "sharedTags": ["ai", "llm"],
        "sameAuthor": true
      },
      "bookmark": { ... } // if details=true
    }
  ]
}
```

### Exploratory Traversal
```
POST /api/explore/trail
Content-Type: application/json

{
  "startId": "bookmark-id",
  "depth": 2,
  "breadth": 5,
  "preset": "similar"
}
```

**Parameters:**
- `startId`: Bookmark ID to start from
- `depth`: BFS depth (1-4, default 2)
- `breadth`: Neighbors to explore per level (1-20, default 5)
- `preset`: Exploration mode:
  - `'similar'`: Tight coherent paths (high-score edges)
  - `'adjacent'`: Cross-topic exploration (mid-range edges)
  - `'contrasting'`: Serendipitous discovery (low-score edges)
  - `'timeline'`: Results sorted by tweet date

**Response:**
```json
{
  "startId": "...",
  "nodeCount": 47,
  "maxDepth": 2,
  "preset": "similar",
  "trail": [
    {
      "id": "bookmark-id",
      "depth": 0,
      "score": 1.0,
      "path": ["start-id"],
      "reasons": ["start node"]
    },
    {
      "id": "neighbor-id",
      "depth": 1,
      "score": 0.78,
      "path": ["start-id", "neighbor-id"],
      "reasons": ["in 2 shared categories", "3 shared tags"]
    }
  ]
}
```

## CLI Commands

Run `npx tsx cli/siftly.ts <command> [options]` from the project root.

### query
```bash
npx tsx cli/siftly.ts query "search terms" --limit 20
```
Hybrid keyword + AI search (FTS + category intent detection).

**Output:**
```json
{
  "query": "search terms",
  "keywords": ["search", "terms"],
  "count": 15,
  "bookmarks": [ ... ]
}
```

### get
```bash
npx tsx cli/siftly.ts get <id|tweetId>
```
Fetch a single bookmark (alias: `show`).

**Output:**
```json
{
  "id": "...",
  "tweetId": "...",
  ...full bookmark data...
}
```

### multi-get
```bash
npx tsx cli/siftly.ts multi-get --ids id1,id2,id3
```
Batch fetch multiple bookmarks.

**Output:**
```json
{
  "count": 3,
  "bookmarks": [ ... ]
}
```

### neighbors
```bash
npx tsx cli/siftly.ts neighbors <id> --mode similar --limit 10
```
Find related bookmarks using graph relationships.

**Options:**
- `--mode`: `similar`, `adjacent`, or `contrasting`
- `--limit`: Max results (default 10)

**Output:**
```json
{
  "id": "source-id",
  "count": 8,
  "neighbors": [
    {
      "id": "...",
      "score": 0.75,
      "reasons": [...]
    }
  ]
}
```

### list
```bash
npx tsx cli/siftly.ts list --source bookmark --category ai-resources --limit 10 --sort newest
```
Browse bookmarks with filtering and pagination.

**Options:**
- `--source`: `bookmark` or `like`
- `--category`: Category slug
- `--author`: Author handle
- `--media`: Filter by media type (photo, video, gif)
- `--sort`: `newest`, `oldest`, `enriched`
- `--limit`: Results per page (default 20, max 100)
- `--page`: Page number (default 1)

**Output:**
```json
{
  "total": 1250,
  "page": 1,
  "limit": 10,
  "bookmarks": [ ... ]
}
```

### categories
```bash
npx tsx cli/siftly.ts categories
```
List all categories with bookmark counts.

**Output:**
```json
{
  "total": 25,
  "categories": [
    {
      "id": "...",
      "name": "AI Resources",
      "slug": "ai-resources",
      "color": "#0066cc",
      "bookmarkCount": 342,
      "isAiGenerated": false
    }
  ]
}
```

### stats
```bash
npx tsx cli/siftly.ts stats
```
Library-wide statistics.

**Output:**
```json
{
  "totalBookmarks": 1250,
  "totalCategories": 25,
  "totalMedia": 450,
  "totalEnriched": 1100,
  "sourceBreakdown": { "bookmark": 950, "like": 300 },
  "mediaBreakdown": { "photo": 400, "video": 30, "gif": 20 }
}
```

## Integration Patterns

### Python Example: Fetch and Analyze Related Bookmarks
```python
import requests
import json

BASE_URL = "http://localhost:3000"

def get_bookmark(bid):
    """Fetch a bookmark."""
    r = requests.get(f"{BASE_URL}/api/bookmarks/{bid}")
    return r.json()

def find_neighbors(bid, mode="similar", limit=10):
    """Find related bookmarks."""
    r = requests.get(
        f"{BASE_URL}/api/bookmarks/{bid}/neighbors",
        params={"mode": mode, "limit": limit, "details": "true"}
    )
    return r.json()["neighbors"]

def explore_trail(start_id, depth=2, preset="similar"):
    """Exploratory traversal."""
    r = requests.post(
        f"{BASE_URL}/api/explore/trail",
        json={"startId": start_id, "depth": depth, "preset": preset}
    )
    return r.json()

# Usage
bookmark = get_bookmark("some-id")
print(f"Title: {bookmark['text'][:80]}")
print(f"Categories: {', '.join(c['name'] for c in bookmark['categories'])}")

neighbors = find_neighbors("some-id", mode="adjacent", limit=5)
for n in neighbors:
    print(f"  → {n['bookmark']['text'][:60]} (score: {n['score']:.2f})")

trail = explore_trail("some-id", depth=2, preset="similar")
print(f"Explored {trail['nodeCount']} nodes at max depth {trail['maxDepth']}")
```

### Curl Examples
```bash
# Get bookmark
curl http://localhost:3000/api/bookmarks/my-bookmark-id

# Find neighbors
curl 'http://localhost:3000/api/bookmarks/my-id/neighbors?mode=adjacent&limit=5'

# Explore trail
curl -X POST http://localhost:3000/api/explore/trail \
  -H 'Content-Type: application/json' \
  -d '{"startId":"my-id","depth":2,"preset":"similar"}'

# Batch fetch
curl -X POST http://localhost:3000/api/bookmarks/multi-get \
  -H 'Content-Type: application/json' \
  -d '{"ids":["id1","id2","id3"]}'
```

## Error Handling

All endpoints return errors as JSON:
```json
{
  "error": "Description of what went wrong"
}
```

HTTP status codes:
- **400**: Bad request (invalid JSON, missing required params)
- **404**: Bookmark/category not found
- **500**: Server error (check logs)

## Performance Notes

- **Neighbors**: O(1) per source, O(n) to compare against all bookmarks. Cached results when possible.
- **Trail**: O(breadth^depth). Stops at 100 nodes or depth limit.
- **Batch fetch**: Limited to 100 IDs per request to prevent resource exhaustion.
- **All endpoints**: Results are paginated at 50-item limits for large datasets.

## Backward Compatibility

Existing endpoints remain unchanged:
- `POST /api/search/ai` — Hybrid QMD-like search with reranking
- `GET /api/settings` — Provider and model configuration
- `POST /api/import/*` — Import operations
- `POST /api/categorize` — AI categorization pipeline

The new agent APIs are purely additive and do not break existing functionality.
