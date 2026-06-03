import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import type { JellyfinConfig, SceneDetectConfig } from "../config";
import {
  searchItems,
  listItems,
  getItemDetails,
  downloadItem,
  extractClip,
  extractFrames,
  formatItemLine,
  formatItemDetails,
  formatSize,
  probeMedia,
  parseTimestamp,
} from "../utils/jellyfin";
import {
  isSceneDetectAvailable,
  detectScenesWithFfmpeg,
  detectScenesWithPySceneDetect,
  saveSceneFramesWithFfmpeg,
  saveSceneImagesWithPySceneDetect,
  splitVideoWithFfmpeg,
  splitVideoWithPySceneDetect,
  formatScenes,
} from "../utils/scenedetect";

type MediaType = "movie" | "tv" | "any";

/**
 * Media domain — unified Jellyfin library + ffmpeg scene processing.
 *
 * Covers movies, TV shows, and episodes under a single toolset.
 * Jellyfin tools use media_type to target the right library.
 * Scene extraction tools operate on local video files (media-agnostic).
 */

export function createMediaTools(
  jellyfinConfig: JellyfinConfig,
  sceneDetectConfig: SceneDetectConfig,
  defaultDownloadDir: string,
): ToolDefinition<any, any>[] {
  return [
    // ── Search ──────────────────────────────────────────────────────────
    {
      name: "pibrarian_media_search",
      label: "Search Media",
      description:
        "Search the media library by title, genre, year, actor, or description. Searches movies, TV shows, or both.",
      promptSnippet: "Search movies and TV shows by title, genre, year, actor, or description",
      promptGuidelines: [
        "Use pibrarian_media_search to find movies or TV shows. Set media_type to 'movie', 'tv', or 'any' (default).",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search query — title, genre, year, actor, or natural language description",
        }),
        media_type: Type.Optional(
          Type.Enum({ movie: "movie", tv: "tv", any: "any" }, {
            description: "Filter by media type. Default: 'any' (search both)",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 20)" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const mediaType = params.media_type || "any";
        const items = await searchItems(
          jellyfinConfig,
          params.query,
          params.limit ?? 20,
          mediaType === "any" ? undefined : mediaType,
        );
        if (signal?.aborted) throw new Error("Aborted");

        if (items.length === 0) return { content: [{ type: "text", text: "No results found." }] };

        const lines = [
          `Found ${items.length} result(s):`,
          ...items.map((item) => formatItemLine(item)),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── List ────────────────────────────────────────────────────────────
    {
      name: "pibrarian_media_list",
      label: "List Media",
      description:
        "List movies or TV shows from the library with optional filters (year, genre, rating, sort).",
      promptSnippet: "List movies or TV shows with filters",
      promptGuidelines: [
        "Use pibrarian_media_list to browse the library. Set media_type to 'movie' or 'tv'.",
      ],
      parameters: Type.Object({
        media_type: Type.Enum({ movie: "movie", tv: "tv" }, {
          description: "'movie' to list films, 'tv' to list series",
        }),
        year: Type.Optional(
          Type.String({ description: "Filter by year (e.g. '1995')" }),
        ),
        genre: Type.Optional(
          Type.String({ description: "Filter by genre (e.g. 'sci-fi')" }),
        ),
        min_rating: Type.Optional(
          Type.Number({ description: "Minimum community rating (0-10)" }),
        ),
        sort: Type.Optional(
          Type.String({
            description: "Sort field (Name, Year, CommunityRating, etc.)",
          }),
        ),
        order: Type.Optional(
          Type.String({ description: "Sort order: Asc or Desc" }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 50)" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const items = await listItems(jellyfinConfig, {
          type: params.media_type === "movie" ? "movies" : "shows",
          year: params.year,
          genre: params.genre,
          minRating: params.min_rating,
          sort: params.sort,
          order: params.order as "Asc" | "Desc" | undefined,
          limit: params.limit ?? 50,
        });
        if (signal?.aborted) throw new Error("Aborted");

        if (items.length === 0)
          return { content: [{ type: "text", text: `No ${params.media_type === "movie" ? "movies" : "shows"} found.` }] };

        const label = params.media_type === "movie" ? "movie(s)" : "show(s)";
        const lines = [
          `Found ${items.length} ${label}:`,
          ...items.map((item) => formatItemLine(item)),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── List Episodes ───────────────────────────────────────────────────
    {
      name: "pibrarian_media_list_episodes",
      label: "List Episodes",
      description:
        "List episodes for a TV show or specific season.",
      promptSnippet: "List episodes for a TV show or season",
      promptGuidelines: [
        "Use pibrarian_media_list_episodes to see episodes of a TV series.",
      ],
      parameters: Type.Object({
        series_id: Type.String({
          description: "Jellyfin series ID",
        }),
        season: Type.Optional(
          Type.Number({
            description: "Season number (omit for all seasons)",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 100)" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const items = await listItems(jellyfinConfig, {
          type: "episodes",
          parentId: params.series_id,
          limit: params.limit ?? 100,
        });
        if (signal?.aborted) throw new Error("Aborted");

        const filtered = params.season
          ? items.filter((i) => i.ParentIndexNumber === params.season)
          : items;

        if (filtered.length === 0)
          return { content: [{ type: "text", text: "No episodes found." }] };

        const lines = [
          `Found ${filtered.length} episode(s):`,
          ...filtered.map((item) => formatItemLine(item)),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── Details ─────────────────────────────────────────────────────────
    {
      name: "pibrarian_media_details",
      label: "Media Details",
      description:
        "Get full metadata for any media item — movie, TV show, or episode (title, year, genre, rating, cast, external IDs).",
      promptSnippet: "Get metadata for a movie, TV show, or episode",
      promptGuidelines: [
        "Use pibrarian_media_details to look up metadata for any item by its Jellyfin ID.",
      ],
      parameters: Type.Object({
        item_id: Type.String({ description: "Jellyfin item ID" }),
      }),
      async execute(_toolCallId, params, signal) {
        const item = await getItemDetails(jellyfinConfig, params.item_id);
        if (signal?.aborted) throw new Error("Aborted");
        return {
          content: [{ type: "text", text: formatItemDetails(item) }],
        };
      },
    },

    // ── Download ────────────────────────────────────────────────────────
    {
      name: "pibrarian_media_download",
      label: "Download Media",
      description:
        "Download a movie or TV episode from Jellyfin to local disk for processing.",
      promptSnippet: "Download a movie or episode file from Jellyfin",
      promptGuidelines: [
        "Use pibrarian_media_download to download media for local processing.",
      ],
      parameters: Type.Object({
        item_id: Type.String({ description: "Jellyfin item ID" }),
        output_dir: Type.Optional(
          Type.String({
            description: "Output directory (default: ~/pibrarian/downloads)",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const item = await getItemDetails(jellyfinConfig, params.item_id);
        if (signal?.aborted) throw new Error("Aborted");

        const ms = item.MediaSources?.[0];
        if (!ms) {
          return {
            content: [
              { type: "text", text: "No media source found for this item." },
            ],
            isError: true,
          };
        }

        const ext = ms.Container || "mp4";
        let filename: string;

        if (item.SeriesName) {
          // TV episode
          const safeSeries = item.SeriesName.replace(/[^a-zA-Z0-9\s\-_.]/g, "").replace(/\s+/g, "-");
          const s = String(item.ParentIndexNumber || 1).padStart(2, "0");
          const e = String(item.IndexNumber || 1).padStart(2, "0");
          filename = `${safeSeries}-S${s}E${e}.${ext}`;
        } else {
          // Movie
          filename = item.Name.replace(/[^a-zA-Z0-9\s\-_.]/g, "").replace(/\s+/g, "-");
          if (item.ProductionYear) filename += `-${item.ProductionYear}`;
          filename += `.${ext}`;
        }

        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : defaultDownloadDir;
        const outPath = path.join(outDir, filename);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Downloading ${item.Name} (${formatSize(ms.Size || 0)})...`,
            },
          ],
        });

        await downloadItem(jellyfinConfig, params.item_id, outPath);
        if (signal?.aborted) throw new Error("Aborted");

        const size = fs.statSync(outPath).size;
        return {
          content: [
            {
              type: "text",
              text: `Downloaded: ${outPath}\nSize: ${formatSize(size)}`,
            },
          ],
        };
      },
    },

    // ── Extract Scene ───────────────────────────────────────────────────
    {
      name: "pibrarian_media_extract_scene",
      label: "Extract Scene",
      description:
        "Extract a scene/clip from a video file at specific timestamps. Accepts start:end format (e.g. '1:30:00' to '2:15:30'). Uses ffmpeg for fast stream copy or precise re-encode.",
      promptSnippet: "Extract a scene clip from a video file at specific timestamps",
      promptGuidelines: [
        "Use pibrarian_media_extract_scene to cut a clip from any video file.",
        "Timestamps accept HH:MM:SS, MM:SS, or plain seconds.",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the video file on disk",
        }),
        start: Type.String({
          description:
            "Start timestamp (e.g. '1:30:00', '90', '1:30')",
        }),
        end: Type.String({
          description:
            "End timestamp (e.g. '2:15:30', '150', '2:15')",
        }),
        output_dir: Type.Optional(
          Type.String({
            description:
              "Output directory (default: same as input file)",
          }),
        ),
        codec: Type.Optional(
          Type.String({
            description:
              "Codec: 'copy' for fast stream copy (may lose frames), 'libx264' for precise re-encode",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${inputPath}` },
            ],
            isError: true,
          };
        }

        const info = probeMedia(inputPath);
        const totalSec = parseFloat(info.format.duration);
        const startSec = parseTimestamp(params.start);
        const endSec = parseTimestamp(params.end);

        if (startSec >= endSec) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid range: start (${startSec}s) must be before end (${endSec}s)`,
              },
            ],
            isError: true,
          };
        }

        if (endSec > totalSec) {
          return {
            content: [
              {
                type: "text",
                text: `End time (${endSec}s) exceeds video duration (${totalSec.toFixed(1)}s)`,
              },
            ],
            isError: true,
          };
        }

        const base = path.basename(inputPath, path.extname(inputPath));
        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : path.dirname(inputPath);
        const outPath = path.join(
          outDir,
          `${base}_scene_${params.start.replace(/[:.]/g, "_")}_to_${params.end.replace(/[:.]/g, "_")}.mp4`,
        );

        const codec = params.codec || "copy";
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Extracting scene ${params.start} → ${params.end} (${(endSec - startSec).toFixed(0)}s) with codec=${codec}...`,
            },
          ],
        });

        await extractClip(inputPath, outPath, params.start, params.end, undefined, codec);
        if (signal?.aborted) throw new Error("Aborted");

        const size = fs.statSync(outPath).size;
        return {
          content: [
            {
              type: "text",
              text: `Scene extracted: ${outPath}\nDuration: ${(endSec - startSec).toFixed(1)}s\nSize: ${formatSize(size)}\nCodec: ${codec}`,
            },
          ],
        };
      },
    },

    // ── Extract Frames ──────────────────────────────────────────────────
    {
      name: "pibrarian_media_extract_frames",
      label: "Extract Frames",
      description:
        "Extract frames from a video file. Can extract evenly across the full video, or within a scene range (start to end).",
      promptSnippet: "Extract frames from a video file, optionally within a time range",
      promptGuidelines: [
        "Use pibrarian_media_extract_frames to pull still frames from any video.",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the video file on disk",
        }),
        start: Type.Optional(
          Type.String({
            description:
              "Start timestamp for range (e.g. '1:30:00')",
          }),
        ),
        end: Type.Optional(
          Type.String({
            description:
              "End timestamp for range (e.g. '2:15:30')",
          }),
        ),
        count: Type.Optional(
          Type.Number({
            description:
              "Number of frames to extract (default 5)",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description:
              "Output directory (default: same as input file)",
          }),
        ),
        format: Type.Optional(
          Type.String({
            description: "Image format: 'png' or 'jpg' (default: png)",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${inputPath}` },
            ],
            isError: true,
          };
        }

        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : path.dirname(inputPath);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Extracting ${params.count || 5} frames...`,
            },
          ],
        });

        const frames = await extractFrames(inputPath, outDir, {
          start: params.start,
          end: params.end,
          count: params.count ?? 5,
          format: (params.format as "png" | "jpg") || "png",
        });
        if (signal?.aborted) throw new Error("Aborted");

        const lines = [
          `Extracted ${frames.length} frame(s):`,
          ...frames.map((f) => `  ${f}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── Detect Scenes ───────────────────────────────────────────────────
    {
      name: "pibrarian_media_detect_scenes",
      label: "Detect Scenes",
      description:
        "Automatically detect scene cuts in a video file. Uses ffmpeg by default (fast, no extra deps). Set use_scenedetect=true for PySceneDetect (higher accuracy, requires setup).",
      promptSnippet: "Detect scene cuts in a video file automatically",
      promptGuidelines: [
        "Use pibrarian_media_detect_scenes to find scene boundaries in any video file.",
        "Default uses ffmpeg — fast and requires no setup. For higher accuracy, set use_scenedetect=true (requires PySceneDetect venv).",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the video file on disk",
        }),
        threshold: Type.Optional(
          Type.Number({
            description:
              "Detection sensitivity. ffmpeg: 0.3-0.6 (default 0.4). PySceneDetect: 23-40 (default 32)",
          }),
        ),
        min_scene_length: Type.Optional(
          Type.String({
            description: "Minimum scene length (e.g. '2s', '0.6s')",
          }),
        ),
        use_scenedetect: Type.Optional(
          Type.Boolean({
            description: "Use PySceneDetect instead of ffmpeg for higher accuracy (requires venv setup). Default: false",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description: "Output directory for CSV report",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${inputPath}` },
            ],
            isError: true,
          };
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Detecting scenes in ${path.basename(inputPath)}...`,
            },
          ],
        });

        let scenes;
        if (params.use_scenedetect) {
          if (!isSceneDetectAvailable(sceneDetectConfig)) {
            return {
              content: [
                {
                  type: "text",
                  text: "PySceneDetect not available. Set up a venv first, or omit use_scenedetect to use ffmpeg (default).",
                },
              ],
              isError: true,
            };
          }
          scenes = await detectScenesWithPySceneDetect(sceneDetectConfig, inputPath, {
            threshold: params.threshold,
            minSceneLength: params.min_scene_length,
            outputDir: params.output_dir ? path.resolve(params.output_dir) : undefined,
          });
        } else {
          scenes = detectScenesWithFfmpeg(inputPath, {
            threshold: params.threshold,
            minSceneDuration: params.min_scene_length ? parseFloat(params.min_scene_length) : undefined,
          });
        }
        if (signal?.aborted) throw new Error("Aborted");

        return {
          content: [{ type: "text", text: formatScenes(scenes) }],
        };
      },
    },

    // ── Save Scene Images ───────────────────────────────────────────────
    {
      name: "pibrarian_media_save_scene_images",
      label: "Save Scene Images",
      description:
        "Detect scenes and save representative frames from each scene. Uses ffmpeg by default. Set use_scenedetect=true for PySceneDetect.",
      promptSnippet: "Save still frames from each detected scene in a video",
      promptGuidelines: [
        "Use pibrarian_media_save_scene_images to get still frames from every scene.",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the video file on disk",
        }),
        threshold: Type.Optional(
          Type.Number({
            description: "Detection sensitivity. ffmpeg: 0.3-0.6 (default 0.4). PySceneDetect: 23-40 (default 32)",
          }),
        ),
        frames_per_scene: Type.Optional(
          Type.Number({
            description: "Number of frames per scene (default 1)",
          }),
        ),
        format: Type.Optional(
          Type.String({
            description: "Image format: 'png' or 'jpg' (default: jpg)",
          }),
        ),
        use_scenedetect: Type.Optional(
          Type.Boolean({
            description: "Use PySceneDetect for detection (requires venv setup). Default: false",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description: "Output directory for images",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${inputPath}` },
            ],
            isError: true,
          };
        }

        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : path.dirname(inputPath);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Detecting scenes and saving frames...`,
            },
          ],
        });

        let images;
        if (params.use_scenedetect) {
          if (!isSceneDetectAvailable(sceneDetectConfig)) {
            return {
              content: [
                {
                  type: "text",
                  text: "PySceneDetect not available. Omit use_scenedetect to use ffmpeg (default).",
                },
              ],
              isError: true,
            };
          }
          images = await saveSceneImagesWithPySceneDetect(sceneDetectConfig, inputPath, {
            threshold: params.threshold,
            framesPerScene: params.frames_per_scene ?? 3,
            format: (params.format as "png" | "jpg") || "jpg",
            outputDir: outDir,
          });
        } else {
          images = saveSceneFramesWithFfmpeg(inputPath, outDir, {
            threshold: params.threshold,
            format: (params.format as "png" | "jpg") || "jpg",
            framesPerScene: params.frames_per_scene ?? 1,
          });
        }
        if (signal?.aborted) throw new Error("Aborted");

        const lines = [
          `Saved ${images.length} image(s):`,
          ...images.map((f) => `  ${f}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── Split Into Scenes ───────────────────────────────────────────────
    {
      name: "pibrarian_media_split_scenes",
      label: "Split Into Scenes",
      description:
        "Detect scenes and split the video into individual scene clips. Uses ffmpeg by default. Set use_scenedetect=true for PySceneDetect.",
      promptSnippet: "Split a video into individual scene clips",
      promptGuidelines: [
        "Use pibrarian_media_split_scenes to cut a video into separate scene files.",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the video file on disk",
        }),
        threshold: Type.Optional(
          Type.Number({
            description: "Detection sensitivity. ffmpeg: 0.3-0.6 (default 0.4). PySceneDetect: 23-40 (default 32)",
          }),
        ),
        use_scenedetect: Type.Optional(
          Type.Boolean({
            description: "Use PySceneDetect for detection (requires venv setup). Default: false",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description: "Output directory for clips",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${inputPath}` },
            ],
            isError: true,
          };
        }

        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : path.dirname(inputPath);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Detecting scenes and splitting video...`,
            },
          ],
        });

        let clips;
        if (params.use_scenedetect) {
          if (!isSceneDetectAvailable(sceneDetectConfig)) {
            return {
              content: [
                {
                  type: "text",
                  text: "PySceneDetect not available. Omit use_scenedetect to use ffmpeg (default).",
                },
              ],
              isError: true,
            };
          }
          clips = await splitVideoWithPySceneDetect(sceneDetectConfig, inputPath, {
            threshold: params.threshold,
            outputDir: outDir,
          });
        } else {
          clips = splitVideoWithFfmpeg(inputPath, outDir, {
            threshold: params.threshold,
          });
        }
        if (signal?.aborted) throw new Error("Aborted");

        const lines = [
          `Split into ${clips.length} clip(s):`,
          ...clips.map((f) => `  ${f}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
  ];
}
