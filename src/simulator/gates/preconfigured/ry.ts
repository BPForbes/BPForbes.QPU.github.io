import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { applySingleQubitGate } from '../operations';
import { rotationYMatrix } from '../matrices';
// RY gate palette entry and apply hook for the shared registry.

export const ryGate: GateDefinition = {
  id: 'RY',
  category: 'preconfigured',
  label: 'RY',
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: true,
  cssClass: 'gate-ry',
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    const angle = gate.phase ?? 0;
    return {
      state: applySingleQubitGate(state, qubitCount, target, rotationYMatrix(angle)),
      measurements,
      log: [`RY(${angle.toFixed(3)}) rotated q${target}.`],
    };
  },
};
