'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('PFBK1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN; // 33 bytes
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

const EXPECTED_BUCKETS = [
  'exercise-videos',
  'client-videos',
  'inbody-printouts',
  'message-media'
];

const EXPECTED_SCHEMAS = [
  'public',
  'private',
  'auth',
  'storage',
  'supabase_migrations'
];

const REQUIRED_ENV_KEYS = [
  'SUPABASE_PROJECT_REF',
  'SUPABASE_DB_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BACKUP_ENCRYPTION_KEY',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY'
];

const PLACEHOLDER_PATTERN = /^(changeme|placeholder|example|replace[-_ ]?me|your[-_ ]|test[-_ ]?key|xxx+)$/i;

/**
 * Validates backup configuration strictly without touching any network or database.
 * Returns { ok, errors, warnings, config }.
 */
function validateBackupConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const key of REQUIRED_ENV_KEYS) {
    const val = (env[key] || '').trim();
    if (!val) {
      errors.push(`Missing required environment variable: ${key}`);
    } else if (PLACEHOLDER_PATTERN.test(val)) {
      errors.push(`Environment variable ${key} looks like an unconfigured placeholder.`);
    }
  }

  const projectRef = (env.SUPABASE_PROJECT_REF || '').trim();
  if (projectRef && !/^[a-z0-9]{15,30}$/.test(projectRef)) {
    errors.push('SUPABASE_PROJECT_REF must be a valid Supabase project reference ID (lowercase alphanumeric).');
  }

  const supabaseUrl = (env.SUPABASE_URL || '').trim();
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:') {
        errors.push('SUPABASE_URL must use https://.');
      }
      if (projectRef && parsed.hostname !== `${projectRef}.supabase.co`) {
        errors.push(`SUPABASE_URL host (${parsed.hostname}) does not match SUPABASE_PROJECT_REF (${projectRef}).`);
      }
    } catch {
      errors.push('SUPABASE_URL is not a valid URL.');
    }
  }

  const dbUrl = (env.SUPABASE_DB_URL || '').trim();
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        errors.push('SUPABASE_DB_URL must use postgres:// or postgresql://.');
      }
      const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
      if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
        errors.push('SUPABASE_DB_URL must include sslmode=require (or verify-ca / verify-full).');
      }
    } catch {
      errors.push('SUPABASE_DB_URL is not a valid PostgreSQL connection URI.');
    }
  }

  const encKey = (env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (encKey && encKey.length < 32) {
    errors.push('BACKUP_ENCRYPTION_KEY must be at least 32 characters long.');
  }

  const s3Endpoint = (env.BACKUP_S3_ENDPOINT || '').trim();
  if (s3Endpoint) {
    try {
      const parsed = new URL(s3Endpoint);
      if (parsed.protocol !== 'https:') {
        errors.push('BACKUP_S3_ENDPOINT must use https://.');
      }
    } catch {
      errors.push('BACKUP_S3_ENDPOINT is not a valid URL.');
    }
  }

  const s3Bucket = (env.BACKUP_S3_BUCKET || '').trim();
  if (s3Bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket)) {
    errors.push('BACKUP_S3_BUCKET must be a valid lowercase S3 bucket name.');
  }

  const rawRetention = (env.BACKUP_RETENTION_DAYS || '30').trim();
  const retentionDays = Number(rawRetention);
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
    errors.push('BACKUP_RETENTION_DAYS must be an integer between 7 and 3650.');
  }

  const rawMinKeep = (env.BACKUP_MIN_KEEP_COUNT || '7').trim();
  const minKeepCount = Number(rawMinKeep);
  if (!Number.isInteger(minKeepCount) || minKeepCount < 3 || minKeepCount > 365) {
    errors.push('BACKUP_MIN_KEEP_COUNT must be an integer between 3 and 365.');
  }

  const s3Prefix = (env.BACKUP_S3_PREFIX || `pure-function/${projectRef || 'unknown'}`).replace(/^\/+|\/+$/g, '');
  const s3Region = (env.BACKUP_S3_REGION || 'auto').trim();

  if (env.ENABLE_SUPABASE_BACKUP !== 'true') {
    warnings.push('ENABLE_SUPABASE_BACKUP is not "true"; live backup execution remains disabled.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    config: {
      projectRef,
      supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
      dbUrl,
      serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
      encryptionKey: encKey,
      s3Endpoint: s3Endpoint.replace(/\/+$/, ''),
      s3Bucket,
      s3Region,
      s3Prefix,
      s3AccessKeyId: (env.BACKUP_S3_ACCESS_KEY_ID || '').trim(),
      s3SecretAccessKey: (env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim(),
      retentionDays: Number.isInteger(retentionDays) ? retentionDays : 30,
      minKeepCount: Number.isInteger(minKeepCount) ? minKeepCount : 7,
      enabled: env.ENABLE_SUPABASE_BACKUP === 'true'
    }
  };
}

