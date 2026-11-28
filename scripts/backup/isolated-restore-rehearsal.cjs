#!/usr/bin/env node
'use strict';
// Recovery rehearsal only: Google Drive GET + disposable local Supabase DB/Storage.
// No Production/QA database connections, no uploads outside loopback, no email.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {exchangeRefreshToken} = require('./gdrive-storage.cjs');
const {decryptFile,sha256File,safeStorageFilePath} = require('./backup-lib.cjs');
const {createClient} = require('@supabase/supabase-js');

const PROD_REF = 'rugwzvztweiffprkxfdc';
const ARCHIVE_NAME = process.env.BACKUP_ARCHIVE_NAME || 'backup-2026-11-23T22-29-25Z.tar.gz.enc';
assert(/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz\.enc$/.test(ARCHIVE_NAME),
  'Blocked: backup archive name does not match safe naming format');
const MAX_BYTES = 256 * 1024 * 1024;
const SECRETS = ['BACKUP_GDRIVE_CLIENT_ID','BACKUP_GDRIVE_CLIENT_SECRET',
  'BACKUP_GDRIVE_REFRESH_TOKEN','BACKUP_ENCRYPTION_KEY'];
for (const key of SECRETS) assert(process.env[key], 'Missing required backup secret: '+key);
assert.equal(process.env.PF_ISOLATED_RESTORE, 'I_CONFIRM_DISPOSABLE_LOCAL_ONLY',
  'Blocked: explicit disposable-local-only guard');
