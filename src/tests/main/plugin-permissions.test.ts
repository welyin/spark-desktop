import { describe, expect, it } from 'vitest';
import {
  ADVANCED_PERMISSIONS,
  BASIC_PERMISSIONS,
  normalizeDeclaredPermissions,
  resolveGrantedPermissions
} from '../../main/plugins/permissions';

describe('plugin-permissions', () => {
  it('normalizes declared permissions: filters invalid entries and deduplicates', () => {
    expect(normalizeDeclaredPermissions(['org:sync', 'bogus', 'org:sync', 1, null])).toEqual(['org:sync']);
    expect(normalizeDeclaredPermissions(undefined)).toEqual([]);
    expect(normalizeDeclaredPermissions('org:sync')).toEqual([]);
  });

  it('grants basic permissions unconditionally', () => {
    const granted = resolveGrantedPermissions([]);
    for (const permission of BASIC_PERMISSIONS) {
      expect(granted).toContain(permission);
    }
    for (const permission of ADVANCED_PERMISSIONS) {
      expect(granted).not.toContain(permission);
    }
  });

  it('grants declared advanced permissions on top of basic ones', () => {
    const granted = resolveGrantedPermissions(['org:sync', 'identity:sign']);
    expect(granted).toContain('org:sync');
    expect(granted).toContain('identity:sign');
    expect(granted).toContain('storage:read');
    expect(granted).not.toContain('network:broadcast');
  });
});
