import { describe, expect, it } from 'vitest';
import { compareSemver, maxSemver, parseSemver } from '../../../main/updater/semver';

describe('updater semver utilities', () => {
  it('parses semver with pre-release labels', () => {
    const parsed = parseSemver('1.2.3-beta.2');
    expect(parsed.major).toBe(1);
    expect(parsed.minor).toBe(2);
    expect(parsed.patch).toBe(3);
    expect(parsed.preRelease).toEqual(['beta', '2']);
  });

  it('compares semver correctly for stable and pre-release versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3-alpha.1', '1.2.3-alpha.2')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3-rc.1')).toBeGreaterThan(0);
  });

  it('returns max semver value', () => {
    expect(maxSemver('1.2.3', '1.2.4')).toBe('1.2.4');
    expect(maxSemver('2.0.0', '1.9.9')).toBe('2.0.0');
  });
});
