import { describe, it, expect } from 'vitest';
import { parseProjectPaths } from './config.js';

describe('parseProjectPaths', () => {
  it('returns empty map for undefined', () => {
    expect(parseProjectPaths(undefined)).toEqual(new Map());
  });

  it('parses a single entry', () => {
    const result = parseProjectPaths('myapp:/home/user/Work/myapp');
    expect(result.get('myapp')).toBe('/home/user/Work/myapp');
    expect(result.size).toBe(1);
  });

  it('parses multiple entries', () => {
    const result = parseProjectPaths('foo:/path/foo,bar:/path/bar');
    expect(result.get('foo')).toBe('/path/foo');
    expect(result.get('bar')).toBe('/path/bar');
  });

  it('ignores entries without colon', () => {
    const result = parseProjectPaths('bad-entry,good:/path');
    expect(result.size).toBe(1);
    expect(result.get('good')).toBe('/path');
  });

  it('trims whitespace around name and path', () => {
    const result = parseProjectPaths(' myapp : /home/user/Work/myapp ');
    expect(result.get('myapp')).toBe('/home/user/Work/myapp');
  });

  it('handles paths with colons (Windows-style or extra colons)', () => {
    // Only split on the FIRST colon
    const result = parseProjectPaths('proj:/path/with:colon');
    expect(result.get('proj')).toBe('/path/with:colon');
  });
});
