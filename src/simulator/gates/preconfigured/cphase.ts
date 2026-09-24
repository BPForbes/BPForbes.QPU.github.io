import type { GateDefinition } from '../types';
import { gateIoArity } from '../types';
import { applyControlledPhase } from '../operations';
// CPHASE gate palette entry and apply hook for the shared registry.

export const cphaseGate: GateDefinition = {
  id: 'CPHASE',
  category: 'preconfigured',
  label: 'CP',
  controlKind: 'single',
  ioArity: gateIoArity(1, 1),
  astInputCount: 1,
  inPalette: true,
  isAstPrimitive: true,
  isAstDerived: false,
  supportsReverse: true,
  supportsPhase: true,
  cssClass: 'gate-cphase',
  apply: ({ state, qubitCount, gate, measurements }) => {
    const target = gate.targets[0];
    const control = gate.controls[0];
    const angle = gate.phase ?? 0;
    return {
      state: applyControlledPhase(state, qubitCount, control, target, angle),
      measurements,
      log: [`CPHASE(${angle.toFixed(3)}) phased |11⟩ on q${control}, q${target}.`],
    };
  },
};
