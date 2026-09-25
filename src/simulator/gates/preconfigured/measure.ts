import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { measureStateVector } from '../../physics/measurement/Measurement';
// MEASURE gate palette entry and apply hook for the shared registry.

export const measureGate: GateDefinition = {
  id: 'MEASURE',
  category: 'preconfigured',
  label: 'M',
  controlKind: 'none',
  ioArity: gateIoArity(0, 0, 1, 0),
  astInputCount: 0,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: false,
  supportsPhase: false,
  cssClass: 'gate-measure',
  // Collapse is Physics Engine behavior; the gate only records the classical outcome.
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    const basis = gate.basis ?? 'Z';
    const measured = measureStateVector(state, qubitCount, target, basis);
    const basisNote = basis === 'Z' ? '' : ` in ${basis} basis`;
    return {
      state: measured.state,
      measurements: { ...measurements, [target]: measured.outcome },
      log: [`Measured q${target}${basisNote} = ${measured.outcome} (P(1)=${measured.probabilityOne.toFixed(3)}).`],
    };
  },
};
