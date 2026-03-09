# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Devs 4 course project — a collection of TypeScript scripts for interacting with the AG3NTS hub platform (hub.ag3nts.org). 
Each task/exercise is first  as a standalone script under `playground/`.

## Tech Stack

- **Runtime:** Bun (not Node.js)
- **Language:** TypeScript (strict mode, ESNext target, bundler module resolution)
- **No build step:** Bun runs `.ts` files directly (`bun run <file>`)

## Commands

```bash
bun install                          # Install dependencies
bun run <path/to/script.ts>          # Run any script directly
bun run download_file_from_hub       # Run via package.json script alias
```

## Project Structure

- `playground/<task_name>/` — each task gets its own directory with a main `.ts` file and an `output/` folder (gitignored) for downloaded/generated artifacts
- `src/` — final complex solution (currently empty; place reusable helpers here)
- `index.ts` — project entry point (placeholder)

## Environment

- Copy `.env.example` to `.env` and set `HUB_API_KEY` to your AG3NTS hub API key
- The hub URL pattern is `https://hub.ag3nts.org/data/{api-key}/filename.ext` — scripts inject the API key from env automatically

## Conventions

- Scripts use Bun-specific APIs (e.g., `Bun.write`, `import.meta.dir`)
- Output files go in each task's `output/` directory (gitignored via `.gitignore`)
- API keys are sanitized from all logged/returned URLs using `sanitizeUrl` patterns
