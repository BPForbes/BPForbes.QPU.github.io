import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { getGateDefinition, preconfiguredPaletteGates } from '../../../simulator/gates/registry';
import { docTargets, gateDocTarget, gateHelp, workbenchSelectorUse, type QpuGuideFile } from '../learningHelp';

const repositoryRoot = new URL('../../../../', import.meta.url);

// Named destinations come from \hypertarget and from \GateHeading, which emits gate-<ID>.
const namedDestinations = (file: QpuGuideFile) => {
  const entry = readFileSync(new URL(`docs/${file.replace(/\.pdf$/, '.tex')}`, repositoryRoot), 'utf8');
  const sources = [...entry.matchAll(/\\input\{([^}]+)\}/g)].map((match) => readFileSync(new URL(match[1], repositoryRoot), 'utf8'));
  return new Set(sources.flatMap((tex) => [
    ...[...tex.matchAll(/\\hypertarget\{([^}]+)\}/g)].map((match) => match[1]),
    ...[...tex.matchAll(/\\GateHeading\{[^}]*\}\{([^}]+)\}/g)].map((match) => `gate-${match[1]}`),
  ]));
};

describe('learning help', () => {
  it('explains every preconfigured palette gate', () => {
    preconfiguredPaletteGates().forEach((gate) => {
      expect(gateHelp[gate.id], gate.id).toBeDefined();
    });
  });

  it('links only to named destinations that exist in the linked guide', () => {
    const targets = [
      ...Object.values(docTargets),
      ...preconfiguredPaletteGates().map((gate) => gateDocTarget(gate.id)),
    ];
    targets.forEach((target) => {
      expect(namedDestinations(target.file).has(target.anchor), `${target.file}#${target.anchor}`).toBe(true);
    });
  });

  it('reports which workbench selectors each gate reads', () => {
    expect(workbenchSelectorUse(getGateDefinition('H'))).toEqual({ controlA: false, controlB: false, phase: false });
    expect(workbenchSelectorUse(getGateDefinition('CNOT'))).toEqual({ controlA: true, controlB: false, phase: false });
    expect(workbenchSelectorUse(getGateDefinition('CCNOT'))).toEqual({ controlA: true, controlB: true, phase: false });
    expect(workbenchSelectorUse(getGateDefinition('AND'))).toEqual({ controlA: true, controlB: true, phase: false });
    expect(workbenchSelectorUse(getGateDefinition('SWAP'))).toEqual({ controlA: false, controlB: true, phase: false });
    expect(workbenchSelectorUse(getGateDefinition('PHASE'))).toEqual({ controlA: false, controlB: false, phase: true });
  });
});
