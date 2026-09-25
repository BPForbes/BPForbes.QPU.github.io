import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { prepareZeroQubit } from '../../physics/state/StateVector';

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
    let nextState = state;
    gate.targets.forEach((qubit) => {
      nextState = prepareZeroQubit(nextState, qubitCount, qubit);
    });
    return {
      state: nextState,
      measurements,
      log: [`Cycle workspace prepared: q${gate.targets.join(', q')} as |0⟩.`],
    };
  },
};
