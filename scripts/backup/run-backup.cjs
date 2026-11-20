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
const { inspectFirstBackupDrive, uploadAndPruneGDrive } = require('./gdrive-storage.cjs');
const { runConnectivity } = require('./check-connectivity.cjs');

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

async function preflightFirstDriveBackup(cfg, workDir) {
  if (process.env.ENABLE_SUPABASE_BACKUP !== 'false' || cfg.provider !== 'gdrive' ||
      cfg.projectRef !== 'rugwzvztweiffprkxfdc' ||
      cfg.gdriveFolderName !== 'PureFunction-Encrypted-Backups') {
    throw new Error('First backup requires the approved project and Google Drive folder with the repository backup switch off.');
  }
  await runSelfTest(workDir, cfg.encryptionKey);
  if (!await runConnectivity()) throw new Error('Read-only connectivity preflight failed.');
  const sql = `SELECT current_setting('server_version_num'), pg_database_size(current_database()),
    count(*), coalesce(sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$'
      THEN (metadata->>'size')::numeric ELSE 0 END), 0)
    FROM storage.objects WHERE name !~ '(^|/)\\.emptyFolderPlaceholder$';`;
  const output = runTool('psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '--dbname', cfg.dbUrl, '-c', sql], {
    env: readOnlyPgEnv(process.env)
  }).trim();
  if (!/^\d+\|\d+\|\d+\|\d+$/.test(output)) throw new Error('Could not estimate the backup source size.');
  const [serverVersion, databaseBytes, objectCount, storageBytes] = output.split('|').map(BigInt);
  const clientMajor = runTool('pg_dump', ['--version']).match(/PostgreSQL\) (\d+)/)?.[1];
  if (!clientMajor || BigInt(clientMajor) < serverVersion / 10000n) {
    throw new Error('PostgreSQL client is older than the source server.');
  }
  console.log(`Source estimate: PostgreSQL ${databaseBytes} bytes; Storage ${storageBytes} bytes across ${objectCount} objects; pg_dump ${clientMajor}.`);
  const destination = await inspectFirstBackupDrive(cfg, databaseBytes + storageBytes);
  console.log(`Drive quota: ${destination.freeBytes ?? 'unlimited'} available bytes. Private folder: ${destination.folder ? 'available' : 'will be created during backup'}.`);
  return objectCount;
}

function verifyDumpContents(item) {
  if (!item.name.endsWith('.dump')) return;
  const contents = runTool('pg_restore', ['--list', item.outputPath]);
  const required = {
    'public-private-full.dump': ['public clients', 'public workouts'],
    'auth-full.dump': ['auth users', 'auth identities'],
    'storage-schema-full.dump': ['storage buckets', 'storage objects'],
    'supabase-migrations.dump': ['supabase_migrations schema_migrations']
  };
  for (const entry of required[item.name]) {
    if (!contents.includes(`TABLE ${entry} `) || !contents.includes(`TABLE DATA ${entry} `)) {
      throw new Error('Expected table definition or data is missing from a database component.');
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const validateOnly = args.has('--validate-only') || args.has('--dry-run');
  const confirmLive = args.has('--confirm-live');
  const firstBackup = args.has('--first-drive-backup');
  const firstPreflight = args.has('--first-drive-preflight');

  process.umask(0o077);
  const validation = validateBackupConfig(process.env);
  const secrets = [
    validation.config.dbUrl,
    validation.config.serviceRoleKey,
    validation.config.encryptionKey,
    validation.config.s3AccessKeyId,
    validation.config.s3SecretAccessKey,
    validation.config.gdriveClientSecret,
    validation.config.gdriveRefreshToken
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
      console.log(
        `PASS: Backup configuration is valid (provider=${validation.config.provider}) and AES-256-GCM round-trip self-test succeeded.`
      );
      for (const w of validation.warnings) {
        console.log(`NOTE: ${w}`);
      }
      console.log('Dry-run complete. Zero database, Storage, S3, or Google Drive operations were executed.');
      return;
    }

    if (!firstBackup && !firstPreflight && (!confirmLive || !validation.config.enabled)) {
      console.error(
        'Refusing to execute live backup: requires BOTH --confirm-live flag and ENABLE_SUPABASE_BACKUP=true.'
      );
      process.exitCode = 2;
      return;
    }

    const cfg = validation.config;
    let expectedStorageObjects;
    if (firstBackup || firstPreflight) {
      expectedStorageObjects = await preflightFirstDriveBackup(cfg, workDir);
      if (firstPreflight) return;
    }
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
      if (firstBackup) verifyDumpContents(item);
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
    if (firstBackup && (storageSummary.missingExpectedBuckets.length ||
        BigInt(storageSummary.objectCount) !== expectedStorageObjects)) {
      throw new Error('Storage export did not match the expected buckets and object count.');
    }

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
      storageProvider: cfg.provider,
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

    // 5 & 6) Upload encrypted archive + non-PII manifest and prune expired backups
    let prunedCount = 0;
    if (cfg.provider === 'gdrive') {
      console.log(`[5/6] Uploading encrypted archive to Google Drive folder "${cfg.gdriveFolderName}"...`);
      console.log(firstBackup ? '[6/6] Google Drive retention deletion disabled for this run.'
        : `[6/6] Evaluating Google Drive retention policy (${cfg.retentionDays}d, minimum ${cfg.minKeepCount} backups kept)...`);
      const gdriveRes = await uploadAndPruneGDrive({
        config: cfg,
        encPath,
        manifestPath,
        baseName,
        firstBackup
      });
      prunedCount = gdriveRes.prunedCount;
      console.log(
        `PASS: Encrypted backup ${baseName}.tar.gz.enc uploaded to Google Drive folder "${gdriveRes.folderName}" (${encBytes} bytes, ${storageSummary.objectCount} storage files). Pruned ${prunedCount} expired file(s).`
      );
      if (firstBackup) console.log(`PASS: Stored archive and manifest sizes and SHA-256 verified. Archive SHA-256: ${encSha256}.`);
    } else {
      console.log('[5/6] Uploading encrypted archive and non-PII manifest to external S3-compatible bucket...');
      const awsEnv = s3Env(cfg);
      const s3Base = `s3://${cfg.s3Bucket}/${cfg.s3Prefix}`;
      runTool('aws', ['s3', 'cp', encPath, `${s3Base}/${baseName}.tar.gz.enc`, '--endpoint-url', cfg.s3Endpoint, '--only-show-errors'], { env: awsEnv });
      runTool('aws', ['s3', 'cp', manifestPath, `${s3Base}/${baseName}.manifest.json`, '--endpoint-url', cfg.s3Endpoint, '--only-show-errors'], { env: awsEnv });

      console.log(`[6/6] Evaluating S3 retention policy (${cfg.retentionDays}d, minimum ${cfg.minKeepCount} backups kept)...`);
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
      prunedCount = deletions.length;
      console.log(
        `PASS: Encrypted backup ${baseName}.tar.gz.enc uploaded to S3 bucket (${encBytes} bytes, ${storageSummary.objectCount} storage files). Pruned ${prunedCount} expired file(s).`
      );
    }
  } catch (err) {
    console.error('BACKUP FAILED:', firstBackup || firstPreflight
      ? 'The current backup stage did not complete. Sensitive operation details are suppressed.'
      : redactSecrets(err && err.stack ? err.stack : String(err), secrets));
    process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main();
}
