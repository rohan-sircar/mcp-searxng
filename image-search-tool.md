# Proposal: Adding `searxng_image_search` Tool to mcp-searxng

## 1. Analysis Summary

### Current Codebase Architecture (v1.0.3)

The project has been significantly refactored from a single-file implementation to a modular architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                        src/index.ts                              │
│  - createMcpServer() factory function                            │
│  - Handles: ListTools, CallTool, SetLevel, Resources            │
│  - Imports tool definitions from types.js                        │
│  - Delegates to modular handlers (search.js, url-reader.js)     │
└────────────────┬────────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌───────────────┐ ┌──────────────────┐
│ src/types.ts  │ │ src/search.ts    │
│ - Tool defs   │ │ - performWebSearch│
│ - Type guards │ │   (with proxy,    │
│ - WEB_SEARCH_ │ │   error handling, │
│   TOOL        │ │   logging)        │
│ - READ_URL_   │ └──────────────────┘
│   TOOL        │
└───────────────┘
```

### Key Differences Between Your Fork and Current Codebase

| Aspect | Your Fork | Current Codebase |
|--------|-----------|------------------|
| **Server** | Manual `new Server()` with capabilities config | `McpServer` factory pattern (`createMcpServer()`) |
| **Tool Registration** | Static in constructor, `ListToolsRequestSchema` returns array | Declarative in `types.ts`, returned from handler |
| **Search Logic** | Inline `performWebSearch()` with `categories` param | Extracted to `src/search.ts`, no `categories` param |
| **Type Guards** | `isSearXNGWebSearchArgs()` in same file | Exported from `src/types.ts` |
| **Error Handling** | Basic try/catch in handler | Dedicated `src/error-handler.ts` with contextual errors |
| **Proxy/TLS** | None | `src/proxy.ts`, `src/tls-config.ts`, `src/http-security.ts` |
| **Logging** | None | `src/logging.ts` with level control |
| **Caching** | None | `src/cache.ts` for URL content |
| **SearXNG Types** | Inline `SearXNGWeb` with image fields | Minimal `SearXNGWeb` (only web fields) |

---

## 2. SearXNG Image API Response Format

When `categories=images` is passed to the SearXNG `/search` endpoint, results have different fields than web search:

```json
{
  "results": [
    {
      "title": "Image title",
      "img_src": "https://example.com/image.jpg",
      "thumbnail_src": "https://example.com/thumbnail.jpg",
      "source": "Source name",
      "url": "Original page URL",
      "thumbnail": "Thumbnail URL",
      "content": "",
      "score": 1.5,
      "engine": "google",
      "category": "images"
    }
  ]
}
```

**Key image result fields:**
- `img_src` - Direct image URL
- `thumbnail_src` - Thumbnail URL
- `title` - Image title/description
- `url` - Source page URL
- `source` - Image host/source
- `score` - Relevance

## 2.1 SearXNG Result Limit Limitation

**Important:** SearXNG does **not** have a built-in `num` or `limit` query parameter for controlling the number of results returned per page. This is a known limitation confirmed by multiple GitHub issues (#1276, #2240, #3754).

- SearXNG returns a **fixed ~20 results per page** by default (varies by engine)
- The only pagination parameter available is `pageno` (page number, 1-indexed)
- `max_page` is a server-side configuration, not an API parameter

**Implication for this tool:** Since SearXNG returns ~100 results for image search (aggregated from Google Images, Bing, Unsplash, etc.), the MCP server must implement **client-side limiting**. The tools include a `num` parameter that truncates results after fetching, preventing context overflow for LLM consumers.

---

## 3. Implementation Plan

### 3.1 Files to Modify/Create

| File | Action | Purpose |
|------|--------|---------|
| `src/types.ts` | **Modify** | Add `IMAGE_SEARCH_TOOL` definition, `VISION_IMAGE_SEARCH_TOOL` definition, `SearXNGImage` type, type guards |
| `src/search.ts` | **Modify** | Add `performImageSearch()` (relevance-based) and `performVisionImageSearch()` (embedding-based) functions |
| `src/embedding-service.ts` | **Create** | Call llama.cpp `/embeddings` endpoint, cosine similarity, image download |
| `src/index.ts` | **Modify** | Register both tools in `ListToolsRequestSchema` and `CallToolRequestSchema` |
| `__tests__/unit/search.test.ts` | **Create** | Add tests for both image search variants |

### 3.2 Detailed Changes

#### Step 1: `src/types.ts` — Add Image Search Tool Definitions

**`IMAGE_SEARCH_TOOL`** (relevance-based, updated description):

```typescript
// Add after READ_URL_TOOL definition

