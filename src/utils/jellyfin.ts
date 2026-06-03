import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { JellyfinConfig } from "../config";

// ── Jellyfin API ──────────────────────────────────────────────────────────────

interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  Overview?: string;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Genres?: string[];
  Studios?: Array<{ Name: string }>;
  People?: Array<{ Name: string; Role: string }>;
  ExternalIds?: { ImdbId?: string; TmdbId?: number; TvdbId?: number };
  MediaSources?: Array<{
    Container: string;
    Path: string;
    VideoCodec?: string;
    AudioCodec?: string;
    Bitrate?: number;
    Width?: number;
    Height?: number;
    Size?: number;
    Name: string;
  }>;
  UserData?: {
    Played: boolean;
    PlayedPercentage: number;
    Rating?: number;
    IsFavorite: boolean;
  };
  [key: string]: any;
}

function getBaseUrl(cfg: JellyfinConfig): string {
  return process.env.JELLYFIN_URL ?? cfg.baseUrl;
}

function getToken(cfg: JellyfinConfig): string {
  return process.env.JELLYFIN_API_KEY ?? cfg.apiKey;
}

export async function jellyfinRequest(
  cfg: JellyfinConfig,
  method: string,
  urlPath: string,
  body?: any,
): Promise<any> {
  const baseUrl = getBaseUrl(cfg);
  const token = getToken(cfg);
  const url = `${baseUrl}${urlPath}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["X-Emby-Token"] = token;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`Jellyfin API error: ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

export async function searchItems(
  cfg: JellyfinConfig,
  query: string,
  limit: number = 20,
  mediaType?: "movie" | "tv",
): Promise<JellyfinItem[]> {
  const userId = cfg.userId;
  if (!userId) throw new Error("Jellyfin: not authenticated. Run /pibrarian-jellyfin-login first.");

  const params = new URLSearchParams({
    UserId: userId,
    SearchTerm: query,
    Limit: String(limit),
    Recursive: "true",
    Fields: "ItemCounts,Overview,PrimaryImageAspectRatio,MediaSources",
  });

  if (mediaType === "movie") {
    params.set("IncludeItemTypes", "Movie");
  } else if (mediaType === "tv") {
    params.set("IncludeItemTypes", "Series,Episode");
  }

  const data = await jellyfinRequest(
    cfg,
    "GET",
    `/Users/${userId}/Items?${params}`,
  );
  return data?.Items || [];
}

export async function listItems(
  cfg: JellyfinConfig,
  options: {
    type?: "movies" | "shows" | "episodes" | "seasons" | "collections";
    parentId?: string;
    year?: string;
    genre?: string;
    minRating?: number;
    sort?: string;
    order?: "Asc" | "Desc";
    limit?: number;
  } = {},
): Promise<JellyfinItem[]> {
  const userId = cfg.userId;
  if (!userId) throw new Error("Jellyfin: not authenticated. Run /pibrarian-jellyfin-login first.");

  const typeMap: Record<string, string> = {
    movies: "Movie",
    shows: "Series",
    seasons: "Season",
    episodes: "Episode",
    collections: "Boxset",
  };

  const params = new URLSearchParams({
    UserId: userId,
    Recursive: "true",
    Fields: "ItemCounts,MediaSources,Overview,PrimaryImageAspectRatio,Path,Genres,Studios,People,ExternalIds",
  });

  if (options.type && typeMap[options.type]) {
    params.set("IncludeItemTypes", typeMap[options.type]);
  }
  if (options.parentId) params.set("ParentId", options.parentId);
  if (options.year) params.set("Years", options.year);
  if (options.genre) params.set("Genres", options.genre);
  if (options.minRating) params.set("MinCommunityRating", String(options.minRating));
  if (options.sort) params.set("SortBy", options.sort);
  if (options.order) params.set("SortOrder", options.order);
  if (options.limit) params.set("Limit", String(options.limit));

  const data = await jellyfinRequest(cfg, "GET", `/Items?${params}`);
  return data?.Items || [];
}

export async function getItemDetails(
  cfg: JellyfinConfig,
  itemId: string,
): Promise<JellyfinItem> {
  const userId = cfg.userId;
  if (!userId) throw new Error("Jellyfin: not authenticated. Run /pibrarian-jellyfin-login first.");

  return jellyfinRequest(cfg, "GET", `/Users/${userId}/Items/${itemId}`);
}

export async function downloadItem(
  cfg: JellyfinConfig,
  itemId: string,
  outputPath: string,
): Promise<string> {
  const token = getToken(cfg);
  const baseUrl = getBaseUrl(cfg);
  const streamUrl = `${baseUrl}/Videos/${itemId}/stream?api_key=${token}&Static=true`;

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Download via curl (handles large files better than fetch)
  try {
    execSync(
      `curl -f -s -L -o "${outputPath}" "${streamUrl}"`,
      { stdio: "pipe", timeout: 300_000 },
    );
  } catch (e: any) {
    throw new Error(
      `Download failed: ${e.stderr?.toString().trim().slice(-200) || e.message}`,
    );
  }

  const size = fs.statSync(outputPath).size;
  return outputPath;
}

// ── FFmpeg helpers ────────────────────────────────────────────────────────────

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

export function parseTimestamp(ts: string | number): number {
  if (typeof ts === "number") return ts;
  const parts = ts.split(":").map(Number);
  if (parts.some(isNaN)) return parseFloat(ts);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(ts);
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function probeMedia(file: string): any {
  const raw = execSync(
    `${FFPROBE} -v quiet -print_format json -show_format -show_streams "${file}"`,
    { encoding: "utf-8" },
  );
  return JSON.parse(raw);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().slice(-500)));
    });
  });
}

