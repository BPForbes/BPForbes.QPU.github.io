import { describe, expect, it } from 'vitest';
import { configuredProcesses, protocolExamples, protocolLibrary } from '../protocolExamples';

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

describe('protocolExamples', () => {
  it('excludes library-only child processes but keeps them in the library', () => {
    const exampleNames = protocolExamples.map((process) => process.name);
    expect(exampleNames).not.toContain('RecursiveH');
    expect(exampleNames).not.toContain('RecursiveReversibleEcho');
    expect(exampleNames).toContain('RecursiveHParent');
    expect(exampleNames).toContain('RecursiveReversibleEchoHarness');
    expect(protocolLibrary.RecursiveH).toBeDefined();
    expect(protocolLibrary.RecursiveReversibleEcho).toBeDefined();
  });
});
