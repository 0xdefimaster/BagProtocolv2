import { describe, expect, it } from 'vitest';
import { assertWindowsDriveLetterCase } from '../../vitest.config';

// The guard turns a Windows environment failure (lowercase drive letter: every file fails with
// "Vitest failed to find the runner") into one clear error. It must never block other setups.
describe('assertWindowsDriveLetterCase', () => {
  it('refuses a lowercase drive letter on Windows and names the uppercase path to use', () => {
    expect(() => assertWindowsDriveLetterCase('c:\\Users\\dev\\BagProtocolv2', 'win32')).toThrow(
      /C:\\Users\\dev\\BagProtocolv2/,
    );
  });

  it('accepts an uppercase drive letter on Windows', () => {
    expect(() => assertWindowsDriveLetterCase('C:\\Users\\dev\\BagProtocolv2', 'win32')).not.toThrow();
  });

  it('never applies outside Windows', () => {
    expect(() => assertWindowsDriveLetterCase('c:/not/a/drive', 'linux')).not.toThrow();
    expect(() => assertWindowsDriveLetterCase('/home/runner/work', 'linux')).not.toThrow();
  });
});
