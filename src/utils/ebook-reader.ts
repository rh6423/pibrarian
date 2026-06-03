import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * EPUB reader — parses local EPUB files to extract chapters and text.
 *
 * Uses Python's ebooklib when available (most reliable), falls back to
 * a pure Node.js ZIP+XML parser.
 */

// ── Python-based reader (ebooklib) ────────────────────────────────────────────

const EBOOKLIB_SCRIPT = `
import sys, json, zipfile, re, html

def strip_tags(text):
    """Remove HTML tags and decode entities."""
    text = re.sub(r'<br\\s*/?>', '\\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<p[^>]*>', '\\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    # Decode common HTML entities
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&quot;', '"').replace('&apos;', "'").replace('&#39;', "'")
    text = text.replace('&nbsp;', ' ').replace('&mdash;', '—').replace('&ndash;', '–')
    text = text.replace('&hellip;', '…').replace('&laquo;', '«').replace('&raquo;', '»')
    # Collapse whitespace but preserve paragraph breaks
    lines = text.split('\\n')
    lines = [line.strip() for line in lines]
    lines = [line for line in lines if line]
    return '\\n\\n'.join(lines)

def read_epub(path, action, chapter=None):
    """Read an EPUB file using zipfile (no external deps)."""
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        print(json.dumps({"error": f"Cannot open EPUB: {e}"}))
        return

    # Find container.xml
    try:
        container = zf.read('META-INF/container.xml').decode('utf-8')
    except:
        print(json.dumps({"error": "Missing META-INF/container.xml"}))
        return

    # Extract OPF path from container
    opf_match = re.search(r'<rootfile\\s+href=["\']([^"\']+)["\']', container)
    if not opf_match:
        print(json.dumps({"error": "Cannot find rootfile in container.xml"}))
        return

    opf_path = opf_match.group(1)
    opf_dir = opf_path.rsplit('/', 1)[0] + '/' if '/' in opf_path else ''

    # Parse OPF
    try:
        opf = zf.read(opf_path).decode('utf-8')
    except:
        print(json.dumps({"error": f"Cannot read {opf_path}"}))
        return

    # Build manifest: id -> href
    manifest = {}
    for m in re.finditer(r'<item\\s+id=["\']([^"\']+)["\']\\s+href=["\']([^"\']+)["\']', opf):
        manifest[m.group(1)] = m.group(2)

    # Build spine: ordered list of item IDs
    spine_items = re.findall(r'<itemref\\s+idref=["\']([^"\']+)["\']', opf)

    # Try to find nav.xhtml for chapter titles
    nav_path = None
    for item_id, href in manifest.items():
        if 'nav' in href.lower() and href.endswith('.xhtml'):
            nav_path = (opf_dir + href) if opf_dir else href
            break

    chapters = []
    if nav_path:
        # Parse navigation
        try:
            nav_content = zf.read(nav_path).decode('utf-8')
            # Find navPoints or ol > li > a patterns
            # Pattern: <a href="chapter001.xhtml">Chapter 1</a>
            links = re.findall(r'<a\\s+href=["\']([^"\']+)["\'][^>]*>([^<]+)</a>', nav_content)
            if links:
                for href, title in links:
                    # Resolve relative path
                    full_href = href if href.startswith('/') else (path.rsplit('/', 1)[0] + '/' if '/' in (path := nav_path) else '') + href
                    # Simpler resolution
                    nav_dir = nav_path.rsplit('/', 1)[0] + '/' if '/' in nav_path else ''
                    full_href = href if href.startswith('/') else (nav_dir + href if not href.startswith('#') else nav_path)
                    # Skip fragments-only links
                    if full_href.startswith('#'):
                        full_href = nav_path

                    # Find matching manifest entry
                    for mid, mhref in manifest.items():
                        resolved = (opf_dir + mhref) if opf_dir else mhref
                        if resolved == full_href or resolved.endswith(href.split('#')[0]):
                            chapters.append({
                                "title": title.strip(),
                                "href": resolved,
                                "id": mid
                            })
                            break
        except:
            pass

    # If no chapters found from nav, build from spine
    if not chapters:
        for i, item_id in enumerate(spine_items):
            href = manifest.get(item_id, '')
            full_href = (opf_dir + href) if opf_dir and href else href
            if full_href and (full_href.endswith('.xhtml') or full_href.endswith('.html')):
                chapters.append({
                    "title": f"Chapter {i + 1}",
                    "href": full_href,
                    "id": item_id
                })

    if action == "chapters":
        print(json.dumps({
            "chapters": [{"index": i, "title": ch["title"]} for i, ch in enumerate(chapters)],
            "count": len(chapters)
        }))
        return

    if action == "read":
        # Find the target chapter
        target = None
        if chapter is not None:
            # Try to match by index
            if isinstance(chapter, int) and 0 <= chapter < len(chapters):
                target = chapters[chapter]
            else:
                # Try to match by title
                for ch in chapters:
                    if ch["title"].lower() == str(chapter).lower():
                        target = ch
                        break
                # Try partial match
                if not target:
                    for ch in chapters:
                        if str(chapter).lower() in ch["title"].lower():
                            target = ch
                            break

        if not target:
            target = chapters[0] if chapters else None

        if not target:
            print(json.dumps({"error": "No chapter found"}))
            return

        try:
            content = zf.read(target["href"]).decode('utf-8')
            # Extract body content
            body_match = re.search(r'<body[^>]*>([\s\S]*?)</body>', content, re.IGNORECASE)
            body = body_match.group(1) if body_match else content
            text = strip_tags(body)
            print(json.dumps({
                "title": target["title"],
                "text": text[:50000],  # Cap at ~50K chars
                "truncated": len(text) > 50000
            }))
        except Exception as e:
            print(json.dumps({"error": f"Cannot read chapter: {e}"}))

# Main
if len(sys.argv) < 3:
    print(json.dumps({"error": "Usage: epub_reader.py <path> <chapters|read> [chapter]"}))
    sys.exit(1)

epub_path = sys.argv[1]
action = sys.argv[2]
chapter = sys.argv[3] if len(sys.argv) > 3 else None

# Try to parse chapter as int
if chapter is not None:
    try:
        chapter = int(chapter)
    except ValueError:
        pass

read_epub(epub_path, action, chapter)
`;

