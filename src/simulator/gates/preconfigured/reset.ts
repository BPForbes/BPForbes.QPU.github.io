import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { physics } from '../../physics/PhysicsEngine';

export const resetGate: GateDefinition = {
  id: 'RESET',
  category: 'preconfigured',
  label: 'R',
  controlKind: 'none',
  ioArity: gateIoArity(0, 0),
  astInputCount: 0,
  inPalette: false,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: false,
  supportsPhase: false,
  cssClass: 'gate-reset',
  apply: ({ state, qubitCount, gate, measurements }) => {
    // The Physics Engine decides how a wire is forced to |0⟩ (see physics/measurement/Reset.ts).
    const reset = gate.targets.reduce((current, qubit) => physics.reset(current, qubit), physics.fromAmplitudes(state, qubitCount));
    return {
      state: reset.amplitudes,
      measurements,
      log: [`Logical-cycle workspace prepared: q${gate.targets.join(', q')} as |0⟩.`],
    };
  },
};
