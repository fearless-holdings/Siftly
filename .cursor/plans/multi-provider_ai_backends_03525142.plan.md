---
name: Multi-provider AI backends
overview: Introduce a request-scoped ResolvedAiBackend, HTTP/SDK backends first (anthropic, openai, openrouter, gemini, opencode), split resolution vs execution fallback, explicit capability flags, wire the real search path (search-pipeline), update settings surfaces or document env override; defer or gate ACP (1.5) with a strict security posture; Phase 2 Antigravity OAuth optional; add tests and smoke matrix.
todos:
  - id: resolved-ai-context
    content: "Add ResolvedAiBackend type (backend, model, client, capabilities, resolutionSource); single resolver; pass through routes and libs"
    status: pending
  - id: capability-matrix
    content: "Define per-backend capability flags and health probe strategy; document in code"
    status: pending
  - id: http-sdk-adapters
    content: "Implement OpenRouter, Gemini, OpenCode adapters; extend AIClient or adapter-specific facades where needed"
    status: pending
  - id: fallback-policies
    content: "Implement resolution fallback (bootstrap) vs execution fallback (runtime) with logging and limits"
    status: pending
  - id: search-pipeline-wire
    content: "Refactor lib/search-pipeline hybridSearchPipeline + app/api/search/ai to use ResolvedAiBackend; reconcile with lib/search-expansion (merge or call from pipeline)"
    status: pending
  - id: settings-surfaces
    content: "Align app/api/settings/*, cli-status, POST categorize key lookup, settings page with effective-backend truth or explicit env-override UX"
    status: pending
  - id: acp-phase-15
    content: "ACP behind SIFTLY_EXPERIMENTAL_ACP or Phase 1.5; no unattended allow-all tools; plan/plan+read-only or permission allowlist"
    status: pending
  - id: validation-matrix
    content: "Add vitest + unit/adapter tests; manual smoke + failure checklist; npm script"
    status: pending
  - id: phase2-antigravity
    content: "Document optional Antigravity OAuth Phase 2"
    status: pending
isProject: false
---

# Multi-provider AI for Siftly (revised)

## Corrections to the previous draft

### Search: real path vs dead code

- **`app/api/search/ai/route.ts`** calls **`hybridSearchPipeline()`** in [`lib/search-pipeline.ts`](lib/search-pipeline.ts), passing `client` and `model` only.
- That pipeline uses a **local** [`expandQuery()`](lib/search-pipeline.ts) (keyword reduction only; `aiParaphrase` is explicitly unused in v1). It does **not** import [`lib/search-expansion.ts`](lib/search-expansion.ts).
- [`lib/search-expansion.ts`](lib/search-expansion.ts) implements AI paraphrase via CLI/SDK but is **not** on the live AI search route today (only referenced from [`verify-modules.ts`](verify-modules.ts)).

**Plan requirement:** Any multi-provider work must **thread `ResolvedAiBackend` (or equivalent) through [`hybridSearchPipeline`](lib/search-pipeline.ts)** and the search route. **Either** wire AI paraphrase from `search-expansion` into the pipeline when capabilities allow, **or** explicitly delete/merge `search-expansion` into `search-pipeline` so there is a single expansion/reranking path. Leaving `search-expansion.ts` updated in isolation is insufficient.

### Single source of truth per request

**Problem:** Today `getProvider()`, `getActiveModel()`, DB key lookup, and `resolveAIClient()` are invoked separately across [`lib/categorizer.ts`](lib/categorizer.ts), [`lib/vision-analyzer.ts`](lib/vision-analyzer.ts), [`app/api/categorize/route.ts`](app/api/categorize/route.ts), [`app/api/analyze/images/route.ts`](app/api/analyze/images/route.ts), etc. If fallback lives only inside `resolveAIClient()`, other branches can still use the **wrong** provider for CLI paths, **wrong** model, or **wrong** DB key slot.

**Plan requirement:** Introduce a **request-scoped** (or pipeline-scoped) **`ResolvedAiBackend`** object, created **once** at the API route or top-level orchestrator, and passed through:

- `backend` — canonical id
- `model` — resolved model string for that backend
- `client` — `AIClient | null` when applicable
- `capabilities` — see capability matrix below
- `resolutionSource` — e.g. `env` | `db` | `autodetect` | `fallback:N`

All downstream functions take **`ResolvedAiBackend`** (or a narrow read-only interface) instead of recomputing provider/model/client.

DB key selection must be **derived from** `ResolvedAiBackend.backend`, not from a separate `getProvider()` call that could disagree.

### ACP and unattended server pipelines (security)

