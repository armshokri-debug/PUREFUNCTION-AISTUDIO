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
