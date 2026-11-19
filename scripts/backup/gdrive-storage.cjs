'use strict';

const fs = require('fs');
const { computeRetentionDeletions } = require('./backup-lib.cjs');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Must be a multiple of 256 KiB per Google Drive resumable upload protocol.
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Exchanges a Google OAuth 2.0 refresh token for a short-lived access token.
 * Suitable for unattended GitHub Actions when the OAuth Consent Screen is set
 * to "In Production" (avoids 7-day Testing expiration) with least-privilege
 * scope https://www.googleapis.com/auth/drive.file.
 */
async function exchangeRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = globalThis.fetch
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const code = data.error || `HTTP ${res.status}`;
    if (code === 'invalid_grant') {
      throw new Error(
        'Google OAuth refresh token was rejected (invalid_grant). Ensure your OAuth Consent Screen is set to "In Production" (Testing tokens expire after 7 days), then generate a fresh refresh token.'
      );
    }
    throw new Error(`Google OAuth token refresh failed (${code}).`);
  }

  return data.access_token;
}

/**
 * Resolves the target Google Drive folder under drive.file scope.
 * - If folderId is supplied, verifies it is accessible, is a folder, and is not trashed.
 * - Otherwise searches for an app-accessible folder matching folderName, or creates one.
 */
async function ensureBackupFolder({
  accessToken,
  folderId,
  folderName = 'PureFunction-Encrypted-Backups',
  fetchImpl = globalThis.fetch
}) {
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  if (folderId) {
    const res = await fetchImpl(
      `${DRIVE_FILES_URL}/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`,
      { method: 'GET', headers: authHeader }
    );
    if (res.status === 404 || res.status === 403) {
      throw new Error(
        `Google Drive folder ID "${folderId}" is not accessible (HTTP ${res.status}). With the least-privilege "drive.file" scope, the backup app can only access a folder it created itself. Leave BACKUP_GDRIVE_FOLDER_ID empty to let the app create/reuse "${folderName}" automatically.`
      );
    }
    if (!res.ok) {
      throw new Error(`Failed to verify Google Drive folder "${folderId}" (HTTP ${res.status}).`);
    }
    const meta = await res.json();
    if (meta.trashed) {
      throw new Error(`Google Drive folder "${folderId}" is in the Trash.`);
    }
    if (meta.mimeType !== FOLDER_MIME) {
      throw new Error(`Google Drive ID "${folderId}" is not a folder.`);
    }
    return { id: meta.id, name: meta.name, created: false };
  }

  const q = `name='${escapeDriveQueryValue(folderName)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const listUrl = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`;
  const listRes = await fetchImpl(listUrl, { method: 'GET', headers: authHeader });
  if (!listRes.ok) {
    throw new Error(`Failed to search Google Drive backup folder (HTTP ${listRes.status}).`);
  }
  const listData = await listRes.json();
  if (Array.isArray(listData.files) && listData.files.length > 0) {
    return { id: listData.files[0].id, name: listData.files[0].name, created: false };
  }

  const createRes = await fetchImpl(`${DRIVE_FILES_URL}?fields=id,name`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME })
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create Google Drive backup folder "${folderName}" (HTTP ${createRes.status}).`);
  }
  const created = await createRes.json();
  if (!created.id) {
    throw new Error('Google Drive did not return an ID for the newly created backup folder.');
  }
  return { id: created.id, name: created.name || folderName, created: true };
}

/**
 * Uploads a local file to a Google Drive folder using Google Drive v3
 * Resumable Upload protocol (supports files > 5 MB reliably in fixed chunks).
 */
async function uploadFileResumable({
  accessToken,
  folderId,
  filePath,
  fileName,
  mimeType = 'application/octet-stream',
  chunkSizeBytes = DEFAULT_CHUNK_BYTES,
  fetchImpl = globalThis.fetch
}) {
  if (chunkSizeBytes <= 0 || chunkSizeBytes % (256 * 1024) !== 0) {
    throw new Error('chunkSizeBytes must be a positive multiple of 256 KiB.');
  }
  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;

  const initRes = await fetchImpl(
    `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,size,modifiedTime`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(totalBytes)
      },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId]
      })
    }
  );
  if (!initRes.ok) {
    throw new Error(`Failed to start Google Drive resumable upload for ${fileName} (HTTP ${initRes.status}).`);
  }
  const uploadUrl = initRes.headers.get('location') || initRes.headers.get('Location');
  if (!uploadUrl) {
    throw new Error(`Google Drive resumable upload did not return a session Location header for ${fileName}.`);
  }

  if (totalBytes === 0) {
    const emptyRes = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': '0'
      },
      body: Buffer.alloc(0)
    });
    if (!emptyRes.ok) {
      throw new Error(`Google Drive upload failed for empty file ${fileName} (HTTP ${emptyRes.status}).`);
    }
    return await emptyRes.json();
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    const reusableBuf = Buffer.allocUnsafe(Math.min(chunkSizeBytes, totalBytes));

    while (offset < totalBytes) {
      const toRead = Math.min(reusableBuf.length, totalBytes - offset);
      const bytesRead = fs.readSync(fd, reusableBuf, 0, toRead, offset);
      if (bytesRead <= 0) {
        throw new Error(`Unexpected EOF while reading ${fileName} at byte ${offset}.`);
      }
      const chunk = reusableBuf.subarray(0, bytesRead);
      const endByte = offset + bytesRead - 1;

      const putRes = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(bytesRead),
          'Content-Range': `bytes ${offset}-${endByte}/${totalBytes}`
        },
        body: chunk
      });

      if (putRes.status === 308) {
        offset += bytesRead;
        continue;
      }
      if (putRes.ok) {
        return await putRes.json();
      }
      throw new Error(
        `Google Drive chunk upload failed for ${fileName} at bytes ${offset}-${endByte} (HTTP ${putRes.status}).`
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  throw new Error(`Google Drive upload for ${fileName} ended without a final completion response.`);
}

/**
 * Lists all non-trashed files inside the target Google Drive backup folder.
 */
async function listFolderFiles({ accessToken, folderId, fetchImpl = globalThis.fetch }) {
  const files = [];
  let pageToken = null;
  const q = `'${escapeDriveQueryValue(folderId)}' in parents and trashed=false`;

  while (true) {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,modifiedTime,createdTime)',
      pageSize: '1000'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetchImpl(`${DRIVE_FILES_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error(`Failed to list Google Drive backup folder contents (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (Array.isArray(data.files)) {
      files.push(...data.files);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return files;
}

async function deleteDriveFile({ accessToken, fileId, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to prune expired Google Drive backup file ${fileId} (HTTP ${res.status}).`);
  }
}

