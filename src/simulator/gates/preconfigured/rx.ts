import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { applySingleQubitGate } from '../operations';
import { rotationXMatrix } from '../matrices';
// RX gate palette entry and apply hook for the shared registry.

export const rxGate: GateDefinition = {
  id: 'RX',
  category: 'preconfigured',
  label: 'RX',
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: true,
  cssClass: 'gate-rx',
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    const angle = gate.phase ?? 0;
    return {
      state: applySingleQubitGate(state, qubitCount, target, rotationXMatrix(angle)),
      measurements,
      log: [`RX(${angle.toFixed(3)}) rotated q${target}.`],
    };
  },
};
