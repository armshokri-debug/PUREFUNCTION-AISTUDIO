import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  EXPECTED_BUCKETS,
  validateBackupConfig,
  redactSecrets,
  buildPgDumpPlan,
  readOnlyPgEnv,
  sha256File,
  encryptFile,
  decryptFile,
  computeRetentionDeletions,
  safeStorageFilePath
} = require('./backup-lib.cjs');
const { exportSupabaseStorage } = require('./export-storage.cjs');

const VALID_ENV = {
  ENABLE_SUPABASE_BACKUP: 'false',
  SUPABASE_PROJECT_REF: 'rugwzvztweiffprkxfdc',
  SUPABASE_DB_URL: 'postgresql://postgres:super-secret-db-pass@db.rugwzvztweiffprkxfdc.supabase.co:5432/postgres?sslmode=require',
  SUPABASE_URL: 'https://rugwzvztweiffprkxfdc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signaturevalue123456',
  BACKUP_ENCRYPTION_KEY: 'A9f!k2Lm#8qPx7Vz@4nRt6Yw$1cBh5JdE3gM',
  BACKUP_S3_ENDPOINT: 'https://1234567890abcdef.r2.cloudflarestorage.com',
  BACKUP_S3_BUCKET: 'purefunction-prod-backups',
  BACKUP_S3_REGION: 'auto',
  BACKUP_S3_ACCESS_KEY_ID: 'r2-access-key-123456',
  BACKUP_S3_SECRET_ACCESS_KEY: 'r2-secret-access-key-9876543210',
  BACKUP_RETENTION_DAYS: '30',
  BACKUP_MIN_KEEP_COUNT: '7'
};

const tempDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-backup-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Supabase backup configuration & safety guards', () => {
  it('accepts a complete valid configuration while flagging disabled live mode', () => {
    const res = validateBackupConfig(VALID_ENV);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.config.enabled).toBe(false);
    expect(res.warnings.some((w) => w.includes('ENABLE_SUPABASE_BACKUP'))).toBe(true);
  });

  it('rejects missing secrets, weak encryption keys, non-TLS DB URLs, and mismatched project refs', () => {
    const res = validateBackupConfig({
      ...VALID_ENV,
      SUPABASE_URL: 'https://otherproject123456.supabase.co',
      SUPABASE_DB_URL: 'postgresql://postgres:pass@db.rugwzvztweiffprkxfdc.supabase.co:5432/postgres',
      BACKUP_ENCRYPTION_KEY: 'too-short',
      BACKUP_S3_SECRET_ACCESS_KEY: ''
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('does not match SUPABASE_PROJECT_REF'))).toBe(true);
    expect(res.errors.some((e) => e.includes('sslmode=require'))).toBe(true);
    expect(res.errors.some((e) => e.includes('at least 32 characters'))).toBe(true);
    expect(res.errors.some((e) => e.includes('BACKUP_S3_SECRET_ACCESS_KEY'))).toBe(true);
  });

  it('enforces read-only PostgreSQL options and covers public, private, auth, storage, and migrations schemas', () => {
    const env = readOnlyPgEnv({});
    expect(env.PGOPTIONS).toContain('default_transaction_read_only=on');

    const plan = buildPgDumpPlan(VALID_ENV.SUPABASE_DB_URL, '/tmp/db');
    const allArgs = plan.flatMap((p) => p.args).join(' ');
    expect(allArgs).toContain('--schema=public');
    expect(allArgs).toContain('--schema=private');
    expect(allArgs).toContain('--schema=auth');
    expect(allArgs).toContain('--schema=storage');
    expect(allArgs).toContain('--schema=supabase_migrations');
    expect(allArgs).toContain('--lock-wait-timeout=30000');
  });

  it('redacts secrets, Postgres URI passwords, and JWTs from failure reports', () => {
    const raw = `Error connecting to ${VALID_ENV.SUPABASE_DB_URL} with key ${VALID_ENV.BACKUP_ENCRYPTION_KEY} and token ${VALID_ENV.SUPABASE_SERVICE_ROLE_KEY}`;
    const safe = redactSecrets(raw, [VALID_ENV.BACKUP_ENCRYPTION_KEY, VALID_ENV.SUPABASE_S3_SECRET_ACCESS_KEY]);
    expect(safe).not.toContain('super-secret-db-pass');
    expect(safe).not.toContain(VALID_ENV.BACKUP_ENCRYPTION_KEY);
    expect(safe).not.toContain('signaturevalue123456');
  });
});

