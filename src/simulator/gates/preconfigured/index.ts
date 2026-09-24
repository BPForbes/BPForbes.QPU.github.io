import { xGate } from './x';
import { yGate } from './y';
import { zGate } from './z';
import { hGate } from './h';
import { sGate } from './s';
import { tGate } from './t';
import { rxGate } from './rx';
import { ryGate } from './ry';
import { rzGate } from './rz';
import { phaseGate } from './phase';
import { cnotGate } from './cnot';
import { ccnotGate } from './ccnot';
import { czGate } from './cz';
import { cyGate } from './cy';
import { cphaseGate } from './cphase';
import { swapGate } from './swap';
import { measureGate } from './measure';
import { resetGate } from './reset';
import { notGate } from './not';
import { andGate } from './and';
import { nandGate } from './nand';
import { orGate } from './or';
import { xorGate } from './xor';
import type { GateDefinition } from '../types';
// Ordered palette list consumed by registry.ts.
export const preconfiguredGates: GateDefinition[] = [
  xGate,
  yGate,
  zGate,
  hGate,
  sGate,
  tGate,
  rxGate,
  ryGate,
  rzGate,
  phaseGate,
  cnotGate,
  ccnotGate,
  czGate,
  cyGate,
  cphaseGate,
  swapGate,
  measureGate,
  resetGate,
  notGate,
  andGate,
  nandGate,
  orGate,
  xorGate,
];

export const preconfiguredGateMap = Object.fromEntries(
  preconfiguredGates.map((gate) => [gate.id, gate]),
) as Record<string, GateDefinition>;
