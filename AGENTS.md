# Siftly

Self-hosted Twitter/X bookmark manager with AI-powered categorization, search, and visualization.

## Quick Setup

```bash
./start.sh            # installs deps, sets up DB, opens browser
```

Or manually:

```bash
npm install
npx prisma generate && npx prisma db push
npx next dev
```

App runs at **http://localhost:3000**

## AI Backends

Siftly now resolves a request-scoped backend context (`ResolvedAiBackend`) once per request and passes it through categorization, vision, enrichment, and AI search.

Supported backends:
- `anthropic` (Claude API + Claude CLI path)
- `openai` (OpenAI API + Codex CLI path)
- `openrouter` (OpenAI-compatible)
- `gemini` (Gemini API adapter)
- `opencode` (Zen/Go endpoint adapter)
- `acp_cursor`, `acp_amp` (ACP adapters, gated behind `SIFTLY_EXPERIMENTAL_ACP=1`)

Resolution order:
1. `SIFTLY_AI_BACKEND` (if set)
2. Saved UI provider (`anthropic` / `openai`)
3. Auto-detect (Claude CLI, then Codex CLI, else Anthropic default)
4. Optional `SIFTLY_AI_FALLBACK` chain

Runtime retry/failover can be configured separately with `SIFTLY_AI_EXECUTION_FALLBACK`.

Antigravity OAuth is intentionally not enabled by default in this codebase; treat it as an optional, experimental Phase 2 integration.

To inspect active resolution details, hit: `GET /api/settings/cli-status` and `GET /api/settings`.

## Key Commands

```bash
npx next dev          # Start dev server (port 3000)
npx tsc --noEmit      # Type check
npx prisma studio     # Database GUI
npx prisma db push    # Apply schema changes to DB
npm run build         # Production build
```

## Project Structure

```
app/
  api/
    categorize/       # 4-stage AI pipeline (start/stop/status via SSE)
    import/           # Bookmark JSON import + dedup
    search/ai/        # FTS5 + Claude semantic search
    settings/
      cli-status/     # GET — returns Claude CLI auth status
      test/           # POST — validates API key or CLI auth
    analyze/images/   # Vision analysis progress + trigger
    bookmarks/        # CRUD + filtering
    categories/       # Category management
    mindmap/          # Graph data
    stats/            # Dashboard counts
  import/             # 3-step import UI
  mindmap/            # Interactive force graph
  settings/           # API keys, model selection
  ai-search/          # Natural language search UI
  bookmarks/          # Browse + filter UI
  categorize/         # Pipeline monitor

lib/
  claude-cli-auth.ts  # Claude CLI OAuth session (macOS keychain)
  categorizer.ts      # AI categorization + default categories
  vision-analyzer.ts  # Image vision + semantic tagging
  fts.ts              # SQLite FTS5 full-text search
  rawjson-extractor.ts # Entity extraction from tweet JSON
  parser.ts           # Multi-format bookmark JSON parser
  exporter.ts         # CSV / JSON / ZIP export

prisma/schema.prisma  # SQLite schema (Bookmark, Category, MediaItem, Setting, ImportJob)
```

## Tech Stack

- **Next.js 16** (App Router, TypeScript)
- **Prisma 7** + **SQLite** (local, zero setup, FTS5 built in)
- **Anthropic SDK** — vision, tagging, categorization, search
- **@xyflow/react** — mindmap graph
- **Tailwind CSS v4**

## Environment Variables

See `.env.example` for the full list. Only `DATABASE_URL` is required (defaults to `file:./prisma/dev.db`).

## CLI for AI Agents

`cli/siftly.ts` provides direct database access without the Next.js server. Outputs JSON (pretty-printed on TTY, compact when piped). Must run from project root.

```bash
npx tsx cli/siftly.ts stats                          # Library statistics
npx tsx cli/siftly.ts categories                     # Categories with counts
npx tsx cli/siftly.ts search "AI agents"             # FTS5 keyword search
npx tsx cli/siftly.ts list --limit 5                 # Recent bookmarks
npx tsx cli/siftly.ts list --source like --category ai-resources --sort oldest
npx tsx cli/siftly.ts show <id|tweetId>              # Full bookmark detail
npm run siftly -- stats                              # Alternative via npm script
```

## Common Tasks

| Task | How |
|------|-----|
| Run AI pipeline | `POST /api/categorize` with `{}` body; `GET /api/categorize` for SSE progress |
| Add category | Edit `DEFAULT_CATEGORIES` in `lib/categorizer.ts` — description is passed verbatim to Claude |
| Add known tool | Append domain to `KNOWN_TOOL_DOMAINS` in `lib/rawjson-extractor.ts` |
| Test API auth | `POST /api/settings/test` with `{"provider":"anthropic"}` |
| Check CLI auth | `GET /api/settings/cli-status` |

## Database

SQLite at `prisma/dev.db`. After schema changes: `npx prisma db push`

Models: `Bookmark`, `MediaItem`, `BookmarkCategory`, `Category`, `Setting`, `ImportJob` — see `prisma/schema.prisma` for details.