describe('AES-256-GCM streaming backup encryption & tamper verification', () => {
  it('round-trips files accurately and rejects wrong keys or tampered ciphertext', async () => {
    const dir = makeTmpDir();
    const input = path.join(dir, 'sample.tar.gz');
    const encrypted = path.join(dir, 'sample.tar.gz.enc');
    const restored = path.join(dir, 'restored.tar.gz');
    const payload = crypto.randomBytes(128 * 1024);
    fs.writeFileSync(input, payload);

    const expectedHash = await sha256File(input);
    await encryptFile(input, encrypted, VALID_ENV.BACKUP_ENCRYPTION_KEY);
    await decryptFile(encrypted, restored, VALID_ENV.BACKUP_ENCRYPTION_KEY);
    expect(await sha256File(restored)).toBe(expectedHash);

    // Wrong key must fail cleanly and leave no output file
    const badKeyOut = path.join(dir, 'bad-key.tar.gz');
    await expect(
      decryptFile(encrypted, badKeyOut, 'WrongKey-123456789012345678901234567890')
    ).rejects.toThrow(/decryption\/authentication failed/i);
    expect(fs.existsSync(badKeyOut)).toBe(false);

    // Tampered ciphertext byte must fail GCM authentication
    const tampered = Buffer.from(fs.readFileSync(encrypted));
    tampered[60] ^= 0xff;
    const tamperedPath = path.join(dir, 'tampered.tar.gz.enc');
    fs.writeFileSync(tamperedPath, tampered);
    const tamperedOut = path.join(dir, 'tampered-out.tar.gz');
    await expect(
      decryptFile(tamperedPath, tamperedOut, VALID_ENV.BACKUP_ENCRYPTION_KEY)
    ).rejects.toThrow(/decryption\/authentication failed/i);
    expect(fs.existsSync(tamperedOut)).toBe(false);
  });
});

describe('Retention pruning safety floor & path traversal protection', () => {
  it('prunes backups older than retentionDays while always keeping at least minKeepCount newest backups', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const objects = [];
    // 10 backups aged 35..44 days old (all older than 30 days!)
    for (let i = 0; i < 10; i++) {
      const d = new Date(now.getTime() - (35 + i) * 86400_000);
      const stamp = d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
      objects.push({ key: `pure-function/rugwzvztweiffprkxfdc/backup-${stamp}.tar.gz.enc`, lastModified: d.toISOString() });
      objects.push({ key: `pure-function/rugwzvztweiffprkxfdc/backup-${stamp}.manifest.json`, lastModified: d.toISOString() });
    }
    objects.push({ key: 'pure-function/rugwzvztweiffprkxfdc/README.txt', lastModified: '2020-01-01T00:00:00Z' });

    const toDelete = computeRetentionDeletions(objects, 30, now, 7);
    // Only the 3 oldest backup archives + their 3 manifests should be deleted; newest 7 are protected
    expect(toDelete.filter((k) => k.endsWith('.tar.gz.enc'))).toHaveLength(3);
    expect(toDelete.filter((k) => k.endsWith('.manifest.json'))).toHaveLength(3);
    expect(toDelete.some((k) => k.endsWith('README.txt'))).toBe(false);
  });

  it('rejects storage path traversal attempts', () => {
    const dir = makeTmpDir();
    expect(() => safeStorageFilePath(dir, 'client-videos', '../../etc/passwd')).toThrow();
    expect(() => safeStorageFilePath(dir, '../bad', 'clip.mp4')).toThrow();
    const okPath = safeStorageFilePath(dir, 'client-videos', 'client-1/clip.webm');
    expect(okPath.startsWith(path.resolve(dir) + path.sep)).toBe(true);
  });
});

