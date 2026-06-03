import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { CalibreConfig } from "../config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OPDSFormat {
  name: string; // e.g. "EPUB", "MOBI"
  size: number;
  url: string;
}

export interface OPDSAuthor {
  name: string;
}

export interface OPDSItem {
  id: string;
  title: string;
  authors: OPDSAuthor[];
  publishers?: string[];
  series?: string;
  seriesIndex?: number;
  tags?: string[];
  description?: string;
  published?: string;
  languages?: string[];
  formats?: OPDSFormat[];
  identifier?: string; // Calibre internal ID
}

export interface OPDSFeed {
  title: string;
  items: OPDSItem[];
  links: Array<{ rel?: string; href: string; title?: string; type?: string }>;
}

// ── OPDS HTTP client ──────────────────────────────────────────────────────────

function getBaseUrl(cfg: CalibreConfig): string {
  return process.env.PIBRARIAN_CALIBRE_URL ?? cfg.opdsUrl;
}

function buildAuthHeader(cfg: CalibreConfig): string | undefined {
  if (cfg.username && cfg.password) {
    return "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  }
  return undefined;
}

async function opdsFetch(
  cfg: CalibreConfig,
  urlPath: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const baseUrl = getBaseUrl(cfg).replace(/\/+$/, "");
  const url = `${baseUrl}${urlPath}`;

  const headers: Record<string, string> = {
    Accept: "application/atom+xml, application/xml, text/xml, */*",
  };

  const auth = buildAuthHeader(cfg);
  if (auth) headers["Authorization"] = auth;

  const res = await fetch(url, { headers, signal: options?.signal });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Calibre OPDS error: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }

  return res.text();
}

// ── ATOM XML parsing (lightweight, no external deps) ──────────────────────────

/**
 * Minimal ATOM feed parser. Calibre's OPDS uses ATOM XML.
 * We parse just the fields we need rather than pulling in a full XML library.
 */