/**
 * Redacts all known secret values and URI credentials from log/alert text.
 */
function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  // Mask any postgres://user:pass@host credentials if present
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/gi, '$1[REDACTED]$3');
  // Mask JWT-like bearer tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  return out;
}

/**
 * Builds read-only pg_dump argument sets for each Supabase backup component.
 * Every invocation must run with PGOPTIONS="-c default_transaction_read_only=on".
 */
function buildPgDumpPlan(dbUrl, dbDir) {
  return [
    {
      name: 'public-private-schema.sql',
      description: 'Readable DDL schema (tables, indexes, RLS policies, functions, triggers) for public and private schemas',
      outputPath: path.join(dbDir, 'public-private-schema.sql'),
      args: [
        '--dbname', dbUrl,
        '--schema=public',
        '--schema=private',
        '--schema-only',
        '--no-owner',
        '--lock-wait-timeout=30000',
        '--file', path.join(dbDir, 'public-private-schema.sql')
      ]
    },
    {
      name: 'public-private-full.dump',
      description: 'Full schema + data custom dump for public and private schemas',
      outputPath: path.join(dbDir, 'public-private-full.dump'),
      args: [
        '--dbname', dbUrl,
        '--format=custom',
        '--compress=9',
        '--schema=public',
        '--schema=private',
        '--no-owner',
        '--lock-wait-timeout=30000',
        '--file', path.join(dbDir, 'public-private-full.dump')
      ]
    },
    {
      name: 'auth-full.dump',
      description: 'Supabase Auth schema + users/identities/MFA custom dump',
      outputPath: path.join(dbDir, 'auth-full.dump'),
      args: [
        '--dbname', dbUrl,
        '--format=custom',
        '--compress=9',
        '--schema=auth',
        '--no-owner',
        '--lock-wait-timeout=30000',
        '--file', path.join(dbDir, 'auth-full.dump')
      ]
    },
    {
      name: 'storage-schema-full.dump',
      description: 'Supabase Storage buckets/objects metadata and policies custom dump',
      outputPath: path.join(dbDir, 'storage-schema-full.dump'),
      args: [
        '--dbname', dbUrl,
        '--format=custom',
        '--compress=9',
        '--schema=storage',
        '--no-owner',
        '--lock-wait-timeout=30000',
        '--file', path.join(dbDir, 'storage-schema-full.dump')
      ]
    },
    {
      name: 'supabase-migrations.dump',
      description: 'Applied supabase_migrations history dump',
      outputPath: path.join(dbDir, 'supabase-migrations.dump'),
      args: [
        '--dbname', dbUrl,
        '--format=custom',
        '--compress=9',
        '--schema=supabase_migrations',
        '--no-owner',
        '--lock-wait-timeout=30000',
        '--file', path.join(dbDir, 'supabase-migrations.dump')
      ]
    }
  ];
}

function readOnlyPgEnv(baseEnv = process.env) {
  const existing = (baseEnv.PGOPTIONS || '').trim();
  const flag = '-c default_transaction_read_only=on';
  return {
    ...baseEnv,
    PGOPTIONS: existing.includes('default_transaction_read_only') ? existing : `${existing} ${flag}`.trim()
  };
}

/**
 * Computes SHA-256 hex digest of a file using streaming I/O.
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Encrypts inputPath to outputPath using AES-256-GCM + scrypt key derivation.
 * Binary format (PFBK1):
 *   [5 bytes "PFBK1"][16 bytes salt][12 bytes IV][ciphertext...][16 bytes GCM authTag]
 */
