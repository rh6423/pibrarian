import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import type { CalibreConfig } from "../config";
import {
  searchOPDS,
  browseByTitle,
  browseByAuthor,
  browseByTag,
  getOPDSItem,
  downloadEbook,
  formatItemLine,
  formatItemDetails,
  formatSize,
  type OPDSItem,
} from "../utils/opds";
import { getChapters, readChapter } from "../utils/ebook-reader";

/**
 * Books domain — Calibre / ebook library tools.
 *
 * Integrates with Calibre's OPDS Content Server to search, browse,
 * get metadata, download, and read ebooks.
 */

export function createBooksTools(
  calibreConfig: CalibreConfig,
  defaultDownloadDir: string,
): ToolDefinition<any, any>[] {
  return [
    // ── Search ──────────────────────────────────────────────────────────
    {
      name: "pibrarian_books_search",
      label: "Search Books",
      description:
        "Search the ebook library by title, author, keyword, or natural language description. Uses Calibre's OPDS search.",
      promptSnippet: "Search ebooks by title, author, or meaning",
      promptGuidelines: [
        "Use pibrarian_books_search to find books in the Calibre library.",
        "Search supports partial matches on title, author, and tags.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search query — title, author, keyword, or natural language description",
        }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 20)" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const items = await searchOPDS(
          calibreConfig,
          params.query,
          params.limit ?? 20,
          { signal },
        );

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No books found matching "${params.query}".`,
              },
            ],
          };
        }

        const lines = [
          `Found ${items.length} book(s) matching "${params.query}":`,
          "",
          ...items.map((item) => formatItemLine(item)),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── Browse ──────────────────────────────────────────────────────────
    {
      name: "pibrarian_books_browse",
      label: "Browse Books",
      description:
        "Browse the ebook library sorted by title, author, or tag. Useful for exploring the library without a specific search query.",
      promptSnippet: "Browse ebooks by title, author, or tag",
      promptGuidelines: [
        "Use pibrarian_books_browse to explore the library. Set sort_by to 'title', 'author', or a specific tag.",
      ],
      parameters: Type.Object({
        sort_by: Type.Optional(
          Type.String({
            description:
              "Sort order: 'title' (default), 'author', or a tag name to filter by tag",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 50)" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        let items: OPDSItem[];
        const sortBy = params.sort_by?.toLowerCase();

        if (sortBy === "author") {
          items = await browseByAuthor(calibreConfig, params.limit ?? 50, { signal });
        } else if (sortBy && sortBy !== "title") {
          // Treat as tag filter
          items = await browseByTag(calibreConfig, params.sort_by, params.limit ?? 50, { signal });
        } else {
          items = await browseByTitle(calibreConfig, params.limit ?? 50, { signal });
        }

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: sortBy === "title"
                  ? "Library is empty or no books found."
                  : `No books found${sortBy === "author" ? " sorted by author" : ` with tag "${params.sort_by}"`}.`,
              },
            ],
          };
        }

        const label = sortBy === "title" || !sortBy ? "sorted by title" : sortBy === "author" ? "sorted by author" : `tagged "${params.sort_by}"`;
        const lines = [
          `Found ${items.length} book(s) ${label}:`,
          "",
          ...items.map((item) => formatItemLine(item)),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },

    // ── Details ─────────────────────────────────────────────────────────
    {
      name: "pibrarian_books_details",
      label: "Book Details",
      description:
        "Get full metadata for a specific book — title, author, series, tags, description, available formats.",
      promptSnippet: "Get book metadata and details",
      promptGuidelines: [
        "Use pibrarian_books_details to look up book information by its Calibre ID.",
        "The ID is shown in search/browse results (first column).",
      ],
      parameters: Type.Object({
        id: Type.String({
          description: "Calibre book ID (shown in search/browse results)",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const item = await getOPDSItem(calibreConfig, params.id, { signal });
        return {
          content: [{ type: "text", text: formatItemDetails(item) }],
        };
      },
    },

    // ── Download ────────────────────────────────────────────────────────
    {
      name: "pibrarian_books_download",
      label: "Download Book",
      description:
        "Download an ebook from Calibre to local disk. Supports EPUB, MOBI, PDF, and other formats. The downloaded file can be used with pibrarian_books_read.",
      promptSnippet: "Download an ebook file from Calibre",
      promptGuidelines: [
        "Use pibrarian_books_download to download a book for local reading.",
        "If format is not specified, EPUB is preferred (best for chapter reading).",
      ],
      parameters: Type.Object({
        id: Type.String({
          description: "Calibre book ID",
        }),
        format: Type.Optional(
          Type.String({
            description:
              "Ebook format: EPUB, MOBI, PDF, etc. (default: EPUB or first available)",
          }),
        ),
        output_dir: Type.Optional(
          Type.String({
            description: "Output directory (default: ~/pibrarian/downloads/books)",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const item = await getOPDSItem(calibreConfig, params.id, { signal });
        if (signal?.aborted) throw new Error("Aborted");

        // Determine format
        let format: string;
        if (params.format) {
          format = params.format.toUpperCase();
        } else if (item.formats?.length) {
          // Prefer EPUB, then first available
          const epub = item.formats.find((f) => f.name === "EPUB");
          format = epub ? "EPUB" : item.formats[0].name;
        } else {
          format = "EPUB";
        }

        const outDir = params.output_dir
          ? path.resolve(params.output_dir)
          : path.join(defaultDownloadDir, "books");
        const ext = format.toLowerCase();
        const safeName = item.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").replace(/\s+/g, "-");
        const filename = `${safeName}-${params.id}.${ext}`;
        const outPath = path.join(outDir, filename);

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Downloading "${item.title}" as ${format}...`,
            },
          ],
        });

        await downloadEbook(calibreConfig, params.id, format, outPath, { signal });
        if (signal?.aborted) throw new Error("Aborted");

        const size = fs.statSync(outPath).size;
        return {
          content: [
            {
              type: "text",
              text: `Downloaded: ${outPath}\nFormat: ${format}\nSize: ${formatSize(size)}\n\nUse pibrarian_books_read with file_path="${outPath}" to read chapters.`,
            },
          ],
          details: { path: outPath, format, size },
        };
      },
    },

    // ── Read ────────────────────────────────────────────────────────────
    {
      name: "pibrarian_books_read",
      label: "Read Book",
      description:
        "Read a chapter or section from an ebook file on disk. Supports EPUB format. Can read by chapter number or title.",
      promptSnippet: "Read chapters from an ebook file",
      promptGuidelines: [
        "Use pibrarian_books_read to read ebook content from a local file.",
        "Download the book first with pibrarian_books_download if you don't have it locally.",
        "Specify chapter by number (0-based) or by title string.",
      ],
      parameters: Type.Object({
        file_path: Type.String({
          description: "Path to the ebook file on disk (EPUB)",
        }),
        chapter: Type.Optional(
          Type.String({
            description:
              "Chapter number (0-based) or chapter title. Default: first chapter.",
          }),
        ),
        list_chapters: Type.Optional(
          Type.Boolean({
            description: "If true, only list available chapters without reading. Default: false.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        const filePath = path.resolve(params.file_path);
        if (!fs.existsSync(filePath)) {
          return {
            content: [
              { type: "text", text: `File not found: ${filePath}` },
            ],
            isError: true,
          };
        }

        if (params.list_chapters) {
          // List chapters only
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Reading chapter list from ${path.basename(filePath)}...`,
              },
            ],
          });

          const chapters = await getChapters(filePath);
          if (signal?.aborted) throw new Error("Aborted");

          if (chapters.length === 0) {
            return {
              content: [
                { type: "text", text: "No chapters found in this ebook." },
              ],
            };
          }

          const lines = [
            `Chapters in ${path.basename(filePath)} (${chapters.length} total):`,
            "",
            ...chapters.map((ch) => `  [${ch.index}] ${ch.title}`),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Read a chapter
        const chapterTarget = params.chapter
          ? isNaN(parseInt(params.chapter))
            ? params.chapter // Title string
            : parseInt(params.chapter) // Chapter number
          : 0; // Default: first chapter

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Reading chapter from ${path.basename(filePath)}...`,
            },
          ],
        });

        const result = await readChapter(filePath, chapterTarget);
        if (signal?.aborted) throw new Error("Aborted");

        const lines = [
          `## ${result.title}`,
          "",
          result.text,
          result.truncated ? "\n\n[Text truncated — chapter is very long]" : "",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    },
  ];
}
