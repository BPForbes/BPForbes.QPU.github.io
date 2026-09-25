import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Code outside physics/ must reach quantum physics through the PhysicsEngine class, not its kernels.
const SRC = join(__dirname, '..', '..', '..');
const PHYSICS = join(SRC, 'simulator', 'physics');
const ALLOWED_VALUE_MODULES = new Set(['PhysicsEngine', 'index', 'particleTracking', 'webGpu']);

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'tests' || name === 'node_modules' ? [] : sourceFiles(path);
  return /\.(ts|tsx)$/.test(name) ? [path] : [];
});

describe('Physics Engine boundary', () => {
  it('only imports physics values through the engine class, the tracker, or the index', () => {
    const violations = sourceFiles(SRC)
      .filter((file) => !file.startsWith(PHYSICS + sep))
      .flatMap((file) => {
        const text = readFileSync(file, 'utf8');
        const imports = [...text.matchAll(/^(import|export)\s+(?!type\b)[^;]*?from\s+'([^']*physics(?:\/[^']*)?)';/gms)];
        return imports.flatMap((match) => {
          const target = match[2].split('/physics')[1] ?? '';
          const module = target.replace(/^\//, '') || 'index';
          return ALLOWED_VALUE_MODULES.has(module) ? [] : [`${relative(SRC, file)} → ${match[2]}`];
        });
      });
    expect(violations).toEqual([]);
  });

  it('keeps amplitude arithmetic out of UI components', () => {
    const offenders = sourceFiles(join(SRC, 'components'))
      .filter((file) => /magnitudeSquared|\.re \*\*|\.re \* .*\.re/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