function extractText(xml: string, tag: string): string | undefined {
  // Handle namespaced tags (e.g. <dc:creator>, <atom:title>)
  const regex = new RegExp(`<[^>]*:${tag}\\s*>([^<]*)</[^>]*:${tag}>|<${tag}\\s*>([^<]*)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? (match[1] ?? match[2] ?? "").trim() : undefined;
}

function extractAllText(xml: string, tag: string): string[] {
  const regex = new RegExp(`<[^>]*:${tag}\\s*>([^<]*)</[^>]*:${tag}>|<${tag}\\s*>([^<]*)</${tag}>`, "gi");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = (match[1] ?? match[2] ?? "").trim();
    if (text) results.push(text);
  }
  return results;
}

function extractLinks(xml: string): Array<{ rel?: string; href: string; title?: string; type?: string }> {
  const regex = /<link\s+([^>]+)\/?>/gi;
  const links: Array<{ rel?: string; href: string; title?: string; type?: string }> = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1];
    const rel = extractAttr(attrs, "rel");
    const href = extractAttr(attrs, "href");
    const title = extractAttr(attrs, "title");
    const type = extractAttr(attrs, "type");
    if (href) links.push({ rel, href, title, type });
  }
  return links;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`${name}=["']([^"']*)["']`, "i");
  const match = attrs.match(regex);
  return match ? match[1] : undefined;
}

function parseEntry(entryXml: string): OPDSItem {
  const id = extractText(entryXml, "id") ?? "";
  const title = extractText(entryXml, "title") ?? "Unknown";

  // Authors — Calibre uses <dc:creator>
  const authorNames = extractAllText(entryXml, "creator");
  const authors: OPDSAuthor[] = authorNames.map((name) => ({ name }));

  // Publisher
  const publishers = extractAllText(entryXml, "publisher");

  // Tags — Calibre uses <dc:subject>
  const tags = extractAllText(entryXml, "subject");

  // Published date
  const published = extractText(entryXml, "published") ?? extractText(entryXml, "updated");

  // Languages
  const languages = extractAllText(entryXml, "language");

  // Description / summary
  const description = extractText(entryXml, "summary");

  // Series info — Calibre embeds in dc:subject or custom fields
  // Try to extract from subject tags that look like "Series Name #X"
  let series: string | undefined;
  let seriesIndex: number | undefined;
  for (const tag of tags) {
    const seriesMatch = tag.match(/^(.+?)\s*#(\d+(?:\.\d+)?)$/);
    if (seriesMatch) {
      series = seriesMatch[1];
      seriesIndex = parseFloat(seriesMatch[2]);
      break;
    }
  }

  // Formats — Calibre provides download links
  const links = extractLinks(entryXml);
  const formats: OPDSFormat[] = [];

  for (const link of links) {
    if (link.rel === "http://opds-spec.org/acquisition" || link.rel === "http://opds-spec.org/acquisition/open-access") {
      // Format name is typically in the title or can be derived from the URL
      const name = link.title ?? extractFormatFromUrl(link.href);
      formats.push({
        name,
        size: 0, // Size is in the <opds:content> element or not always present
        url: link.href,
      });
    }
  }

  // Try to get size from opds:content elements
  const sizeMatches = entryXml.match(/<opds:content\s+name="[^"]*"\s+size="(\d+)"/g);
  if (sizeMatches) {
    for (let i = 0; i < Math.min(sizeMatches.length, formats.length); i++) {
      const sizeStr = sizeMatches[i].match(/size="(\d+)"/);
      if (sizeStr) formats[i].size = parseInt(sizeStr[1], 10);
    }
  }

  // Calibre item ID — extract from the entry id or links
  // Calibre OPDS entry IDs look like "/opds/entries/1234" or similar
  const calibreIdMatch = id.match(/\/(\d+)(?:\/|$)/);
  const identifier = calibreIdMatch ? calibreIdMatch[1] : id;

  return {
    id,
    identifier,
    title,
    authors,
    publishers: publishers.length ? publishers : undefined,
    series,
    seriesIndex,
    tags: tags.length ? tags : undefined,
    description,
    published,
    languages: languages.length ? languages : undefined,
    formats: formats.length ? formats : undefined,
  };
}

function extractFormatFromUrl(url: string): string {
  // Extract format from URL like /opds/download/123/EPUB or filename.epub
  const parts = url.split("/");
  for (const part of parts) {
    const upper = part.toUpperCase();
    if (["EPUB", "MOBI", "PDF", "CBZ", "CBR", "DJVU", "TXT", "HTML", "RTF", "LIT", "FB2", "AZW3", "AZW", "DOCX", "ODT"].includes(upper)) {
      return upper;
    }
  }
  // Try file extension
  const extMatch = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return extMatch ? extMatch[1].toUpperCase() : "UNKNOWN";
}

function parseFeed(xml: string): OPDSFeed {
  const title = extractText(xml, "title") ?? "Calibre Library";
  const links = extractLinks(xml);

  // Extract individual <entry> blocks
  const entryRegex = /<entry\s*>([\s\S]*?)(?=<entry\s*|<\/feed>)/gi;
  const items: OPDSItem[] = [];
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = `<entry>${match[0]}</entry>`;
    items.push(parseEntry(entryXml));
  }

  return { title, items, links };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch and parse an OPDS feed from a path relative to the Calibre OPDS root.
 */
export async function fetchOPDSFeed(
  cfg: CalibreConfig,
  path: string,
  options?: { signal?: AbortSignal },
): Promise<OPDSFeed> {
  const xml = await opdsFetch(cfg, path, options);
  return parseFeed(xml);
}

/**
 * Search the Calibre library. Supports keyword search via Calibre's /opds/search endpoint.
 */
export async function searchOPDS(
  cfg: CalibreConfig,
  query: string,
  limit: number = 20,
  options?: { signal?: AbortSignal },
): Promise<OPDSItem[]> {
  const encoded = encodeURIComponent(query);
  const feed = await fetchOPDSFeed(cfg, `/opds/search?q=${encoded}`, options);
  return feed.items.slice(0, limit);
}

/**
 * Browse books sorted by title.
 */
export async function browseByTitle(
  cfg: CalibreConfig,
  limit: number = 50,
  options?: { signal?: AbortSignal },
): Promise<OPDSItem[]> {
  const feed = await fetchOPDSFeed(cfg, "/opds/entries/by_title", options);
  return feed.items.slice(0, limit);
}

/**
 * Browse books sorted by author.
 */
export async function browseByAuthor(
  cfg: CalibreConfig,
  limit: number = 50,
  options?: { signal?: AbortSignal },
): Promise<OPDSItem[]> {
  const feed = await fetchOPDSFeed(cfg, "/opds/entries/by_author", options);
  return feed.items.slice(0, limit);
}

/**
 * Browse books by tag.
 */
export async function browseByTag(
  cfg: CalibreConfig,
  tag: string,
  limit: number = 50,
  options?: { signal?: AbortSignal },
): Promise<OPDSItem[]> {
  const encoded = encodeURIComponent(tag);
  const feed = await fetchOPDSFeed(cfg, `/opds/entries/by_tags/${encoded}`, options);
  return feed.items.slice(0, limit);
}

/**
 * Get full metadata for a single book by its Calibre ID.
 */
export async function getOPDSItem(
  cfg: CalibreConfig,
  calibreId: string,
  options?: { signal?: AbortSignal },
): Promise<OPDSItem> {
  const feed = await fetchOPDSFeed(cfg, `/opds/entries/${calibreId}`, options);
  if (feed.items.length === 0) {
    throw new Error(`Book not found: ID ${calibreId}`);
  }
  return feed.items[0];
}

/**
 * Download an ebook from Calibre to a local file.
 * Uses curl for reliable large-file downloads.
 */
export async function downloadEbook(
  cfg: CalibreConfig,
  calibreId: string,
  format: string,
  outputPath: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const baseUrl = getBaseUrl(cfg).replace(/\/+$/, "");
  const downloadUrl = `${baseUrl}/opds/download/${calibreId}/${format.toUpperCase()}`;

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Build curl command with optional auth
  const args = ["-f", "-s", "-L", "-o", outputPath, downloadUrl];
  const auth = buildAuthHeader(cfg);
  if (auth) {
    args.push("-H", `Authorization: ${auth}`);
  }

  try {
    execSync(`curl ${args.join(" ")}`, { stdio: "pipe", timeout: 300_000 });
  } catch (e: any) {
    throw new Error(
      `Download failed: ${e.stderr?.toString().trim().slice(-200) || e.message}`,
    );
  }

  if (options?.signal?.aborted) throw new Error("Aborted");

  const size = fs.statSync(outputPath).size;
  return outputPath;
}

/**
 * Download a specific format link directly (when we have the full URL).
 */
export async function downloadFromUrl(
  cfg: CalibreConfig,
  url: string,
  outputPath: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const baseUrl = getBaseUrl(cfg).replace(/\/+$/, "");

  // If the URL is relative, make it absolute
  const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = ["-f", "-s", "-L", "-o", outputPath, fullUrl];
  const auth = buildAuthHeader(cfg);
  if (auth) {
    args.push("-H", `Authorization: ${auth}`);
  }

  try {
    execSync(`curl ${args.join(" ")}`, { stdio: "pipe", timeout: 300_000 });
  } catch (e: any) {
    throw new Error(
      `Download failed: ${e.stderr?.toString().trim().slice(-200) || e.message}`,
    );
  }

  if (options?.signal?.aborted) throw new Error("Aborted");
  const size = fs.statSync(outputPath).size;
  return outputPath;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatItemLine(item: OPDSItem): string {
  const author = item.authors.map((a) => a.name).join(", ");
  const seriesInfo = item.series
    ? ` [${item.series}${item.seriesIndex ? " #" + item.seriesIndex : ""}]`
    : "";
  const formats = item.formats?.map((f) => f.name).join(", ") || "";
  const year = item.published
    ? new Date(item.published).getFullYear().toString()
    : "";

  return `  ${item.identifier}  ${item.title}${author ? ` — ${author}` : ""}${year ? ` (${year})` : ""}${seriesInfo}${formats ? ` [${formats}]` : ""}`;
}

export function formatItemDetails(item: OPDSItem): string {
  const lines: string[] = [];
  lines.push(`Title:       ${item.title}`);
  lines.push(`ID:          ${item.identifier}`);
  if (item.authors.length)
    lines.push(`Author(s):   ${item.authors.map((a) => a.name).join(", ")}`);
  if (item.publishers?.length)
    lines.push(`Publisher:   ${item.publishers.join(", ")}`);
  if (item.series)
    lines.push(`Series:      ${item.series}${item.seriesIndex ? " #" + item.seriesIndex : ""}`);
  if (item.published)
    lines.push(`Published:   ${new Date(item.published).toLocaleDateString()}`);
  if (item.languages?.length)
    lines.push(`Language:    ${item.languages.join(", ")}`);
  if (item.tags?.length)
    lines.push(`Tags:        ${item.tags.join(", ")}`);
  if (item.description)
    lines.push(`Description: ${item.description.replace(/\n/g, " ").slice(0, 500)}`);
  if (item.formats?.length) {
    lines.push(`Formats:     ${item.formats.map((f) => `${f.name}${f.size ? " (" + formatSize(f.size) + ")" : ""}`).join(", ")}`);
  }
  return lines.join("\n");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