export interface SearXNGImageResult {
  title: string;
  img_src: string;
  thumbnail_src: string;
  url: string;
  source: string;
  engine: string;
  height: number;
  width: number;
  score: number;
}

export interface SearXNGImage {
  results: SearXNGImageResult[];
}

export function isSearXNGImageSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  num?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

export const IMAGE_SEARCH_TOOL: Tool = {
  name: "searxng_image_search",
  description:
    "Performs an image search using the SearXNG API. " +
    "Use this when you need to find images related to a query.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query for images",
      },
      pageno: {
        type: "number",
        description: "Search page number (starts at 1)",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description: "Language code for search results (e.g., 'en', 'fr', 'de')",
        default: "all",
      },
      safesearch: {
        type: "number",
        description: "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
      num: {
        type: "number",
        description: "Maximum number of results to return (client-side limit). SearXNG does not support a server-side limit, so this truncates results after fetching. Default: 16, Max: 100",
        default: 16,
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["query"],
  },
};
```

#### Step 1.5: `src/embedding-service.ts` — Embedding Service Client

A lightweight client for calling the llama.cpp embedding server via its OpenAI-compatible API:

```typescript
// Core functions:
// 1. callTextEmbeddingService(input, model?) → EmbeddingResult[]
//    - POST to /embeddings with OpenAI-compatible format
//    - Text: {"input": "Query: <text>", "model": "..."}
//    - Supports batching for multiple inputs
//
// 2. callVisionEmbeddingService(imageBase64, prompt?, model?) → VisionEmbeddingResult
//    - POST to /embeddings with multimodal format
//    - {"content": [{"prompt_string": "<__media__>", "multimodal_data": [base64]}]}
//
// 3. cosineSimilarity(a, b) → number
//    - Dot product of two vectors divided by product of their norms
//
// 4. downloadImageAsBase64(url) → Promise<string>
//    - Fetch image, return base64-encoded string
```

#### Step 1.6: `src/types.ts` — Add Vision Image Search Tool Definition

```typescript
export const VISION_IMAGE_SEARCH_TOOL: Tool = {
  name: "searxng_image_search_vision",
  description:
    "Performs an image search using the SearXNG API with multimodal embedding-based filtering. " +
    "Two-stage pipeline: text-based title filtering followed by vision-based image content analysis. " +
    "Slower but more semantically relevant results. " +
    "Requires EMBEDDING_SERVICE_URL environment variable pointing to a running llama.cpp server " +
    "with jina-embeddings-v5-omni-small-retrieval-GGUF. " +
    "Note: SearXNG returns ~100 results for image search with no server-side limit.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query for images" },
      pageno: { type: "number", description: "Search page number (starts at 1)", default: 1 },
      topK: { type: "number", description: "Candidates after text-stage filtering. Default: 25, Max: 100", default: 25, minimum: 5, maximum: 100 },
      minScore: { type: "number", description: "Min cosine similarity for vision-stage. Default: 0.15, Range: 0-1", default: 0.15, minimum: 0, maximum: 1 },
      num: { type: "number", description: "Max results to return. Default: 16, Max: 100", default: 16, minimum: 1, maximum: 100 },
      time_range: { type: "string", enum: ["day", "month", "year"] },
      language: { type: "string", default: "all" },
      safesearch: { type: "number", enum: [0, 1, 2], default: 0 },
    },
    required: ["query"],
  },
};

export function isSearXNGVisionImageSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  topK?: number;
  minScore?: number;
  num?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
} { /* ... validation ... */ }
```

#### Step 2: `src/search.ts` — Add `performImageSearch()` Function

Add a new exported function that reuses the infrastructure from `performWebSearch()`:

```typescript
/**
 * Performs an image search using the SearXNG API.
 * Reuses the same HTTP infrastructure as web search but with categories=images.
 */