// ── Pure Node.js fallback reader ──────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  let text = html;
  // Convert <br> and <p> to newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "\n");
  // Remove all other tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»");
  // Collapse whitespace but preserve paragraph breaks
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.join("\n\n");
}

/**
 * Decompress a DEFLATE stream (EPUB uses zlib).
 * Uses Node.js built-in zlib.
 */
import zlib from "node:zlib";

async function unzipEntry(data: Buffer): Promise<string> {
  try {
    return zlib.unzipSync(data).toString("utf-8");
  } catch {
    // Some entries are not compressed
    return data.toString("utf-8");
  }
}

// Minimal ZIP parser (no external deps)
interface ZipEntry {
  filename: string;
  data: Buffer;
  compressedSize: number;
  compressionMethod: number; // 0 = stored, 8 = deflate
}

function parseZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  // Find End of Central Directory record
  let eocdPos = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 // PK\x05\x06
    ) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) throw new Error("Not a valid ZIP file");

  const centralDirOffset = buffer.readUInt32LE(eocdPos + 16);
  const centralDirEntries = buffer.readUInt16LE(eocdPos + 10);

  let pos = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break; // PK\x01\x02

    const compressionMethod = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const filenameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);

    const filename = buffer.toString("utf-8", pos + 46, pos + 46 + filenameLength);

    // Read from local file header
    const localPos = localHeaderOffset + 26 + buffer.readUInt16LE(localHeaderOffset + 26);
    const data = buffer.slice(localPos, localPos + compressedSize);

    entries.push({
      filename,
      data,
      compressedSize,
      compressionMethod,
    });

    pos += 46 + filenameLength + extraLength + commentLength;
  }

  return entries;
}

