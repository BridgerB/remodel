## Project Configuration

- **Language**: TypeScript
- **Package Manager**: npm
- **Add-ons**: vitest, playwright, sveltekit-adapter, drizzle, better-auth, mcp

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, GPU-backed backend for two house-photo AI tools, wired together with a Nix flake (NixOS, single NVIDIA GPU at `CUDA_VISIBLE_DEVICES=0`):

- **image → image** house remodel — FLUX.2 klein-9b via ComfyUI
- **image → text** house description — gemma3:27b via Ollama

All logic lives in `services/` as TypeScript. The flake (`flake.nix`) is the entry point: it defines `nix run .#<app>` commands and the runtime environment. There is no build step and (currently) no test suite — `package.json` only defines `lint`/`fmt`.

## Commands

Everything is driven through the flake apps (each auto-starts the servers it needs):

```sh
nix run .#bootstrap                                   # one-time: download ~35GB of models/venv/ComfyUI into ./data
nix run .#describe -- --image house.jpg               # also: --dir <folder>, repeated --image, or positional paths/urls
nix run .#remodel  -- --image house.jpg --prompt "…"  # opts: --seed --steps --mp --name
nix run .#api                                         # HTTP API on 127.0.0.1:8090 (POST /describe, /remodel; GET /health)
nix run .#serve-comfy   /   nix run .#serve-ollama     # run a server in the foreground explicitly
nix run .#lint   /   nix run .#fmt                     # Biome check / check --write over services/
```

Run a single TS file directly during dev (Node 24 strips types, no flags/transpile): `node services/remodel.ts --image … --prompt …` — but the FLUX path needs ComfyUI already up on `:8189` (use the flake app, which guarantees it). Lint/format can also be run as `cd services && npm run lint|fmt`.

## Architecture

**Servers and ports (non-default, deliberately isolated):**
- ComfyUI → `127.0.0.1:8189`
- Ollama → `127.0.0.1:11435` (not the default `11434`; bootstrap pulls models on `11436`)
- API → `127.0.0.1:8090`, reached from a laptop via `ssh -N -L 8090:localhost:8090 bridger@<box>`

**The GPU is the shared constraint.** gemma3 (~19GB) and FLUX.2 9b cannot both be resident. `api.ts` calls `unloadGemma()` (an Ollama `keep_alive: 0` request) before every `/remodel` so the GPU/RAM is free. `describe.ts` manages this for batches via `planKeepAlive`: warm-load once, keep alive `5m` between images, then `keep_alive: 0` after the last image to evict (override with `REMODEL_KEEP_ALIVE`).

**Two runtimes, split on purpose (see `flake.nix`):**
- ComfyUI + `bootstrap` run inside an **FHS sandbox** (`buildFHSEnv`) so the pip-installed CUDA wheels (torch cu124 / 2.6.0, pinned in `setupVenv`) can find `libcuda` on NixOS.
- The Node client scripts run **outside** the sandbox — they only speak HTTP to the servers, so they don't need it.

**`services/remodel.ts`** is the FLUX path. `buildGraph()` constructs a ComfyUI prompt graph and is *reference-based editing*, not classic img2img: the source image is VAE-encoded and fed as `ReferenceLatent` while sampling starts from an `EmptyFlux2LatentImage` (cfg 1.0, euler, default 4 steps because klein is distilled). It POSTs the graph to ComfyUI, polls `/history/<id>` for completion, and picks the newest `remodel_out*.png` by mtime. `prepareInput` runs every source through `ffmpeg` into a PNG in ComfyUI's input dir first.

**`services/describe.ts`** POSTs a base64 image to Ollama's `/api/generate` with `format: SCHEMA` (a strict JSON schema → structured `HouseDescription` output) and a real-estate-appraiser `PROMPT`. Falls back to `{full_description: raw}` if the response isn't valid JSON. Writes a `desc_<stem>.json` per image into `data/out`.

**`services/api.ts`** is a dependency-free `node:http` server that *reuses the core functions exported by the two CLIs* (`runRemodel`, `writeInput`, `describeOne`) — the CLI and API share one implementation. It accepts an image as a raw `image/*` body or JSON `{image_url | image_b64, …}`.

**`services/bootstrap.ts`** is the one-time installer: clones ComfyUI + the ComfyUI-GGUF custom node, builds the venv, downloads the three FLUX model files (GGUF unet, qwen text encoder, flux2 vae) and pulls `gemma3:27b`. Idempotent — it skips anything already present.

## Conventions and runtime layout

- **`./data` holds everything heavy** (models, venv, ComfyUI, Ollama models, outputs) and is gitignored; it sits next to the working tree on the big drive. Code resolves it via `REMODEL_DATA` (and the repo via `REMODEL_REPO`), both defaulted in the flake's `preamble`. Don't hardcode paths — read these env vars.
- **Node 24 runs `.ts` directly** via type-stripping; keep code to syntax Node can strip (no enums, no `namespace`, no decorators needing transform).
- **Biome** formats/lints (`services/biome.json`): tabs, double quotes, recommended rules, organize-imports on.
- The code favors small pure functions (e.g. `buildGraph`, `planKeepAlive`, `parseResponse`) separated from the IO/`main()`; each CLI guards `main()` with `if (process.argv[1] === fileURLToPath(import.meta.url))` so it's importable without running.
