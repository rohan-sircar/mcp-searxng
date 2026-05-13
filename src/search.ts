import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearXNGWeb, SearXNGImageResult, type SearXNGImage } from "./types.js";
import { createProxyAgent, createDefaultAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import {
  MCPSearXNGError,
  validateEnvironment,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  createNoResultsMessage,
  type ErrorContext
} from "./error-handler.js";
import {
  callTextEmbeddingService,
  callVisionEmbeddingService,
  cosineSimilarity,
  downloadImageAsBase64,
  type EmbeddingResult,
  type VisionEmbeddingResult,
} from "./embedding-service.js";

export async function performWebSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: number
) {
  const startTime = Date.now();
  
  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch ? `safesearch: ${safesearch}` : null
  ].filter(Boolean).join(", ");
  
  logMessage(mcpServer, "info", `Starting web search: "${query}" (${searchParams})`);
  
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

  if (
    time_range !== undefined &&
    ["day", "month", "year"].includes(time_range)
  ) {
    url.searchParams.set("time_range", time_range);
  }

  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }

  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }

  // Prepare request options with headers
  const requestOptions: RequestInit = {
    method: "GET"
  };

  // Add proxy or default dispatcher (includes system CA certs for TLS)
  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  // Add basic authentication if credentials are provided
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    requestOptions.headers = {
      ...requestOptions.headers,
      'Authorization': `Basic ${base64Auth}`
    };
  }

  // Add User-Agent header if configured
  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      'User-Agent': userAgent
    };
  }

  // Fetch with enhanced error handling
  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username
    };
    throw createNetworkError(error, context);
  }

  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '[Could not read response body]';
    }

    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl
    };
    throw createServerError(response.status, response.statusText, responseBody, context);
  }

  // Parse JSON response
  let data: SearXNGWeb;
  try {
    data = (await response.json()) as SearXNGWeb;
  } catch (error: any) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = '[Could not read response text]';
    }

    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  if (!data.results) {
    const context: ErrorContext = { url: url.toString(), query };
    throw createDataError(data, context);
  }

  const results = data.results.map((result) => ({
    title: result.title || "",
    content: result.content || "",
    url: result.url || "",
    score: result.score || 0,
  }));

  if (results.length === 0) {
    logMessage(mcpServer, "info", `No results found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${results.length} results in ${duration}ms`);

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.content}\nURL: ${r.url}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
}

/**
 * Performs an image search using the SearXNG API.
 * Reuses the same HTTP infrastructure as performWebSearch but with categories=images.
 *
 * Note: SearXNG has no server-side limit parameter for results, so we implement
 * client-side limiting via the `num` parameter to prevent context overflow.
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
  
  // Clamp num to valid range (1-100)
  const limit = Math.min(Math.max(1, num), 100);
  
  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `limit: ${limit}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch ? `safesearch: ${safesearch}` : null
  ].filter(Boolean).join(", ");
  
  logMessage(mcpServer, "info", `Starting image search: "${query}" (${searchParams})`);
  
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
  url.searchParams.set("categories", "images");

  if (
    time_range !== undefined &&
    ["day", "month", "year"].includes(time_range)
  ) {
    url.searchParams.set("time_range", time_range);
  }

  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }

  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }

  // Prepare request options with headers
  const requestOptions: RequestInit = {
    method: "GET"
  };

  // Add proxy or default dispatcher (includes system CA certs for TLS)
  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  // Add basic authentication if credentials are provided
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    requestOptions.headers = {
      ...requestOptions.headers,
      'Authorization': `Basic ${base64Auth}`
    };
  }

  // Add User-Agent header if configured
  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      'User-Agent': userAgent
    };
  }

  // Fetch with enhanced error handling
  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during image search: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username
    };
    throw createNetworkError(error, context);
  }

  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '[Could not read response body]';
    }

    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl
    };
    throw createServerError(response.status, response.statusText, responseBody, context);
  }

  // Parse JSON response
  let data: SearXNGImage;
  try {
    data = (await response.json()) as SearXNGImage;
  } catch (error: any) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = '[Could not read response text]';
    }

    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  if (!data.results) {
    const context: ErrorContext = { url: url.toString(), query };
    throw createDataError(data, context);
  }

  // Format image results with image-specific fields
  // Note: SearXNG returns ~100 results for image search with no server-side limit,
  // so we truncate client-side to prevent context overflow.
  const results: Array<{
    title: string;
    img_src: string;
    thumbnail_src: string;
    url: string;
    source: string;
    engine: string;
    width: number;
    height: number;
    score: number;
  }> = data.results
    .map((result: SearXNGImageResult) => ({
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
    .sort((a, b) => b.score - a.score)
    .map((r) => r);

  // Fisher-Yates shuffle: O(n) uniform random permutation
  for (let i = results.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [results[i], results[j]] = [results[j], results[i]];
  }

  results.splice(limit);

  if (results.length === 0) {
    logMessage(mcpServer, "info", `No images found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Image search completed: "${query}" (${searchParams}) - ${results.length} results in ${duration}ms`);

  return results
    .map((r) => `Title: ${r.title}\nImage URL: ${r.img_src}\nThumbnail: ${r.thumbnail_src}\nSource URL: ${r.url}\nSource: ${r.source}\nDimensions: ${r.width}x${r.height}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
}

interface VisionImageResult {
  title: string;
  img_src: string;
  thumbnail_src: string;
  url: string;
  source: string;
  engine: string;
  width: number;
  height: number;
  score: number;
  similarity: number;
}

/**
 * Performs an image search using SearXNG with multimodal embedding-based filtering.
 *
 * Two-stage pipeline:
 *   1. Text stage: Embed query + image titles, keep top K by cosine similarity
 *   2. Vision stage: Download thumbnails, embed via vision tower, filter by similarity
 *
 * Requires EMBEDDING_SERVICE_URL pointing to a llama.cpp server running
 * jina-embeddings-v5-omni-small-retrieval-GGUF.
 */
