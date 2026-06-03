# pibrarian — TODO

## High Priority

### Comics: Search & Read (Komga Integration)

Two tools are defined as placeholders in `src/domains/comics.ts` — schemas, descriptions, and prompt guidelines are ready, but the backends return "Komga integration not yet implemented."

| Tool | Description |
|------|-------------|
| `pibrarian_comics_search` | Search comics by title, series, or issue number |
| `pibrarian_comics_read` | Read a comic issue page-by-page, with optional panel extraction |

Panel extraction (`pibrarian_comics_extract_panels`) is the only fully working comics tool.

### Semantic Search (Embeddings)

Infrastructure exists but is unused:
- `src/utils/embeddings.ts` — fully implemented (`getEmbedding`, `getEmbeddings`)
- `config.ts` + `config.json.example` — embedding baseUrl + model configured
- **No tool consumes it**

To implement: build/maintain an embedding index from book descriptions, then wire it into a semantic search tool (likely `pibrarian_books_search` enhancement or a new `pibrarian_books_semantic_search`).

### Tests

The current pibrarian extension has **zero tests**. No test framework, no test files, no test scripts in `package.json`.

The old dev directory (`~/calibre-plugin/tests/`) has ~12 test files for the **previous CLI codebase** (calibrembed). Those tests cover a different architecture (vector store, embedding pipeline, CLI) and are not directly reusable, though they could inform test strategy.

**Recommended approach:**
1. Add a test framework (`node:test` is already available in Node 20+)
2. Add a `"test"` script to `package.json`
3. Start with unit tests for utility modules:
   - `src/utils/opds.ts` — ATOM XML parsing, URL construction
   - `src/utils/jellyfin.ts` — API response formatting, URL helpers
   - `src/utils/ebook-reader.ts` — EPUB chapter extraction
   - `src/utils/scenedetect.ts` — timestamp parsing, ffmpeg command construction
   - `src/utils/embeddings.ts` — API call formatting
   - `src/config.ts` — config resolution, env var precedence
4. Add integration tests for domain tools (mocked HTTP)
5. Add end-to-end smoke tests against live servers (opt-in, skip when unreachable)

## Medium Priority

### Calibre Enhancements

| Feature | Notes |
|---------|-------|
| **MOBI/AZW3 reading** | EPUB reading works; MOBI would need a Python subprocess with `ebooklib` or `mobi-tools` |
| **Library sync / caching** | Cache downloaded ebooks and metadata locally; track what's already cached |
| **Full-text search** | Calibre's OPDS is metadata-only; full-text would require downloading and indexing book content |
| **Cover image download** | Calibre OPDS includes cover thumbnails but no tool exposes them |
| **Browse by series/publisher** | Calibre supports `/opds/entries/by_series` and `/opds/entries/by_publisher` but they aren't exposed as tools |

### Config Improvements

| Config field | Purpose |
|-------------|---------|
| `calibre.download_dir` | Dedicated config for ebook download directory (currently hardcoded to `~/pibrarian/downloads/books`) |
| `calibre.cache_dir` | Directory for caching metadata/embeddings |
