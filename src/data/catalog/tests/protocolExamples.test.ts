import { describe, expect, it } from 'vitest';
import { configuredProcesses, protocolLibrary } from '../protocolExamples';

describe('protocolLibrary', () => {
  it('maps every configured process name to its source', () => {
    expect(Object.keys(protocolLibrary).sort()).toEqual(
      configuredProcesses.map((process) => process.name).sort(),
    );
    configuredProcesses.forEach((process) => {
      expect(protocolLibrary[process.name]).toBe(process.source);
    });
  });
});
