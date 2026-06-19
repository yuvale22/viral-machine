// api/cardcom/charge-recurring.js
// CRON endpoint — runs daily, charges every active subscription whose
// next_charge_date has arrived, using the saved Cardcom token.

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRICES = {
  basic: { monthly: 99, yearly: 990 },
  pro:   { monthly: 139, yearly: 1390 },
  max:   { monthly: 259, yearly: 2590 },
};

function supaHeaders() {
  return {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}

function nextDate(fromISO, cycle) {
  const d = new Date(fromISO);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secretOk = req.query?.secret === process.env.CRON_SECRET
    || req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET;
  if (!isVercelCron && !secretOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  const TERMINAL = parseInt(process.env.CARDCOM_TERMINAL || '170602', 10);
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';
  const API_PASSWORD = process.env.CARDCOM_API_PASSWORD || '';
  const today = new Date().toISOString().slice(0, 10);
  const debugMode = req.query?.debug === '1';

  let charged = 0, failed = 0, skipped = 0;
  const log = [];

  try {
    const q = `select=*&status=eq.active&auto_renew=eq.true`
      + `&cardcom_token=not.is.null&next_charge_date=lte.${today}`;
    const subsRes = await fetch(`${SUPA_URL}/rest/v1/user_profiles?${q}`, { headers: supaHeaders() });
    const subs = await subsRes.json();

    if (!Array.isArray(subs)) {
      return res.status(500).json({ error: 'Failed to load subscriptions', detail: subs });
    }

    for (const sub of subs) {
      const cycle = sub.billing_cycle || 'monthly';
      const plan = sub.plan || 'pro';
      const amount = (PRICES[plan] || PRICES.pro)[cycle];

      // Build payload with ApiPassword + separate month/year fields
      const payload = {
        TerminalNumber: TERMINAL,
        ApiName: API_NAME,
        ApiPassword: API_PASSWORD,
        Amount: amount,
        ISOCoinId: 1,
        ExternalUniqTranId: sub.id + '-' + today,
        ReturnValue: sub.id,
        Token: sub.cardcom_token,
      };

      // Card expiry — field name: CardExpirationMMYY, format: MMYY (e.g. "1231")
      const exp = (sub.cardcom_token_exp || '').replace(/\D/g, '');
      if (exp.length >= 4) {
        payload.CardExpirationMMYY = exp.slice(0, 4);
      }

      try {
        const r = await fetch('https://secure.cardcom.solutions/api/v11/Transactions/Transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        const ok = data.ResponseCode === 0;

        if (debugMode) {
          log.push({
            user: sub.id,
            email: sub.email,
            sent: { ...payload, Token: '***', ApiPassword: '***' },
            cardcom_response: data,
          });
          continue;
        }

        if (ok) {
          const newNext = nextDate(sub.next_charge_date || today, cycle);
          await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: supaHeaders(),
            body: JSON.stringify({
              next_charge_date: newNext,
              trial_ends_at: newNext,
              status: 'active',
            }),
          });
          await fetch(`${SUPA_URL}/rest/v1/payments`, {
            method: 'POST',
            headers: supaHeaders(),
            body: JSON.stringify({
              user_id: sub.id, plan, amount, amount_ils: amount * 100,
              status: 'completed',
            }),
          });
          charged++;
          log.push({ user: sub.id, plan, amount, result: 'charged', next: newNext });
        } else {
          await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: supaHeaders(),
            body: JSON.stringify({ status: 'expired', plan: 'free' }),
          });
          await fetch(`${SUPA_URL}/rest/v1/payments`, {
            method: 'POST',
            headers: supaHeaders(),
            body: JSON.stringify({
              user_id: sub.id, plan, amount, amount_ils: amount * 100, status: 'failed',
            }),
          });
          failed++;
          log.push({ user: sub.id, plan, result: 'declined', code: data.ResponseCode, desc: data.Description });
        }
      } catch (e) {
        skipped++;
        log.push({ user: sub.id, result: 'error', error: e.message });
      }
    }

    return res.status(200).json({ ok: true, debug: debugMode, today, charged, failed, skipped, total: subs.length, log });
  } catch (error) {
    console.error('charge-recurring error:', error);
    return res.status(500).json({ error: error.message });
  }
};
