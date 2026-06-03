import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { queryVision } from "../utils/vision";
import type { VisionConfig } from "../config";

// How many pixels to expand each crop edge outward.
// Compensates for the vision model's coordinate imprecision
// and ensures no content is cut off at panel borders.
const EXPAND_PX = 12;

interface PanelBox {
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  description?: string;
}

const PANEL_DETECTION_PROMPT = `This is a comic book page. I need the coordinates of every panel.

The page is {width}x{height} pixels. Report coordinates on a normalized 1000x1000 grid
where (0,0) is top-left and (1000,1000) is bottom-right.

For each panel give:
- index: panel number (1, 2, 3...)
- left: x-coordinate of the LEFT edge of the OUTER black border
- top: y-coordinate of the TOP edge of the OUTER black border
- right: x-coordinate of the RIGHT edge of the OUTER black border
- bottom: y-coordinate of the BOTTOM edge of the OUTER black border
- description: brief description of panel content

Rules:
- Coordinates are on a 1000x1000 grid regardless of actual aspect ratio
- Measure the OUTER edge of the black border (not the inner content edge)
- Do NOT assume uniform grid — panels vary in size
- List panels in reading order (left-to-right, top-to-bottom)

Return ONLY valid JSON. No markdown, no explanation.`;

async function detectPanels(
  visionConfig: VisionConfig,
  imagePath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; panels: PanelBox[] }> {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const prompt = PANEL_DETECTION_PROMPT
    .replace(/{width}/g, String(width))
    .replace(/{height}/g, String(height));

  const jsonStr = await queryVision(visionConfig, imagePath, prompt, {
    maxTokens: 2000,
    signal,
  });
  const parsed = JSON.parse(jsonStr);

  // Handle both array and object wrappers
  const panels: PanelBox[] = Array.isArray(parsed) ? parsed : parsed.panels;

  return { width, height, panels };
}

async function cropPanel(
  image: sharp.Sharp,
  left: number,
  top: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
): Promise<Buffer> {
  // Expand crop to compensate for coordinate imprecision
  const clampedLeft = Math.max(0, left - EXPAND_PX);
  const clampedTop = Math.max(0, top - EXPAND_PX);
  const clampedRight = Math.min(pageWidth, left + width + EXPAND_PX);
  const clampedBottom = Math.min(pageHeight, top + height + EXPAND_PX);
  const expandedW = clampedRight - clampedLeft;
  const expandedH = clampedBottom - clampedTop;

  // Crop with expanded bounds
  const cropped = await image
    .clone()
    .extract({
      left: clampedLeft,
      top: clampedTop,
      width: expandedW,
      height: expandedH,
    })
    .toBuffer();

  // Trim white/light gutter from edges (safety net — may not fire if no gutter)
  const trimmed = await sharp(cropped)
    .trim({
      background: { r: 250, g: 250, b: 250 },
      tolerance: { r: 15, g: 15, b: 15 },
      threshold: 500,
    })
    .toBuffer();

  return trimmed;
}

/**
 * Build the extract_panels tool. Requires vision config at call time.
 */
export function createExtractPanelsTool(
  visionConfig: VisionConfig,
): ToolDefinition<any, any> {
  return {
    name: "pibrarian_comics_extract_panels",
    label: "Extract Comic Panels",
    description:
      "Extract individual panels from a comic book page. Uses a vision model to detect panel layout, then crops each panel as a PNG file with clean borders.",
    promptSnippet: "Extract individual panels from a comic page",
    promptGuidelines: [
      "Use pibrarian_comics_extract_panels to split comic pages into individual panels.",
    ],
    parameters: Type.Object({
      image_path: Type.String({
        description:
          "Path to the comic page image (JPG or PNG) to extract panels from",
      }),
      output_dir: Type.Optional(
        Type.String({
          description:
            "Output directory for panel PNGs. Defaults to <image_name>_panels/ next to the source image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const imagePath = path.resolve(params.image_path);
      if (!fs.existsSync(imagePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${imagePath}` }],
          isError: true,
        };
      }

      const defaultOutDir = path.join(
        path.dirname(imagePath),
        path.basename(imagePath, path.extname(imagePath)) + "_panels",
      );
      const outputDir = params.output_dir
        ? path.resolve(params.output_dir)
        : defaultOutDir;

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Detecting panels in ${path.basename(imagePath)}...`,
          },
        ],
      });

      const { width: pageW, height: pageH, panels } = await detectPanels(
        visionConfig,
        imagePath,
        signal,
      );

      if (signal?.aborted) throw new Error("Operation aborted");

      fs.mkdirSync(outputDir, { recursive: true });
      const image = sharp(imagePath);
      const results: Array<{
        path: string;
        index: number;
        width: number;
        height: number;
        description?: string;
      }> = [];

      for (const panel of panels) {
        // Scale from 1000x1000 grid to actual dimensions
        const left = Math.round((panel.left / 1000) * pageW);
        const top = Math.round((panel.top / 1000) * pageH);
        const right = Math.round((panel.right / 1000) * pageW);
        const bottom = Math.round((panel.bottom / 1000) * pageH);
        const w = right - left;
        const h = bottom - top;

        const buffer = await cropPanel(image, left, top, w, h, pageW, pageH);
        const meta = await sharp(buffer).metadata();

        const outPath = path.join(
          outputDir,
          `panel_${String(panel.index).padStart(2, "0")}.png`,
        );

        await sharp(buffer).toFormat("png").toFile(outPath);

        results.push({
          path: outPath,
          index: panel.index,
          width: meta.width!,
          height: meta.height!,
          description: panel.description,
        });
      }

      const meta = await sharp(imagePath).metadata();
      const lines = [
        `Extracted ${results.length} panels from ${path.basename(imagePath)} (${meta.width}x${meta.height}):`,
        "",
        ...results.map((r) => {
          return `  Panel ${r.index}: ${r.width}x${r.height} — ${r.description || ""}\n    → ${r.path}`;
        }),
        "",
        `Output directory: ${outputDir}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { outputDir, panelCount: results.length },
      };
    },
  };
}

/**
 * Placeholder tools for future comic domain features.
 */
export const comicsPlaceholderTools: ToolDefinition<any, any>[] = [
  {
    name: "pibrarian_comics_search",
    label: "Search Comics",
    description:
      "Search the comic library by title, series, or issue number.",
    promptSnippet: "Search comics by title, series, or issue",
    promptGuidelines: [
      "Use pibrarian_comics_search to find comics in the library.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query — title, series, or issue number",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)" }),
      ),
    }),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "[pibrarian_comics_search: Komga integration not yet implemented]",
          },
        ],
        details: {},
      };
    },
  },
  {
    name: "pibrarian_comics_read",
    label: "Read Comic",
    description:
      "Read a comic issue page by page, optionally extracting panels.",
    promptSnippet: "Read a comic issue, with optional panel extraction",
    promptGuidelines: [
      "Use pibrarian_comics_read to browse comic issues.",
    ],
    parameters: Type.Object({
      identifier: Type.String({
        description: "Comic title, series, or issue number",
      }),
      page: Type.Optional(
        Type.Number({ description: "Page number (default: all)" }),
      ),
      extract_panels: Type.Optional(
        Type.Boolean({
          description: "Extract individual panels (default: false)",
        }),
      ),
    }),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "[pibrarian_comics_read: Komga integration not yet implemented]",
          },
        ],
        details: {},
      };
    },
  },
];
