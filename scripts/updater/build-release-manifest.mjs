#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) {
      continue;
    }
    const key = part.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i += 1;
  }
  return args;
}

function normalizeVersion(value) {
  if (!value) {
    return '';
  }
  return value.startsWith('v') ? value.slice(1) : value;
}

function releaseDownloadUrl(repository, tag, fileName) {
  return `https://github.com/${repository}/releases/download/${tag}/${fileName}`;
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${url}, status=${response.status}`);
  }

  return await response.json();
}

async function downloadAsset(assetUrl, destination, token) {
  const response = await fetch(assetUrl, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Asset download failed: ${assetUrl}, status=${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(destination, buffer);
}

function inferPlatformArch(fileName) {
  const fullMatch = fileName.match(/spark-desktop-(darwin|linux|win32)-(x64|arm64)-v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)\./i);
  if (fullMatch) {
    return {
      platform: fullMatch[1],
      arch: fullMatch[2],
      version: fullMatch[3]
    };
  }

  return null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv);

  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = args.tag;
  const appId = args.appId ?? 'spark-desktop';
  const channel = args.channel ?? 'stable';
  const outputDir = args.outputDir ?? 'dist/updater';
  const revokedRaw = args.revoked ?? '';
  const revokedVersions = revokedRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (!token) {
    throw new Error('Missing GITHUB_TOKEN');
  }
  if (!repository) {
    throw new Error('Missing GITHUB_REPOSITORY');
  }
  if (!tag) {
    throw new Error('Missing --tag argument');
  }

  const version = normalizeVersion(args.version || tag);
  if (!version) {
    throw new Error('Unable to resolve release version');
  }

  const release = await fetchJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, token);
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const selectedAssets = assets.filter((asset) => {
    const name = String(asset.name || '');
    if (!name) return false;
    if (name.endsWith('.sig')) return false;
    if (name === 'spark-manifest.json') return false;
    if (name === 'spark-manifest.sig') return false;
    if (name === 'spark-checksums.txt') return false;
    return true;
  });

  if (selectedAssets.length === 0) {
    throw new Error(`No release assets found for tag ${tag}`);
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'spark-updater-'));
  const fullAssets = [];
  const checksums = [];

  for (const asset of selectedAssets) {
    const fileName = String(asset.name);
    const inferred = inferPlatformArch(fileName);
    if (!inferred) {
      continue;
    }

    const assetPath = path.join(tempDir, fileName);
    await downloadAsset(String(asset.url), assetPath, token);

    const buffer = await fs.promises.readFile(assetPath);
    const digest = sha256(buffer);
    const size = buffer.byteLength;

    checksums.push(`${digest}  ${fileName}`);

    fullAssets.push({
      kind: 'full',
      platform: inferred.platform,
      arch: inferred.arch,
      fileName,
      url: releaseDownloadUrl(repository, tag, fileName),
      sha256: digest,
      size
    });
  }

  if (fullAssets.length === 0) {
    throw new Error('No release assets matched naming convention spark-desktop-<platform>-<arch>-v<version>.*');
  }

  const manifest = {
    manifestVersion: 1,
    appId,
    channel,
    version,
    releaseTime: new Date().toISOString(),
    critical: false,
    revokedVersions,
    assets: fullAssets,
    patches: []
  };

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(path.join(outputDir, 'spark-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.promises.writeFile(path.join(outputDir, 'spark-checksums.txt'), `${checksums.join('\n')}\n`, 'utf8');

  console.log(`Generated manifest for ${fullAssets.length} assets at ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
