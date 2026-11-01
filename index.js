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
//   - READ-ONLY BY DEFAULT: writes (POST) are refused unless the third
//     secret CLIFF_WRITE is set to exactly "on". Deploy with it set to
//     "off", verify what Cliff can read, then flip it to "on".
//   - Writes require baseUpdatedAt to match the doc's current updatedAt
//     (optimistic concurrency). If the app changed data in between, the
//     write is refused with 409 instead of overwriting newer data.
//   - Before every write, the current cloud copy is saved to Cliff's OWN
//     slots in the versions subcollection: versions/cliff-0 … cliff-4
//     (rotated by a separate cliffVc counter). Cliff never touches the
//     app's own 0–4 slots or its vc/snapAt fields. The app's Cloud copies
//     screen lists all versions docs, so Cliff's copies show up there
//     and can be restored from the app like any other copy.
//   - A write is refused if any main list is missing from the payload,
//     if it contains zero items in total, or if it would drop more than
//     half of the current items — unless the request body says
//     force: true.
//   - settings.keys and chat are stripped from stored payloads, matching
//     the app's own exportable() behaviour. Payloads over 900k are
//     refused, matching the app's cloudPush limit.
//
// Setup (owner, one time):
//   firebase functions:secrets:set CLIFF_KEY    (invent a long random key)
//   firebase functions:secrets:set CLIFF_UID    (your Firebase Auth uid)
//   firebase functions:secrets:set CLIFF_WRITE  (set to: off — flip to: on
//                                                when read access is verified)
//   firebase deploy --only functions
// Endpoint after deploy:
//   https://us-central1-ffmanager-a7075.cloudfunctions.net/cliff
// ─────────────────────────────────────────────────────────────────────────────

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');

const CLIFF_KEY = defineSecret('CLIFF_KEY');
const CLIFF_UID = defineSecret('CLIFF_UID');
const CLIFF_WRITE = defineSecret('CLIFF_WRITE');

// The app's main lists (its LISTS array). A write missing any of these is
// treated as a malformed/truncated payload, not a real database.
const REQUIRED_LISTS = ['debts', 'income', 'expenses', 'goals', 'bills', 'accounts', 'meals', 'memory', 'notes', 'scheduled'];
// The lists the app itself counts items by (CORE_LISTS in the app).
const COUNT_LISTS = ['debts', 'income', 'expenses', 'goals', 'bills', 'accounts', 'meals', 'notes'];

function keyOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function itemCount(dbObj) {
  return COUNT_LISTS.reduce((s, k) => s + (dbObj && Array.isArray(dbObj[k]) ? dbObj[k].length : 0), 0);
}

function sanitize(dbObj) {
  const c = JSON.parse(JSON.stringify(dbObj || {}));
  if (c.settings) delete c.settings.keys; // never store AI provider keys in cloud payloads
  delete c.chat;                          // app excludes chat from cloud sync
  c.app = 'FFM';
  return c;
}

exports.cliff = onRequest({ secrets: [CLIFF_KEY, CLIFF_UID, CLIFF_WRITE] }, async (req, res) => {
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
      if (!snap.exists) return res.json({ ok: true, exists: false, data: null, writesEnabled: CLIFF_WRITE.value() === 'on' });
      const r = snap.data();
      let data = null;
      try { data = JSON.parse(r.data); } catch (e) { /* leave null */ }
      return res.json({
        ok: true, exists: true,
        updatedAt: r.updatedAt || 0, device: r.device || null, vc: r.vc || 0,
        writesEnabled: CLIFF_WRITE.value() === 'on',
        data
      });
    }

    if (req.method === 'POST') {
      // Read-only first: writes stay off until the owner flips CLIFF_WRITE on.
      if (CLIFF_WRITE.value() !== 'on') {
        return res.status(403).json({ ok: false, error: 'writes disabled: CLIFF_WRITE is not set to "on"' });
      }
      const body = req.body || {};
      if (!body.data || typeof body.data !== 'object') {
        return res.status(400).json({ ok: false, error: 'body.data (object) required' });
      }
      // Missing main lists = truncated/malformed payload, never a real DB.
      const missing = REQUIRED_LISTS.filter(k => !Array.isArray(body.data[k]));
      if (missing.length) {
        return res.status(400).json({ ok: false, error: 'payload is missing main lists: ' + missing.join(', '), missing });
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
      // Empty / mass-drop guard: refuse unless the request says force: true.
      let prevCount = 0;
      if (prev && prev.data) { try { prevCount = itemCount(JSON.parse(prev.data)); } catch (e) { /* stays 0 */ } }
      const newCount = itemCount(body.data);
      if (body.force !== true) {
        if (newCount === 0) {
          return res.status(400).json({ ok: false, error: 'refused: payload contains zero items (send force: true to override)', prevCount, newCount });
        }
        if (prevCount > 0 && newCount < prevCount * 0.5) {
          return res.status(400).json({ ok: false, error: 'refused: payload drops more than half of the current items (send force: true to override)', prevCount, newCount });
        }
      }
      const clean = sanitize(body.data);
      const payload = JSON.stringify(clean);
      if (payload.length > 900000) {
        return res.status(413).json({ ok: false, error: 'data too large to sync' });
      }
      // Back up the current copy into Cliff's OWN versions slots
      // (cliff-0 … cliff-4, rotated by a separate cliffVc counter) so a
      // Cliff write never evicts one of the app's own 0–4 copies. The
      // app's vc and snapAt fields are carried through unchanged.
      const vc = (prev && prev.vc) || 0;
      const snapAt = (prev && prev.snapAt) || 0;
      let cliffVc = (prev && prev.cliffVc) || 0;
      if (prev && prev.data) {
        await ref.collection('versions').doc('cliff-' + (cliffVc % 5)).set({
          data: prev.data, savedAt: Date.now(), updatedAt: prev.updatedAt || 0, count: prevCount
        });
        cliffVc++;
      }
      const now = Date.now();
      await ref.set({ data: payload, updatedAt: now, device: 'cliff', vc, snapAt, cliffVc });
      return res.json({ ok: true, updatedAt: now, prevCount, newCount });
    }

    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});
