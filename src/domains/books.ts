import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Books domain — Calibre / ebook library tools.
 *
 * Placeholder tools. Will be wired to Calibre OPDS + embedding backend.
 */

export const booksTools: ToolDefinition<any, any>[] = [
  {
    name: "pibrarian_books_search",
    label: "Search Books",
    description:
      "Search the ebook library by title, author, or semantic content.",
    promptSnippet: "Search ebooks by title, author, or meaning",
    promptGuidelines: [
      "Use pibrarian_books_search to find books in the Calibre library.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query — title, author, keyword, or natural language description",
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
            text: "[pibrarian_books_search: Calibre integration not yet implemented]",
          },
        ],
        details: {},
      };
    },
  },
  {
    name: "pibrarian_books_details",
    label: "Book Details",
    description:
      "Get metadata for a specific book (title, author, series, tags, description).",
    promptSnippet: "Get book metadata and details",
    promptGuidelines: [
      "Use pibrarian_books_details to look up book information.",
    ],
    parameters: Type.Object({
      identifier: Type.String({
        description: "Book title, ID, or partial match",
      }),
    }),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "[pibrarian_books_details: Calibre integration not yet implemented]",
          },
        ],
        details: {},
      };
    },
  },
  {
    name: "pibrarian_books_read",
    label: "Read Book",
    description:
      "Read a chapter or section from an ebook in the library.",
    promptSnippet: "Read chapters from an ebook",
    promptGuidelines: ["Use pibrarian_books_read to read ebook content."],
    parameters: Type.Object({
      identifier: Type.String({
        description: "Book title or ID",
      }),
      chapter: Type.Optional(
        Type.String({
          description: "Chapter number or title (default: first)",
        }),
      ),
    }),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "[pibrarian_books_read: Calibre integration not yet implemented]",
          },
        ],
        details: {},
      };
    },
  },
];
