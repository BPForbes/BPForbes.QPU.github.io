# Project notes

## Test runner (`package.json`)

`package.json` cannot carry inline comments, so test-runner decisions are recorded here.

The simulator regression suite uses **Vitest** (`npm test` / `npm run test:watch`).

## Project metadata (`project-metadata.json`)

GitHub Pages publishes machine-readable repository metadata for bailey-forbes.com.

- Generator: `scripts/projectMetadata.mjs` (CLI: `scripts/generate-project-metadata.mjs`)
- Languages: GitHub REST Languages API, which uses GitHub Linguist (respects `.gitattributes`)
- Timeline: merged pull requests plus published releases/tags
- Output: `public/project-metadata.json` during CI, copied by Vite into `dist/`
- Public URL after deploy: `https://bpforbes.github.io/BPForbes.QPU.github.io/project-metadata.json`

Do not commit generated metadata. The deploy workflow regenerates it on every push to `main`.
