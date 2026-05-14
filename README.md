# SearXNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) that integrates the [SearXNG](https://docs.searxng.org) API, giving AI assistants web search capabilities.

[![https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true](https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true)](https://www.npmjs.com/package/mcp-searxng)

## Vision Image Search (Fork Addition)

This fork adds **vision-based image search** powered by the [jina-embeddings-v5-omni-nano-retrieval](https://huggingface.co/jinaai/jina-embeddings-v5-omni-nano-retrieval) model. Unlike traditional keyword-based image search, this tool uses AI embeddings to understand how semantically related a text query is to the actual visual content of each image.

### How It Works

There are **two stages** of cosine similarity comparison, both against the same query embedding:

**Stage 1: Text filtering (title vs. query)**
- Query embedding (text) vs. each image's title text embedding
- Narrows ~100 SearXNG results down to top 25 candidates

**Stage 2: Vision filtering (image vs. query)** — this is where the embedding service matters
- Query embedding (text, e.g. "golden retriever puppy") vs. each candidate image's visual embedding (actual pixels)
- Filters by minScore (default 0.15), ranks by similarity descending

So the cosine similarity measures **how semantically related the user's text query is to each image's visual content**. Higher score = better match. The final results are sorted by this vision-stage similarity, with SearXNG's relevance score as a tiebreaker.

### Embedding Service Setup

Vision image search requires a separate Python FastAPI server running `jina-embeddings-v5-omni-nano-retrieval`. It provides an OpenAI-compatible `/v1/embeddings` endpoint for both text and image embeddings.

**Quick start (Docker on ROCm):**

```bash
docker build -t embedding-service -f Dockerfile.embedding .

docker run -d --gpus all \
  -p 8080:8080 \
  -v ${HOME}/.cache/huggingface:/root/.cache/huggingface \
  -e EMBEDDING_MODEL=jinaai/jina-embeddings-v5-omni-nano-retrieval \
  -e EMBEDDING_MODALITY=vision \
  -e EMBEDDING_PORT=8080 \
  embedding-service
```

**Quick start (local Python):**

```bash
python3 -m venv embedding-venv
source embedding-venv/bin/activate

# Install PyTorch with ROCm support (for AMD GPU)
pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm7.2
pip install -r requirements.txt

python embedding-service.py --modality vision --port 8080
```

Then set `EMBEDDING_SERVICE_URL=http://localhost:8080/v1` in your MCP client config.

Full setup details: [CONFIGURATION.md](CONFIGURATION.md) — Embedding Service section.

### New Tool

- **searxng_image_search_vision**
  - Execute vision-powered image searches using AI embeddings to match queries against actual image content
  - Combines SearXNG's web indexing with neural visual understanding for semantically relevant results
  - Inputs:
    - `query` (string): The search query for images
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `num` (number, optional): Maximum number of results to return. Default: 16, Max: 100
    - `minScore` (number, optional): Minimum cosine similarity threshold for vision-stage filtering. Results below this threshold are excluded. Default: 0.15, Range: 0-1
    - `time_range` (string, optional): Filter results by time range - one of: "day", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (number, optional): Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: 0)

## Quick Start

[![https://badgen.net/docker/pulls/isokoliuk/mcp-searxng](https://badgen.net/docker/pulls/isokoliuk/mcp-searxng)](https://hub.docker.com/r/isokoliuk/mcp-searxng)

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

## Quick Start

Add to your MCP client configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

Replace `YOUR_SEARXNG_INSTANCE_URL` with the URL of your SearXNG instance (e.g. `https://search.example.com`).

## Features

- **Web Search**: General queries, news, articles, with pagination.
- **Image Search**: Find images related to search queries with random result sampling.
- **URL Content Reading**: Advanced content extraction with pagination, section filtering, and heading extraction.
- **Intelligent Caching**: URL content is cached with TTL (Time-To-Live) to improve performance and reduce redundant requests.
- **Pagination**: Control which page of results to retrieve.
- **Time Filtering**: Filter results by time range (day, month, year).
- **Language Selection**: Filter results by preferred language.
- **Safe Search**: Control content filtering level for search results.

## How It Works

`mcp-searxng` is a standalone MCP server — a separate Node.js process that your AI assistant connects to for web search. It queries any SearXNG instance via its HTTP JSON API.

> **Not a SearXNG plugin:** This project cannot be installed as a native SearXNG plugin. Point it at any existing SearXNG instance by setting `SEARXNG_URL`.

```
AI Assistant (e.g. Claude)
        │  MCP protocol
        ▼
  mcp-searxng  (this project — Node.js process)
        │  HTTP JSON API  (SEARXNG_URL)
        ▼
  SearXNG instance
```

## Tools

- **searxng_web_search**
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): The search query. This string is passed to external search services.
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `time_range` (string, optional): Filter results by time range - one of: "day", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (number, optional): Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: instance setting)

- **searxng_image_search**
  - Execute image searches with pagination and result limiting
  - Returns formatted image results with title, image URL, thumbnail, source URL, source, dimensions, and relevance score
  - Note: SearXNG does not support a server-side result limit, so this tool uses a `num` parameter to truncate results client-side after fetching. Results are randomly shuffled before truncation to provide diverse sampling.
  - Inputs:
    - `query` (string): The search query for images
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `num` (number, optional): Maximum number of results to return (client-side limit). SearXNG does not support a server-side limit, so this truncates results after fetching. Default: 16, Max: 100
    - `time_range` (string, optional): Filter results by time range - one of: "day", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (number, optional): Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: 0)

