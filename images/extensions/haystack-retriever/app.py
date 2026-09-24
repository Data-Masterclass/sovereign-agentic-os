#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
Haystack retrieval service — RAG retrieval over OpenSearch (Layer 2).

architecture.md: "Haystack retrieves from OpenSearch; LangGraph keeps agent
control flow." This is a Haystack pipeline (embed query -> OpenSearch kNN
retrieve) exposed over HTTP, embedding through the LiteLLM gateway so it stays
sovereign/consistent. Agents call /retrieve to get grounded context.

Plain stdlib HTTP server.  GET /retrieve?q=...   POST /ingest   GET /health
"""
import json
import os
import time
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from haystack import Document, Pipeline
from haystack.components.embedders import OpenAIDocumentEmbedder, OpenAITextEmbedder
from haystack.utils import Secret
from haystack_integrations.document_stores.opensearch import OpenSearchDocumentStore
from haystack_integrations.components.retrievers.opensearch import (
    OpenSearchEmbeddingRetriever,
)

LITELLM_BASE = os.environ.get("LITELLM_BASE_URL", "http://agentic-os-litellm:4000/v1")
LITELLM_KEY = os.environ.get("LITELLM_API_KEY", "")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "sovereign-embed")
OPENSEARCH_URL = os.environ.get("OPENSEARCH_URL", "http://opensearch:9200")
INDEX = os.environ.get("INDEX_NAME", "haystack_knowledge")
DIM = int(os.environ.get("KNN_DIMENSION", "384"))
TOP_K = int(os.environ.get("TOP_K", "3"))
PORT = int(os.environ.get("PORT", "8000"))

SAMPLE = [
    {"title": "Retrieval backbone",
     "text": "OpenSearch is the retrieval backbone, providing hybrid vector and lexical search."},
    {"title": "RAG pipelines",
     "text": "Haystack runs the RAG retrieval pipelines over OpenSearch, embedding via LiteLLM."},
    {"title": "Document parsing",
     "text": "Docling parses uploaded documents into clean markdown before they are embedded."},
    {"title": "Policy",
     "text": "OPA authorizes tool use at the boundary with default-deny policies."},
]

store = OpenSearchDocumentStore(hosts=OPENSEARCH_URL, index=INDEX, embedding_dim=DIM)
_key = Secret.from_token(LITELLM_KEY) if LITELLM_KEY else Secret.from_token("none")
doc_embedder = OpenAIDocumentEmbedder(api_key=_key, api_base_url=LITELLM_BASE, model=EMBED_MODEL)
text_embedder = OpenAITextEmbedder(api_key=_key, api_base_url=LITELLM_BASE, model=EMBED_MODEL)

pipe = Pipeline()
pipe.add_component("text_embedder", text_embedder)
pipe.add_component("retriever", OpenSearchEmbeddingRetriever(document_store=store, top_k=TOP_K))
pipe.connect("text_embedder.embedding", "retriever.query_embedding")


def ingest():
    if store.count_documents() > 0:
        return store.count_documents()
    docs = [Document(content=d["text"], meta={"title": d["title"]}) for d in SAMPLE]
    embedded = doc_embedder.run(documents=docs)["documents"]
    store.write_documents(embedded)
    return store.count_documents()


def retrieve(q):
    out = pipe.run({"text_embedder": {"text": q}})
    return [
        {"title": d.meta.get("title"), "content": d.content, "score": d.score}
        for d in out["retriever"]["documents"]
    ]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        print("[haystack] " + (fmt % a))

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/healthz", "/"):
            try:
                n = store.count_documents()
            except Exception:
                n = -1
            return self._send(200, {"status": "ok", "docs": n})
        if u.path == "/retrieve":
            q = (parse_qs(u.query).get("q") or [""])[0]
            if not q:
                return self._send(400, {"error": "missing q"})
            try:
                return self._send(200, {"query": q, "results": retrieve(q)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path == "/ingest":
            try:
                return self._send(200, {"ingested": ingest()})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})


def wait_and_ingest():
    for _ in range(60):
        try:
            store.count_documents()
            break
        except Exception:
            time.sleep(3)
    for attempt in range(10):
        try:
            print(f"[haystack] ingested {ingest()} docs")
            return
        except Exception as e:
            print(f"[haystack] ingest retry {attempt}: {e}")
            time.sleep(5)


def main():
    print(f"[haystack] starting on :{PORT} (index={INDEX}, dim={DIM})")
    wait_and_ingest()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