async function readEntry(entries: ZipEntry[], filename: string): Promise<string> {
  const entry = entries.find((e) => e.filename === filename);
  if (!entry) throw new Error(`Entry not found: ${filename}`);

  if (entry.compressionMethod === 0) {
    return entry.data.toString("utf-8");
  } else if (entry.compressionMethod === 8) {
    return zlib.unzipSync(entry.data).toString("utf-8");
  }
  throw new Error(`Unsupported compression: ${entry.compressionMethod}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ChapterInfo {
  index: number;
  title: string;
}

/**
 * Get the list of chapters from an EPUB file.
 * Prefers Python ebooklib if available, falls back to pure Node.js.
 */
export async function getChapters(epubPath: string): Promise<ChapterInfo[]> {
  const resolved = path.resolve(epubPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  // Try pure Node.js first (no external deps needed)
  try {
    return getChaptersNode(resolved);
  } catch (nodeErr) {
    // Fall back to Python
    try {
      return getChaptersPython(resolved);
    } catch (pyErr) {
      throw new Error(
        `Cannot read EPUB chapters: Node.js fallback failed (${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}), Python fallback failed (${pyErr instanceof Error ? pyErr.message : String(pyErr)})`,
      );
    }
  }
}

function getChaptersPython(epubPath: string): ChapterInfo[] {
  const result = spawnSync("python3", ["-c", EBOOKLIB_SCRIPT, epubPath, "chapters"], {
    encoding: "utf-8",
    timeout: 30000,
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr || "Python epub reader failed");
  }

  const output = result.stdout.trim().split("\n").join("");
  const data = JSON.parse(output);
  if (data.error) throw new Error(data.error);

  return data.chapters as ChapterInfo[];
}

async function getChaptersNode(epubPath: string): Promise<ChapterInfo[]> {
  const buffer = fs.readFileSync(epubPath);
  const entries = parseZip(buffer);

  // Find container.xml
  const containerXml = await readEntry(entries, "META-INF/container.xml");
  const opfMatch = containerXml.match(/<rootfile\s+href=["']([^"']+)["']/);
  if (!opfMatch) throw new Error("Cannot find rootfile in container.xml");

  const opfPath = opfMatch[1];
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfContent = await readEntry(entries, opfPath);

  // Build manifest
  const manifest: Record<string, string> = {};
  const manifestRegex = /<item\s+id=["']([^"']+)["']\s+href=["']([^"']+)["']/g;
  let m;
  while ((m = manifestRegex.exec(opfContent)) !== null) {
    manifest[m[1]] = m[2];
  }

  // Build spine
  const spineRegex = /<itemref\s+idref=["']([^"']+)["']/g;
  const spineItems: string[] = [];
  while ((m = spineRegex.exec(opfContent)) !== null) {
    spineItems.push(m[1]);
  }

  // Try to find nav document
  let navPath: string | null = null;
  for (const [id, href] of Object.entries(manifest)) {
    if (href.toLowerCase().includes("nav") && href.endsWith(".xhtml")) {
      navPath = opfDir + href;
      break;
    }
  }

  const chapters: Array<{ title: string; href: string }> = [];

  if (navPath) {
    try {
      const navContent = await readEntry(entries, navPath);
      const navDir = navPath.includes("/") ? navPath.substring(0, navPath.lastIndexOf("/") + 1) : "";

      // Extract links: <a href="...">Title</a>
      const linkRegex = /<a\s+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/g;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(navContent)) !== null) {
        const href = linkMatch[1];
        const title = linkMatch[2].trim();

        // Resolve href relative to nav document
        let fullHref: string;
        if (href.startsWith("/")) {
          fullHref = href.substring(1);
        } else if (href.startsWith("#")) {
          fullHref = navPath; // Same document, skip for chapter list
          continue;
        } else {
          fullHref = navDir + href;
        }

        // Find matching manifest entry
        const hrefBase = fullHref.split("#")[0];
        for (const [, mhref] of Object.entries(manifest)) {
          const resolved = opfDir + mhref;
          if (resolved === hrefBase || resolved.endsWith(hrefBase)) {
            chapters.push({ title, href: resolved });
            break;
          }
        }
      }
    } catch {
      // Nav parsing failed, fall through to spine-based
    }
  }

  // If no chapters from nav, build from spine order
  if (chapters.length === 0) {
    for (let i = 0; i < spineItems.length; i++) {
      const item_id = spineItems[i];
      const href = manifest[item_id];
      if (!href) continue;
      const fullHref = opfDir + href;
      if (fullHref.endsWith(".xhtml") || fullHref.endsWith(".html")) {
        chapters.push({ title: `Chapter ${i + 1}`, href: fullHref });
      }
    }
  }

  return chapters.map((ch, i) => ({ index: i, title: ch.title }));
}

/**
 * Read a specific chapter from an EPUB file and return plain text.
 * @param epubPath - Path to the EPUB file
 * @param chapter - Chapter index (0-based) or title string
 */
export async function readChapter(
  epubPath: string,
  chapter: number | string,
): Promise<{ title: string; text: string; truncated?: boolean }> {
  const resolved = path.resolve(epubPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  // Try pure Node.js first
  try {
    return readChapterNode(resolved, chapter);
  } catch (nodeErr) {
    // Fall back to Python
    try {
      return readChapterPython(resolved, chapter);
    } catch (pyErr) {
      throw new Error(
        `Cannot read chapter: Node.js fallback failed (${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}), Python fallback failed (${pyErr instanceof Error ? pyErr.message : String(pyErr)})`,
      );
    }
  }
}

function readChapterPython(
  epubPath: string,
  chapter: number | string,
): { title: string; text: string; truncated?: boolean } {
  const result = spawnSync("python3", ["-c", EBOOKLIB_SCRIPT, epubPath, "read", String(chapter)], {
    encoding: "utf-8",
    timeout: 30000,
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr || "Python epub reader failed");
  }

  const output = result.stdout.trim().split("\n").join("");
  const data = JSON.parse(output);
  if (data.error) throw new Error(data.error);

  return { title: data.title, text: data.text, truncated: data.truncated };
}

async function readChapterNode(
  epubPath: string,
  chapter: number | string,
): Promise<{ title: string; text: string; truncated?: boolean }> {
  const buffer = fs.readFileSync(epubPath);
  const entries = parseZip(buffer);

  // Parse OPF (same as getChaptersNode)
  const containerXml = await readEntry(entries, "META-INF/container.xml");
  const opfMatch = containerXml.match(/<rootfile\s+href=["']([^"']+)["']/);
  if (!opfMatch) throw new Error("Cannot find rootfile in container.xml");

  const opfPath = opfMatch[1];
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfContent = await readEntry(entries, opfPath);

  const manifest: Record<string, string> = {};
  const manifestRegex = /<item\s+id=["']([^"']+)["']\s+href=["']([^"']+)["']/g;
  let m;
  while ((m = manifestRegex.exec(opfContent)) !== null) {
    manifest[m[1]] = m[2];
  }

  const spineRegex = /<itemref\s+idref=["']([^"']+)["']/g;
  const spineItems: string[] = [];
  while ((m = spineRegex.exec(opfContent)) !== null) {
    spineItems.push(m[1]);
  }

  // Find nav and build chapter list
  let navPath: string | null = null;
  for (const href of Object.values(manifest)) {
    if (href.toLowerCase().includes("nav") && href.endsWith(".xhtml")) {
      navPath = opfDir + href;
      break;
    }
  }

  const chapters: Array<{ title: string; href: string }> = [];

  if (navPath) {
    try {
      const navContent = await readEntry(entries, navPath);
      const navDir = navPath.includes("/") ? navPath.substring(0, navPath.lastIndexOf("/") + 1) : "";
      const linkRegex = /<a\s+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/g;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(navContent)) !== null) {
        const href = linkMatch[1];
        const title = linkMatch[2].trim();
        if (href.startsWith("#")) continue;

        let fullHref: string;
        if (href.startsWith("/")) {
          fullHref = href.substring(1);
        } else {
          fullHref = navDir + href;
        }

        const hrefBase = fullHref.split("#")[0];
        for (const [, mhref] of Object.entries(manifest)) {
          const resolved = opfDir + mhref;
          if (resolved === hrefBase || resolved.endsWith(hrefBase)) {
            chapters.push({ title, href: resolved });
            break;
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  if (chapters.length === 0) {
    for (let i = 0; i < spineItems.length; i++) {
      const href = manifest[spineItems[i]];
      if (!href) continue;
      const fullHref = opfDir + href;
      if (fullHref.endsWith(".xhtml") || fullHref.endsWith(".html")) {
        chapters.push({ title: `Chapter ${i + 1}`, href: fullHref });
      }
    }
  }

  // Find target chapter
  let target: { title: string; href: string } | null = null;

  if (typeof chapter === "number") {
    if (chapter >= 0 && chapter < chapters.length) {
      target = chapters[chapter];
    }
  } else {
    // Try exact title match
    for (const ch of chapters) {
      if (ch.title.toLowerCase() === chapter.toLowerCase()) {
        target = ch;
        break;
      }
    }
    // Try partial match
    if (!target) {
      for (const ch of chapters) {
        if (ch.title.toLowerCase().includes(chapter.toLowerCase())) {
          target = ch;
          break;
        }
      }
    }
  }

  if (!target) {
    target = chapters[0] || null;
  }

  if (!target) {
    throw new Error("No chapter found in EPUB");
  }

  const content = await readEntry(entries, target.href);
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : content;
  let text = stripHtmlTags(body);

  const truncated = text.length > 50000;
  if (truncated) text = text.substring(0, 50000);

  return { title: target.title, text, truncated };
}