export async function extractClip(
  inputPath: string,
  outputPath: string,
  start: string | number,
  end?: string | number,
  duration?: number,
  codec: string = "copy",
): Promise<string> {
  const startSec = parseTimestamp(start);
  const args = ["-ss", String(startSec), "-i", inputPath];

  if (duration) {
    args.push("-t", String(duration));
  } else if (end) {
    const endSec = parseTimestamp(end);
    args.push("-to", String(endSec));
  }

  args.push("-c", codec, "-y", outputPath);

  await runFfmpeg(args);
  return outputPath;
}

export async function extractFrames(
  inputPath: string,
  outputDir: string,
  options: {
    start?: string | number;
    end?: string | number;
    count?: number;
    interval?: number;
    format?: "png" | "jpg";
  } = {},
): Promise<string[]> {
  const ext = options.format === "jpg" ? "jpg" : "png";
  const format = options.format === "jpg" ? "mjpeg" : "png";
  const base = path.basename(inputPath, path.extname(inputPath));
  const frames: string[] = [];

  if (options.start && options.count === 1) {
    // Single frame at timestamp
    const startSec = parseTimestamp(options.start);
    const outPath = path.join(outputDir, `${base}_frame_001.${ext}`);
    await runFfmpeg([
      "-ss",
      String(startSec),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outPath,
    ]);
    frames.push(outPath);
  } else if (options.start && options.end) {
    // Extract frames between start and end
    const startSec = parseTimestamp(options.start);
    const endSec = parseTimestamp(options.end);
    const totalSec = endSec - startSec;
    const count = options.count || 5;
    const interval = totalSec / count;

    for (let i = 0; i < count; i++) {
      const time = startSec + i * interval;
      const outPath = path.join(
        outputDir,
        `${base}_frame_${String(i + 1).padStart(3, "0")}.${ext}`,
      );
      await runFfmpeg([
        "-ss",
        String(time),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        outPath,
      ]);
      frames.push(outPath);
    }
  } else {
    // Evenly spaced across entire video
    const info = probeMedia(inputPath);
    const totalSec = parseFloat(info.format.duration);
    const count = options.count || 5;
    const interval = totalSec / count;

    for (let i = 0; i < count; i++) {
      const time = i * interval;
      const outPath = path.join(
        outputDir,
        `${base}_frame_${String(i + 1).padStart(3, "0")}.${ext}`,
      );
      await runFfmpeg([
        "-ss",
        String(time),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        outPath,
      ]);
      frames.push(outPath);
    }
  }

  return frames;
}

// ── Item formatting ──────────────────────────────────────────────────────────