export async function performImageSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  num: number = 16,
  time_range?: string,
  language: string = "all",
  safesearch?: number
) {
  const startTime = Date.now();

  // Clamp num to valid range
  const limit = Math.min(Math.max(1, num), 100);

  logMessage(mcpServer, "info", `Starting image search: "${query}" (page ${pageno}, limit ${limit})`);

  const validationError = validateEnvironment();
  if (validationError) {
    logMessage(mcpServer, "error", "Configuration invalid");
    throw new MCPSearXNGError(validationError);
  }

  const searxngUrl = process.env.SEARXNG_URL!;
  const parsedUrl = new URL(searxngUrl.endsWith('/') ? searxngUrl : searxngUrl + '/');
  const url = new URL('search', parsedUrl);

  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());
  url.searchParams.set("categories", "images"); // Key difference: image category

  if (time_range !== undefined && ["day", "month", "year"].includes(time_range)) {
    url.searchParams.set("time_range", time_range);
  }
  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }
  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }

  // Reuse proxy and auth setup from performWebSearch
  const requestOptions: RequestInit = { method: "GET" };
  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    requestOptions.headers = { ...requestOptions.headers, 'Authorization': `Basic ${base64Auth}` };
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = { ...requestOptions.headers, 'User-Agent': userAgent };
  }

  // Fetch and parse (same error handling as web search)
  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during image search: ${error.message}`);
    throw createNetworkError(error, { url: url.toString(), searxngUrl });
  }

  if (!response.ok) {
    throw createServerError(
      response.status,
      response.statusText,
      await response.text(),
      { url: url.toString(), searxngUrl }
    );
  }

  let data: SearXNGImage;
  try {
    data = (await response.json()) as SearXNGImage;
  } catch (error: any) {
    throw createJSONError(await response.text(), { url: url.toString() });
  }

  if (!data.results) {
    throw createDataError(data, { url: url.toString(), query });
  }

  // Format image results with image-specific fields, applying client-side limit
  // Note: SearXNG has no server-side limit parameter, so we truncate client-side
  const results = data.results
    .map((result) => ({
      title: result.title || "",
      img_src: result.img_src || "",
      thumbnail_src: result.thumbnail_src || "",
      url: result.url || "",
      source: result.source || "",
      engine: result.engine || "",
      width: result.width || 0,
      height: result.height || 0,
      score: result.score || 0,
    }))
    .slice(0, limit);

  if (results.length === 0) {
    logMessage(mcpServer, "info", `No images found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Image search completed: "${query}" - ${results.length} results in ${duration}ms`);

  return results
    .map((r) => `Title: ${r.title}\nImage URL: ${r.img_src}\nThumbnail: ${r.thumbnail_src}\nSource URL: ${r.url}\nSource: ${r.source}\nDimensions: ${r.width}x${r.height}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
}
```

#### Step 3: `src/index.ts` — Register the New Tool

**Import the new tool and type guard:**

```typescript
// Change line 15 from:
import { WEB_SEARCH_TOOL, READ_URL_TOOL, isSearXNGWebSearchArgs } from "./types.js";

// To:
import { WEB_SEARCH_TOOL, READ_URL_TOOL, IMAGE_SEARCH_TOOL, isSearXNGWebSearchArgs, isSearXNGImageSearchArgs } from "./types.js";

// And import the new search function:
import { performWebSearch, performImageSearch } from "./search.js";
```

**Register in ListTools handler (line ~94-98):**

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logMessage(mcpServer, "debug", "Handling list_tools request");
  return {
    tools: [WEB_SEARCH_TOOL, IMAGE_SEARCH_TOOL, READ_URL_TOOL],
  };
});
```

**Add handler in CallTool handler (line ~107-128):**

```typescript
} else if (name === "searxng_image_search") {
  if (!isSearXNGImageSearchArgs(args)) {
    throw new Error("Invalid arguments for image search");
  }

  const result = await performImageSearch(
    mcpServer,
    args.query,
    args.pageno ?? 1,
    args.num ?? 16,
    args.time_range,
    args.language,
    args.safesearch
  );

  return {
    content: [
      {
        type: "text",
        text: result,
      },
    ],
  };
```

**Add handler for vision image search (after regular image search handler):**

```typescript
} else if (name === "searxng_image_search_vision") {
  if (!isSearXNGVisionImageSearchArgs(args)) {
    throw new Error("Invalid arguments for vision image search");
  }

  if (!process.env.EMBEDDING_SERVICE_URL) {
    throw new Error(
      "EMBEDDING_SERVICE_URL is not set. " +
      "Start a llama.cpp server with jina-embeddings-v5-omni-small-retrieval-GGUF and set the environment variable."
    );
  }

  const result = await performVisionImageSearch(
    mcpServer,
    args.query,
    args.pageno ?? 1,
    args.topK ?? 25,
    args.minScore ?? 0.15,
    args.num ?? 16,
    args.time_range,
    args.language,
    args.safesearch
  );

  return {
    content: [
      {
        type: "text",
        text: result,
      },
    ],
  };
```