/**
 * Uploads encrypted backup archive + non-PII manifest to Google Drive,
 * then applies retention pruning while preserving at least minKeepCount newest backups.
 */
async function uploadAndPruneGDrive({
  config,
  encPath,
  manifestPath,
  baseName,
  now = new Date(),
  chunkSizeBytes = DEFAULT_CHUNK_BYTES,
  fetchImpl = globalThis.fetch
}) {
  const accessToken = await exchangeRefreshToken({
    clientId: config.gdriveClientId,
    clientSecret: config.gdriveClientSecret,
    refreshToken: config.gdriveRefreshToken,
    fetchImpl
  });

  const folder = await ensureBackupFolder({
    accessToken,
    folderId: config.gdriveFolderId,
    folderName: config.gdriveFolderName,
    fetchImpl
  });

  const encFile = await uploadFileResumable({
    accessToken,
    folderId: folder.id,
    filePath: encPath,
    fileName: `${baseName}.tar.gz.enc`,
    mimeType: 'application/octet-stream',
    chunkSizeBytes,
    fetchImpl
  });

  const manifestFile = await uploadFileResumable({
    accessToken,
    folderId: folder.id,
    filePath: manifestPath,
    fileName: `${baseName}.manifest.json`,
    mimeType: 'application/json',
    chunkSizeBytes,
    fetchImpl
  });

  const existing = await listFolderFiles({ accessToken, folderId: folder.id, fetchImpl });
  const objects = existing.map((f) => ({
    key: f.name,
    id: f.id,
    lastModified: f.modifiedTime || f.createdTime
  }));
  const keysToDelete = new Set(
    computeRetentionDeletions(objects, config.retentionDays, now, config.minKeepCount)
  );

  let prunedCount = 0;
  for (const obj of objects) {
    if (keysToDelete.has(obj.key) && obj.id) {
      await deleteDriveFile({ accessToken, fileId: obj.id, fetchImpl });
      prunedCount++;
    }
  }

  return {
    folderId: folder.id,
    folderName: folder.name,
    folderCreated: folder.created,
    archiveFileId: encFile.id,
    manifestFileId: manifestFile.id,
    prunedCount
  };
}

module.exports = {
  DEFAULT_CHUNK_BYTES,
  exchangeRefreshToken,
  ensureBackupFolder,
  uploadFileResumable,
  listFolderFiles,
  deleteDriveFile,
  uploadAndPruneGDrive
};