const db = process.env.PF_RESTORE_DB_URL;
const api = process.env.PF_RESTORE_API_URL;
const localServiceKey = process.env.PF_RESTORE_LOCAL_SERVICE_KEY;
for(const url of [db,api]) {
  assert(url, 'Missing local Supabase endpoint');
  const u = new URL(url);
  assert(['localhost','127.0.0.1'].includes(u.hostname), 'Blocked: remote endpoint');
}
assert(localServiceKey,'Missing disposable-local service key');
const folderId=process.env.BACKUP_GDRIVE_FOLDER_ID;
assert(/^[\w-]{10,120}$/.test(folderId||''),'Missing pinned backup folder');
process.umask(0o077);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pf-restore-isolated-'));
const stem=ARCHIVE_NAME.replace(/\.tar\.gz\.enc$/,'');
const shaRegex=/^[a-f0-9]{64}$/;
function tool(name,args) {
  // Discard pg_restore stdout/stderr so Auth rows and private metadata
  // never appear in CI logs or error reports.
  return execFileSync(name,args,{
    encoding:'utf8',maxBuffer:5*1024*1024,
    stdio:['ignore','pipe','pipe'],timeout:180000
  });
}
const q = s=>tool('psql',[db,'-X','-v','ON_ERROR_STOP=1','-A','-t','-c',s]).trim();
function pgRestore(file,mode, extra=[], restoreAcl=false) {
  try{
    tool('pg_restore',['--dbname',db,'--no-owner',...(restoreAcl?[]:['--no-privileges']),
      '--exit-on-error',...mode,...extra,file]);
  } catch (err) {
    // pg_restore errors can include statements and row data. Print only a
    // bounded, redacted error class, never raw SQL or untrusted backup content.
    const raw=String(err.stderr||'');
    const lines=raw.split(/\r?\n/).filter(l=>/pg_restore: error:|ERROR:|FATAL:/i.test(l)).slice(0,3);
    const safe=lines.map(l=>l.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi,'[email]')
      .replace(/'[\s\S]*?'/g,'[value]').replace(/"[^"]*"/g,'[identifier]')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'[uuid]').slice(0,160)).join(' ; ');
    const sourceTable=raw.match(/COPY failed for table "([a-z][a-z0-9_]*)"/i)?.[1];
    const tableNote=sourceTable?' [table: '+sourceTable+']':'';
    throw Error('Local restore failed for '+path.basename(file)+tableNote+(safe?' / '+safe:''));
  }
}
async function fileFromDrive(token,name,output) {
  const u=new URL('https://www.googleapis.com/drive/v3/files');
  u.searchParams.set('q',`'${folderId}' in parents and name='${name}' and trashed=false`);
  u.searchParams.set('fields','files(id,name,mimeType,size),nextPageToken');
  u.searchParams.set('pageSize','10');
  const res=await fetch(u,{headers:{Authorization:'Bearer '+token}});
  assert(res.ok, 'Backup Drive list failed (HTTP '+res.status+')');
  const list=await res.json();
  assert.equal(list.files?.length,1,'Expected exactly one requested backup component');
  const item=list.files[0];
  assert(item.id&&item.name===name,'Unexpected backup object');
  assert(Number(item.size)<=MAX_BYTES,'Backup exceeds safety limit');
  const download=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?alt=media',
    {headers:{Authorization:'Bearer '+token}});
  assert(download.ok,'Backup Drive download failed (HTTP '+download.status+')');
  const b=Buffer.from(await download.arrayBuffer());
  assert(b.byteLength<=MAX_BYTES,'Backup exceeds safety limit');
  fs.writeFileSync(output,b,{mode:0o600});
  return b.byteLength;
}
function restoreDataTables(dump,schema,tableNames) {
  // Limit Auth/Storage restore to user/application state, not provider-managed
  // schema migration history. The target is a disposable local Supabase.
  let toc;
  try {toc=tool('pg_restore',['--list',dump]);}
  catch{throw Error('Cannot inspect '+schema+' dump catalog');}
  const keep=new Set(tableNames);
  const items=toc.split('\n').map(l=>{
    const m=l.match(/^\d+;\s+\d+\s+\d+\s+TABLE DATA\s+(\S+)\s+(\S+)\s/);
    return {line:l,schema:m?.[1],table:m?.[2]};
  }).filter(x=>x.schema===schema&&keep.has(x.table))
    .sort((a,b)=>tableNames.indexOf(a.table)-tableNames.indexOf(b.table))
    .map(x=>x.line);
  assert(items.length>0, 'No expected '+schema+' table data in original backup');
  const f=path.join(tmp,schema+'.toc');
  fs.writeFileSync(f,items.join('\n')+'\n',{mode:0o600});
  // Provider-managed Auth/Storage tables are not owned by the local postgres
  // connection. Do not disable their system triggers during data replay.
  pgRestore(dump,['--data-only','--use-list',f]);
}
async function main(){
  const accessToken=await exchangeRefreshToken({
    clientId:process.env.BACKUP_GDRIVE_CLIENT_ID,
    clientSecret:process.env.BACKUP_GDRIVE_CLIENT_SECRET,
    refreshToken:process.env.BACKUP_GDRIVE_REFRESH_TOKEN
  });
  const enc=path.join(tmp,'backup.enc'),manifestPath=path.join(tmp,'manifest.json');
  const tar=path.join(tmp,'backup.tar.gz');
  await fileFromDrive(accessToken,ARCHIVE_NAME,enc);
  await fileFromDrive(accessToken,stem+'.manifest.json',manifestPath);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  assert.equal(manifest.projectRef,PROD_REF,'Backup source mismatch');
  assert.equal(manifest.archiveName,ARCHIVE_NAME,'Backup name mismatch');
  assert(shaRegex.test(manifest.encryptedArchiveSha256),'Missing archive checksum');
  assert.equal(await sha256File(enc),manifest.encryptedArchiveSha256,'Encrypted hash mismatch');
  await decryptFile(enc,tar,process.env.BACKUP_ENCRYPTION_KEY);
  assert.equal(await sha256File(tar),manifest.plaintextArchiveSha256,'Decrypted archive checksum mismatch');
  const listing=tool('tar',['-tzf',tar]).trim().split('\n');
  assert(listing.every(p=>!path.isAbsolute(p)&&!p.split('/').includes('..')),'Unsafe archive path');
  const root=path.join(tmp,'payload'); fs.mkdirSync(root,{mode:0o700});
  tool('tar',['-xzf',tar,'-C',root,'--no-same-owner','--no-same-permissions']);
  const required=[
    'public-private-full.dump','auth-full.dump','storage-schema-full.dump',
    'supabase-migrations.dump','public-private-schema.sql'
  ];
  for(const name of required){
    const p=path.join(root,'db',name);
    const comp=manifest.dbComponents?.find(x=>x.name===name);
    assert(fs.statSync(p).size>0 && comp&&shaRegex.test(comp.sha256),
      'Backup component missing or invalid: '+name);
    assert.equal(await sha256File(p),comp.sha256,'DB component checksum mismatch: '+name);
    tool('pg_restore',['--list',p].filter(Boolean).length&&name.endsWith('.dump')?['--list',p]:['--help']);
  }
  const inventoryPath=path.join(root,'storage','storage-inventory.json');
  const bucketPath=path.join(root,'storage','buckets.json');
  const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  const buckets=JSON.parse(fs.readFileSync(bucketPath,'utf8'));
  assert.equal(inventory.objectCount,manifest.storageSummary.objectCount,
    'Storage object inventory count mismatch');
  assert(inventory.bucketCount===buckets.length,'Storage bucket count mismatch');
  for(const obj of inventory.objects){
    const disk=safeStorageFilePath(path.join(root,'storage','files'),obj.bucket,obj.path);
    assert.equal(await sha256File(disk),obj.sha256,'Storage object checksum mismatch');
  }
  console.log('PASS: exact Production backup downloaded, decrypted and all DB/Storage hashes verified');
  // All DB connections go to disposable local Supabase. Refuse remote targets above.
  const pub=path.join(root,'db','public-private-full.dump');
  const auth=path.join(root,'db','auth-full.dump');
  const storage=path.join(root,'db','storage-schema-full.dump');
  pgRestore(pub,['--section=pre-data','--clean','--if-exists']);
  restoreDataTables(auth,'auth',['users','identities','sessions','refresh_tokens',
    'mfa_factors','mfa_challenges','mfa_amr_claims','one_time_tokens','flow_state']);
  pgRestore(pub,['--data-only','--disable-triggers']);
  // A row-only restore is not a complete application recovery: constraints,
  // indexes, triggers and RLS policies live in the post-data section.
  pgRestore(pub,['--section=post-data']);
  // Restore application ACLs explicitly without overwriting provider-managed Auth/Storage ACLs.
  const aclList=tool('pg_restore',['--list',pub]).split('\n')
    .filter(l=>/^\d+;\s+\d+\s+\d+\s+(DEFAULT ACL|ACL)\s/.test(l));
  assert(aclList.length>0,'Application grant entries are missing from archive');
  const aclFile=path.join(tmp,'app-acl.toc');
  fs.writeFileSync(aclFile,aclList.join('\n')+'\n',{mode:0o600});
  pgRestore(pub,['--use-list',aclFile],[],true);
  assert.equal(Number(q("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")),0,
    'Restored application tables must have RLS enabled');
  assert(Number(q("select count(*) from pg_policies where schemaname='public'"))>0,'Application RLS policies missing');
  assert(Number(q("select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype='f'"))>0,'Application foreign keys missing');
  console.log('PASS: application post-data, RLS policies, foreign keys and archived grant entries restored');
  restoreDataTables(storage,'storage',['buckets','objects']);
  // Reattach only the archived Storage bytes to disposable local object storage.
  const client=createClient(api,localServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  for(const obj of inventory.objects){
    const disk=safeStorageFilePath(path.join(root,'storage','files'),obj.bucket,obj.path);
    const {error}=await client.storage.from(obj.bucket).upload(obj.path,
      fs.readFileSync(disk),{contentType:obj.contentType||'application/octet-stream',upsert:true});
    assert(!error,'Isolated local Storage replay failed');
    const got=await client.storage.from(obj.bucket).download(obj.path);
    assert(!got.error,'Restored local Storage object is not readable');
    const crypto=require('node:crypto');
    const hash=crypto.createHash('sha256').update(Buffer.from(await got.data.arrayBuffer())).digest('hex');
    assert.equal(hash,obj.sha256,'Restored Storage byte mismatch');
  }
  const users=Number(q('SELECT COUNT(*) FROM auth.users'));
  const clients=Number(q('SELECT COUNT(*) FROM public.clients'));
  const workouts=Number(q('SELECT COUNT(*) FROM public.workouts'));
  assert(users>0&&clients>0&&workouts>0,'Restored app/Auth data is unexpectedly empty');
  assert.equal(inventory.objectCount,manifest.storageSummary.objectCount);
  console.log('PASS: real Auth and application rows restored to disposable PostgreSQL');
  console.log('PASS: archived Storage objects restored and downloaded with matching SHA-256');
  console.log('PASS: isolated data/schema recovery; live password login and Storage policy parity still require separate acceptance');
}
main().catch(err=>{
  // Never emit underlying database errors, object contents, passwords or keys.
  console.error('FAIL: isolated restore acceptance: '+String(err.message||'unknown').slice(0,175));
  process.exitCode=1;
}).finally(()=>{fs.rmSync(tmp,{recursive:true,force:true});});
