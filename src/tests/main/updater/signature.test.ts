import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyManifestSignature } from '../../../main/updater/signature';

describe('manifest signature verification', () => {
  it('accepts valid signature and rejects invalid signature', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const manifestText = JSON.stringify({ appId: 'spark-desktop', version: '1.2.3' });

    const signature = crypto.sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    expect(verifyManifestSignature(manifestText, signature, [publicPem])).toBe(true);
    expect(verifyManifestSignature(`${manifestText}x`, signature, [publicPem])).toBe(false);
  });
});
