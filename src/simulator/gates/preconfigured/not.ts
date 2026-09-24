import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { applySingleQubitGate } from '../operations';
import { MATRIX_X } from '../matrices';
// NOT gate palette entry and apply hook for the shared registry.

export const notGate: GateDefinition = {
  id: 'NOT',
  category: 'preconfigured',
  label: '¬',
  controlKind: 'none',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: false,
  isAstDerived: true,
  supportsReverse: true,
  supportsPhase: false,
  cssClass: 'gate-not',
  // apply hook wires simulator state through the shared operations layer.
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    return {
      state: applySingleQubitGate(state, qubitCount, target, MATRIX_X),
      measurements,
      log: [`NOT flipped q${target}.`],
    };
  },
};