export function formatItemLine(item: JellyfinItem): string {
  const type = item.Type || "?";
  const year = item.ProductionYear || "";
  const runtime = item.RunTimeTicks
    ? Math.round(item.RunTimeTicks / 600000000)
    : "";
  const rating = item.CommunityRating
    ? item.CommunityRating.toFixed(1)
    : "";
  const playedPct = item.UserData?.PlayedPercentage;
  const played = playedPct && playedPct > 0 ? ` [${playedPct}%]` : "";
  const parent = item.SeriesName || "";

  let line = `  ${item.Id}  ${item.Name}`;
  if (parent) line += ` (${parent})`;
  line += `  [${type}${year ? " " + year : ""}${runtime ? " " + runtime + "m" : ""}${rating ? " ★" + rating : ""}${played}]`;
  if (item.OfficialRating) line += ` ${item.OfficialRating}`;
  return line;
}

export function formatItemDetails(item: JellyfinItem): string {
  const lines: string[] = [];
  lines.push(`Name:        ${item.Name}`);
  lines.push(`Type:        ${item.Type}`);
  lines.push(`ID:          ${item.Id}`);
  if (item.ProductionYear) lines.push(`Year:        ${item.ProductionYear}`);
  if (item.PremiereDate) lines.push(`Premiere:    ${item.PremiereDate}`);
  if (item.OfficialRating) lines.push(`Rating:      ${item.OfficialRating}`);
  if (item.CommunityRating)
    lines.push(`Community:   ${item.CommunityRating.toFixed(1)}`);
  if (item.RunTimeTicks) {
    const runtime = Math.round(item.RunTimeTicks / 600000000);
    lines.push(`Runtime:     ${runtime}m`);
  }
  if (item.SeriesName) lines.push(`Series:      ${item.SeriesName}`);
  if (item.ParentIndexNumber)
    lines.push(`Season:      ${item.ParentIndexNumber}`);
  if (item.IndexNumber) lines.push(`Episode:     ${item.IndexNumber}`);
  if (item.Overview)
    lines.push(`Overview:    ${item.Overview.replace(/\n/g, " ")}`);

  if (item.Genres?.length)
    lines.push(`Genres:      ${item.Genres.join(", ")}`);
  if (item.Studios?.length)
    lines.push(
      `Studios:     ${item.Studios.map((s: any) => s.Name).join(", ")}`,
    );
  if (item.People?.length) {
    const byRole: Record<string, string[]> = {};
    for (const p of item.People) {
      if (!byRole[p.Role]) byRole[p.Role] = [];
      byRole[p.Role].push(p.Name);
    }
    for (const [role, names] of Object.entries(byRole)) {
      lines.push(`  ${role}:    ${names.join(", ")}`);
    }
  }

  if (item.ExternalIds) {
    const ids: string[] = [];
    if (item.ExternalIds.ImdbId)
      ids.push(`IMDb: tt${item.ExternalIds.ImdbId}`);
    if (item.ExternalIds.TmdbId)
      ids.push(`TMDB: ${item.ExternalIds.TmdbId}`);
    if (item.ExternalIds.TvdbId)
      ids.push(`TVDB: ${item.ExternalIds.TvdbId}`);
    if (ids.length) lines.push(`External:    ${ids.join(", ")}`);
  }

  if (item.MediaSources?.[0]) {
    const ms = item.MediaSources[0];
    lines.push(`Path:        ${ms.Path}`);
    lines.push(
      `Format:      ${ms.Container} / ${ms.VideoCodec || ms.AudioCodec || "N/A"}`,
    );
    if (ms.Bitrate)
      lines.push(`Bitrate:     ${(ms.Bitrate / 1000000).toFixed(1)} Mbps`);
    if (ms.Width) lines.push(`Resolution:  ${ms.Width}x${ms.Height}`);
    if (ms.Size)
      lines.push(`Size:        ${(ms.Size / 1024 / 1024 / 1024).toFixed(1)} GB`);
  }

  if (item.UserData) {
    const ud = item.UserData;
    const played = ud.Played ? "Yes" : "No";
    const pct = ud.PlayedPercentage > 0 ? ` (${ud.PlayedPercentage}%)` : "";
    lines.push(`Played:      ${played}${pct}`);
    if (ud.Rating) lines.push(`User rating: ${ud.Rating}/10`);
    lines.push(`Favorite:    ${ud.IsFavorite ? "Yes" : "No"}`);
  }

  return lines.join("\n");
}