**Import the new tool, type guard, and search function:**

```typescript
// Change line 15 from:
import { WEB_SEARCH_TOOL, READ_URL_TOOL, IMAGE_SEARCH_TOOL, isSearXNGWebSearchArgs, isSearXNGImageSearchArgs } from "./types.js";

// To:
import { WEB_SEARCH_TOOL, READ_URL_TOOL, IMAGE_SEARCH_TOOL, VISION_IMAGE_SEARCH_TOOL, isSearXNGWebSearchArgs, isSearXNGImageSearchArgs, isSearXNGVisionImageSearchArgs } from "./types.js";

// And import the new search function:
import { performWebSearch, performImageSearch, performVisionImageSearch } from "./search.js";
```

---

## 4. Architecture Diagram

```
                     ┌─────────────────────────────────────┐
                     │          src/index.ts               │
                     │   createMcpServer() factory         │
                     │                                     │
                     │  ListTools ─────────────────────┐   │
                     │  CallTool ──────────────────────┤   │
                     └─────────────────────────────────┼───┘
                                                       │
                  ┌────────────────────────────────────┴────────────────────────────────────┐
                  ▼                                         ▼                                 ▼
    ┌──────────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────┐
    │       src/types.ts        │    │       src/search.ts      │    │  src/embedding-service.ts│
    │  ┌─────────────────────┐ │    │  ┌─────────────────────┐ │    │                          │
    │  │ WEB_SEARCH_TOOL     │ │    │  │ performWebSearch()    │ │    │  callTextEmbedding()   │
    │  │ IMAGE_SEARCH_TOOL   │ │    │  │ performImageSearch()  │ │    │  callVisionEmbedding() │
    │  │ VISION_IMAGE_TOOL   │ │    │  │ performVisionSearch() │ │    │  cosineSimilarity()    │
    │  │ READ_URL_TOOL       │ │    │  └─────────────────────┘ │    │  downloadImageAsBase64()│
    │  │ isSearXNG*Args()    │ │    │                          │    │                          │
    │  └─────────────────────┘ │    │  Uses: proxy.ts          │    │  External: llama.cpp     │
    │                           │    │  error-handler.ts        │    │  jina-embeddings-v5-omni │
    │  Defines Tool schemas &  │    │  logging.ts              │    │  server (/embeddings)    │
    │  type guards             │    │  tls-config.ts           │    │                          │
    └──────────────────────────┘    └──────────────────────────┘    └──────────────────────────┘
```

```
                    ┌─────────────────────────────────────┐
                    │          src/index.ts               │
                    │   createMcpServer() factory         │
                    │                                     │
                    │  ListTools ─────────────────────┐   │
                    │  CallTool ──────────────────────┤   │
                    └─────────────────────────────────┼───┘
                                                      │
                                    ┌─────────────────┴─────────────────┐
                                    ▼                                   ▼
                    ┌──────────────────────────┐    ┌──────────────────────────┐
                    │       src/types.ts        │    │       src/search.ts      │
                    │  ┌─────────────────────┐ │    │  ┌─────────────────────┐ │
                    │  │ WEB_SEARCH_TOOL     │ │    │  │ performWebSearch()    │ │
                    │  │ IMAGE_SEARCH_TOOL   │ │    │  │ performImageSearch()  │ │
                    │  │ READ_URL_TOOL       │ │    │  └─────────────────────┘ │
                    │  │ isSearXNG*Args()    │ │    │                          │
                    │  └─────────────────────┘ │    │  Uses: proxy.ts          │
                    │                           │    │  error-handler.ts        │
                    │  Defines Tool schemas &  │    │  logging.ts              │
                    │  type guards             │    │  tls-config.ts           │
                    └──────────────────────────┘    └──────────────────────────┘
```

---

## 5. Key Design Decisions

### 5.1 Why a Separate Function, Not a Parameter?

The current `performWebSearch()` function has no `categories` parameter. Adding one would require:

1. Modifying the function signature
2. Adding conditional logic for different result types
3. Handling different response schemas (`SearXNGWeb` vs `SearXNGImage`)

A separate `performImageSearch()` function:
- Keeps concerns separated (web vs image have different result formats)
- Reuses the same HTTP infrastructure (proxy, auth, TLS)
- Follows the existing pattern (each tool has its own handler)
- Is easier to test independently

### 5.2 Result Format

