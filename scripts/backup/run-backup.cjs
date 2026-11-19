#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateBackupConfig,
  redactSecrets,
  buildPgDumpPlan,
  readOnlyPgEnv,
  sha256File,
  encryptFile,
  decryptFile,
  computeRetentionDeletions
} = require('./backup-lib.cjs');
const { exportSupabaseStorage } = require('./export-storage.cjs');

function runTool(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...opts
  });
}

function s3Env(cfg) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: cfg.s3AccessKeyId,
    AWS_SECRET_ACCESS_KEY: cfg.s3SecretAccessKey,
    AWS_DEFAULT_REGION: cfg.s3Region || 'auto',
    AWS_EC2_METADATA_DISABLED: 'true'
  };
}

function collectReadOnlyDbInventory(cfg, outputPath) {
  const sql = `
    SELECT json_build_object(
      'captured_at', now(),
      'server_version', current_setting('server_version'),
      'extensions', (
        SELECT coalesce(json_agg(json_build_object('name', extname, 'version', extversion) ORDER BY extname), '[]'::json)
        FROM pg_extension
      ),
      'tables', (
        SELECT coalesce(json_agg(json_build_object(
          'schema', schemaname,
          'table', relname,
          'estimated_rows', n_live_tup
        ) ORDER BY schemaname, relname), '[]'::json)
        FROM pg_stat_user_tables
        WHERE schemaname IN ('public', 'private', 'auth', 'storage')
      )
    )::text;
  `;
  const out = runTool(
    'psql',
    ['--dbname', cfg.dbUrl, '--no-psqlrc', '--tuples-only', '--no-align', '--command', sql],
    { env: readOnlyPgEnv(process.env) }
  );
  fs.writeFileSync(outputPath, out.trim() + '\n', { mode: 0o600 });
}

