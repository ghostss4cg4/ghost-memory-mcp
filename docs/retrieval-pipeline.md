# NANCE Retrieval Pipeline

## Current State (Live)

Stage 1 — Qdrant cosine similarity is **already live** in the Worker.
Zero extra code needed — Qdrant handles it natively via `memory.vector.search`.

---

## Planned: 3-Stage Pipeline

### Stage 1 — Coarse Filter (✅ Live)
- Cosine similarity between query embedding and chunk embeddings
- Handled by Qdrant natively
- Returns top-N candidates

### Stage 2 — LLMLingua-2 Compression (🔲 Planned)

Microsoft open-source token compressor. Reduces retrieved context by ~70%
before Claude sees it — major token cost reduction.

```python
from llmlingua import PromptCompressor
compressor = PromptCompressor()
result = compressor.compress_prompt(your_text, rate=0.3)
```

**Hosting constraint:** LLMLingua needs ~1-2GB model — cannot run on Cloudflare Worker.

**Plan:** Deploy as a Hugging Face Space (free tier).
Worker calls this endpoint after Stage 1, before returning results to Claude.

**Latency cost:** ~2-4 seconds. Acceptable for memory lookups.

### Stage 3 — Terse Schema Formatting (🔲 Planned)

Pure prompt engineering. Converts retrieved chunks into a compact
consistent schema before injecting into Claude's context window.

Can run inside the Worker itself — no extra infra needed.
Do this before Stage 2 (zero cost, immediate win).

---

## Implementation Order

1. ✅ Stage 1 — live
2. 🔲 Stage 3 first — zero infra, pure prompting
3. 🔲 Stage 2 last — needs HF Space, highest complexity

---

## Token Budget (Target)

| Layer | Tokens |
|-------|--------|
| Redis graph snapshot | ~200 |
| Qdrant top-5 raw results | ~800 |
| After LLMLingua-2 (0.3 rate) | ~240 |
| After terse schema | ~150 |
| **Total context injection** | **~350–400** |
