// FFM background push: checks every hour and sends phone notifications for bills due soon.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
admin.initializeApp();

const DAY = 86400000;

exports.ffmBillPush = onSchedule({ schedule: 'every 60 minutes', timeZone: 'UTC' }, async () => {
  const db = admin.firestore();
  const snap = await db.collection('pushTokens').get();
  for (const doc of snap.docs) {
    const uid = doc.id;
    const { tokens = [], tz = 0, sent = {} } = doc.data();
    if (!tokens.length) continue;

    // Only send between 8am and 9pm in the user's local time
    const local = new Date(Date.now() - tz * 60000);
    const hour = local.getUTCHours();
    if (hour < 8 || hour > 20) continue;
    const today = local.toISOString().slice(0, 10);

    const ud = await db.collection('userData').doc(uid).get();
    if (!ud.exists) continue;
    let data;
    try { data = JSON.parse(ud.data().data); } catch (e) { continue; }
    if (data.settings && data.settings.alertsOn === false) continue;

    const msgs = [];
    for (const b of data.bills || []) {
      if (!b.due) continue;
      const diff = Math.round((Date.parse(b.due) - Date.parse(today)) / DAY);
      if (diff > 2 || diff < -3) continue;
      const key = 'bill:' + b.id + ':' + b.due + ':' + (diff < 0 ? 'late' : diff);
      if (sent[key]) continue;
      const when = diff < 0 ? 'is overdue' : diff === 0 ? 'is due today' : diff === 1 ? 'is due tomorrow' : 'is due in 2 days';
      msgs.push({ key, title: 'FFM — Bill reminder', body: (b.name || 'A bill') + ' ' + when + ' ($' + Number(b.amount || 0).toFixed(2) + ').', tag: key });
    }
    if (!msgs.length) continue;

    const bad = new Set();
    for (const m of msgs.slice(0, 5)) {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        data: { title: m.title, body: m.body, tag: m.tag, url: './index.html?tab=bills&inbox=1' },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } }
      });
      res.responses.forEach((r, i) => {
        if (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error && r.error.code || '')) bad.add(tokens[i]);
      });
      sent[m.key] = today;
    }
    // keep the sent list small and drop dead tokens
    const keys = Object.keys(sent);
    if (keys.length > 100) keys.slice(0, keys.length - 100).forEach(k => delete sent[k]);
    const update = { sent };
    if (bad.size) update.tokens = tokens.filter(t => !bad.has(t));
    await doc.ref.set(update, { merge: true });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Cliff access endpoint for FFM — PASTE INTO index.js (the Firebase Functions
// entry file in this repo, next to ffmBillPush). Does NOT replace index.js.
//
// What it does:
//   Gives Cliff (D.L.'s Muse assistant) a key-guarded way to read and update
//   ONE user's cloud data: Firestore userData/{CLIFF_UID} — exactly the doc
//   the app already syncs. The app keeps working unchanged: Cliff's writes
//   look like a sync from another device (device: "cliff"), so the app picks
//   them up live via its onSnapshot listener, and keeps its on-device API
//   keys (applyRemote preserves local keys/models/provider).
//
// Safety built in:
//   - Only the single uid stored in the CLIFF_UID secret is served. Any uid
//     in the request is ignored.
//   - Every call needs the shared secret in the x-cliff-key header
//     (CLIFF_KEY secret, compared in constant time).
//   - Writes require baseUpdatedAt to match the doc's current updatedAt
//     (optimistic concurrency). If the app changed data in between, the
//     write is refused with 409 instead of overwriting newer data.
//   - Before every write, the current cloud copy is rotated into the
//     versions subcollection (same vc % 5 scheme as the app), so any Cliff
//     write can be undone from the app's restore-copies screen.
//   - settings.keys and chat are stripped from stored payloads, matching
//     the app's own exportable() behaviour. Payloads over 900k are refused,
//     matching the app's cloudPush limit.
//
// Setup (owner, one time):
//   firebase functions:secrets:set CLIFF_KEY   (invent a long random key)
//   firebase functions:secrets:set CLIFF_UID   (your Firebase Auth uid)
//   firebase deploy --only functions
// Endpoint after deploy:
//   https://us-central1-ffmanager-a7075.cloudfunctions.net/cliff
// ─────────────────────────────────────────────────────────────────────────────

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');

const CLIFF_KEY = defineSecret('CLIFF_KEY');
const CLIFF_UID = defineSecret('CLIFF_UID');

function keyOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function sanitize(dbObj) {
  const c = JSON.parse(JSON.stringify(dbObj || {}));
  if (c.settings) delete c.settings.keys; // never store AI provider keys in cloud payloads
  delete c.chat;                          // app excludes chat from cloud sync
  c.app = 'FFM';
  return c;
}

exports.cliff = onRequest({ secrets: [CLIFF_KEY, CLIFF_UID] }, async (req, res) => {
  try {
    if (!keyOk(req.get('x-cliff-key'), CLIFF_KEY.value())) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const uid = CLIFF_UID.value();
    if (!uid) return res.status(500).json({ ok: false, error: 'CLIFF_UID not set' });

    const admin = require('firebase-admin');
    const ref = admin.firestore().collection('userData').doc(uid);

    if (req.method === 'GET') {
      const snap = await ref.get();
      if (!snap.exists) return res.json({ ok: true, exists: false, data: null });
      const r = snap.data();
      let data = null;
      try { data = JSON.parse(r.data); } catch (e) { /* leave null */ }
      return res.json({
        ok: true, exists: true,
        updatedAt: r.updatedAt || 0, device: r.device || null, vc: r.vc || 0,
        data
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!body.data || typeof body.data !== 'object') {
        return res.status(400).json({ ok: false, error: 'body.data (object) required' });
      }
      const snap = await ref.get();
      const prev = snap.exists ? snap.data() : null;
      const prevUpdatedAt = prev ? (prev.updatedAt || 0) : 0;
      if (Number(body.baseUpdatedAt || 0) !== Number(prevUpdatedAt)) {
        return res.status(409).json({
          ok: false, error: 'conflict: data changed since it was read',
          currentUpdatedAt: prevUpdatedAt
        });
      }
      const payload = JSON.stringify(sanitize(body.data));
      if (payload.length > 900000) {
        return res.status(413).json({ ok: false, error: 'data too large to sync' });
      }
      let vc = (prev && prev.vc) || 0;
      let snapAt = (prev && prev.snapAt) || 0;
      if (prev && prev.data) {
        // Rotate the current copy into versions/{vc % 5} first, like the app does
        let prevCount = 0;
        try {
          const p = JSON.parse(prev.data);
          prevCount = ['debts', 'income', 'expenses', 'goals', 'bills', 'accounts', 'meals', 'notes']
            .reduce((s, k) => s + (Array.isArray(p[k]) ? p[k].length : 0), 0);
        } catch (e) { /* count stays 0 */ }
        await ref.collection('versions').doc(String(vc % 5)).set({
          data: prev.data, savedAt: Date.now(), updatedAt: prev.updatedAt || 0, count: prevCount
        });
        vc++; snapAt = Date.now();
      }
      const now = Date.now();
      await ref.set({ data: payload, updatedAt: now, device: 'cliff', vc, snapAt });
      return res.json({ ok: true, updatedAt: now });
    }

    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});
