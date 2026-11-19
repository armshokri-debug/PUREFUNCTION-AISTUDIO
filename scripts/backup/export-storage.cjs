'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { EXPECTED_BUCKETS, safeStorageFilePath } = require('./backup-lib.cjs');

/**
 * Read-only Supabase Storage exporter.
 * Lists every bucket in the project, recursively enumerates all objects with
 * pagination, downloads raw bytes via the authenticated Storage endpoint,
 * and writes bucket definitions + per-file SHA-256 inventory.
 * Never creates, modifies, or deletes any bucket or object.
 */
async function exportSupabaseStorage({
  supabaseUrl,
  serviceRoleKey,
  outputDir,
  fetchImpl = globalThis.fetch
}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('supabaseUrl and serviceRoleKey are required for Storage export.');
  }
  const base = supabaseUrl.replace(/\/+$/, '');
  const authHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };

  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const filesRoot = path.join(outputDir, 'files');
  fs.mkdirSync(filesRoot, { recursive: true, mode: 0o700 });

  // 1) List all buckets (read-only GET)
  const bucketsRes = await fetchImpl(`${base}/storage/v1/bucket`, {
    method: 'GET',
    headers: authHeaders
  });
  if (!bucketsRes.ok) {
    throw new Error(`Failed to list Storage buckets (HTTP ${bucketsRes.status}).`);
  }
  const buckets = await bucketsRes.json();
  if (!Array.isArray(buckets)) {
    throw new Error('Unexpected response while listing Storage buckets.');
  }

  fs.writeFileSync(
    path.join(outputDir, 'buckets.json'),
    JSON.stringify(buckets, null, 2),
    { mode: 0o600 }
  );

  const discoveredBucketIds = buckets.map((b) => b.id || b.name).filter(Boolean);
  const missingExpectedBuckets = EXPECTED_BUCKETS.filter((id) => !discoveredBucketIds.includes(id));

  const inventory = [];
  let totalBytes = 0;

  async function listFolder(bucketId, prefix) {
    let offset = 0;
    const limit = 100;
    while (true) {
      const listRes = await fetchImpl(`${base}/storage/v1/object/list/${encodeURIComponent(bucketId)}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prefix,
          limit,
          offset,
          sortBy: { column: 'name', order: 'asc' }
        })
      });
      if (!listRes.ok) {
        throw new Error(`Failed to list Storage objects in ${bucketId}/${prefix} (HTTP ${listRes.status}).`);
      }
      const items = await listRes.json();
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        if (!item || !item.name || item.name === '.emptyFolderPlaceholder') continue;
        const objectPath = prefix ? `${prefix}/${item.name}` : item.name;
        const isFolder = item.id === null || item.id === undefined;
        if (isFolder) {
          await listFolder(bucketId, objectPath);
          continue;
        }
        const destPath = safeStorageFilePath(filesRoot, bucketId, objectPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });

        const encodedObject = objectPath.split('/').map(encodeURIComponent).join('/');
        const dlRes = await fetchImpl(
          `${base}/storage/v1/object/authenticated/${encodeURIComponent(bucketId)}/${encodedObject}`,
          { method: 'GET', headers: authHeaders }
        );
        if (!dlRes.ok) {
          throw new Error(`Failed to download Storage object ${bucketId}/${objectPath} (HTTP ${dlRes.status}).`);
        }

        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const out = fs.createWriteStream(destPath, { mode: 0o600 });

        if (dlRes.body && typeof dlRes.body.getReader === 'function') {
          const nodeStream = Readable.fromWeb(dlRes.body);
          nodeStream.on('data', (chunk) => {
            hash.update(chunk);
            bytes += chunk.length;
          });
          await pipeline(nodeStream, out);
        } else {
          const buf = Buffer.from(await dlRes.arrayBuffer());
          hash.update(buf);
          bytes = buf.length;
          fs.writeFileSync(destPath, buf, { mode: 0o600 });
          out.destroy();
        }

        totalBytes += bytes;
        inventory.push({
          bucket: bucketId,
          path: objectPath,
          size: bytes,
          contentType: (item.metadata && item.metadata.mimetype) || dlRes.headers.get('content-type') || null,
          updatedAt: item.updated_at || item.created_at || null,
          sha256: hash.digest('hex')
        });
      }

      if (items.length < limit) break;
      offset += limit;
    }
  }

  for (const bucketId of discoveredBucketIds) {
    await listFolder(bucketId, '');
  }

  // Inventory stays inside the encrypted backup archive (never uploaded in plaintext).
  fs.writeFileSync(
    path.join(outputDir, 'storage-inventory.json'),
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      bucketCount: discoveredBucketIds.length,
      buckets: discoveredBucketIds,
      missingExpectedBuckets,
      objectCount: inventory.length,
      totalBytes,
      objects: inventory
    }, null, 2),
    { mode: 0o600 }
  );

  return {
    bucketCount: discoveredBucketIds.length,
    buckets: discoveredBucketIds,
    missingExpectedBuckets,
    objectCount: inventory.length,
    totalBytes
  };
}

module.exports = { exportSupabaseStorage };
