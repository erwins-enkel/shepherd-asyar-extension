import { describe, expect, it } from 'vitest';
import { moveSelection, settleSelection } from './selection';

describe('moveSelection', () => {
  it('returns null for an empty list', () => {
    expect(moveSelection([], null, 'ArrowDown')).toBeNull();
    expect(moveSelection([], null, 'ArrowUp')).toBeNull();
  });

  it('selects the first row when ArrowDown arrives with nothing selected', () => {
    expect(moveSelection(['a', 'b', 'c'], null, 'ArrowDown')).toBe('a');
  });

  it('selects the last row when ArrowUp arrives with nothing selected', () => {
    expect(moveSelection(['a', 'b', 'c'], null, 'ArrowUp')).toBe('c');
  });

  it('moves down one row', () => {
    expect(moveSelection(['a', 'b', 'c'], 'a', 'ArrowDown')).toBe('b');
  });

  it('moves up one row', () => {
    expect(moveSelection(['a', 'b', 'c'], 'c', 'ArrowUp')).toBe('b');
  });

  it('wraps from the last row to the first, matching the launcher root list', () => {
    expect(moveSelection(['a', 'b', 'c'], 'c', 'ArrowDown')).toBe('a');
  });

  it('wraps from the first row to the last', () => {
    expect(moveSelection(['a', 'b', 'c'], 'a', 'ArrowUp')).toBe('c');
  });

  it('restarts from the edge when the selected row is no longer visible', () => {
    expect(moveSelection(['a', 'b'], 'gone', 'ArrowDown')).toBe('a');
    expect(moveSelection(['a', 'b'], 'gone', 'ArrowUp')).toBe('b');
  });
});

describe('settleSelection', () => {
  it('keeps a selection that is still visible', () => {
    expect(settleSelection(['a', 'b'], 'b')).toBe('b');
  });

  it('selects the top row when the list first arrives', () => {
    expect(settleSelection(['a', 'b'], null)).toBe('a');
  });

  it('falls back to the top row when the filter hides the selected one', () => {
    expect(settleSelection(['a', 'b'], 'c')).toBe('a');
  });

  it('has nothing to select in an empty list', () => {
    expect(settleSelection([], 'a')).toBeNull();
    expect(settleSelection([], null)).toBeNull();
  });
});
