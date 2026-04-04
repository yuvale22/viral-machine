// api/cardcom/charge-recurring.js
// POST — Cron: charges due subscriptions via Cardcom token
// Secured with CRON_SECRET header

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';

function getServiceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }

async function supaAdmin(method, path, body) {
  const key = getServiceKey();
  const opts = { method, headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' } };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, opts);
  return r.json();
}

async function chargeToken(token, amount, productName) {
  const params = new URLSearchParams({
    'TerminalNumber': process.env.CARDCOM_TERMINAL || '170602',
    'ApiName': process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM',
    'TokenToCharge.Token': token,
    'TokenToCharge.SumToBill': String(amount / 100),
    'TokenToCharge.CoinId': '1',
    'TokenToCharge.NumOfPayments': '1',
    'ProductName': productName,
  });
  const r = await fetch('https://secure.cardcom.solutions/api/v11/BillGold/ChargeToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = req.headers['x-cron-secret'] || (req.headers.authorization || '').replace('Bearer ', '');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const subs = await supaAdmin('GET', 'subscriptions?select=*&or=(and(status.eq.trialing,trial_end.lte.now()),and(status.eq.active,current_period_end.lte.now()))&cancel_at_period_end=eq.false&charge_failures=lt.3');
    if (!Array.isArray(subs) || subs.length === 0) return res.status(200).json({ message: 'No subscriptions due', charged: 0 });

    const results = [];
    for (const sub of subs) {
      if (!sub.cardcom_token) { await supaAdmin('PATCH', 'user_profiles?id=eq.' + sub.user_id, { status: 'read_only' }); results.push({ id: sub.id, status: 'no_token' }); continue; }
      const label = { basic:'Basic', pro:'Pro', agency:'Agency' }[sub.plan] || sub.plan;
      try {
        const cr = await chargeToken(sub.cardcom_token, sub.amount_ils, 'YUMi ' + label);
        const ok = String(cr.ResponseCode) === '0';
        await supaAdmin('POST', 'billing_log', { user_id: sub.user_id, subscription_id: sub.id, cardcom_deal_id: cr.InternalDealNumber || null, amount_ils: sub.amount_ils, status: ok ? 'success' : 'failed', cardcom_response: cr, failure_reason: ok ? null : cr.Description });
        if (ok) {
          const end = new Date(Date.now() + 30*24*60*60*1000);
          await supaAdmin('PATCH', 'subscriptions?id=eq.' + sub.id, { status: 'active', current_period_start: new Date().toISOString(), current_period_end: end.toISOString(), last_charge_date: new Date().toISOString(), last_charge_status: 'success', charge_failures: 0 });
          await supaAdmin('PATCH', 'user_profiles?id=eq.' + sub.user_id, { status: 'active' });
          results.push({ id: sub.id, status: 'charged' });
        } else {
          const f = (sub.charge_failures || 0) + 1;
          await supaAdmin('PATCH', 'subscriptions?id=eq.' + sub.id, { last_charge_status: 'failed', charge_failures: f, status: f >= 3 ? 'past_due' : sub.status });
          if (f >= 3) await supaAdmin('PATCH', 'user_profiles?id=eq.' + sub.user_id, { status: 'read_only' });
          results.push({ id: sub.id, status: 'failed', failures: f });
        }
      } catch(e) { results.push({ id: sub.id, status: 'error', msg: e.message }); }
      await new Promise(r => setTimeout(r, 1000));
    }
    return res.status(200).json({ processed: results.length, results });
  } catch (error) { return res.status(500).json({ error: error.message }); }
};