async function runSelfTest(workDir, encryptionKey) {
  const sampleIn = path.join(workDir, 'selftest-in.bin');
  const sampleEnc = path.join(workDir, 'selftest.enc');
  const sampleOut = path.join(workDir, 'selftest-out.bin');
  const payload = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(sampleIn, payload, { mode: 0o600 });
  const hashBefore = await sha256File(sampleIn);
  await encryptFile(sampleIn, sampleEnc, encryptionKey);
  await decryptFile(sampleEnc, sampleOut, encryptionKey);
  const hashAfter = await sha256File(sampleOut);
  if (hashBefore !== hashAfter) {
    throw new Error('Encryption self-test failed: decrypted SHA-256 mismatch.');
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const validateOnly = args.has('--validate-only') || args.has('--dry-run');
  const confirmLive = args.has('--confirm-live');

  process.umask(0o077);
  const validation = validateBackupConfig(process.env);
  const secrets = [
    validation.config.dbUrl,
    validation.config.serviceRoleKey,
    validation.config.encryptionKey,
    validation.config.s3AccessKeyId,
    validation.config.s3SecretAccessKey
  ];

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-backup-'));
  try {
    if (!validation.ok) {
      console.error('Backup configuration validation failed:');
      for (const err of validation.errors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
      return;
    }

    if (validateOnly) {
      await runSelfTest(workDir, validation.config.encryptionKey);
      console.log('PASS: Backup configuration is valid and AES-256-GCM round-trip self-test succeeded.');
      for (const w of validation.warnings) {
        console.log(`NOTE: ${w}`);
      }
      console.log('Dry-run complete. Zero database, Storage, or S3 operations were executed.');
      return;
    }

    if (!confirmLive || !validation.config.enabled) {
      console.error(
        'Refusing to execute live backup: requires BOTH --confirm-live flag and ENABLE_SUPABASE_BACKUP=true.'
      );
      process.exitCode = 2;
      return;
    }

    const cfg = validation.config;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
    const stageDir = path.join(workDir, 'payload');
    const dbDir = path.join(stageDir, 'db');
    const storageDir = path.join(stageDir, 'storage');
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });

    // 1) Read-only PostgreSQL dumps (public, private, auth, storage metadata, migrations)
    console.log(`[1/6] Running read-only PostgreSQL dumps for project ${cfg.projectRef}...`);
    const dumpPlan = buildPgDumpPlan(cfg.dbUrl, dbDir);
    const dbComponents = [];
    for (const item of dumpPlan) {
      runTool('pg_dump', item.args, { env: readOnlyPgEnv(process.env) });
      const stat = fs.statSync(item.outputPath);
      if (stat.size === 0) {
        throw new Error(`pg_dump produced an empty file for ${item.name}`);
      }
      dbComponents.push({
        name: item.name,
        bytes: stat.size,
        sha256: await sha256File(item.outputPath)
      });
    }
    collectReadOnlyDbInventory(cfg, path.join(dbDir, 'db-inventory.json'));

    // 2) Read-only Supabase Storage export (all buckets & object bytes)
    console.log('[2/6] Exporting Supabase Storage buckets and objects (read-only)...');
    const storageSummary = await exportSupabaseStorage({
      supabaseUrl: cfg.supabaseUrl,
      serviceRoleKey: cfg.serviceRoleKey,
      outputDir: storageDir
    });

    // 3) Package tarball
    console.log('[3/6] Creating compressed archive...');
    const baseName = `backup-${stamp}`;
    const tarPath = path.join(workDir, `${baseName}.tar.gz`);
    runTool('tar', ['-czf', tarPath, '-C', stageDir, '.']);
    const tarSha256 = await sha256File(tarPath);
    const tarBytes = fs.statSync(tarPath).size;

    // 4) Encrypt & immediately verify decryption round-trip before upload
    console.log('[4/6] Encrypting archive with AES-256-GCM and verifying decryption...');
    const encPath = path.join(workDir, `${baseName}.tar.gz.enc`);
    const verifyPath = path.join(workDir, `${baseName}.verify.tar.gz`);
    await encryptFile(tarPath, encPath, cfg.encryptionKey);
    await decryptFile(encPath, verifyPath, cfg.encryptionKey);
    const verifiedSha256 = await sha256File(verifyPath);
    if (verifiedSha256 !== tarSha256) {
      throw new Error('Encrypted archive verification failed: decrypted SHA-256 mismatch.');
    }
    fs.rmSync(verifyPath, { force: true });
    const encSha256 = await sha256File(encPath);
    const encBytes = fs.statSync(encPath).size;

    // Non-PII sidecar manifest (only hashes, counts, sizes, and component names)
    const manifest = {
      formatVersion: 1,
      encryption: 'PFBK1-AES-256-GCM-SCRYPT',
      projectRef: cfg.projectRef,
      createdAt: new Date().toISOString(),
      archiveName: `${baseName}.tar.gz.enc`,
      plaintextArchiveBytes: tarBytes,
      plaintextArchiveSha256: tarSha256,
      encryptedArchiveBytes: encBytes,
      encryptedArchiveSha256: encSha256,
      dbComponents,
      storageSummary: {
        bucketCount: storageSummary.bucketCount,
        missingExpectedBuckets: storageSummary.missingExpectedBuckets,
        objectCount: storageSummary.objectCount,
        totalBytes: storageSummary.totalBytes
      }
    };
    const manifestPath = path.join(workDir, `${baseName}.manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    // 5) Upload to external S3-compatible bucket (Cloudflare R2 / Backblaze B2 / AWS S3)
    console.log('[5/6] Uploading encrypted archive and non-PII manifest to external bucket...');
    const awsEnv = s3Env(cfg);
    const s3Base = `s3://${cfg.s3Bucket}/${cfg.s3Prefix}`;
    runTool('aws', ['s3', 'cp', encPath, `${s3Base}/${baseName}.tar.gz.enc`, '--endpoint-url', cfg.s3Endpoint, '--only-show-errors'], { env: awsEnv });
    runTool('aws', ['s3', 'cp', manifestPath, `${s3Base}/${baseName}.manifest.json`, '--endpoint-url', cfg.s3Endpoint, '--only-show-errors'], { env: awsEnv });

    // 6) Safe retention pruning (always preserves at least minKeepCount newest backups)
    console.log(`[6/6] Evaluating retention policy (${cfg.retentionDays}d, minimum ${cfg.minKeepCount} backups kept)...`);
    const listOut = runTool(
      'aws',
      [
        's3api', 'list-objects-v2',
        '--bucket', cfg.s3Bucket,
        '--prefix', `${cfg.s3Prefix}/`,
        '--endpoint-url', cfg.s3Endpoint,
        '--output', 'json'
      ],
      { env: awsEnv }
    );
    const parsedList = JSON.parse(listOut || '{}');
    const objects = (parsedList.Contents || []).map((o) => ({
      key: o.Key,
      lastModified: o.LastModified
    }));
    const deletions = computeRetentionDeletions(objects, cfg.retentionDays, new Date(), cfg.minKeepCount);
    for (const key of deletions) {
      runTool(
        'aws',
        ['s3api', 'delete-object', '--bucket', cfg.s3Bucket, '--key', key, '--endpoint-url', cfg.s3Endpoint],
        { env: awsEnv }
      );
    }

    console.log(
      `PASS: Encrypted backup ${baseName}.tar.gz.enc uploaded (${encBytes} bytes, ${storageSummary.objectCount} storage files). Pruned ${deletions.length} expired file(s).`
    );
  } catch (err) {
    console.error('BACKUP FAILED:', redactSecrets(err && err.stack ? err.stack : String(err), secrets));
    process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main();
}
