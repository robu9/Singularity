# Singularity

Singularity is a local-first AI workspace that remembers your work. It captures screen activity and recordings on your machine, stores them in SQLite, and builds a **property graph of episodes and facts with its own embedded graph engine** — no database server to install. The Assistant, search, and the Memory view retrieve over that graph, including current vs superseded facts and explicit abstention when nothing matches. Voice input is push-to-talk dictation through AssemblyAI.

## Quick start

Need **Node.js 24**, **npm 11**, and a **Gemini API key**. An **AssemblyAI API key** is optional and enables dictation.

```bash
git clone https://github.com/robu9/Singularity.git
cd Singularity
cp .env.example .env
# set GEMINI_API_KEY (and optionally ASSEMBLYAI_API_KEY) in .env
npm install
npm run dev
```

`npm run dev` starts the capture API on `http://127.0.0.1:3030` and Vite + Electron (`http://localhost:1420`). That is the whole stack — memory lives inside the same SQLite file as your captures.

## Memory graph

Vector search cannot tell you whether a fact is still true, what it replaced, or that the answer is not in memory. Singularity ships its own small property-graph engine (`backend/src/memory/graph/`) on top of `node:sqlite`:

- **Nodes** have a string key, a label, and a JSON property bag; an FTS5 shadow index makes their text searchable.
- **Edges** are typed, directed, weighted, and unique per `(from, to, relation)`, so re-ingesting is idempotent.
- **Queries** are equality matches on properties, neighbour walks, bounded BFS traversal, and BM25 text search re-scored by token coverage.

These are **graph schema names**, not product vocabulary — none of them appear in the interface.

| Graph object | Role |
| --- | --- |
| `Episode` | A screen chunk, transcript, meeting, pinned note, or chat turn |
| `Fact` | A durable claim with `current`, `valid_from`, `valid_to` |
| `Session` | A multi-turn conversation spanning time |
| `App` | An application that episodes were captured in |
| `FOLLOWS` | Chronological chain of episodes |
| `SUPERSEDES` | Later fact replacing an earlier one |
| `RECORDED_AS` / `IN_SESSION` | Provenance from episode → fact → session |
| `CAPTURED_IN` / `SPOKEN_IN` | Episode → app, audio segment → meeting |

Chat retrieval searches **current** facts first, then superseded facts (labeled so the model must not treat them as live), then related episodes. If the graph has no match, Singularity injects an `[abstain]` instruction so the model says it does not know instead of inventing history.

Completed Assistant turns are written back into the graph automatically. Singularity conservatively extracts declarative key/value facts (for example, `I live in Austin`, `My city is Austin`, or `Project Atlas launch is Friday`) while ignoring questions and requests. A later fact with the same normalized subject becomes current, marks the earlier value inactive, and links the pair with `SUPERSEDES`. Replayed session payloads are idempotent and cannot make an older value current again.

## Dictation

The Assistant's **Dictate** button records a clip from the microphone (16 kHz mono PCM, up to two minutes), sends it to the local backend, and the backend forwards it to the [AssemblyAI Dictation API](https://www.assemblyai.com/docs/dictation). The tidied transcript is dropped into the input box for you to review and send. Nothing is streamed while you speak; only the finished clip leaves the machine, and only through the backend that holds the key.

Set `ASSEMBLYAI_API_KEY` in `.env`, or paste the key under **Settings → AI → Dictation** in the packaged app. Without a key the button is hidden.

## What you see

The interface deliberately speaks plain English rather than schema. The mapping:

| In the app | Underneath |
| --- | --- |
| **Assistant** | Chat over graph-retrieved context, typed or dictated |
| **History** | `frames` — screen snapshots with OCR text |
| **Routines** | `pipes` — scheduled automations |
| **Recordings** | `meetings` — audio, transcripts, summaries |
| **Memory** | The graph of `Episode` / `Fact` / `Session` / `App` |
| **Integrations** | Composio connectors |
| **Support** | Feedback and help |
| Snapshot / Audio segment / Memory | `frame` / `audio_chunk` / graph node |

Renaming anything in the left column is a UI-copy change only; the right column is schema and is never renamed without a migration.

## What you can do

Singularity follows a **Capture → Remember → Act** loop:

- **Capture** screen snapshots locally (deduplicated JPEG/MP4, OCR)
- **Capture** meeting audio, then transcribe, summarize, and extract action items
- **Remember** — everything becomes a queryable graph you can inspect in **Memory**
- **Act** — search your history with SQLite FTS5 (`Ctrl/Cmd+K`)
- **Act** — ask the **Assistant** (typed or dictated) with graph-retrieved context plus Gemini
- **Act** — run built-in **Routines** (Daily Summary, Meeting Recap, Focus Tracker, Action Items)
- Optionally connect Gmail, Calendar, Slack, and Notion through **Integrations**

## Local data

| Data | Where |
| --- | --- |
| Screenshots, video, audio, OCR, SQLite, memory graph | `~/.singularity/` |
| Capture API | `http://127.0.0.1:3030` |
| Chat, meeting STT, summaries | Retrieved graph snippets are sent to Gemini when an API key is set |
| Dictation | Finished voice clips are sent to AssemblyAI when an API key is set |

## Ingest a chat session (graph memory)

```bash
curl -s http://127.0.0.1:3030/memory/sessions \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"demo-1\",\"turns\":[{\"role\":\"user\",\"content\":\"I live in Austin\"},{\"role\":\"assistant\",\"content\":\"Noted.\"}]}"
```

A later session with a different city writes a new `Fact` and a `SUPERSEDES` edge. Chat questions about the current city should use the new fact; questions about the old city should treat it as replaced.

## Verify temporal memory

With the backend running, execute:

```bash
npm run eval:memory
```

The deterministic smoke evaluation ingests an old and a new value for the same fact slot, queries the retrieval layer directly, and checks three behaviors: the new value is tagged `[current]`, the old value is tagged `[superseded]`, and an unknown query produces `[abstain]`. It does not depend on Gemini wording.

## Architecture

```
Renderer (React) --IPC--> Electron main
                              |-- Hono capture API :3030
                                    |-- Capture engine (screen / OCR / audio)
                                    |-- SQLite + FTS5
                                    |-- Embedded graph memory (nodes / edges / FTS)
                                    |-- Gemini chat / summaries / pipes
                                    |-- AssemblyAI dictation proxy
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend + Vite/Electron |
| `npm run eval:memory` | Verify current, superseded, and abstention retrieval |
| `npm run typecheck` | Typecheck the desktop app |
| `npm test` | Runtime policy, fact extraction, and graph engine tests |
| `npm run build:win` | Windows installer |
| `npm run build:mac` | macOS DMG |
| `npm run build:linux` | Linux AppImage |

## License

MIT.
