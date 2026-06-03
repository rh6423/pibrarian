# pibrarian

## Status

beta. Works well for me, but there may be some cracks in the pavement here and there.

## Philosophy

There should be a way to connect LLMs with media libraries. Pibrarian was built to automate common media tasks for my workflows, and I'm sharing it because there's nothing else in the Pi ecosystem that talks to ODPS libraries like Calirbre.

## Hey Pibrarian, introduce yourself in your own mechanical words!

Multi-domain content library extension for [pi](https://pi.dev). Integrates with Calibre (books), Komga (comics), and Jellyfin (movies/TV) to give the LLM tools for searching, reading, downloading, and processing your media libraries.

## Features

### Books (Calibre)
- **Search** ebooks by title, author, keyword, or description
- **Browse** library sorted by title, author, or tag
- **Get details** — full metadata including authors, series, tags, formats
- **Download** ebooks (EPUB, MOBI, PDF, etc.) to local disk
- **Read chapters** from EPUB files — list chapters, read by number or title

### Comics
- Extract individual panels from comic book pages using vision model
- Search and read comics

> **Status:** Panel extraction is fully implemented. Search/read are placeholders (Komga integration pending).

### Media (Jellyfin)
- **Search** movies and TV shows by title, genre, year, actor
- **List** movies/shows with filters (year, genre, rating, sort)
- **List episodes** for TV shows or specific seasons
- **Get details** — full metadata including cast, external IDs, media sources
- **Download** movies or episodes to local disk
- **Extract scenes/clips** at specific timestamps (ffmpeg)
- **Extract frames** evenly across a video or within a time range
- **Detect scenes** automatically (ffmpeg or PySceneDetect)
- **Save scene images** — representative frames from each scene
- **Split into scenes** — cut video into individual scene clips

## Installation

### From git (GitHub)

```bash
pi install git:github.com/<your-username>/pibrarian@v0.1.0
```

### From npm (after publishing)

```bash
pi install npm:pibrarian@0.1.0
```

### Local development

```bash
# Clone into your extensions directory
git clone https://github.com/<your-username>/pibrarian.git ~/.pi/agent/extensions/pibrarian
cd ~/.pi/agent/extensions/pibrarian
npm install
```

## Configuration

Copy `config.json.example` to `config.json` and fill in your endpoints:

```bash
cp config.json.example config.json
```

### Config fields

| Section | Field | Description |
|---------|-------|-------------|
| `vision` | `baseUrl` | OpenAI-compatible vision model endpoint |
| | `model` | Vision model ID (e.g. `qwen3.6-27B`) |
| `embedding` | `baseUrl` | OpenAI-compatible embeddings endpoint |
| | `model` | Embedding model ID (e.g. `nomic-embed-text`) |
| `calibre` | `opdsUrl` | Calibre OPDS web server URL |
| | `username` | Calibre Content Server username (optional) |
| | `password` | Calibre Content Server password (optional) |
| `jellyfin` | `baseUrl` | Jellyfin server URL |
| | `apiKey` | Jellyfin API key (optional) |
| `scene_detect` | `venvPath` | Path to Python venv with `scenedetect[opencv]` (optional) |
| | `pythonBinary` | Python binary for creating the venv |

### Environment variables (override config file)

| Variable | Config field |
|----------|-------------|
| `PIBRARIAN_VISION_BASE_URL` | vision.baseUrl |
| `PIBRARIAN_VISION_MODEL` | vision.model |
| `PIBRARIAN_EMBEDDING_BASE_URL` | embedding.baseUrl |
| `PIBRARIAN_EMBEDDING_MODEL` | embedding.model |
| `PIBRARIAN_CALIBRE_URL` | calibre.opdsUrl |
| `PIBRARIAN_CALIBRE_USERNAME` | calibre.username |
| `PIBRARIAN_CALIBRE_PASSWORD` | calibre.password |
| `PIBRARIAN_JELLYFIN_URL` | jellyfin.baseUrl |
| `PIBRARIAN_JELLYFIN_API_KEY` | jellyfin.apiKey |
| `PIBRARIAN_JELLYFIN_USER_ID` | jellyfin.userId |
| `PIBRARIAN_JELLYFIN_TOKEN` | jellyfin.token |
| `PIBRARIAN_SCENEDETECT_VENV` | sceneDetect.venvPath |
| `PIBRARIAN_SCENEDETECT_PYTHON` | sceneDetect.pythonBinary |

### Jellyfin Authentication

After configuring your Jellyfin URL, authenticate:

```
/pibrarian-jellyfin-login <username> <password>
```

This stores your userId and token in `config.json` under `jellyfin_auth`.

## Commands

| Command | Description |
|---------|-------------|
| `/pibrarian-activate <domain\|all>` | Activate domain tools (books, comics, media) |
| `/pibrarian-deactivate <domain\|all>` | Deactivate domain tools |
| `/pibrarian-status` | Show domain activation status |
| `/pibrarian-jellyfin-login <user> <pass>` | Authenticate with Jellyfin |

## Dependencies

- **ffmpeg/ffprobe** — Required for all media tools. Must be on PATH.
- **Python 3.12+** — Optional, for PySceneDetect (higher accuracy scene detection)
- **sharp** — Native Node.js module for image processing (panel extraction)

## Scene Detection Backends

### ffmpeg (default)
- Fast, no extra dependencies
- Uses ffmpeg's built-in scene filter
- Threshold: 0.3–0.6 (default 0.4)

### PySceneDetect (opt-in)
- Higher accuracy
- Requires a Python venv with `scenedetect[opencv]`
- Set `scene_detect.venvPath` in config
- Pass `use_scenedetect=true` to detect/save/split tools
- Threshold: 23–40 (default 32)

## License

Apache 2.0
