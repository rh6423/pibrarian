import fs from "node:fs";
import path from "node:path";
import type { VisionConfig } from "../config";

/**
 * Load an image file and return base64 + mime type.
 */
export function loadImage(imagePath: string): { base64: string; mimeType: string } {
  const imgBuf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return { base64: imgBuf.toString("base64"), mimeType };
}

/**
 * Call an OpenAI-compatible vision endpoint.
 */
export async function queryVision(
  config: VisionConfig,
  imagePath: string,
  prompt: string,
  options?: { maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  const { base64, mimeType } = loadImage(imagePath);
  const url = `${config.baseUrl}/chat/completions`;

  const payload = {
    model: config.model,
    messages: [
      { role: "system" as const, content: "Be concise." },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: prompt },
          {
            type: "image_url" as const,
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    max_tokens: options?.maxTokens ?? 2000,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`Vision API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: [{ message: { content: string } }];
  };

  let content = (data.choices[0].message.content || "").trim();
  // Strip markdown code fences if present
  if (content.startsWith("```")) {
    content = content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
  }
  return content;
}
