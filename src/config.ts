import fs from "node:fs";
import path from "node:path";

/**
 * Config loading with three-tier precedence:
 *   1. Environment variables (highest)
 *   2. Extension config file (~/.pi/agent/extensions/pibrarian/config.json)
 *   3. Pi's current model (ctx.model.baseUrl + ctx.model.id) — lowest
 */

export interface VisionConfig {
  baseUrl: string;
  model: string;
}

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
}

export interface CalibreConfig {
  opdsUrl: string;
  username?: string;
  password?: string;
}

export interface JellyfinConfig {
  baseUrl: string;
  apiKey: string;
  userId?: string;
  token?: string;
}

export interface SceneDetectConfig {
  /** Path to Python venv with scenedetect installed. Empty = not set up yet. */
  venvPath: string;
  /** Which python binary to use when creating the venv (e.g. 'python3.12'). */
  pythonBinary: string;
}

export interface PibrarianConfig {
  vision: VisionConfig;
  embedding: EmbeddingConfig;
  calibre: CalibreConfig;
  jellyfin: JellyfinConfig;
  sceneDetect: SceneDetectConfig;
}

// Raw config from file (optional fields)
interface RawConfig {
  vision?: Partial<VisionConfig>;
  embedding?: Partial<EmbeddingConfig>;
  calibre?: Partial<CalibreConfig>;
  jellyfin?: Partial<JellyfinConfig>;
  jellyfin_auth?: { userId?: string; token?: string };
  scene_detect?: Partial<SceneDetectConfig>;
}

const CONFIG_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "config.json",
);

/**
 * Load config from file if it exists.
 */
function loadFileConfig(): RawConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as RawConfig;
  } catch {
    return {};
  }
}

/**
 * Write partial config to file, merging with existing values.
 */
export function writeConfig(partial: Partial<RawConfig>): void {
  const existing = loadFileConfig();
  const merged = Object.assign({}, existing, partial);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Resolve vision config with precedence: env > file > pi model.
 */
export function resolveVisionConfig(ctxModelBaseUrl: string, ctxModelId: string): VisionConfig {
  const file = loadFileConfig().vision ?? {};

  return {
    baseUrl: process.env.PIBRARIAN_VISION_BASE_URL ?? file.baseUrl ?? ctxModelBaseUrl,
    model: process.env.PIBRARIAN_VISION_MODEL ?? file.model ?? ctxModelId,
  };
}

/**
 * Resolve embedding config with precedence: env > file > pi model.
 */
export function resolveEmbeddingConfig(ctxModelBaseUrl: string, ctxModelId: string): EmbeddingConfig {
  const file = loadFileConfig().embedding ?? {};

  return {
    baseUrl: process.env.PIBRARIAN_EMBEDDING_BASE_URL ?? file.baseUrl ?? ctxModelBaseUrl,
    model: process.env.PIBRARIAN_EMBEDDING_MODEL ?? file.model ?? ctxModelId,
  };
}

/**
 * Resolve Calibre config with precedence: env > file > default.
 */
export function resolveCalibreConfig(): CalibreConfig {
  const file = loadFileConfig().calibre ?? {};

  return {
    opdsUrl: process.env.PIBRARIAN_CALIBRE_URL ?? file.opdsUrl ?? "http://127.0.0.1:8080",
    username: process.env.PIBRARIAN_CALIBRE_USERNAME ?? file.username ?? undefined,
    password: process.env.PIBRARIAN_CALIBRE_PASSWORD ?? file.password ?? undefined,
  };
}

/**
 * Resolve Jellyfin config with precedence: env > file > default.
 */
export function resolveJellyfinConfig(): JellyfinConfig {
  const file = loadFileConfig().jellyfin ?? {};
  const auth = loadFileConfig().jellyfin_auth ?? {};

  return {
    baseUrl: process.env.PIBRARIAN_JELLYFIN_URL ?? file.baseUrl ?? "http://localhost:8096",
    apiKey: process.env.PIBRARIAN_JELLYFIN_API_KEY ?? file.apiKey ?? "",
    userId: process.env.PIBRARIAN_JELLYFIN_USER_ID ?? auth.userId ?? file.userId ?? undefined,
    token: process.env.PIBRARIAN_JELLYFIN_TOKEN ?? auth.token ?? file.token ?? undefined,
  };
}

export function saveJellyfinAuth(userId: string, token: string): void {
  writeConfig({ jellyfin_auth: { userId, token } });
}

/**
 * Resolve scenedetect config with precedence: env > file > default.
 */
export function resolveSceneDetectConfig(): SceneDetectConfig {
  const file = loadFileConfig().scene_detect ?? {};

  return {
    venvPath: process.env.PIBRARIAN_SCENEDETECT_VENV ?? file.venvPath ?? "",
    pythonBinary: process.env.PIBRARIAN_SCENEDETECT_PYTHON ?? file.pythonBinary ?? "python3.12",
  };
}

/**
 * Build full config from pi model defaults.
 */
export function loadConfig(ctxModelBaseUrl: string, ctxModelId: string): PibrarianConfig {
  return {
    vision: resolveVisionConfig(ctxModelBaseUrl, ctxModelId),
    embedding: resolveEmbeddingConfig(ctxModelBaseUrl, ctxModelId),
    calibre: resolveCalibreConfig(),
    jellyfin: resolveJellyfinConfig(),
    sceneDetect: resolveSceneDetectConfig(),
  };
}