- **web_url_read**
  - Read and convert the content from a URL to markdown with advanced content extraction options
  - Inputs:
    - `url` (string): The URL to fetch and process
    - `startChar` (number, optional): Starting character position for content extraction (default: 0)
    - `maxLength` (number, optional): Maximum number of characters to return
    - `section` (string, optional): Extract content under a specific heading (searches for heading text)
    - `paragraphRange` (string, optional): Return specific paragraph ranges (e.g., '1-5', '3', '10-')
    - `readHeadings` (boolean, optional): Return only a list of headings instead of full content

## Installation

<details>
<summary>NPM (global install)</summary>

```bash
npm install -g mcp-searxng
```

```json
{
  "mcpServers": {
    "searxng": {
      "command": "mcp-searxng",
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

</details>

<details>
<summary>Docker</summary>

**Pre-built image:**

```bash
docker pull isokoliuk/mcp-searxng:latest
```

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

To pass additional env vars, add `-e VAR_NAME` to `args` and the variable to `env`.

**Build locally:**

```bash
docker build -t mcp-searxng:latest -f Dockerfile .
```

Use the same config above, replacing `isokoliuk/mcp-searxng:latest` with `mcp-searxng:latest`.

</details>

<details>
<summary>Docker Compose</summary>

`docker-compose.yml`:

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=YOUR_SEARXNG_INSTANCE_URL
      # Add optional variables as needed — see CONFIGURATION.md
```

MCP client config:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker-compose",
      "args": ["run", "--rm", "mcp-searxng"]
    }
  }
}
```

</details>

<details>
<summary>HTTP Transport</summary>

By default the server uses STDIO. Set `MCP_HTTP_PORT` to enable HTTP mode:

```json
{
  "mcpServers": {
    "searxng-http": {
      "command": "mcp-searxng",
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "MCP_HTTP_PORT": "3000"
      }
    }
  }
}
```

**Endpoints:** `POST/GET/DELETE /mcp` (MCP protocol), `GET /health` (health check)

**Test it:**

```bash
MCP_HTTP_PORT=3000 SEARXNG_URL=http://localhost:8080 mcp-searxng
curl http://localhost:3000/health
```

</details>

## Configuration

Set `SEARXNG_URL` to your SearXNG instance URL. All other variables are optional.

### HTTP Transport Configuration

When using HTTP mode (`MCP_HTTP_PORT` is set), you can configure the bind address:

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_HTTP_PORT` | Port to listen on (enables HTTP mode) | — |
| `MCP_HTTP_HOST` | Bind address (use `0.0.0.0` for all interfaces) | `127.0.0.1` |

Example for remote access:

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_HOST=0.0.0.0 SEARXNG_URL=https://search.example.com mcp-searxng
```

Full environment variable reference: [CONFIGURATION.md](CONFIGURATION.md)

## Troubleshooting

### 403 Forbidden from SearXNG

Your SearXNG instance likely has JSON format disabled. Edit `settings.yml` (usually `/etc/searxng/settings.yml`):

```yaml
search:
  formats:
    - html
    - json
```

Restart SearXNG (`docker restart searxng`) then verify:

```bash
curl 'http://localhost:8080/search?q=test&format=json'
```

You should receive a JSON response. If not, confirm the file is correctly mounted and YAML indentation is valid.

See also: [SearXNG settings docs](https://docs.searxng.org/admin/settings/settings.html) · [discussion](https://github.com/searxng/searxng/discussions/1789)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE) for details.
