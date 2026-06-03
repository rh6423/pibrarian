import type { EmbeddingConfig } from "../config";

/**
 * Call an OpenAI-compatible embeddings endpoint.
 */
export async function getEmbedding(
  config: EmbeddingConfig,
  text: string,
  options?: { signal?: AbortSignal },
): Promise<number[]> {
  const url = `${config.baseUrl}/embeddings`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: text,
    }),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    data: [{ embedding: number[] }];
  };

  return data.data[0].embedding;
}

/**
 * Batch embeddings.
 */
export async function getEmbeddings(
  config: EmbeddingConfig,
  texts: string[],
  options?: { signal?: AbortSignal },
): Promise<number[][]> {
  const url = `${config.baseUrl}/embeddings`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: texts,
    }),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    data: [{ embedding: number[] }];
  };

  return data.data.map((d) => d.embedding);
}