describe('Read-only Storage exporter (mocked fetch, zero live calls)', () => {
  it('recursively exports nested objects across buckets and records SHA-256 inventory', async () => {
    const dir = makeTmpDir();
    const calls = [];
    const mockFetch = async (url, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      if (url.endsWith('/storage/v1/bucket')) {
        return new Response(
          JSON.stringify(EXPECTED_BUCKETS.map((id) => ({ id, name: id, public: false }))),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/storage/v1/object/list/client-videos')) {
        const body = JSON.parse(opts.body);
        if (body.prefix === '') {
          return new Response(JSON.stringify([{ name: 'client-abc', id: null, metadata: null }]), { status: 200 });
        }
        if (body.prefix === 'client-abc') {
          return new Response(
            JSON.stringify([{ name: 'clip1.webm', id: 'obj-1', metadata: { mimetype: 'video/webm' }, updated_at: '2026-11-10T00:00:00Z' }]),
            { status: 200 }
          );
        }
      }
      if (url.includes('/storage/v1/object/list/')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/storage/v1/object/authenticated/client-videos/client-abc/clip1.webm')) {
        return new Response(Buffer.from('fake-webm-bytes'), {
          status: 200,
          headers: { 'content-type': 'video/webm' }
        });
      }
      return new Response('not found', { status: 404 });
    };

    const summary = await exportSupabaseStorage({
      supabaseUrl: VALID_ENV.SUPABASE_URL,
      serviceRoleKey: VALID_ENV.SUPABASE_SERVICE_ROLE_KEY,
      outputDir: dir,
      fetchImpl: mockFetch
    });

    expect(summary.bucketCount).toBe(4);
    expect(summary.missingExpectedBuckets).toEqual([]);
    expect(summary.objectCount).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'files/client-videos/client-abc/clip1.webm'), 'utf8')).toBe('fake-webm-bytes');

    // Confirm zero mutating HTTP methods (PUT/DELETE/PATCH) were ever sent
    expect(calls.some((c) => /^(PUT|DELETE|PATCH)\b/.test(c))).toBe(false);
  });
});

