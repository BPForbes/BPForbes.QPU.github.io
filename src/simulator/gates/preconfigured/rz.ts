import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { applySingleQubitGate } from '../operations';
import { rotationZMatrix } from '../matrices';
// RZ gate palette entry and apply hook for the shared registry.

export const rzGate: GateDefinition = {
  id: 'RZ',
  category: 'preconfigured',
  label: 'RZ',
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: true,
  cssClass: 'gate-rz',
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    const angle = gate.phase ?? 0;
    return {
      state: applySingleQubitGate(state, qubitCount, target, rotationZMatrix(angle)),
      measurements,
      log: [`RZ(${angle.toFixed(3)}) rotated q${target}.`],
    };
  },
};
