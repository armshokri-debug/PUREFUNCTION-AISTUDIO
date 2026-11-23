// In-memory Supabase for Playwright: auth, the sign-up Edge Function, PostgREST
// (profiles / clients / workouts / exercises), Storage (exercise-videos) and the
// Realtime websocket. It mirrors the database rules in supabase/migrations:
//  - coach = the configured coach email; client = an email the coach added
//  - coach reads/writes everything; a client only their own client row and workouts
//  - clients can't delete workouts or write exercises; strangers see nothing
const crypto = require('crypto');

module.exports = function createMock({ coachEmail = 'coach@example.com', otherCoachEmail = 'othercoach@example.com' } = {}) {
  const db = { users: [], profiles: [], clients: [], workouts: [], exercises: [], files: {}, clientFiles: {}, emails: [], resetTokens: {}, verificationTokens: {}, inviteTokens: {}, coach_messages: [], coach_notes_secure: [], food_entries: [], food_items: [], posture_public_reports: [], program_templates: [], deletionJobs: {} };
  const log = [];
  const realtimeLog = [];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'access-control-expose-headers': '*'
  };
  const json = (route, status, body) =>
    route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sessionFor = (u) => ({
    access_token: 'tok-' + u.id,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'ref-' + u.id,
    user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta || {}, app_metadata: {}, created_at: new Date().toISOString() }
  });
  const uidFrom = (req) => {
    const m = (req.headers()['authorization'] || '').match(/tok-(.+)$/);
    return m && m[1];
  };
  const profileOf = (uid) => db.profiles.find((p) => p.id === uid);

  function linkUser(u) {
    if (profileOf(u.id)) return;
    if ([coachEmail.toLowerCase(), otherCoachEmail.toLowerCase()].includes(u.email.toLowerCase())) {
      db.profiles.push({ id: u.id, role: 'coach', display_name: (u.meta && u.meta.display_name) || u.email.split('@')[0], client_id: null });
      return;
    }
    const c = db.clients.find((c) => c.email && c.email.toLowerCase() === u.email.toLowerCase());
    if (c) db.profiles.push({ id: u.id, role: 'client', display_name: c.data.name, client_id: c.id });
  }

  const canRead = (prof, table, row) => {
    if (!prof) return false;
    if (prof.role === 'coach') {
      if (table === 'clients') return row.coach_id === prof.id;
      if (table === 'profiles') return row.id === prof.id || db.clients.some(c => c.id === row.client_id && c.coach_id === prof.id);
      if (table === 'exercises') return true;
      if (table === 'program_templates') return row.owner_id === prof.id;
      return db.clients.some(c => c.id === row.client_id && c.coach_id === prof.id);
    }
    if (table === 'profiles') return row.id === prof.id;
    if (table === 'clients') return row.id === prof.client_id;
    if (['food_entries','food_items','posture_public_reports'].includes(table)) return row.client_id === prof.client_id;
    if (table === 'coach_messages') return row.client_id === prof.client_id;
    if (table === 'coach_notes_secure') return row.client_id === prof.client_id && row.shared;
    if (table === 'workouts') return row.client_id === prof.client_id;
    if (table === 'exercises') return true;
    return false;
  };
  const canWrite = (prof, table, row) => {
    if (!prof) return false;
    if (prof.role === 'coach') {
      if (table === 'clients') return !db.clients.some(c => c.id === row.id) || row.coach_id === prof.id || db.clients.some(c => c.id === row.id && c.coach_id === prof.id);
      if (table === 'exercises') return !row.owner_id || row.owner_id === prof.id;
      if (table === 'program_templates') return !row.owner_id || row.owner_id === prof.id;
      return canRead(prof, table, row);
    }
    if (table === 'clients') return row.id === prof.client_id;
    if (table === 'coach_messages') return row.client_id === prof.client_id && !row.from_coach;
    return false;
  };

  function matches(row, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'on_conflict', 'limit', 'columns'].includes(k)) continue;
      let m = v.match(/^eq\.(.*)$/);
      if (m && String(row[k]) !== m[1]) return false;
      m = v.match(/^in\.\((.*)\)$/);
      if (m) {
        const list = m[1].split(',').map((x) => x.replace(/^"|"$/g, ''));
        if (!list.includes(String(row[k]))) return false;
      }
    }
    return true;
  }

  async function handler(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    log.push(`${method} ${path}${url.search.slice(0, 100)}`);

    // ---------------- Edge Function: sign-up ----------------
    if (path === '/functions/v1/sign-up') {
      const b = JSON.parse(req.postData() || '{}');
      const email = String(b.email || '').trim().toLowerCase();
      if (String(b.password || '').length < 8) return json(route, 400, { error: 'Password must be at least 8 characters.' });
      const allowed = [coachEmail.toLowerCase(), otherCoachEmail.toLowerCase()].includes(email) || db.clients.some((c) => c.email && c.email.toLowerCase() === email);
      if (!allowed) return json(route, 200, { ok: true, verificationRequired: true });
      let u = db.users.find((u) => u.email === email);
      if (!u) {
        u = { id: crypto.randomUUID(), email, password: b.password, confirmed: false, meta: { display_name: b.name } };
        db.users.push(u); linkUser(u);
      }
      const token = 'verify-' + crypto.randomUUID(); db.verificationTokens[token] = u.id;
      db.emails.push({ to: email, kind: 'verify', token });
      return json(route, 200, { ok: true, verificationRequired: true });
    }

    // ---------------- Edge Functions: email ----------------
    if (path === '/functions/v1/send-invite') {
      const prof = profileOf(uidFrom(req));
      if (!prof || prof.role !== 'coach') return json(route, 403, { error: 'Only the coach can send invites.' });
      const b = JSON.parse(req.postData() || '{}');
      const c = db.clients.find((c) => c.id === b.clientId);
      if (!c || c.coach_id !== prof.id || !c.email) return json(route, 400, { error: 'This client has no email yet.' });
      let u = db.users.find(u => u.email === c.email);
      if (u?.confirmed && u.password) return json(route, 409, { error: 'This client already has an active account.' });
      if (!u) {
        u = { id: crypto.randomUUID(), email: c.email, password: null, confirmed: false,
          meta: { display_name: c.data.name } };
        db.users.push(u); linkUser(u);
      }
      const token = 'invite-' + crypto.randomUUID();
      db.inviteTokens[token] = u.id;
      db.emails.push({ to: c.email, kind: 'invite', token });
      return json(route, 200, { ok: true });
    }
    if (path === '/functions/v1/reset-password') {
      const b = JSON.parse(req.postData() || '{}');
      const email = String(b.email || '').trim().toLowerCase();
      const u = db.users.find((u) => u.email === email);
      if (u) {
        const token = 'rst-' + crypto.randomUUID();
        db.resetTokens[token] = u.id;
        db.emails.push({ to: email, kind: 'reset', token });
      }
      return json(route, 200, { ok: true });
    }
    if (path === '/functions/v1/delete-client') {
      const uid = uidFrom(req);
      const prof = profileOf(uid);
      if (!uid) return json(route, 401, { error: 'Sign in again.' });
      if (!prof || prof.role !== 'coach') return json(route, 403, { error: 'Only the coach can delete a client.' });
      const b = JSON.parse(req.postData() || '{}');
      const clientId = String(b.clientId || '').trim();
      if (!clientId || b.confirm !== true) {
        return json(route, 400, { error: 'Explicit coach confirmation is required before deleting a client.' });
      }
      let job = db.deletionJobs[clientId];
      if (job) {
        if (job.coachId !== prof.id) return json(route, 403, { error: 'Only the owning coach may delete this client.' });
        if (!job.isTestClient && String(b.confirmName || '').trim().toLowerCase() !== job.clientName.toLowerCase()) {
          return json(route, 400, { error: 'Type the client’s full name to confirm permanent deletion.' });
        }
        if (job.status === 'completed') {
          return json(route, 200, { ok: true, status: 'completed', alreadyCompleted: true, deletedClientId: clientId, deletedAuthUsers: job.linkedAuthUserIds.length, deletedFiles: job.filePaths.length });
        }
        job.attempts += 1;
      } else {
        const c = db.clients.find((row) => row.id === clientId);
        if (!c || c.coach_id !== prof.id) {
          return json(route, 403, { error: 'Only the owning coach may delete this client.' });
        }
        const isTest = Boolean(c.data && c.data.isTestClient);
        const storedName = String((c.data && c.data.name) || '').trim();
        if (!isTest && (!storedName || String(b.confirmName || '').trim().toLowerCase() !== storedName.toLowerCase())) {
          return json(route, 400, { error: 'Type the client’s full name to confirm permanent deletion.' });
        }
        const linked = db.profiles.filter((p) => p.client_id === clientId);
        if (linked.some((p) => p.role !== 'client' || p.id === prof.id)) {
          return json(route, 409, { error: 'Refused: this client record is linked to a coach account.' });
        }
        job = {
          clientId,
          coachId: prof.id,
          clientName: storedName || clientId,
          isTestClient: isTest,
          status: 'pending',
          linkedAuthUserIds: [...new Set(linked.map((p) => p.id))],
          filePaths: Object.keys(db.clientFiles).filter((k) => k.startsWith(clientId + '/')),
          attempts: 1
        };
        db.deletionJobs[clientId] = job;
      }

      // Stage 1: reversible auth lock
      if (job.status === 'pending') {
        db.users.forEach((u) => { if (job.linkedAuthUserIds.includes(u.id)) u.banned = true; });
        job.status = 'auth_disabled';
      }
      // Stage 2: DB delete first (before permanent Auth delete)
      if (job.status === 'auth_disabled') {
        db.clients = db.clients.filter((row) => row.id !== clientId);
        db.workouts = db.workouts.filter((row) => row.client_id !== clientId);
        db.coach_messages = db.coach_messages.filter((row) => row.client_id !== clientId);
        db.coach_notes_secure = db.coach_notes_secure.filter((row) => row.client_id !== clientId);
        db.food_entries = db.food_entries.filter((row) => row.client_id !== clientId);
        db.food_items = db.food_items.filter((row) => row.client_id !== clientId);
        db.posture_public_reports = db.posture_public_reports.filter((row) => row.client_id !== clientId);
        job.status = 'db_deleted';
      }
      // Stage 3: permanent Auth delete only after DB delete
      if (job.status === 'db_deleted') {
        const linkedIds = new Set(job.linkedAuthUserIds);
        db.users = db.users.filter((u) => !linkedIds.has(u.id));
        db.profiles = db.profiles.filter((p) => !linkedIds.has(p.id) && p.client_id !== clientId);
        job.status = 'auth_deleted';
      }
      // Stage 4: storage cleanup
      if (job.status === 'auth_deleted') {
        job.filePaths.forEach((k) => { delete db.clientFiles[k]; });
        job.status = 'completed';
      }
      return json(route, 200, { ok: true, status: 'completed', deletedClientId: clientId, deletedAuthUsers: job.linkedAuthUserIds.length, deletedFiles: job.filePaths.length });
    }

    // ---------------- Auth ----------------
    if (path === '/auth/v1/verify' && method === 'POST') {
      const b = JSON.parse(req.postData() || '{}');
      const verification = ['signup', 'magiclink', 'invite'].includes(b.type);
      const tokens = b.type === 'invite' ? db.inviteTokens : verification ? db.verificationTokens : db.resetTokens;
      const id = tokens[b.token_hash];
      delete tokens[b.token_hash];
      if (verification && id) db.users.find(u => u.id === id).confirmed = true;
      const u = id && db.users.find((u) => u.id === id);
      return u ? json(route, 200, sessionFor(u)) : json(route, 403, { code: 'otp_expired', msg: 'Email link is invalid or has expired' });
    }
    if (path === '/auth/v1/user' && method === 'PUT') {
      const u = db.users.find((u) => u.id === uidFrom(req));
      if (!u) return json(route, 401, {});
      const b = JSON.parse(req.postData() || '{}');
      if (b.password) u.password = b.password;
      return json(route, 200, sessionFor(u).user);
    }
    if (path === '/auth/v1/token') {
      const b = JSON.parse(req.postData() || '{}');
      if (url.searchParams.get('grant_type') === 'password') {
        const u = db.users.find((u) => u.email === String(b.email).toLowerCase() && u.password === b.password);
        if (!u) return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
        if (u.confirmed === false) return json(route, 400, { msg: 'Email not confirmed' });
        return json(route, 200, sessionFor(u));
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const m = String(b.refresh_token || '').match(/^ref-(.+)$/);
        const u = m && db.users.find((u) => u.id === m[1]);
        return u ? json(route, 200, sessionFor(u)) : json(route, 400, { error: 'invalid_grant' });
      }
      return json(route, 400, { error: 'unsupported' });
    }
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (path === '/auth/v1/user') {
      const u = db.users.find((u) => u.id === uidFrom(req));
      return u ? json(route, 200, sessionFor(u).user) : json(route, 401, {});
    }

    // ---------------- Storage ----------------
    // private client videos: coach everything, a client only their own folder
    let cm = path.match(/^\/storage\/v1\/object\/(sign\/)?client-videos\/(.+)$/);
    if (cm) {
      const key = decodeURIComponent(cm[2]);
      const prof = profileOf(uidFrom(req));
      const folderOk = prof && (prof.role === 'coach' || key.split('/')[0] === prof.client_id);
      if (cm[1] && method === 'POST') {
        if (!folderOk || !db.clientFiles[key]) return json(route, 400, { message: 'Object not found' });
        return json(route, 200, { signedURL: `/object/sign/client-videos/${cm[2]}?token=t` });
      }
      if (cm[1] && method === 'GET') {
        const f = db.clientFiles[key];
        return f ? route.fulfill({ status: 200, headers: { ...cors, 'content-type': f.type }, body: f.body }) : route.fulfill({ status: 404, headers: cors, body: '' });
      }
      if (!cm[1] && method === 'POST') {
        if (!prof || prof.role !== 'coach') return json(route, 403, { message: 'new row violates row-level security policy' });
        db.clientFiles[key] = { type: 'video/webm', body: Buffer.alloc(0) };
        return json(route, 200, { Key: 'client-videos/' + cm[2] });
      }
    }
    let m = path.match(/^\/storage\/v1\/object\/sign\/exercise-videos\/(.+)$/);
    if (m && method === 'POST') {
      const key = decodeURIComponent(m[1]);
      const prof = profileOf(uidFrom(req));
      if (!prof || !db.files[key]) return json(route, 400, { message: 'Object not found' });
      return json(route, 200, { signedURL: `/object/sign/exercise-videos/${m[1]}?token=t` });
    }
    if (m && method === 'GET') {
      const f = db.files[decodeURIComponent(m[1])];
      if (!f) return route.fulfill({ status: 404, headers: cors, body: '' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': f.type }, body: f.body });
    }
    m = path.match(/^\/storage\/v1\/object\/exercise-videos\/(.+)$/);
    if (m && method === 'POST') {
      const prof = profileOf(uidFrom(req));
      if (!prof || prof.role !== 'coach' || decodeURIComponent(m[1]).split('/')[0] !== prof.id)
        return json(route, 403, { message: 'new row violates row-level security policy' });
      let body = req.postDataBuffer() || Buffer.alloc(0);
      let type = req.headers()['content-type'] || '';
      const bm = type.match(/boundary=(.+)$/);
      if (bm) {
        // multipart: take the file part
        const text = body.toString('latin1');
        const parts = text.split('--' + bm[1]).filter((p) => p.includes('filename='));
        if (parts[0]) {
          const [head, ...rest] = parts[0].split('\r\n\r\n');
          type = (head.match(/Content-Type: ([^\r\n]+)/i) || [])[1] || 'video/webm';
          body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
        }
      }
      db.files[decodeURIComponent(m[1])] = { type, size: body.length, body };
      return json(route, 200, { Key: 'exercise-videos/' + m[1], Id: crypto.randomUUID() });
    }
    if (path === '/storage/v1/object/exercise-videos' && method === 'DELETE') {
      const b = JSON.parse(req.postData() || '{}');
      const prof = profileOf(uidFrom(req));
      if (!prof || prof.role !== 'coach' || (b.prefixes || []).some(p => p.split('/')[0] !== prof.id))
        return json(route, 403, { message: 'Not the video owner' });
      (b.prefixes || []).forEach((p) => delete db.files[p]);
      return json(route, 200, []);
    }

    if (path === '/rest/v1/rpc/pf_my_password_ready') {
      const u = db.users.find(u => u.id === uidFrom(req));
      return json(route, 200, !!(u && u.confirmed && u.password));
    }
    if (path === '/rest/v1/rpc/pf_joined_client_ids') {
      const coach = profileOf(uidFrom(req));
      if (!coach || coach.role !== 'coach') return json(route, 200, []);
      return json(route, 200, db.profiles
        .filter(p => p.role === 'client' && db.clients.some(c => c.id === p.client_id && c.coach_id === coach.id))
        .filter(p => db.users.some(u => u.id === p.id && u.confirmed && !!u.password))
        .map(p => p.client_id));
    }
    if (path === '/rest/v1/rpc/pf_head_coach') return json(route, 200, false);
    if (path === '/rest/v1/rpc/save_workout_results_secure') {
      const prof = profileOf(uidFrom(req)); const x = JSON.parse(req.postData() || '{}');
      const row = db.workouts.find(w => w.id === x.p_workout_id && w.client_id === x.p_client_id);
      if (!prof || prof.role !== 'client' || prof.client_id !== x.p_client_id || !row) return json(route, 403, { code: '42501', message: 'Own workout only' });
      if (row.updated_at !== x.p_expected_version) return json(route, 409, { code: '40001', message: 'VERSION_CONFLICT' });
      const r = x.p_results;
      if (Object.keys(r).some(k => !['status','blocks','completedAt','sessionRpe','clientFeedback'].includes(k))) return json(route, 403, { code: '42501', message: 'Result fields only' });
      if (r.blocks.length !== row.data.blocks.length || r.blocks.some(b => !row.data.blocks.some(o => o.id === b.id))) return json(route, 403, { code: '42501', message: 'Block mismatch' });
      row.data = { ...row.data, ...r, blocks: row.data.blocks.map(b => ({ ...b, ...r.blocks.find(x => x.id === b.id) })) };
      row.updated_at = new Date().toISOString(); broadcast('workouts', 'UPDATE', row);
      return json(route, 200, [{ updated_version: row.updated_at }]);
    }
    if (path === '/rest/v1/rpc/pf_save_food_entry') {
      const prof = profileOf(uidFrom(req)); const x = JSON.parse(req.postData() || '{}');
      if (!prof || prof.role !== 'client' || prof.client_id !== x.p_client_id) return json(route, 403, { code: '42501', message: 'Own meal only' });
      let row = db.food_entries.find(r => r.client_id === x.p_client_id && r.idempotency_key === x.p_key);
      if (!row) { row = { id: crypto.randomUUID(), client_id: x.p_client_id, idempotency_key: x.p_key }; db.food_entries.push(row); }
      Object.assign(row, { date: x.p_date, description: x.p_description, status: x.p_status });
      db.food_items = db.food_items.filter(i => i.entry_id !== row.id);
      db.food_items.push(...x.p_items.map(i => ({ ...i, entry_id: row.id, client_id: row.client_id })));
      return json(route, 200, row.id);
    }
    // ---------------- REST ----------------
    m = path.match(/^\/rest\/v1\/(\w+)$/);
    if (m) {
      const table = m[1];
      const rows = db[table];
      if (!rows) return json(route, 404, { message: 'no table' });
      const uid = uidFrom(req);
      if (!uid) return json(route, 200, []); // anon: RLS returns nothing
      const prof = profileOf(uid);

      if (method === 'GET') {
        const out = rows.filter((r) => canRead(prof, table, r) && matches(r, url.searchParams));
        if ((req.headers()['accept'] || '').includes('vnd.pgrst.object')) {
          return out.length ? json(route, 200, out[0]) : json(route, 406, { code: 'PGRST116', message: 'no rows' });
        }
        return json(route, 200, out);
      }
      if (method === 'POST') {
        if (table === 'exercises' && db.failNextExerciseWrite) { db.failNextExerciseWrite = false; return json(route, 503, { message: 'Simulated write failure' }); }
        const body = JSON.parse(req.postData() || '[]');
        const arr = Array.isArray(body) ? body : [body];
        for (const r of arr) {
          if (table === 'coach_messages') { r.id ??= crypto.randomUUID(); r.created_at ??= new Date().toISOString(); if (r.from_coach !== (prof?.role === 'coach')) return json(route, 403, { code: '42501', message: 'Sender mismatch' }); }
          if (table === 'exercises') {
            const existing = rows.find(e => e.id === r.id);
            if (existing?.owner_id && existing.owner_id !== prof?.id)
              return json(route, 403, { code: '42501', message: 'Exercise belongs to another coach' });
            if (r.owner_id && r.owner_id !== prof?.id)
              return json(route, 403, { code: '42501', message: 'Cannot assign exercise to another coach' });
          }
          if (!canWrite(prof, table, r)) return json(route, 403, { code: '42501', message: `new row violates row-level security policy for table "${table}"` });
          if (table === 'clients' && prof.role !== 'coach') {
            // Real database: INSERT ... ON CONFLICT also checks the INSERT policy (coach only), so a client can never POST here.
            return json(route, 403, { code: '42501', message: 'new row violates row-level security policy for table "clients"' });
          }
          if (table === 'workouts') {
            if (!db.clients.some((c) => c.id === r.client_id)) return json(route, 409, { code: '23503', message: 'foreign key' });
            if (rows.some((x) => x.id !== r.id && x.client_id === r.client_id && x.date === r.date)) {
              return json(route, 409, { code: '23505', message: 'duplicate key value violates unique constraint "workouts_client_id_date_key"' });
            }
          }
        }
        for (const r of arr) {
          const i = rows.findIndex((x) => x.id === r.id);
          const row = { ...(i >= 0 ? rows[i] : {}), ...r, updated_at: new Date().toISOString() };
          if (table === 'clients' && i < 0) row.coach_id = prof.id;
          if (table === 'program_templates' && i < 0) row.owner_id = prof.id;
          if (table === 'exercises' && i < 0) row.owner_id = prof.id;
          if (i >= 0) rows[i] = row;
          else rows.push(row);
          if (table === 'clients' && row.email) {
            db.users.filter((u) => u.email === row.email.toLowerCase()).forEach(linkUser);
          }
          broadcast(table, i >= 0 ? 'UPDATE' : 'INSERT', row);
        }
        if ((req.headers()['prefer'] || '').includes('return=representation')) return json(route, 201, (req.headers()['accept'] || '').includes('vnd.pgrst.object') ? rows.find(x => x.id === arr[0].id) : arr.map(r => rows.find(x => x.id === r.id)));
        return route.fulfill({ status: 201, headers: cors, body: '' });
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(req.postData() || '{}');
        const hit = rows.filter((r) => matches(r, url.searchParams) && canRead(prof, table, r) && (table === 'coach_messages' ? r.from_coach !== (prof.role === 'coach') : canWrite(prof, table, r)));
        if (table === 'exercises' && patch.owner_id && patch.owner_id !== prof?.id)
          return json(route, 403, { code: '42501', message: 'Exercise ownership cannot be changed' });
        for (const r of hit) {
          if (table === 'clients' && prof.role === 'client' && patch.data) {
            const allowed = ['photoUrl','nutrition','manualRecords'];
            if ([...new Set([...Object.keys(r.data), ...Object.keys(patch.data)])].some(k => !allowed.includes(k) && JSON.stringify(r.data[k]) !== JSON.stringify(patch.data[k]))) return json(route, 403, { code: '42501', message: 'Coach-owned data' });
          }
          if (table === 'clients' && prof.role !== 'coach' && 'email' in patch && (patch.email || '') !== (r.email || '')) {
            return json(route, 400, { message: "Only the coach can change a client's email" });
          }
          Object.assign(r, patch, { updated_at: new Date().toISOString() });
          broadcast(table, 'UPDATE', r);
        }
        if ((req.headers()['prefer'] || '').includes('return=representation')) return json(route, 200, hit);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        if (!prof || prof.role !== 'coach') return route.fulfill({ status: 204, headers: cors }); // RLS: silently nothing
        const deleted = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i], url.searchParams) && canRead(prof, table, rows[i])) {
            const [gone] = rows.splice(i, 1); deleted.push(gone);
            if (table === 'clients') db.workouts = db.workouts.filter((w) => w.client_id !== gone.id);
            broadcast(table, 'DELETE', { id: gone.id }, gone);
          }
        }
        if ((req.headers()['prefer'] || '').includes('return=representation')) return json(route, 200, deleted);
        return route.fulfill({ status: 204, headers: cors });
      }
    }
    return json(route, 404, { message: 'unmocked ' + path });
  }

  /* ---------------- Realtime (Phoenix vsn 2.0.0: [join_ref, ref, topic, event, payload]) ---------------- */
  const sockets = new Set();
  function broadcast(table, type, record, fullOld) {
    for (const s of sockets) {
      const prof = profileOf(s.uid);
      for (const sub of s.subs) {
        const b = sub.bindings.find((x) => x.table === table);
        if (!b) continue;
        if (type !== 'DELETE' && !canRead(prof, table, record)) continue;
        if (type === 'DELETE' && fullOld && !canRead(prof, table, fullOld)) continue;
        const columns = Object.keys(record).map((name) => ({ name, type: name === 'data' ? 'jsonb' : 'text' }));
        const data =
          type === 'DELETE'
            ? { type, schema: 'public', table, commit_timestamp: new Date().toISOString(), errors: null, columns, old_record: record }
            : { type, schema: 'public', table, commit_timestamp: new Date().toISOString(), errors: null, columns, record };
        s.ws.send(JSON.stringify([sub.joinRef, null, sub.topic, 'postgres_changes', { ids: [b.id], data }]));
        realtimeLog.push(`${type} ${table} -> ${prof ? prof.role : '?'}`);
      }
    }
  }
  function wsHandler(ws) {
    const s = { ws, uid: null, subs: [] };
    sockets.add(s);
    ws.onClose(() => sockets.delete(s));
    ws.onMessage((raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const [joinRef, ref, topic, event, payload] = msg;
      const reply = (response) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (topic === 'phoenix' && event === 'heartbeat') return reply({});
      if (event === 'access_token') {
        const mm = String(payload.access_token || '').match(/tok-(.+)$/);
        if (mm) s.uid = mm[1];
        return;
      }
      if (event === 'phx_join') {
        const mm = String(payload.access_token || '').match(/tok-(.+)$/);
        if (mm) s.uid = mm[1];
        const pc = (payload.config && payload.config.postgres_changes) || [];
        const bindings = pc.map((f, i) => ({ id: 1000 + i + s.subs.length * 10, event: f.event, schema: f.schema, table: f.table, filter: f.filter }));
        s.subs.push({ joinRef, topic, bindings });
        reply({ postgres_changes: bindings });
        ws.send(JSON.stringify([joinRef, null, topic, 'system', { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: topic.replace('realtime:', '') }]));
        return;
      }
      if (event === 'phx_leave') {
        s.subs = s.subs.filter((x) => x.topic !== topic);
        return reply({});
      }
    });
  }

  return { db, log, handler, wsHandler, broadcast, realtimeLog };
};
