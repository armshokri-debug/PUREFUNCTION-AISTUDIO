#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decryptFile, sha256File } = require('./backup-lib.cjs');

/**
 * Offline non-destructive verification and decryption tool for recovery drills.
 *
 * Usage:
 *   BACKUP_ENCRYPTION_KEY="..." node scripts/backup/verify-and-decrypt.cjs <backup.tar.gz.enc> [--manifest <backup.manifest.json>] [--out <decrypted.tar.gz>]
 *
 * Never passes the encryption key via CLI arguments (prevents shell/ps leakage).
 * Never connects to any database or Storage service.
 */
async function main() {
  const argv = process.argv.slice(2);
  const encPath = argv[0];
  if (!encPath || encPath.startsWith('--')) {
    console.error('Usage: BACKUP_ENCRYPTION_KEY=... node scripts/backup/verify-and-decrypt.cjs <backup.tar.gz.enc> [--manifest <file>] [--out <file>]');
    process.exit(1);
  }

  let manifestPath = null;
  let outPath = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--manifest' && argv[i + 1]) manifestPath = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) outPath = argv[++i];
  }

  const key = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (key.length < 32) {
    console.error('Error: set BACKUP_ENCRYPTION_KEY environment variable (at least 32 characters).');
    process.exit(1);
  }

  if (manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actualEncSha = await sha256File(encPath);
    if (manifest.encryptedArchiveSha256 && manifest.encryptedArchiveSha256 !== actualEncSha) {
      throw new Error(`Encrypted archive SHA-256 mismatch (expected ${manifest.encryptedArchiveSha256}, got ${actualEncSha}).`);
    }
    console.log('PASS: Encrypted archive SHA-256 matches manifest.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-verify-'));
  const targetTar = outPath ? path.resolve(outPath) : path.join(tmpDir, 'decrypted.tar.gz');

  try {
    await decryptFile(encPath, targetTar, key);
    const plainSha = await sha256File(targetTar);

    if (manifestPath) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.plaintextArchiveSha256 && manifest.plaintextArchiveSha256 !== plainSha) {
        throw new Error(`Decrypted archive SHA-256 mismatch (expected ${manifest.plaintextArchiveSha256}, got ${plainSha}).`);
      }
      console.log('PASS: Decrypted archive SHA-256 matches manifest.');
    }

    const entries = execFileSync('tar', ['-tzf', targetTar], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const requiredEntries = [
      'db/public-private-schema.sql',
      'db/public-private-full.dump',
      'db/auth-full.dump',
      'db/storage-schema-full.dump',
      'storage/buckets.json',
      'storage/storage-inventory.json'
    ];
    const missing = requiredEntries.filter((req) => !entries.some((e) => e === req || e === `./${req}`));
    if (missing.length > 0) {
      throw new Error(`Backup archive is missing required components: ${missing.join(', ')}`);
    }

    console.log(`PASS: Verified ${entries.length} entries inside decrypted archive (SHA-256: ${plainSha}).`);
    if (outPath) {
      console.log(`Decrypted archive written to: ${targetTar}`);
    } else {
      console.log('Verification-only mode: temporary decrypted copy will now be securely deleted.');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('VERIFICATION FAILED:', err.message);
    process.exit(1);
  });
}
