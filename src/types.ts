import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWeb {
  results: Array<{
    title: string;
    content: string;
    url: string;
    score: number;
  }>;
}

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
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

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Performs a web search using the SearXNG API, ideal for general queries, news, articles, and online content. " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. This is the main input for the web search",
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
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
    },
    required: ["query"],
  },
};

export const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Read the content from an URL. " +
    "Use this for further information retrieving to understand the content of each URL.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL",
      },
      startChar: {
        type: "number",
        description: "Starting character position for content extraction (default: 0)",
        minimum: 0,
      },
      maxLength: {
        type: "number",
        description: "Maximum number of characters to return",
        minimum: 1,
      },
      section: {
        type: "string",
        description: "Extract content under a specific heading (searches for heading text)",
      },
      paragraphRange: {
        type: "string",
        description: "Return specific paragraph ranges (e.g., '1-5', '3', '10-')",
      },
      readHeadings: {
        type: "boolean",
        description: "Return only a list of headings instead of full content",
      },
    },
    required: ["url"],
  },
};

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

export function isSearXNGVisionImageSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  topK?: number;
  minScore?: number;
  num?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const visionArgs = args as any;

  if (visionArgs.topK !== undefined && (typeof visionArgs.topK !== "number" || visionArgs.topK < 5 || visionArgs.topK > 100)) {
    return false;
  }
  if (visionArgs.minScore !== undefined && (typeof visionArgs.minScore !== "number" || visionArgs.minScore < 0 || visionArgs.minScore > 1)) {
    return false;
  }
  if (visionArgs.num !== undefined && (typeof visionArgs.num !== "number" || visionArgs.num < 1 || visionArgs.num > 100)) {
    return false;
  }

  return true;
}

export const IMAGE_SEARCH_TOOL: Tool = {
  name: "searxng_image_search",
  description:
    "Performs an image search using the SearXNG API. " +
    "Sorts results by SearXNG relevance score, applies a proper random shuffle, then truncates. " +
    "Fast and suitable for typical use cases. " +
    "Note: SearXNG returns ~100 results for image search with no server-side limit. " +
    "Use the 'num' parameter to limit results returned to the LLM, and 'pageno' to retrieve additional pages.",
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
      num: {
        type: "number",
        description:
          "Maximum number of results to return (client-side limit). " +
          "SearXNG does not support a server-side limit, so this truncates results after fetching. " +
          "Default: 16, Max: 100",
        default: 16,
        minimum: 1,
        maximum: 100,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de')",
        default: "all",
      },
      safesearch: {
        type: "number",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
    },
    required: ["query"],
  },
};

export const VISION_IMAGE_SEARCH_TOOL: Tool = {
  name: "searxng_image_search_vision",
  description:
    "Performs an image search using the SearXNG API with multimodal embedding-based filtering. " +
    "Two-stage pipeline: text-based title filtering followed by vision-based image content analysis. " +
    "Slower but more semantically relevant results. " +
    "Requires EMBEDDING_SERVICE_URL environment variable pointing to a running llama.cpp server " +
    "with jina-embeddings-v5-omni-small-retrieval-GGUF. " +
    "Note: SearXNG returns ~100 results for image search with no server-side limit.",
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
      topK: {
        type: "number",
        description:
          "Number of candidates to keep after text-stage title filtering. " +
          "Vision embeddings are only computed for these top K results. " +
          "Higher values increase accuracy but also latency. Default: 25, Max: 100",
        default: 25,
        minimum: 5,
        maximum: 100,
      },
      minScore: {
        type: "number",
        description:
          "Minimum cosine similarity threshold for vision-stage filtering. " +
          "Results below this threshold are excluded. " +
          "Lower values return more results but may include less relevant images. Default: 0.15, Range: 0-1",
        default: 0.15,
        minimum: 0,
        maximum: 1,
      },
      num: {
        type: "number",
        description:
          "Maximum number of results to return after all filtering. " +
          "Default: 16, Max: 100",
        default: 16,
        minimum: 1,
        maximum: 100,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de')",
        default: "all",
      },
      safesearch: {
        type: "number",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
    },
    required: ["query"],
  },
};
