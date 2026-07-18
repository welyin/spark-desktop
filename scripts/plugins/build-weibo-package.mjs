#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const pluginRoot = path.join(projectRoot, 'src', 'plugins', 'weibo-core');
const distRoot = path.join(projectRoot, 'dist', 'plugins', 'weibo-core');

const sourceFiles = [
  'manifest.ts',
  'WeiboCoreView.vue'
];

const PRIVATE_KEY_FALLBACK_PATH = path.join(projectRoot, '.secrets', 'spark-update-signing-private-key.pem');

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
    return '0.1.0';
  }
  return value.startsWith('v') ? value.slice(1) : value;
}

function buildReleaseAssetUrl(repository, tag, fileName) {
  return `https://github.com/${repository}/releases/download/${tag}/${fileName}`;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv);

  const pluginId = args.pluginId ?? 'weibo-core';
  const pluginDomain = args.pluginDomain ?? 'plugin:weibo-core';
  const version = normalizeVersion(args.version);
  const outputDir = args.outputDir ? path.resolve(projectRoot, args.outputDir) : distRoot;
  const repository = args.repository ?? process.env.GITHUB_REPOSITORY ?? '';
  const releaseTag = args.releaseTag ?? '';

  await mkdir(outputDir, { recursive: true });

  const bundledFiles = [];
  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(pluginRoot, relativePath);
    const content = await readFile(sourcePath);
    const digest = sha256(content);

    const targetPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);

    bundledFiles.push({
      path: relativePath,
      sha256: digest,
      size: content.byteLength,
      contentBase64: content.toString('base64')
    });
  }

  const packageFileName = `spark-plugin-${pluginId}-${version}.spkg`;
  const packagePath = path.join(outputDir, packageFileName);
  const packagePayload = {
    pluginId,
    domain: pluginDomain,
    version,
    files: bundledFiles
  };
  const packageBuffer = Buffer.from(JSON.stringify(packagePayload, null, 2) + '\n', 'utf8');
  await writeFile(packagePath, packageBuffer);

  const packageDigest = sha256(packageBuffer);
  const packageSize = packageBuffer.byteLength;
  const packageUrl = repository && releaseTag
    ? buildReleaseAssetUrl(repository, releaseTag, packageFileName)
    : `file://${packagePath}`;

  const updateManifest = {
    pluginId,
    domain: pluginDomain,
    manifestVersion: 1,
    version,
    releaseTime: new Date().toISOString(),
    assets: [
      {
        kind: 'package',
        fileName: packageFileName,
        url: packageUrl,
        sha256: packageDigest,
        size: packageSize
      }
    ]
  };

  const manifestText = JSON.stringify(updateManifest, null, 2) + '\n';
  const manifestPath = path.join(outputDir, 'update-manifest.json');
  await writeFile(manifestPath, manifestText, 'utf8');

  const privateKeyPem = process.env.SPARK_PLUGIN_SIGNING_PRIVATE_KEY?.trim()
    || (fs.existsSync(PRIVATE_KEY_FALLBACK_PATH) ? await readFile(PRIVATE_KEY_FALLBACK_PATH, 'utf8') : '');
  if (!privateKeyPem) {
    throw new Error('Missing plugin signing private key. Set SPARK_PLUGIN_SIGNING_PRIVATE_KEY or provide .secrets/spark-update-signing-private-key.pem');
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64');
  await writeFile(path.join(outputDir, 'update-manifest.sig'), signature + '\n', 'utf8');
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  await writeFile(path.join(outputDir, 'update-manifest.pub.pem'), publicPem, 'utf8');

  const checksums = [
    `${packageDigest}  ${packageFileName}`,
    `${sha256(Buffer.from(manifestText, 'utf8'))}  update-manifest.json`
  ];
  await writeFile(path.join(outputDir, 'plugin-checksums.txt'), `${checksums.join('\n')}\n`, 'utf8');

  console.log('[plugin-package] generated', manifestPath);
}

main().catch((error) => {
  console.error('[plugin-package] failed', error);
  process.exit(1);
});
