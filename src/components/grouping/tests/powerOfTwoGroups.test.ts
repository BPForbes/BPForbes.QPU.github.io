import { describe, expect, it } from 'vitest';
import {
  binaryDepth,
  binaryPrefixLabel,
  groupByPowerOfTwo,
  groupingLevels,
  type GroupNode,
} from '../powerOfTwoGroups';

const leafSizes = (nodes: GroupNode[]): number[] =>
  nodes.flatMap((node) => (node.children ? leafSizes(node.children) : [node.end - node.start]));

const maxDepth = (nodes: GroupNode[]): number =>
  Math.max(...nodes.map((node) => (node.children ? maxDepth(node.children) : node.depth)));

describe('power-of-two grouping', () => {
  it('computes binary depth and grouping levels for K = 3', () => {
    expect(binaryDepth(1)).toBe(0);
    expect(binaryDepth(8)).toBe(3);
    expect(binaryDepth(9)).toBe(4);
    expect(binaryDepth(511)).toBe(9);
    expect([1, 8, 9, 64, 65, 511, 512, 513, 4096, 4097].map((count) => groupingLevels(count)))
      .toEqual([0, 0, 1, 1, 2, 2, 2, 3, 3, 4]);
  });

  it('shows up to 2^K items directly', () => {
    expect(groupByPowerOfTwo(0)).toBeUndefined();
    expect(groupByPowerOfTwo(8)).toBeUndefined();
    expect(groupByPowerOfTwo(4, 2)).toBeUndefined();
  });

  it('groups 9–64 items into groups of at most 8', () => {
    const nine = groupByPowerOfTwo(9)!;
    expect(nine.map((node) => [node.start, node.end])).toEqual([[0, 8], [8, 9]]);
    const sixtyFour = groupByPowerOfTwo(64)!;
    expect(sixtyFour).toHaveLength(8);
    expect(sixtyFour.every((node) => node.children === undefined && node.end - node.start === 8)).toBe(true);
  });

  it('nests groups recursively so no level holds more than 2^K entries', () => {
    const groups = groupByPowerOfTwo(511)!;
    expect(groups).toHaveLength(8);
    expect(groups[0].children).toHaveLength(8);
    expect(maxDepth(groups)).toBe(1);
    expect(leafSizes(groups).reduce((sum, size) => sum + size, 0)).toBe(511);
    expect(Math.max(...leafSizes(groups))).toBe(8);

    const big = groupByPowerOfTwo(4097)!;
    expect(big.length).toBeLessThanOrEqual(8);
    expect(maxDepth(big)).toBe(groupingLevels(4097) - 1);
  });

  it('names complete truth-table groups by their shared leading input bits', () => {
    const inputs = ['A0', 'A1', 'B0', 'B1', 'Cin'];
    const bitsOf = (index: number) => index.toString(2).padStart(inputs.length, '0').split('');
    expect(binaryPrefixLabel(inputs, bitsOf, 8, 16)).toBe('A0 A1 = 01');
    expect(binaryPrefixLabel(inputs, bitsOf, 16, 32)).toBe('A0 = 1');
    expect(binaryPrefixLabel(inputs, bitsOf, 3, 9)).toBe('Rows 4–9');
  });

  it('falls back to row numbers when a group does not share its prefix', () => {
    const inputs = ['A', 'B', 'C', 'D'];
    const shuffled = (index: number) => (index === 3 ? ['1', '1', '1', '1'] : index.toString(2).padStart(4, '0').split(''));
    expect(binaryPrefixLabel(inputs, shuffled, 0, 8)).toBe('Rows 1–8');
    expect(binaryPrefixLabel(inputs, shuffled, 8, 16)).toBe('A = 1');
  });
});
