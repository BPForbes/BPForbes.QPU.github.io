# Claude instructions

These rules apply to Claude Code, Claude in Cursor, and other Anthropic assistants working in this repository.

Shared agent policy (protected assets, QPU conventions, Correction Lab behavior, and pull-request hygiene) lives in `@AGENTS.md`. Read and follow it before making changes.

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the Vite dev server
- `npm run build` — typecheck (`tsc -b`) and production build
- `npm test` — run the Vitest regression suite once
- `npm run test:watch` — run Vitest in watch mode

Run `npm test` after parser, catalog, simulator, or correction-flow changes. Vitest does not support Jest-style `--runInBand`.

## Architecture

React + TypeScript + Vite app for editing, simulating, and correcting QPU circuits.

| Area | Location | Role |
| --- | --- | --- |
| App shell | `src/App.tsx` | UI orchestration, uploads, catalog wiring, correction lab |
| Simulator engine | `src/simulator/engine.ts` | Sequencing, conditions, checkpoints, tracing; delegates state changes to physics |
| Physics engine | `src/simulator/physics/` | `PhysicsEngine`: state evolution, measurement, reduced states, entanglement, noise, fidelity, frequency/pulses |
| QPU compiler | `src/simulator/compiler/` | AST parsing (`qpuAst.ts`), serialization (`qpuFormat.ts`), truth tables |
| Gate registry | `src/simulator/gates/` | Built-in and custom gate definitions |
| Correction flows | `src/simulator/correction/` | Intent parsing, child-process fixes, circuit corrector |
| Correction LLM | `src/simulator/llm/` | Browser WebLLM and Ollama intent parsers |
| Process catalog | `src/data/catalog/` | Bundled processes, protected metadata, agent rules |
| File formats | `src/data/formats/` | `.qpucir` / `.qpuio` parsing and naming |
| Bundled fixtures | `src/data/processes/` | Canonical bundled protocol and truth-table files |

Tests live beside their modules in `tests/` subdirectories (for example `src/data/catalog/tests/`, `src/simulator/tests/`).

## Coding conventions

- Minimize scope: make the smallest correct change; do not refactor unrelated code.
- Match surrounding style, naming, imports, and abstractions.
- Prefer extending existing helpers over reimplementing similar logic.
- Add comments only for non-obvious business logic; avoid tautological filler.
- Add tests when changing parsers, catalog behavior, or child-process correction flows.
- Do not edit bundled or site-provided `.qpuio` files for `SingleBitFullAdder`, `TwoBitFullAdder`, `FourBitFullAdder`, or `PhaseDemo`. Enforcement lives in `src/data/catalog/protectedQpuio.ts`.
- To change truth-table expectations for experiments, register a new uploaded or corrected catalog process instead of mutating bundled metadata.

## Correction Lab and LLM work

When touching natural-language correction, prompts, or intent parsing:

- Keep `AGENTS.md` and `src/data/catalog/agentRules.ts` aligned with protected-asset policy.
- Prefer catalog-safe actions: open processes, infer tables for user circuits, probe outputs, run tests, and gate-level protocol fixes.
- Do not emit intents that rewrite protected bundled truth tables.
- LLM settings and browser/Ollama backends are configured in `src/simulator/llm/config.ts`.

## Workflow for Claude sessions

1. Read relevant module comments and nearby tests before editing.
2. Implement the focused change; avoid drive-by cleanup.
3. Run targeted tests, then `npm test` when behavior may ripple.
4. Commit with a clear message describing what changed and why.
5. Keep bundled `.qpuio` diffs out of feature work unless a maintainer is intentionally refreshing canonical site metadata.

## Out of scope unless asked

- Rewriting protected bundled truth tables or `.qpuio` metadata
- Large documentation passes unrelated to the task
- Adding dependencies without a clear need
- Storing secrets, API keys, or personal paths in committed files
