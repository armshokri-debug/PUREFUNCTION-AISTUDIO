'use strict';

const { createHash, createDecipheriv, scryptSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { inspectFirstBackupDrive, listFolderFiles } = require('./gdrive-storage.cjs');
const { safeStorageFilePath } = require('./backup-lib.cjs');

const project = 'rugwzvztweiffprkxfdc';
const name = 'backup-2026-11-19T16-55-08Z';
const expectedSha = '471c7f2709ec6283893a8d93c97cead9aad7482c55a3c2112055e347e79f7c95';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = ok => { if (!ok) throw new Error('Recovery verification mismatch'); };

async function main() {
  const env = process.env;
  check(env.ENABLE_SUPABASE_BACKUP === 'false');
  const passphrase = env.BACKUP_ENCRYPTION_KEY?.trim();
  check(passphrase?.length >= 32);
  const { accessToken, folder } = await inspectFirstBackupDrive({
    gdriveClientId: env.BACKUP_GDRIVE_CLIENT_ID,
    gdriveClientSecret: env.BACKUP_GDRIVE_CLIENT_SECRET,
    gdriveRefreshToken: env.BACKUP_GDRIVE_REFRESH_TOKEN,
    gdriveFolderId: env.BACKUP_GDRIVE_FOLDER_ID
  }, 0);
  check(folder?.id);
  const files = await listFolderFiles({ accessToken, folderId: folder.id });
  async function download(suffix, expectedBytes) {
    const matches = files.filter(item => item.name === name + suffix);
    check(matches.length === 1);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(matches[0].id)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    check(res.ok);
    const bytes = Buffer.from(await res.arrayBuffer());
    check(bytes.length === expectedBytes);
    return bytes;
  }
  const manifest = JSON.parse(await download('.manifest.json', 1452));
  const enc = await download('.tar.gz.enc', 209258);
  check(manifest.projectRef === project && manifest.archiveName === name + '.tar.gz.enc' &&
    manifest.encryptedArchiveBytes === enc.length && sha(enc) === expectedSha &&
    manifest.encryptedArchiveSha256 === expectedSha && enc.subarray(0, 5).toString() === 'PFBK1');
  console.log('PASS: downloaded Drive archive matches the original SHA-256 and manifest.');
  const key = scryptSync(passphrase, enc.subarray(5, 21), 32, { N: 16384, r: 8, p: 1 });
  let plain, chunks;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, enc.subarray(21, 33));
    decipher.setAuthTag(enc.subarray(-16));
    chunks = [decipher.update(enc.subarray(33, -16))];
    chunks.push(decipher.final());
    plain = Buffer.concat(chunks);
    check(plain.length === manifest.plaintextArchiveBytes && sha(plain) === manifest.plaintextArchiveSha256);
    console.log('PASS: AES-256-GCM authenticated decryption and plaintext SHA-256 verified in memory.');
    function entry(member) {
      return execFileSync('tar', ['-xOzf', '-', '--', './' + member], {
        input: plain, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 24 * 1024 * 1024,
        env: { PATH: process.env.PATH }
      });
    }
    function verifyEntry(member, size, digest) {
      const bytes = entry(member);
      try { check(bytes.length === size && sha(bytes) === digest); }
      finally { bytes.fill(0); }
    }
    const names = ['public-private-schema.sql', 'public-private-full.dump', 'auth-full.dump',
      'storage-schema-full.dump', 'supabase-migrations.dump'];
    check(manifest.dbComponents.length === names.length);
    for (const member of names) {
      const record = manifest.dbComponents.find(record => record.name === member);
      check(record);
      verifyEntry('db/' + member, record.bytes, record.sha256);
    }
    const inventoryBytes = entry('storage/storage-inventory.json');
    const bucketsBytes = entry('storage/buckets.json');
    try {
      const inventory = JSON.parse(inventoryBytes);
      const buckets = JSON.parse(bucketsBytes);
      check(buckets.length === manifest.storageSummary.bucketCount && inventory.objects.length ===
        manifest.storageSummary.objectCount && !inventory.missingExpectedBuckets.length);
      let bytes = 0;
      for (const item of inventory.objects) {
        const member = path.relative('/', safeStorageFilePath('/storage/files', item.bucket, item.path));
        verifyEntry(member, item.size, item.sha256);
        bytes += item.size;
      }
      check(bytes === manifest.storageSummary.totalBytes);
      console.log(`PASS: verified ${names.length} database components and ${inventory.objects.length} Storage objects, without restoring any data.`);
    } finally {
      inventoryBytes.fill(0);
      bucketsBytes.fill(0);
    }
  } finally {
    key.fill(0);
    plain?.fill(0);
    chunks?.forEach(chunk => chunk.fill(0));
  }
}

main().catch(() => {
  console.error('Recovery verification failed. Details are suppressed to protect archive contents.');
  process.exitCode = 1;
});