The prior idea of auto-approving **`session/request_permission`** with `allow-once` for **background** bookmark/search pipelines is **not acceptable**: bookmark text, OCR, URLs, and user queries are **untrusted input**; prompt-injection could drive tool execution.

**Plan requirement:**

- **Phase 1:** **HTTP/SDK backends only** — `anthropic`, `openai`, `openrouter`, `gemini`, `opencode` (plus existing Claude/Codex CLI where applicable).
- **ACP (Cursor / Amp):** **Phase 1.5** or behind an explicit flag (e.g. `SIFTLY_EXPERIMENTAL_ACP=1`). Do **not** ship ACP in default server routes without:
  - **No-tools / read-only** ACP session mode if the protocol supports it (per [Cursor ACP docs](https://cursor.com/docs/cli/acp) — align with `plan` / `ask` modes vs `agent`), **or**
  - A **hard allowlist** of permission outcomes (e.g. reject all tool execution), **or**
  - Documentation that ACP is **local developer-only** and must not be enabled on exposed deployments.

**Threat model callout:** **Local dev:** subprocess + user’s Cursor/Amp login — moderate trust boundary. **Deployed server:** any auto-approval is high risk; ACP should default **off** and be explicitly gated.

### Settings surface is not “env-only OK”

The UI and APIs are **tightly coupled** to two providers and two key slots:

- [`app/api/settings/route.ts`](app/api/settings/route.ts)
- [`app/api/settings/test/route.ts`](app/api/settings/test/route.ts)
- [`app/api/settings/cli-status/route.ts`](app/api/settings/cli-status/route.ts)
- [`app/settings/page.tsx`](app/settings/page.tsx)
- [`POST /api/categorize`](app/api/categorize/route.ts) (key name from provider)

**Plan requirement:** Either:

- **Option A (recommended for Phase 1):** Surface **“effective backend”** in settings and health: read-only fields for env-driven backend (`SIFTLY_AI_BACKEND`), model, and “DB keys apply only to anthropic/openai unless extended.” Avoid claiming the selected radio is authoritative when env overrides.
- **Option B:** Extend DB schema/settings keys for `openrouter`, `gemini`, `opencode`, etc., and mirror in the UI.

Leaving these routes **unchanged** while the server resolves OpenRouter/Gemini/OpenCode from env produces **stale/misleading** provider state and ambiguous key behavior — **explicitly out of scope** unless called out as technical debt.

**Open question — resolved in plan (default):** Phase 1 keeps the **Anthropic/OpenAI** settings UI as the **primary** editable keys for those two backends, and adds **read-only “effective AI resolution”** (backend + model + source) when `SIFTLY_AI_*` env wins. Full editing of every backend in the UI can be Phase 2.

---

## Request-scoped `ResolvedAiBackend`

Minimal shape:

```ts
interface ResolvedAiBackend {
  backend: AiBackendId
  model: string
  client: AIClient | null
  capabilities: AiCapabilities
  resolutionSource: ResolutionSource
  // optional: execution fallback metadata after retries
}
```

- **`resolutionSource`** makes debugging and audits possible (“why did I get OpenRouter?”).

Pass this object into:

- [`lib/categorizer.ts`](lib/categorizer.ts), [`lib/vision-analyzer.ts`](lib/vision-analyzer.ts), [`lib/search-pipeline.ts`](lib/search-pipeline.ts), [`lib/search-expansion.ts`](lib/search-expansion.ts) if kept, and any enrichment helpers.

---

## Capability matrix (explicit)

Dimensions (example flags; finalize in implementation):

| Dimension | Purpose |
|-----------|---------|
| `textGeneration` | Can run categorization / enrichment / reranker text prompts |
| `inlineImages` | Native multimodal (base64 in API) |
| `urlOnlyVisionFallback` | Safe to pass image URL in text (CLI or ACP text-only) |
| `cliPrompt` | Claude/Codex-style shell prompt available |
| `healthCheckMethod` | `sdk_ping` \| `http_head` \| `cli_version` \| `none` |
| `modelSource` | `env` \| `db` \| `fixed_default` |
| `supportsExecutionFallback` | Can participate in runtime retry chain |
| `unattendedToolExecution` | **Must be false** for server defaults; ACP gated |

Backends populate **`AiCapabilities`** so call sites **stop** re-branching on raw backend id except where unavoidable (e.g. CLI spawn).

---

## Two fallback policies

### 1. Resolution fallback (bootstrap)

**When:** Before work starts — missing secret, invalid env, backend disabled, binary absent.

**Behavior:** Walk `SIFTLY_AI_FALLBACK` (or ordered list) **once**; produce **one** `ResolvedAiBackend` for the request. Log **which** backend won and why.

**Does not** mix providers mid-request at this stage.

### 2. Execution fallback (runtime)

**When:** After a **transient** failure — HTTP 429/503, rate limit, timeout, malformed JSON recoverable by retry, optional **single** alternate backend if configured (e.g. `SIFTLY_AI_EXECUTION_FALLBACK`).

**Behavior:**

- **Strict limits:** max N attempts per stage, **no** unbounded cross-provider mixing in one batch without explicit logging.
- **Policy must be explicit:** e.g. “retry same backend 2x, then fail” vs “fail over to next backend once.” Default conservative: **same backend retries only** unless `SIFTLY_AI_EXECUTION_FALLBACK` is set.

This avoids **silent** mixing of providers within one pipeline run without observability.

---

## Expanded file / call-site inventory

Must be reviewed and updated in line with `ResolvedAiBackend`:

| Area | Files |
|------|--------|
| Core | [`lib/ai-client.ts`](lib/ai-client.ts), new `lib/ai-backend.ts` (or `lib/ai-context.ts`) |
| Settings | [`lib/settings.ts`](lib/settings.ts) |
| Categorize | [`lib/categorizer.ts`](lib/categorizer.ts), [`app/api/categorize/route.ts`](app/api/categorize/route.ts) |
| Vision | [`lib/vision-analyzer.ts`](lib/vision-analyzer.ts), [`app/api/analyze/images/route.ts`](app/api/analyze/images/route.ts) |
| **Search (live)** | [`lib/search-pipeline.ts`](lib/search-pipeline.ts), [`app/api/search/ai/route.ts`](app/api/search/ai/route.ts) |
| Search (optional merge) | [`lib/search-expansion.ts`](lib/search-expansion.ts) |
| Settings API | [`app/api/settings/route.ts`](app/api/settings/route.ts), [`app/api/settings/test/route.ts`](app/api/settings/test/route.ts), [`app/api/settings/cli-status/route.ts`](app/api/settings/cli-status/route.ts) |
| UI | [`app/settings/page.tsx`](app/settings/page.tsx) |

---

## Phased delivery

| Phase | Scope |
|-------|--------|
| **1** | `ResolvedAiBackend`, capability flags, resolution + execution fallback policies, HTTP/SDK: OpenRouter, Gemini, OpenCode (OpenAI-compat + optional Messages adapter), integrate **search-pipeline**, align settings **truthfulness** (Option A above), tests/smoke matrix |
| **1.5** | ACP behind flag; **no** broad tool auto-approve; document local-only vs server threat model |
| **2** | Antigravity OAuth / accounts file (experimental), optional full settings UI for all backends |

---

## Validation (explicit)

### Automated

- Add **`vitest`** (or similar) + `npm test` script — project currently has **no** test runner in [`package.json`](package.json).
- **Unit tests:** backend resolution order, resolution fallback, execution fallback limits, `resolutionSource` correctness.
- **Adapter contract tests:** each backend’s implementation of text `createMessage()` (and multimodal where applicable) with **mocked** HTTP/SDK.

### Manual smoke

| Endpoint / action | What to verify |
|-------------------|----------------|
| `POST /api/settings/test` | Each configured backend returns meaningful success/failure |
| `POST /api/analyze/images` | Vision path respects capabilities (inline vs URL fallback) |
| `POST /api/categorize` | Full pipeline uses same `ResolvedAiBackend` throughout |
| `POST /api/search/ai` | Reranking uses same resolved client/model as categorize |

### Failure-mode checklist (manual)

- Missing API keys for chosen backend
- Bad model ID (400 from provider)
- Wrong `OPENCODE_CHAT_URL` for selected model family
- Claude/Codex CLI missing on PATH
- ACP binary missing / experimental flag off
- Rate limit (429) — execution fallback / logging

---

## Dependencies

- `@google/genai` (or chosen Gemini SDK), `openai` for OpenRouter/OpenCode OpenAI-compatible paths.

---

## Cleanup

- Remove stray `fetch('http://127.0.0.1:7824/ingest/...')` debug blocks in [`lib/categorizer.ts`](lib/categorizer.ts) and [`app/api/categorize/route.ts`](app/api/categorize/route.ts) when touching those files.

---

## Risks / limits (unchanged in spirit)

- OpenCode Zen/Go: users must match endpoint + model to [Zen](https://opencode.ai/docs/zen/) / [Go](https://opencode.ai/docs/go/) tables.
- Antigravity: Phase 2 only; ToS/account risk per community tools.
