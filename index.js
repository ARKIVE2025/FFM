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
