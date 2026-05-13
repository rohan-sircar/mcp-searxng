#!/usr/bin/env python3
"""
Python-based image embedding service using jina-embeddings-v5-omni-nano-retrieval.

Provides an OpenAI-compatible /v1/embeddings endpoint for text and image embeddings.
Served via FastAPI + sentence-transformers with selective modality loading.
"""

import argparse
import base64
import io
import logging
import os
import sys
import torch
from typing import Any, List, Optional, Union

from fastapi import FastAPI, HTTPException, Response
from PIL import Image
from sentence_transformers import SentenceTransformer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Jina Embedding Service",
    description="OpenAI-compatible embedding endpoint using jina-embeddings-v5-omni-nano-retrieval",
    version="1.0.0",
)

_model: Optional[SentenceTransformer] = None
_MODEL_NAME: str = ""
_MODALITY: str = ""


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model() -> SentenceTransformer:
    """Load the jina-embeddings-v5-omni-nano-retrieval model with selective modality."""
    logger.info(
        "Loading model '%s' with modality='%s' ...", _MODEL_NAME or "jinaai/jina-embeddings-v5-omni-nano-retrieval", _MODALITY or "vision"
    )
    model = SentenceTransformer(
        _MODEL_NAME,
        trust_remote_code=True,
        model_kwargs={"modality": _MODALITY},
    )
    logger.info(
        "Model loaded successfully. Dimension=%d, Device=%s",
        model.get_sentence_embedding_dimension(),
        str(model.device),
    )
    return model


# ---------------------------------------------------------------------------
# Request / Response schemas (lightweight — no extra dependency)
# ---------------------------------------------------------------------------

def _parse_input(raw: Any) -> list[dict[str, Any]]:
    """Normalise the ``input`` field into a list of item dicts.

    OpenAI-compatible format accepts:
      - str          → ["<text>"]
      - list[str]    → as-is (text batch)
      - list[dict]   → already parsed (may contain image_url keys)
    """
    if isinstance(raw, str):
        return [{"type": "text", "text": raw}]

    if not isinstance(raw, list):
        raise ValueError("input must be a string or list")

    items: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, str):
            items.append({"type": "text", "text": item})
        elif isinstance(item, dict):
            items.append(item)
        else:
            raise ValueError(f"Unsupported input item type: {type(item)}")
    return items


def _encode_text(text: str, is_query: bool = True) -> List[float]:
    """Encode a text string into an embedding vector."""
    if is_query:
        vec = _model.encode_query(text)
    else:
        vec = _model.encode_document(text)
    # sentence-transformers may return numpy array
    return vec.tolist()


def _encode_image(base64_str: str) -> List[float]:
    """Decode a base64 image string and encode it into an embedding vector."""
    if not base64_str:
        raise HTTPException(status_code=400, detail="Empty base64 image data")

    try:
        raw_bytes = base64.b64decode(base64_str)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {exc}")

    if len(raw_bytes) == 0:
        raise HTTPException(status_code=400, detail="Decoded image data is empty")

    if len(raw_bytes) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"Image data too large: {len(raw_bytes)} bytes (max 50MB)",
        )

    try:
        image = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Failed to decode image: {exc}"
        )

    # The jina-embeddings-v5-omni processor expects `images` as a list, not a
    # single PIL Image. Also the default bf16 weights cause "unsupported
    # ScalarType BFloat16" inside embed() due to embedding lookup limitations.
    # fp16 works and uses ~47% less VRAM than fp32 with identical embeddings.
    try:
        proc = _model.processor
        raw_model = _model.transformers_model

        if raw_model.dtype != torch.float16:
            raw_model = raw_model.to(torch.float16)

        inputs = proc(images=[image], text="<image>", return_tensors="pt")
        with torch.no_grad():
            vec = raw_model.embed(**{k: v.to(raw_model.device) for k, v in inputs.items()})
            vec = vec[0].cpu().numpy()
    except Exception as exc:
        logger.warning("Raw transformers path failed (%s), falling back", exc)
        try:
            vec = _model.encode([image])[0]
        except Exception:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to encode image with any method: {exc}",
            )

    return vec.tolist()


# ---------------------------------------------------------------------------
# OpenAI-compatible /v1/embeddings endpoint
# ---------------------------------------------------------------------------

