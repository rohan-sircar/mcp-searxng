const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL!;
const EMBEDDING_SERVICE_API_KEY = process.env.EMBEDDING_SERVICE_API_KEY || "none";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "jinaai/jina-embeddings-v5-omni-small-retrieval-GGUF:Q4_K_M";

function logEmbedding(message: string, data?: any): void {
  const ts = new Date().toISOString();
  const preview = typeof data === "string" ? data.substring(0, 200) : "";
  console.error(`[embedding-service:${ts}] ${message}${preview ? " | " + preview : ""}`);
}

interface EmbeddingRequest {
  input: string | string[];
  model: string;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  model: string;
  object: string;
}

export interface EmbeddingResult {
  embedding: number[];
}

export interface VisionEmbeddingResult {
  embedding: number[];
  prompt: string;
  time_eval: number;
  time_prompt: number;
  tokens_count: number;
}

export async function callTextEmbeddingService(
  input: string | string[],
): Promise<EmbeddingResult[]> {

  const url = `${EMBEDDING_SERVICE_URL}/embeddings`;
  const requestBody: EmbeddingRequest = {
    input,
    model: EMBEDDING_MODEL,
  };

  logEmbedding("TEXT EMBEDDING REQUEST", `url=${url} model=${EMBEDDING_MODEL} inputType=${typeof input} inputLen=${typeof input === "string" ? input.length : input.length}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${EMBEDDING_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error: any) {
    logEmbedding("TEXT EMBEDDING FETCH ERROR", `message=${error.message} code=${error.code} cause=${error.cause?.message}`);
    throw new Error(
      `Failed to call text embedding service at ${url}: ${error.message || "unknown error"} (code: ${error.code || "unknown"})`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "[Could not read response]");
    logEmbedding("TEXT EMBEDDING HTTP ERROR", `status=${response.status} statusText=${response.statusText} body=${body.substring(0, 300)}`);
    throw new Error(
      `Embedding service returned HTTP ${response.status}: ${body}`
    );
  }

  let data: EmbeddingResponse;
  try {
    data = (await response.json()) as EmbeddingResponse;
  } catch (error: any) {
    logEmbedding("TEXT EMBEDDING JSON PARSE ERROR", `message=${error.message}`);
    throw new Error(`Failed to parse text embedding response: ${error.message}`);
  }

  if (!Array.isArray(data.data)) {
    throw new Error("Embedding service returned invalid response: missing 'data' array");
  }

  logEmbedding("TEXT EMBEDDING SUCCESS", `results=${data.data.length}`);
  return data.data.map((d) => ({ embedding: d.embedding }));
}

export async function callVisionEmbeddingService(
  imageBase64: string,
  prompt?: string,
): Promise<VisionEmbeddingResult> {

  const url = `${EMBEDDING_SERVICE_URL}/embeddings`;
  const bodySize = imageBase64.length;
  const requestBody = {
    content: [
      {
        prompt_string: prompt || "<__media__>",
        multimodal_data: [imageBase64],
      },
    ],
    model: EMBEDDING_MODEL,
  };

  logEmbedding("VISION EMBEDDING REQUEST", `url=${url} model=${EMBEDDING_MODEL} imageBase64Size=${bodySize} prompt=${prompt || "<__media__>"}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${EMBEDDING_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error: any) {
    logEmbedding("VISION EMBEDDING FETCH ERROR", `message=${error.message} code=${error.code} cause=${error.cause?.message}`);
    throw new Error(
      `Failed to call vision embedding service at ${url}: ${error.message || "unknown error"} (code: ${error.code || "unknown"})`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "[Could not read response]");
    logEmbedding("VISION EMBEDDING HTTP ERROR", `status=${response.status} statusText=${response.statusText} body=${body.substring(0, 300)}`);
    throw new Error(
      `Embedding service returned HTTP ${response.status}: ${body}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (error: any) {
    logEmbedding("VISION EMBEDDING JSON PARSE ERROR", `message=${error.message}`);
    throw new Error(`Failed to parse vision embedding response: ${error.message}`);
  }

  if (!Array.isArray(data) || data.length === 0) {
    logEmbedding("VISION EMBEDDING INVALID RESPONSE", `isArray=${Array.isArray(data)} length=${Array.isArray(data) ? data.length : "N/A"}`);
    throw new Error("Embedding service returned invalid response: expected array with at least one result");
  }

  if (!data[0].embedding) {
    logEmbedding("VISION EMBEDDING MISSING EMBEDDING", `keys=${Object.keys(data[0]).join(",")}`);
    throw new Error("Embedding service returned invalid response: missing 'embedding' field");
  }

  logEmbedding("VISION EMBEDDING SUCCESS", `embeddingLen=${data[0].embedding.length} time_eval=${data[0].time_eval}`);
  return data[0] as VisionEmbeddingResult;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function downloadImageAsBase64(url: string): Promise<string> {
  logEmbedding("IMAGE DOWNLOAD", `url=${url}`);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: any) {
    logEmbedding("IMAGE DOWNLOAD FETCH ERROR", `url=${url} message=${error.message} code=${error.code}`);
    throw new Error(`Failed to download image from ${url}: ${error.message || "fetch failed"} (code: ${error.code || "unknown"})`);
  }

  if (!response.ok) {
    logEmbedding("IMAGE DOWNLOAD HTTP ERROR", `url=${url} status=${response.status}`);
    throw new Error(`Failed to download image from ${url}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  logEmbedding("IMAGE DOWNLOAD SUCCESS", `url=${url} size=${bytes.byteLength} bytes`);

  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
