const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL!;
const EMBEDDING_SERVICE_API_KEY = process.env.EMBEDDING_SERVICE_API_KEY || "none";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "jinaai/jina-embeddings-v5-omni-small-retrieval-GGUF:Q4_K_M";

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

  const requestBody: EmbeddingRequest = {
    input,
    model: EMBEDDING_MODEL,
  };

  const response = await fetch(`${EMBEDDING_SERVICE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_SERVICE_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "[Could not read response]");
    throw new Error(
      `Embedding service returned HTTP ${response.status}: ${body}`
    );
  }

  const data = (await response.json()) as EmbeddingResponse;

  if (!Array.isArray(data.data)) {
    throw new Error("Embedding service returned invalid response: missing 'data' array");
  }

  return data.data.map((d) => ({ embedding: d.embedding }));
}

export async function callVisionEmbeddingService(
  imageBase64: string,
  prompt?: string,
): Promise<VisionEmbeddingResult> {

  const response = await fetch(`${EMBEDDING_SERVICE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_SERVICE_API_KEY}`,
    },
    body: JSON.stringify({
      content: [
        {
          prompt_string: prompt || "<__media__>",
          multimodal_data: [imageBase64],
        },
      ],
      model: EMBEDDING_MODEL,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "[Could not read response]");
    throw new Error(
      `Embedding service returned HTTP ${response.status}: ${body}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Embedding service returned invalid response: expected array with at least one result");
  }

  if (!data[0].embedding) {
    throw new Error("Embedding service returned invalid response: missing 'embedding' field");
  }

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
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image from ${url}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