@app.post("/v1/embeddings")
async def create_embeddings(body: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-compatible embeddings endpoint.

    Accepts text and image inputs, returns normalised embeddings in the
    shared vector space.
    """
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    logger.info("Received embeddings request: keys=%s model=%s", list(body.keys()), body.get("model", "<none>"))

    input_raw = body.get("input")
    if input_raw is None:
        raise HTTPException(status_code=400, detail="'input' field is required")

    model_name: str = body.get("model", _MODEL_NAME)
    prompt_name: str = body.get("prompt_name", "query")
    is_query = prompt_name == "query"

    items = _parse_input(input_raw)
    embeddings: List[dict[str, Any]] = []

    for idx, item in enumerate(items):
        # --- Text input --------------------------------------------------
        if item.get("type") == "text" or "text" in item and "image_url" not in item:
            text = str(item["text"])
            emb = _encode_text(text, is_query=is_query)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        # --- Image input (OpenAI format: {"image_url": {"url": "data:image/...;base64,..."}})
        if "image_url" in item:
            url = item["image_url"]
            if isinstance(url, dict):
                url = url.get("url", "")
            # Strip data URI prefix if present
            if "," in url:
                url = url.split(",", 1)[1]
            emb = _encode_image(url)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        # --- Fallback: try text first, then image_url --------------------
        if "text" in item:
            text = str(item["text"])
            emb = _encode_text(text, is_query=is_query)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        if "image_url" in item:
            url = item["image_url"]
            if isinstance(url, dict):
                url = url.get("url", "")
            if "," in url:
                url = url.split(",", 1)[1]
            emb = _encode_image(url)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        raise HTTPException(
            status_code=400,
            detail=f"Cannot determine modality for input item: {item}",
        )

    return {
        "data": embeddings,
        "model": model_name,
        "object": "list",
    }

    model_name: str = body.get("model", _MODEL_NAME)
    prompt_name: str = body.get("prompt_name", "query")
    is_query = prompt_name == "query"

    items = _parse_input(input_raw)
    embeddings: List[dict[str, Any]] = []

    for idx, item in enumerate(items):
        # --- Text input --------------------------------------------------
        if item.get("type") == "text" or "text" in item and "image_url" not in item:
            text = str(item["text"])
            emb = _encode_text(text, is_query=is_query)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        # --- Image input (OpenAI format: {"image_url": {"url": "data:image/...;base64,..."}})
        if "image_url" in item:
            url = item["image_url"]
            if isinstance(url, dict):
                url = url.get("url", "")
            # Strip data URI prefix if present
            if "," in url:
                url = url.split(",", 1)[1]
            emb = _encode_image(url)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        # --- Fallback: try text first, then image_url --------------------
        if "text" in item:
            text = str(item["text"])
            emb = _encode_text(text, is_query=is_query)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        if "image_url" in item:
            url = item["image_url"]
            if isinstance(url, dict):
                url = url.get("url", "")
            if "," in url:
                url = url.split(",", 1)[1]
            emb = _encode_image(url)
            embeddings.append({
                "index": idx,
                "embedding": emb,
                "object": "embedding",
            })
            continue

        raise HTTPException(
            status_code=400,
            detail=f"Cannot determine modality for input item: {item}",
        )

    return {
        "data": embeddings,
        "model": model_name,
        "object": "list",
    }


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict[str, Any]:
    """Health check — returns model info and embedding dimension."""
    if _model is None:
        return {
            "status": "degraded",
            "model": _MODEL_NAME,
            "modality": _MODALITY,
            "dimension": 0,
            "error": "Model not loaded",
        }

    dim = _model.get_sentence_embedding_dimension()
    return {
        "status": "ok",
        "model": _MODEL_NAME,
        "modality": _MODALITY,
        "dimension": dim,
        "device": str(_model.device),
    }


# ---------------------------------------------------------------------------
# Main / CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Jina Embedding Service — OpenAI-compatible endpoint"
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("EMBEDDING_MODEL", "jinaai/jina-embeddings-v5-omni-nano-retrieval"),
        help="Model name / HuggingFace repo (default: EMBEDDING_MODEL env or jinaai/jina-embeddings-v5-omni-nano-retrieval)",
    )
    parser.add_argument(
        "--modality",
        default=os.environ.get("EMBEDDING_MODALITY", "vision"),
        choices=["text", "vision", "audio", "omni"],
        help="Selective modality to load (default: EMBEDDING_MODALITY env or 'vision')",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("EMBEDDING_PORT", "8080")),
        help="Port to listen on (default: EMBEDDING_PORT env or 8080)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("EMBEDDING_HOST", "127.0.0.1"),
        help="Host to bind (default: EMBEDDING_HOST env or 127.0.0.1)",
    )
    args = parser.parse_args()

    global _MODEL_NAME, _MODALITY
    _MODEL_NAME = args.model
    _MODALITY = args.modality

    if not _MODEL_NAME or not _MODALITY:
        logger.error("MODEL_NAME and MODALITY must be set via CLI args or env vars")
        sys.exit(1)

    try:
        model = load_model()
    except Exception:
        logger.exception("Failed to load model. Check that torch and sentence-transformers are installed.")
        sys.exit(1)

    global _model
    _model = model

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