describe('CLI dry-run, live-execution lock, and disabled-by-default workflow invariants', () => {
  it('passes --validate-only without network access and refuses live execution when disabled', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/backup/run-backup.cjs');
    const out = execFileSync(process.execPath, [scriptPath, '--validate-only'], {
      env: { ...process.env, ...VALID_ENV },
      encoding: 'utf8'
    });
    expect(out).toContain('PASS: Backup configuration is valid');
    expect(out).toContain('Dry-run complete');

    // Without ENABLE_SUPABASE_BACKUP=true, even passing --confirm-live must exit non-zero
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [scriptPath, '--confirm-live'], {
        env: { ...process.env, ...VALID_ENV, ENABLE_SUPABASE_BACKUP: 'false' },
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(2);
  });

  it('keeps .github/workflows/supabase-backup.yml disabled by default with no active schedule or artifact upload', () => {
    const wfPath = path.resolve(process.cwd(), '.github/workflows/supabase-backup.yml');
    const yaml = fs.readFileSync(wfPath, 'utf8');
    // Must not have an uncommented schedule: trigger
    expect(/^\s*schedule\s*:/m.test(yaml)).toBe(false);
    // Must gate live execution on vars.ENABLE_SUPABASE_BACKUP == 'true'
    expect(yaml).toContain("vars.ENABLE_SUPABASE_BACKUP == 'true'");
    // Must never upload encrypted/unencrypted DB backups as GitHub Actions artifacts
    expect(yaml).not.toContain('actions/upload-artifact');
  });

  it('verifies a synthetic encrypted archive and manifest using verify-and-decrypt.cjs', async () => {
    const dir = makeTmpDir();
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'db'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'db/public-private-schema.sql'), '-- schema\n');
    fs.writeFileSync(path.join(stage, 'db/public-private-full.dump'), 'PGDMP-SYNTHETIC');
    fs.writeFileSync(path.join(stage, 'db/auth-full.dump'), 'PGDMP-AUTH');
    fs.writeFileSync(path.join(stage, 'db/storage-schema-full.dump'), 'PGDMP-STORAGE');
    fs.writeFileSync(path.join(stage, 'storage/buckets.json'), '[]');
    fs.writeFileSync(path.join(stage, 'storage/storage-inventory.json'), '{"objects":[]}');

    const tarPath = path.join(dir, 'backup-test.tar.gz');
    const encPath = path.join(dir, 'backup-test.tar.gz.enc');
    const manifestPath = path.join(dir, 'backup-test.manifest.json');
    execFileSync('tar', ['-czf', tarPath, '-C', stage, '.']);
    await encryptFile(tarPath, encPath, VALID_ENV.BACKUP_ENCRYPTION_KEY);

    const manifest = {
      plaintextArchiveSha256: await sha256File(tarPath),
      encryptedArchiveSha256: await sha256File(encPath)
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const verifyScript = path.resolve(process.cwd(), 'scripts/backup/verify-and-decrypt.cjs');
    const out = execFileSync(process.execPath, [verifyScript, encPath, '--manifest', manifestPath], {
      env: { ...process.env, BACKUP_ENCRYPTION_KEY: VALID_ENV.BACKUP_ENCRYPTION_KEY },
      encoding: 'utf8'
    });
    expect(out).toContain('PASS: Encrypted archive SHA-256 matches manifest.');
    expect(out).toContain('PASS: Decrypted archive SHA-256 matches manifest.');
    expect(out).toContain('PASS: Verified');
  });
});

const {
  exchangeRefreshToken,
  ensureBackupFolder,
  uploadFileResumable,
  uploadAndPruneGDrive
} = require('./gdrive-storage.cjs');

const VALID_GDRIVE_ENV = {
  ENABLE_SUPABASE_BACKUP: 'false',
  BACKUP_STORAGE_PROVIDER: 'gdrive',
  SUPABASE_PROJECT_REF: 'rugwzvztweiffprkxfdc',
  SUPABASE_DB_URL: 'postgresql://postgres:super-secret-db-pass@db.rugwzvztweiffprkxfdc.supabase.co:5432/postgres?sslmode=require',
  SUPABASE_URL: 'https://rugwzvztweiffprkxfdc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signaturevalue123456',
  BACKUP_ENCRYPTION_KEY: 'A9f!k2Lm#8qPx7Vz@4nRt6Yw$1cBh5JdE3gM',
  BACKUP_GDRIVE_CLIENT_ID: '1234567890-abcdef.apps.googleusercontent.com',
  BACKUP_GDRIVE_CLIENT_SECRET: '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cret',
  BACKUP_GDRIVE_REFRESH_TOKEN: '1//0gSuperSecretRefreshTokenValue1234567890',
  BACKUP_GDRIVE_FOLDER_NAME: 'PureFunction-Encrypted-Backups',
  BACKUP_RETENTION_DAYS: '30',
  BACKUP_MIN_KEEP_COUNT: '7'
};