async function encryptFile(inputPath, outputPath, passphrase) {
  if (!passphrase || passphrase.length < 32) {
    throw new Error('Encryption passphrase must be at least 32 characters.');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const tmpOut = `${outputPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const out = fs.createWriteStream(tmpOut, { mode: 0o600 });

  try {
    out.write(MAGIC);
    out.write(salt);
    out.write(iv);

    const input = fs.createReadStream(inputPath);
    await pipeline(input, cipher, out, { end: false });
    const tag = cipher.getAuthTag();
    await new Promise((resolve, reject) => {
      out.end(tag, (err) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(tmpOut, outputPath);
  } catch (err) {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Decrypts a PFBK1 AES-256-GCM file and verifies its authentication tag atomically.
 * Deletes partial output if the key is wrong or the file was tampered with.
 */
async function decryptFile(inputPath, outputPath, passphrase) {
  if (!passphrase || passphrase.length < 32) {
    throw new Error('Decryption passphrase must be at least 32 characters.');
  }
  const stat = fs.statSync(inputPath);
  if (stat.size < HEADER_LEN + TAG_LEN) {
    throw new Error('Encrypted backup file is truncated or invalid.');
  }

  const fd = fs.openSync(inputPath, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  const authTag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    fs.readSync(fd, authTag, 0, TAG_LEN, stat.size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Unrecognized backup encryption header (expected PFBK1).');
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const ciphertextStart = HEADER_LEN;
  const ciphertextEnd = stat.size - TAG_LEN - 1;
  const tmpOut = `${outputPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  try {
    if (ciphertextEnd < ciphertextStart) {
      // Empty plaintext payload
      const finalChunk = decipher.final();
      fs.writeFileSync(tmpOut, finalChunk, { mode: 0o600 });
    } else {
      const input = fs.createReadStream(inputPath, { start: ciphertextStart, end: ciphertextEnd });
      const out = fs.createWriteStream(tmpOut, { mode: 0o600 });
      await pipeline(input, decipher, out);
    }
    fs.renameSync(tmpOut, outputPath);
  } catch (err) {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    throw new Error(`Backup decryption/authentication failed: ${err.message}`);
  }
}

/**
 * Computes which backup archives can be safely deleted under retention policy.
 * Always keeps at least `minKeepCount` newest backups, regardless of age.
 * Expects objects: [{ key: string, lastModified: string | Date }]
 */
function computeRetentionDeletions(objects, retentionDays = 30, now = new Date(), minKeepCount = 7) {
  const backupRe = /backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz\.enc$/;
  const backups = objects
    .filter((obj) => obj && typeof obj.key === 'string' && backupRe.test(obj.key))
    .map((obj) => ({
      key: obj.key,
      timestamp: new Date(obj.lastModified).getTime()
    }))
    .filter((obj) => Number.isFinite(obj.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp); // newest first

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const toDelete = [];

  for (let i = 0; i < backups.length; i++) {
    if (i < minKeepCount) continue; // safety floor: always preserve newest N backups
    if (backups[i].timestamp < cutoffMs) {
      toDelete.push(backups[i].key);
      // Also delete matching sidecar manifest if present
      const manifestKey = backups[i].key.replace(/\.tar\.gz\.enc$/, '.manifest.json');
      if (objects.some((o) => o && o.key === manifestKey)) {
        toDelete.push(manifestKey);
      }
    }
  }
  return toDelete;
}

/**
 * Ensures a relative storage path cannot escape its target directory.
 */
function safeStorageFilePath(baseDir, bucketId, objectPath) {
  if (!bucketId || typeof bucketId !== 'string' || /[/\\\0]|\.\./.test(bucketId)) {
    throw new Error(`Unsafe bucket identifier: ${bucketId}`);
  }
  if (!objectPath || typeof objectPath !== 'string' || objectPath.includes('\0')) {
    throw new Error(`Unsafe object path: ${objectPath}`);
  }
  const normalized = path.posix.normalize(objectPath.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Path traversal rejected: ${objectPath}`);
  }
  const resolvedBase = path.resolve(baseDir);
  const fullPath = path.resolve(resolvedBase, bucketId, ...normalized.split('/'));
  if (!fullPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Resolved path escapes backup directory: ${objectPath}`);
  }
  return fullPath;
}

module.exports = {
  EXPECTED_BUCKETS,
  EXPECTED_SCHEMAS,
  REQUIRED_ENV_KEYS,
  validateBackupConfig,
  redactSecrets,
  buildPgDumpPlan,
  readOnlyPgEnv,
  sha256File,
  encryptFile,
  decryptFile,
  computeRetentionDeletions,
  safeStorageFilePath
};