export async function performVisionImageSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  topK: number = 25,
  minScore: number = 0.15,
  num: number = 16,
  time_range?: string,
  language: string = "all",
  safesearch?: number
) {
  const startTime = Date.now();

  const clampedTopK = Math.min(Math.max(5, topK), 100);
  const clampedMinScore = Math.min(Math.max(0, minScore), 1);
  const clampedNum = Math.min(Math.max(1, num), 100);

  const searchParams = [
    `page ${pageno}`,
    `topK: ${clampedTopK}`,
    `minScore: ${clampedMinScore}`,
    `limit: ${clampedNum}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch ? `safesearch: ${safesearch}` : null,
  ].filter(Boolean).join(", ");

  logMessage(mcpServer, "info", `Starting vision image search: "${query}" (${searchParams})`);

  const validationError = validateEnvironment();
  if (validationError) {
    logMessage(mcpServer, "error", "Configuration invalid");
    throw new MCPSearXNGError(validationError);
  }

  const searxngUrl = process.env.SEARXNG_URL!;
  const parsedUrl = new URL(searxngUrl.endsWith("/") ? searxngUrl : searxngUrl + "/");
  const url = new URL("search", parsedUrl);

  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());
  url.searchParams.set("categories", "images");

  if (time_range !== undefined && ["day", "month", "year"].includes(time_range)) {
    url.searchParams.set("time_range", time_range);
  }
  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }
  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }

  const requestOptions: RequestInit = { method: "GET" };
  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString("base64");
    requestOptions.headers = {
      ...requestOptions.headers,
      Authorization: `Basic ${base64Auth}`,
    };
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      "User-Agent": userAgent,
    };
  }

  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during vision image search: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username,
    };
    throw createNetworkError(error, context);
  }

  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = "[Could not read response body]";
    }

    const context: ErrorContext = { url: url.toString(), searxngUrl };
    throw createServerError(response.status, response.statusText, responseBody, context);
  }

  let data: SearXNGImage;
  try {
    data = (await response.json()) as SearXNGImage;
  } catch (error: any) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = "[Could not read response text]";
    }

    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  if (!data.results || data.results.length === 0) {
    const context: ErrorContext = { url: url.toString(), query };
    throw createDataError(data, context);
  }

  // Stage 1: Text-based filtering via title embeddings
  logMessage(mcpServer, "info", `Text embedding: calling embedding service for query "${query}"`);
  const queryEmbedding = await callTextEmbeddingService(`Query: ${query}`);
  logMessage(mcpServer, "info", `Text embedding: query embedding received, ${queryEmbedding[0].embedding.length} dimensions`);

  const titles = data.results
    .map((r) => r.title || "")
    .filter((t) => t.length > 0);

  if (titles.length === 0) {
    logMessage(mcpServer, "warning", "No titles available for text-stage filtering");
  }

  logMessage(mcpServer, "info", `Text embedding: calling embedding service for ${titles.length} titles`);
  const titleEmbeddings = await callTextEmbeddingService(titles);
  logMessage(mcpServer, "info", `Text embedding: ${titleEmbeddings.length} title embeddings received`);

  const allTextSimilarities: Array<{ title: string; similarity: number }> = data.results
    .filter((r) => r.title && r.title.length > 0)
    .map((result, idx) => {
      const titleSimilarity = titleEmbeddings[idx]
        ? cosineSimilarity(queryEmbedding[0].embedding, titleEmbeddings[idx].embedding)
        : 0;

      return { title: result.title || "", similarity: titleSimilarity };
    });

  logMessage(mcpServer, "info", `Text stage similarities: ${allTextSimilarities.map(s => `"${s.title}": ${s.similarity.toFixed(4)}`).join(", ")}`);

  const scoredResults: Array<{ result: SearXNGImageResult; similarity: number }> = allTextSimilarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, clampedTopK)
    .map(s => {
      const match = data.results.find(r => r.title === s.title);
      return match ? { result: match, similarity: s.similarity } : null;
    })
    .filter((r): r is { result: SearXNGImageResult; similarity: number } => r !== null);

  if (scoredResults.length === 0) {
    logMessage(mcpServer, "info", `No images with titles found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  logMessage(mcpServer, "info", `Text stage: ${data.results.length} results → ${scoredResults.length} candidates (topK=${clampedTopK})`);

  // Stage 2: Vision-based filtering
  const visionResults: VisionImageResult[] = [];
  const allVisionSimilarities: Array<{ title: string; similarity: number }> = [];
  logMessage(mcpServer, "info", `Vision stage: processing ${scoredResults.length} candidates`);

  for (let i = 0; i < scoredResults.length; i++) {
    const scored = scoredResults[i];
    logMessage(mcpServer, "info", `Vision stage: processing candidate ${i + 1}/${scoredResults.length}: "${scored.result.title}"`);
    const thumbnailUrl = scored.result.thumbnail_src || scored.result.img_src;
    if (!thumbnailUrl) {
      logMessage(mcpServer, "debug", `Skipping ${scored.result.title}: no thumbnail URL`);
      continue;
    }

    let imgBase64: string;
    try {
      imgBase64 = await downloadImageAsBase64(thumbnailUrl);
      logMessage(mcpServer, "info", `Vision stage: downloaded image (${imgBase64.length} chars base64)`);
    } catch (error: any) {
      logMessage(mcpServer, "warning", `Failed to download image "${scored.result.title}": ${error.message}`);
      continue;
    }

    let imgEmbedding: VisionEmbeddingResult;
    try {
      imgEmbedding = await callVisionEmbeddingService(imgBase64);
      logMessage(mcpServer, "info", `Vision stage: image embedding received (${imgEmbedding.embedding.length} dimensions)`);
    } catch (error: any) {
      logMessage(mcpServer, "warning", `Failed to embed image "${scored.result.title}": ${error.message}`);
      continue;
    }

    const imageSimilarity = cosineSimilarity(queryEmbedding[0].embedding, imgEmbedding.embedding);
    allVisionSimilarities.push({ title: scored.result.title || "", similarity: imageSimilarity });
    logMessage(mcpServer, "info", `Vision stage: similarity=${imageSimilarity.toFixed(4)} (threshold=${clampedMinScore})`);

    if (imageSimilarity >= clampedMinScore) {
      visionResults.push({
        title: scored.result.title || "",
        img_src: scored.result.img_src || "",
        thumbnail_src: scored.result.thumbnail_src || "",
        url: scored.result.url || "",
        source: scored.result.source || "",
        engine: scored.result.engine || "",
        width: scored.result.width || 0,
        height: scored.result.height || 0,
        score: scored.result.score || 0,
        similarity: imageSimilarity,
      });
    }
    logMessage(mcpServer, "info", `Vision stage: candidate ${i + 1}/${scoredResults.length} processed (${imageSimilarity >= clampedMinScore ? "PASSED" : "REJECTED"})`);
  }

  logMessage(mcpServer, "info", `Vision stage similarities: ${allVisionSimilarities.map(s => `"${s.title}": ${s.similarity.toFixed(4)}`).join(", ")}`);

  logMessage(mcpServer, "info", `Vision stage: ${visionResults.length} of ${scoredResults.length} candidates passed threshold`);

  if (visionResults.length === 0) {
    logMessage(mcpServer, "info", `No images passed vision similarity threshold (${clampedMinScore}) for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  // Sort by embedding similarity (descending), then by SearXNG score as tiebreaker
  visionResults.sort((a, b) => b.similarity - a.similarity || b.score - a.score);

  const finalResults = visionResults.slice(0, clampedNum);

  const duration = Date.now() - startTime;
  logMessage(
    mcpServer,
    "info",
    `Vision image search completed: "${query}" (${searchParams}) - ${finalResults.length} results in ${duration}ms`
  );

  return finalResults
    .map(
      (r) =>
        `Title: ${r.title}\nImage URL: ${r.img_src}\nThumbnail: ${r.thumbnail_src}\nSource URL: ${r.url}\nSource: ${r.source}\nDimensions: ${r.width}x${r.height}\nEmbedding Similarity: ${r.similarity.toFixed(4)}\nRelevance Score: ${r.score.toFixed(3)}`
    )
    .join("\n\n");
}
