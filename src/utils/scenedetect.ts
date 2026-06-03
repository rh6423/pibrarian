import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { SceneDetectConfig } from "../config";

// ── Shared types ─────────────────────────────────────────────────────────────

export interface SceneInfo {
  scene: number;
  start: string;   // HH:MM:SS.mmm
  end: string;     // HH:MM:SS.mmm
  duration: string; // seconds
  frames: number;
}

// ── FFmpeg-based scene detection (default) ───────────────────────────────────

/**
 * Run ffprobe to get total frame count and fps.
 */
function getVideoInfo(inputPath: string): { fps: number; totalFrames: number; duration: number } {
  const output = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -show_entries format=duration -of json "${inputPath}"`,
    { encoding: "utf-8" },
  );
  const json = JSON.parse(output);
  const rFrameRate = json.streams?.[0]?.r_frame_rate || "30/1";
  const [num, den] = rFrameRate.split("/").map(Number);
  const fps = num / (den || 1);
  const duration = parseFloat(json.format?.duration || "0");
  return { fps, totalFrames: Math.round(duration * fps), duration };
}

/**
 * Detect scene cuts using ffmpeg's scene filter.
 * Parses the luma score from showinfo output to find frames where scene change exceeds threshold.
 *
 * @param threshold 0.0-1.0 — scene change sensitivity (default 0.4, range 0.3-0.6)
 */
export function detectScenesWithFfmpeg(
  inputPath: string,
  options: {
    threshold?: number;
    minSceneDuration?: number; // seconds, default 2
  } = {},
): SceneInfo[] {
  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`File not found: ${absInput}`);
  }

  const threshold = options.threshold ?? 0.4;
  const minSceneDuration = options.minSceneDuration ?? 2;
  const { fps, duration } = getVideoInfo(absInput);

  // Use ffmpeg's scene filter + showinfo to find frames where scene change exceeds threshold
  // showinfo outputs lines with "pts_time:VALUE" for each selected frame
  const filter = `select='gt(scene,${threshold})',showinfo`;
  const output = execSync(
    `ffmpeg -i "${absInput}" -vf "${filter}" -f null - 2>&1`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );

  // Parse scene change timestamps from showinfo output
  // Each line with pts_time corresponds to a frame where scene change > threshold
  const sceneChangeTimes: number[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const ptsMatch = line.match(/pts_time:([\d.]+)/);
    if (ptsMatch) {
      const pts = parseFloat(ptsMatch[1]);
      // Deduplicate: skip if too close to last entry
      if (sceneChangeTimes.length === 0 || pts - sceneChangeTimes[sceneChangeTimes.length - 1] > 0.5) {
        sceneChangeTimes.push(pts);
      }
    }
  }

  if (sceneChangeTimes.length === 0) {
    // No scene cuts detected — return single scene
    return [
      {
        scene: 1,
        start: "00:00:00.000",
        end: secondsToTimestamp(duration),
        duration: duration.toFixed(1),
        frames: Math.round(duration * fps),
      },
    ];
  }

  // Build scene boundaries from cut timestamps
  // Each cut time marks the END of the current scene and START of the next
  const scenes: SceneInfo[] = [];
  let prevTime = 0;

  for (let i = 0; i < sceneChangeTimes.length; i++) {
    const cutTime = sceneChangeTimes[i];
    const sceneDuration = cutTime - prevTime;

    if (sceneDuration >= minSceneDuration) {
      scenes.push({
        scene: scenes.length + 1,
        start: secondsToTimestamp(prevTime),
        end: secondsToTimestamp(cutTime),
        duration: sceneDuration.toFixed(1),
        frames: Math.round(sceneDuration * fps),
      });
      prevTime = cutTime;
    }
    // If scene is too short, don't advance prevTime — it merges into next scene
  }

  // Final scene (from last accepted cut to end of video)
  const finalDuration = duration - prevTime;
  if (finalDuration >= 0.5) {
    scenes.push({
      scene: scenes.length + 1,
      start: secondsToTimestamp(prevTime),
      end: secondsToTimestamp(duration),
      duration: finalDuration.toFixed(1),
      frames: Math.round(finalDuration * fps),
    });
  }

  // If no scenes survived the min duration filter, return single scene
  if (scenes.length === 0) {
    return [
      {
        scene: 1,
        start: "00:00:00.000",
        end: secondsToTimestamp(duration),
        duration: duration.toFixed(1),
        frames: Math.round(duration * fps),
      },
    ];
  }

  return scenes;
}

/**
 * Save one representative frame per scene using ffmpeg scene detection.
 * Extracts the first frame of each detected scene.
 */
export function saveSceneFramesWithFfmpeg(
  inputPath: string,
  outputDir: string,
  options: {
    threshold?: number;
    minSceneDuration?: number;
    format?: "jpg" | "png";
    framesPerScene?: number;
  } = {},
): string[] {
  const absInput = path.resolve(inputPath);
  const ext = options.format === "png" ? "png" : "jpg";
  const base = path.basename(absInput, path.extname(absInput));
  const scenes = detectScenesWithFfmpeg(absInput, {
    threshold: options.threshold,
    minSceneDuration: options.minSceneDuration,
  });

  fs.mkdirSync(outputDir, { recursive: true });
  const images: string[] = [];
  const fps = getVideoInfo(absInput).fps;
  const framesPerScene = options.framesPerScene ?? 1;

  for (const scene of scenes) {
    const startSec = timestampToSeconds(scene.start);
    for (let i = 0; i < framesPerScene; i++) {
      // Spread frames evenly across the scene
      const durationSec = parseFloat(scene.duration);
      const offset = i === 0 ? 0 : (i / framesPerScene) * (durationSec - 1);
      const time = startSec + offset;

      const filename = framesPerScene === 1
        ? `${base}-Scene-${String(scene.scene).padStart(3, "0")}.${ext}`
        : `${base}-Scene-${String(scene.scene).padStart(3, "0")}-${String(i + 1).padStart(2, "0")}.${ext}`;

      const outPath = path.join(outputDir, filename);
      execSync(
        `ffmpeg -y -ss "${time}" -i "${absInput}" -vframes 1 -q:v 2 "${outPath}"`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      images.push(outPath);
    }
  }

  return images.sort();
}

/**
 * Split video into individual scene clips using ffmpeg scene detection.
 * Two-pass: detect scenes, then extract each clip.
 */
export function splitVideoWithFfmpeg(
  inputPath: string,
  outputDir: string,
  options: {
    threshold?: number;
    minSceneDuration?: number;
    codec?: string;
  } = {},
): string[] {
  const absInput = path.resolve(inputPath);
  const base = path.basename(absInput, path.extname(absInput));
  const scenes = detectScenesWithFfmpeg(absInput, {
    threshold: options.threshold,
    minSceneDuration: options.minSceneDuration,
  });

  fs.mkdirSync(outputDir, { recursive: true });
  const clips: string[] = [];
  const codec = options.codec || "libx264";

  for (const scene of scenes) {
    const outPath = path.join(outputDir, `${base}-Scene-${String(scene.scene).padStart(3, "0")}.mp4`);
    const duration = parseFloat(scene.duration);

    execSync(
      `ffmpeg -y -ss "${scene.start}" -i "${absInput}" -t "${duration}" -c:v ${codec} -c:a aac -avoid_negative_ts make_zero "${outPath}"`,
      { encoding: "utf-8", stdio: "pipe" },
    );
    clips.push(outPath);
  }

  return clips.sort();
}

// ── PySceneDetect (optional, opt-in) ─────────────────────────────────────────

/**
 * Check if scenedetect is available in the configured venv.
 */
export function isSceneDetectAvailable(cfg: SceneDetectConfig): boolean {
  if (!cfg.venvPath) return false;
  const binPath = path.join(cfg.venvPath, "bin", "scenedetect");
  return fs.existsSync(binPath);
}

/**
 * Get the path to the scenedetect binary.
 */
function getSceneDetectBinary(cfg: SceneDetectConfig): string | null {
  if (!cfg.venvPath) return null;
  const binPath = path.join(cfg.venvPath, "bin", "scenedetect");
  return fs.existsSync(binPath) ? binPath : null;
}

function runSceneDetect(
  cfg: SceneDetectConfig,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const binary = getSceneDetectBinary(cfg);
  if (!binary) {
    throw new Error("PySceneDetect not available. Set up a venv first.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().slice(-1000)));
    });
  });
}

/**
 * Detect scenes using PySceneDetect. Only called when user explicitly opts in.
 */
export async function detectScenesWithPySceneDetect(
  cfg: SceneDetectConfig,
  inputPath: string,
  options: {
    threshold?: number;
    minSceneLength?: string;
    detector?: string;
    outputDir?: string;
  } = {},
): Promise<SceneInfo[]> {
  const binary = getSceneDetectBinary(cfg);
  if (!binary) {
    throw new Error("PySceneDetect not available. Set up a venv first.");
  }

  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`File not found: ${absInput}`);
  }

  const outDir = options.outputDir || path.dirname(absInput);
  const csvPath = path.join(outDir, `${path.basename(absInput, path.extname(absInput))}-Scenes.csv`);

  const args: string[] = ["-i", absInput, "-o", outDir];
  if (options.threshold) args.push("--threshold", String(options.threshold));
  if (options.minSceneLength) args.push("-m", options.minSceneLength);
  if (options.detector) args.push(options.detector);
  args.push("list-scenes");

  await runSceneDetect(cfg, args);

  if (!fs.existsSync(csvPath)) return [];

  const csv = fs.readFileSync(csvPath, "utf-8");
  const lines = csv.trim().split("\n").slice(1);
  const scenes: SceneInfo[] = [];

  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length >= 5) {
      scenes.push({
        scene: parseInt(parts[0].trim()),
        start: parts[1].trim(),
        end: parts[2].trim(),
        duration: parts[3].trim(),
        frames: parseInt(parts[4].trim()),
      });
    }
  }

  return scenes;
}

/**
 * Save scene images using PySceneDetect.
 */
export async function saveSceneImagesWithPySceneDetect(
  cfg: SceneDetectConfig,
  inputPath: string,
  options: {
    threshold?: number;
    framesPerScene?: number;
    format?: "jpg" | "png";
    outputDir?: string;
  } = {},
): Promise<string[]> {
  const absInput = path.resolve(inputPath);
  const outDir = options.outputDir || path.dirname(absInput);
  const ext = options.format === "png" ? "png" : "jpg";
  const images: string[] = [];

  const args: string[] = ["-i", absInput, "-o", outDir];
  if (options.threshold) args.push("--threshold", String(options.threshold));
  args.push("save-images");
  if (options.framesPerScene) args.push("--count", String(options.framesPerScene));
  if (options.format) args.push("--format", options.format);

  await runSceneDetect(cfg, args);

  const base = path.basename(absInput, path.extname(absInput));
  const files = fs.readdirSync(outDir);
  for (const f of files) {
    if (f.startsWith(`${base}-Scene-`) && f.endsWith(`.${ext}`)) {
      images.push(path.join(outDir, f));
    }
  }

  return images.sort();
}

/**
 * Split video using PySceneDetect.
 */
export async function splitVideoWithPySceneDetect(
  cfg: SceneDetectConfig,
  inputPath: string,
  options: {
    threshold?: number;
    outputDir?: string;
  } = {},
): Promise<string[]> {
  const absInput = path.resolve(inputPath);
  const outDir = options.outputDir || path.dirname(absInput);
  const clips: string[] = [];

  const args: string[] = ["-i", absInput, "-o", outDir];
  if (options.threshold) args.push("--threshold", String(options.threshold));
  args.push("split-video");

  await runSceneDetect(cfg, args);

  const base = path.basename(absInput, path.extname(absInput));
  const files = fs.readdirSync(outDir);
  for (const f of files) {
    if (f.startsWith(`${base}-Scene-`) && f.endsWith(".mp4")) {
      clips.push(path.join(outDir, f));
    }
  }

  return clips.sort();
}

// ── Format helpers ───────────────────────────────────────────────────────────

export function formatScenes(scenes: SceneInfo[]): string {
  const lines = [`Detected ${scenes.length} scene(s):`];
  for (const s of scenes) {
    lines.push(
      `  Scene ${s.scene}: ${s.start} → ${s.end} (${s.duration}s, ${s.frames} frames)`,
    );
  }
  return lines.join("\n");
}

function secondsToTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function timestampToSeconds(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(ts);
}