describe('Google Drive backup destination (config, OAuth, resumable upload, retention)', () => {
  it('validates Google Drive config without requiring S3 variables and rejects invalid inputs', () => {
    const okRes = validateBackupConfig(VALID_GDRIVE_ENV);
    expect(okRes.ok).toBe(true);
    expect(okRes.config.provider).toBe('gdrive');
    expect(okRes.config.gdriveFolderName).toBe('PureFunction-Encrypted-Backups');
    expect(okRes.config.enabled).toBe(false);

    const badRes = validateBackupConfig({
      ...VALID_GDRIVE_ENV,
      BACKUP_GDRIVE_CLIENT_ID: 'not-a-google-client-id',
      BACKUP_GDRIVE_REFRESH_TOKEN: '',
      BACKUP_GDRIVE_FOLDER_ID: '../bad/id'
    });
    expect(badRes.ok).toBe(false);
    expect(badRes.errors.some((e) => e.includes('BACKUP_GDRIVE_CLIENT_ID'))).toBe(true);
    expect(badRes.errors.some((e) => e.includes('BACKUP_GDRIVE_REFRESH_TOKEN'))).toBe(true);
    expect(badRes.errors.some((e) => e.includes('BACKUP_GDRIVE_FOLDER_ID'))).toBe(true);

    const badProvider = validateBackupConfig({ ...VALID_GDRIVE_ENV, BACKUP_STORAGE_PROVIDER: 'ftp' });
    expect(badProvider.ok).toBe(false);
    expect(badProvider.errors.some((e) => e.includes('BACKUP_STORAGE_PROVIDER'))).toBe(true);
  });

  it('redacts Google OAuth access tokens (ya29.*) and refresh tokens (1//*) from error output', () => {
    const raw =
      'Token ya29.a0AfH6SMBxFakeAccessToken1234567890 and refresh 1//0gFakeRefreshTokenValue1234567890 with secret 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cret';
    const safe = redactSecrets(raw, [VALID_GDRIVE_ENV.BACKUP_GDRIVE_CLIENT_SECRET]);
    expect(safe).not.toContain('ya29.a0AfH6');
    expect(safe).not.toContain('1//0gFakeRefresh');
    expect(safe).not.toContain('GOCSPX-super-secret');
  });

  it('exchanges refresh token and surfaces clear In Production guidance on invalid_grant', async () => {
    const okFetch = async () =>
      new Response(JSON.stringify({ access_token: 'ya29.mockAccessToken1234567890' }), { status: 200 });
    const token = await exchangeRefreshToken({
      clientId: VALID_GDRIVE_ENV.BACKUP_GDRIVE_CLIENT_ID,
      clientSecret: VALID_GDRIVE_ENV.BACKUP_GDRIVE_CLIENT_SECRET,
      refreshToken: VALID_GDRIVE_ENV.BACKUP_GDRIVE_REFRESH_TOKEN,
      fetchImpl: okFetch
    });
    expect(token).toBe('ya29.mockAccessToken1234567890');

    const expiredFetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await expect(
      exchangeRefreshToken({
        clientId: VALID_GDRIVE_ENV.BACKUP_GDRIVE_CLIENT_ID,
        clientSecret: VALID_GDRIVE_ENV.BACKUP_GDRIVE_CLIENT_SECRET,
        refreshToken: VALID_GDRIVE_ENV.BACKUP_GDRIVE_REFRESH_TOKEN,
        fetchImpl: expiredFetch
      })
    ).rejects.toThrow(/In Production/i);
  });

  it('explains drive.file scope limitation if an inaccessible manually-created folder ID is supplied', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    await expect(
      ensureBackupFolder({
        accessToken: 'ya29.mock',
        folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
        folderName: 'PureFunction-Encrypted-Backups',
        fetchImpl: mockFetch
      })
    ).rejects.toThrow(/drive\.file/i);
  });

  it('uploads multi-chunk files via Google Drive resumable upload and reassembles exact bytes', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'large.tar.gz.enc');
    const payload = crypto.randomBytes(600 * 1024); // > 2 chunks of 256 KiB
    fs.writeFileSync(filePath, payload);

    const receivedChunks = [];
    const mockFetch = async (url, opts = {}) => {
      if (url.includes('uploadType=resumable')) {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session-123' }
        });
      }
      if (url.includes('upload_id=session-123') && opts.method === 'PUT') {
        const buf = Buffer.from(opts.body);
        receivedChunks.push(buf);
        const range = opts.headers['Content-Range'];
        const [, endStr, totalStr] = range.match(/bytes \d+-(\d+)\/(\d+)/);
        if (Number(endStr) + 1 < Number(totalStr)) {
          return new Response(null, { status: 308 });
        }
        return new Response(
          JSON.stringify({ id: 'file-resumable-1', name: 'large.tar.gz.enc', size: String(payload.length) }),
          { status: 200 }
        );
      }
      return new Response('unexpected', { status: 500 });
    };

    const uploaded = await uploadFileResumable({
      accessToken: 'ya29.mock',
      folderId: 'folder-123',
      filePath,
      fileName: 'large.tar.gz.enc',
      chunkSizeBytes: 256 * 1024,
      fetchImpl: mockFetch
    });

    expect(uploaded.id).toBe('file-resumable-1');
    expect(receivedChunks.length).toBe(3);
    expect(Buffer.concat(receivedChunks).equals(payload)).toBe(true);
  });

  it('runs end-to-end mocked Google Drive upload and retention pruning preserving 7 newest backups', async () => {
    const dir = makeTmpDir();
    const encPath = path.join(dir, 'backup-2026-11-18T12-00-00Z.tar.gz.enc');
    const manifestPath = path.join(dir, 'backup-2026-11-18T12-00-00Z.manifest.json');
    fs.writeFileSync(encPath, crypto.randomBytes(1024));
    fs.writeFileSync(manifestPath, JSON.stringify({ formatVersion: 1 }));

    const now = new Date('2026-11-18T12:00:00Z');
    const existingFiles = [
      { id: 'keep-notes', name: 'README.txt', modifiedTime: '2020-01-01T00:00:00Z' }
    ];
    for (let i = 0; i < 9; i++) {
      const d = new Date(now.getTime() - (35 + i) * 86400_000);
      const stamp = d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
      existingFiles.push({ id: `enc-${i}`, name: `backup-${stamp}.tar.gz.enc`, modifiedTime: d.toISOString() });
      existingFiles.push({ id: `man-${i}`, name: `backup-${stamp}.manifest.json`, modifiedTime: d.toISOString() });
    }

    const deletedIds = [];
    const createdFolders = [];
    const mockFetch = async (url, opts = {}) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ya29.mockToken1234567890' }), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=') && url.includes('mimeType')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (url === 'https://www.googleapis.com/drive/v3/files?fields=id,name' && opts.method === 'POST') {
        const meta = JSON.parse(opts.body);
        createdFolders.push(meta.name);
        return new Response(JSON.stringify({ id: 'folder-created-1', name: meta.name }), { status: 200 });
      }
      if (url.includes('uploadType=resumable')) {
        const meta = JSON.parse(opts.body);
        return new Response(null, {
          status: 200,
          headers: { location: `https://upload.mock/${encodeURIComponent(meta.name)}` }
        });
      }
      if (url.startsWith('https://upload.mock/') && opts.method === 'PUT') {
        const name = decodeURIComponent(url.replace('https://upload.mock/', ''));
        const id = `new-${name}`;
        existingFiles.push({ id, name, modifiedTime: now.toISOString() });
        return new Response(JSON.stringify({ id, name, size: String(opts.body.length) }), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=') && url.includes('in+parents')) {
        return new Response(JSON.stringify({ files: existingFiles }), { status: 200 });
      }
      if (opts.method === 'DELETE' && url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
        deletedIds.push(url.split('/').pop());
        return new Response(null, { status: 204 });
      }
      return new Response(`unhandled ${opts.method} ${url}`, { status: 500 });
    };

    const cfg = validateBackupConfig(VALID_GDRIVE_ENV).config;
    const res = await uploadAndPruneGDrive({
      config: cfg,
      encPath,
      manifestPath,
      baseName: 'backup-2026-11-18T12-00-00Z',
      now,
      fetchImpl: mockFetch
    });

    expect(createdFolders).toEqual(['PureFunction-Encrypted-Backups']);
    expect(res.folderId).toBe('folder-created-1');
    // 10 total backups (1 new + 9 aged 35..43d); safety floor keeps 7 newest -> 3 oldest pairs (6 files) pruned
    expect(res.prunedCount).toBe(6);
    expect(deletedIds).not.toContain('keep-notes');
    expect(deletedIds).toContain('enc-8');
    expect(deletedIds).toContain('man-8');
  });

  it.each([true, false])('verifies the first Drive upload and never prunes (valid checksum: %s)', async valid => {
    const dir = makeTmpDir();
    const encPath = path.join(dir, 'archive');
    const manifestPath = path.join(dir, 'manifest');
    fs.writeFileSync(encPath, 'encrypted test bytes');
    fs.writeFileSync(manifestPath, '{}');
    const stored = new Map();
    const requests = [];
    const folder = 'private-folder';
    const fetchImpl = async (url, options = {}) => {
      const endpoint = new URL(url);
      requests.push(options.method ?? 'GET');
      if (endpoint.pathname === '/token') return Response.json({
        access_token: 'synthetic', scope: 'https://www.googleapis.com/auth/drive.file'
      });
      if (endpoint.pathname.endsWith('/about')) return Response.json({
        user: { emailAddress: 'arm.shokri@gmail.com' }, storageQuota: { limit: '9000', usage: '0' }
      });
      if (endpoint.searchParams.has('q')) return Response.json({ files: [] });
      if (endpoint.searchParams.has('uploadType')) {
        const { name, parents } = JSON.parse(options.body);
        expect(parents).toEqual([folder]);
        return new Response(null, { headers: { location: `https://example.test/${name}` } });
      }
      if (endpoint.hostname === 'example.test') {
        const id = endpoint.pathname.slice(1);
        stored.set(id, Buffer.from(options.body));
        return Response.json({ id });
      }
      if (options.method === 'POST') return Response.json({ id: folder, name: 'PureFunction-Encrypted-Backups' });
      const id = endpoint.pathname.split('/').at(-1);
      const payload = stored.get(id);
      if (endpoint.searchParams.get('alt') === 'media') return new Response(payload);
      const info = { id, name: id, size: String(payload.length), parents: [folder],
        ownedByMe: true, shared: false, trashed: false };
      if (id.endsWith('.enc')) info.sha256Checksum = valid ? await sha256File(encPath) : '0'.repeat(64);
      return Response.json(info);
    };
    const task = uploadAndPruneGDrive({
      config: validateBackupConfig(VALID_GDRIVE_ENV).config, encPath, manifestPath,
      baseName: 'backup', firstBackup: true, fetchImpl
    });
    if (valid) await expect(task).resolves.toMatchObject({ prunedCount: 0 });
    else await expect(task).rejects.toThrow('SHA-256 did not match');
    expect(stored.size).toBe(2);
    expect(requests).not.toContain('DELETE');
  });

  it('passes CLI --validate-only for gdrive provider and keeps workflow wired & disabled by default', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/backup/run-backup.cjs');
    const out = execFileSync(process.execPath, [scriptPath, '--validate-only'], {
      env: { ...process.env, ...VALID_GDRIVE_ENV },
      encoding: 'utf8'
    });
    expect(out).toContain('provider=gdrive');
    expect(out).toContain('PASS: Backup configuration');

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [scriptPath, '--confirm-live'], {
        env: { ...process.env, ...VALID_GDRIVE_ENV, ENABLE_SUPABASE_BACKUP: 'false' },
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(2);

    const wfPath = path.resolve(process.cwd(), '.github/workflows/supabase-backup.yml');
    const yaml = fs.readFileSync(wfPath, 'utf8');
    expect(yaml).toContain('BACKUP_STORAGE_PROVIDER');
    expect(yaml).toContain('BACKUP_GDRIVE_CLIENT_ID');
    expect(yaml).toContain('BACKUP_GDRIVE_CLIENT_SECRET');
    expect(yaml).toContain('BACKUP_GDRIVE_REFRESH_TOKEN');
    expect(yaml).toContain('BACKUP_S3_BUCKET');
    expect(/^\s*schedule\s*:/m.test(yaml)).toBe(false);
  });
});
