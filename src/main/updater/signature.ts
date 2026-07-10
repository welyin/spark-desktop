import crypto from 'crypto';

export function verifyManifestSignature(manifestText: string, signatureB64: string, publicKeysPem: string[]): boolean {
  const payload = Buffer.from(manifestText, 'utf8');
  const signature = Buffer.from(signatureB64.trim(), 'base64');

  return publicKeysPem.some((key) => {
    try {
      const publicKey = crypto.createPublicKey(key);
      return crypto.verify(null, payload, publicKey, signature);
    } catch {
      return false;
    }
  });
}
