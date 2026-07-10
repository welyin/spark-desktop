#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
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

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir ?? 'dist/updater';
  const privateKeyPem = process.env.SPARK_UPDATE_SIGNING_PRIVATE_KEY;

  if (!privateKeyPem) {
    throw new Error('Missing SPARK_UPDATE_SIGNING_PRIVATE_KEY environment variable');
  }

  const manifestPath = path.join(outputDir, 'spark-manifest.json');
  const signaturePath = path.join(outputDir, 'spark-manifest.sig');
  const publicKeyPath = path.join(outputDir, 'spark-manifest.pub.pem');

  const manifestText = await fs.promises.readFile(manifestPath, 'utf8');
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

  await fs.promises.writeFile(signaturePath, signature, 'utf8');
  await fs.promises.writeFile(publicKeyPath, publicKey, 'utf8');

  console.log(`Signed manifest: ${signaturePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