Image search results should include:
- `img_src` — The direct image URL (most important field)
- `thumbnail_src` — Thumbnail URL for preview
- `url` — Source page URL
- `source` — Image host/source name
- `title` — Image title/alt text
- `width`/`height` — Image dimensions (if available)

This matches what your fork returns but follows the current codebase's formatting style (using `createNoResultsMessage()` for empty results and the standard `Title/Description/URL` format).

### 5.3 Type Guard Reuse

Note that `isSearXNGImageSearchArgs()` has the **exact same shape** as `isSearXNGWebSearchArgs()` (same parameters minus `categories`). However, for type safety and clarity, they should be separate functions. The SDK's type system requires distinct type predicates.

### 5.4 No Changes to `SearXNGWeb` Type

The existing `SearXNGWeb` interface in `src/types.ts` is minimal (only `title`, `content`, `url`, `score`). The new `SearXNGImage` interface should be separate since image results have completely different fields.

### 5.5 Two-Tool Architecture: Relevance vs Vision

Instead of a single tool with a mode parameter, we expose two separate tools:

| | `searxng_image_search` | `searxng_image_search_vision` |
|---|---|---|
| **Method** | Sort by SearXNG score, shuffle, truncate | Two-stage embedding filtering |
| **Latency** | ~50ms | ~3-9s (with GPU) |
| **Quality** | Good, biased toward top engines | Semantically relevant |
| **Dependencies** | None | llama.cpp server + model |
| **Use case** | Typical/fast searches | Disambiguation, quality-critical |

This gives the AI assistant clear signal about what to expect — it can choose based on context (speed vs quality).

### 5.6 Embedding Service as Optional Dependency

The embedding service (llama.cpp server) is **optional infrastructure**:
- If `EMBEDDING_SERVICE_URL` is not set, `searxng_image_search_vision` fails immediately with a clear error
- If the service is down, the tool fails with a descriptive error mentioning the root cause
- All other tools (web search, regular image search, URL read) continue working normally
- This isolation is critical — the embedding service failure must not affect the rest of the MCP server

---

## 6. Testing Strategy

Add tests to `__tests__/unit/search.test.ts`:

### Relevance-based image search (`performImageSearch`)
1. **Successful search** — Mock SearXNG response with image results
2. **Empty results** — Verify `createNoResultsMessage()` is returned
3. **Invalid arguments** — Verify type guard rejection
4. **Network error** — Verify proper error wrapping
5. **Image-specific fields** — Verify `img_src`, `thumbnail_src`, dimensions are included
6. **Fisher-Yates shuffle** — Verify results are shuffled (not sorted)

### Vision-based image search (`performVisionImageSearch`)
7. **Missing env var** — Verify immediate error before any work
8. **Text stage filtering** — Mock embedding service, verify top-K selection
9. **Vision stage filtering** — Mock embedding service, verify similarity threshold
10. **Embedding service down** — Verify clear error message
11. **Image download failure** — Verify individual image failure doesn't crash pipeline
12. **No results pass threshold** — Verify `createNoResultsMessage()` is returned
3. **Invalid arguments** — Verify type guard rejection
4. **Network error** — Verify proper error wrapping
5. **Image-specific fields** — Verify `img_src`, `thumbnail_src`, dimensions are included

---

## 7. Files Requiring Changes (Summary)

| File | Lines Changed | Complexity |
|------|---------------|------------|
| `src/types.ts` | +100 (two tool defs, two type guards) | Low |
| `src/search.ts` | +180 (shuffle fix + vision search function) | High |
| `src/embedding-service.ts` | +120 (new file: embedding client) | Medium |
| `src/index.ts` | +40 (imports, register, handler) | Low |
| `CONFIGURATION.md` | +25 (new section for embedding service) | Low |
| `__tests__/unit/search.test.ts` | +150 (both search variants) | Medium |

**Total: ~615 lines of new/changed code across 6 files.**

---

## 8. Migration Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking existing tools | Very Low | No changes to existing tool schemas or handlers |
| SearXNG API incompatibility | Low | `categories=images` is a standard SearXNG parameter |
| Proxy/auth conflicts | Very Low | Reuses exact same infrastructure as web search |
| TypeScript type errors | Low | New types are well-scoped to image results |
| Embedding service unavailable | Medium | Tool fails fast with clear error; other tools unaffected |
| llama.cpp model not found | Low | Clear error message + documentation on how to start server |

This is a **low-risk, additive change** that introduces two new tools without modifying any existing functionality. The embedding service is an optional dependency with proper error isolation.
