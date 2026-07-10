type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  preRelease: string[];
};

function parseNumber(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid semver segment: ${value}`);
  }
  return Number(value);
}

export function parseSemver(version: string): ParsedSemver {
  const trimmed = version.trim();
  const [main, pre] = trimmed.split('-', 2);
  const parts = main?.split('.') ?? [];
  if (parts.length !== 3) {
    throw new Error(`Invalid semver: ${version}`);
  }

  return {
    major: parseNumber(parts[0]),
    minor: parseNumber(parts[1]),
    patch: parseNumber(parts[2]),
    preRelease: pre ? pre.split('.').filter((item) => item.length > 0) : []
  };
}

function comparePreRelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const l = left[index];
    const r = right[index];

    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }

    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);

    if (lNumeric && rNumeric) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) {
        return diff > 0 ? 1 : -1;
      }
      continue;
    }

    if (lNumeric && !rNumeric) {
      return -1;
    }
    if (!lNumeric && rNumeric) {
      return 1;
    }

    const textDiff = l.localeCompare(r);
    if (textDiff !== 0) {
      return textDiff > 0 ? 1 : -1;
    }
  }

  return 0;
}

export function compareSemver(left: string, right: string): number {
  const l = parseSemver(left);
  const r = parseSemver(right);

  if (l.major !== r.major) {
    return l.major > r.major ? 1 : -1;
  }
  if (l.minor !== r.minor) {
    return l.minor > r.minor ? 1 : -1;
  }
  if (l.patch !== r.patch) {
    return l.patch > r.patch ? 1 : -1;
  }

  return comparePreRelease(l.preRelease, r.preRelease);
}

export function maxSemver(left: string, right: string): string {
  return compareSemver(left, right) >= 0 ? left : right;
}
