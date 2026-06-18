// api/cardcom/charge-recurring.js
// CRON endpoint — runs daily, charges every active subscription whose
// next_charge_date has arrived, using the saved Cardcom token.
// This is what makes the "gym membership" model work: bills again and again
// until the user cancels (auto_renew = false).
//
// Triggered by Vercel Cron (see vercel.json). Protected by CRON_SECRET.

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // REQUIRED — service role, bypasses RLS

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

// Advance a YYYY-MM-DD date by 1 month or 1 year
function nextDate(fromISO, cycle) {
  const d = new Date(fromISO);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  // Allow Vercel Cron (sends a special header) or manual call with the secret
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
  const today = new Date().toISOString().slice(0, 10);

  // ?debug=1 -> return the FULL Cardcom response so we can see exactly what it sends back,
  // without changing any data. Great for diagnosing the expiration / field-name issue.
  const debugMode = req.query?.debug === '1';

  let charged = 0, failed = 0, skipped = 0;
  const log = [];

  try {
    // Find subscriptions due today: active + auto-renew on + has a token + due
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

      // ===== Charge the saved token (Cardcom v11) =====
      // We rely on the TOKEN ALONE - the token already carries the card details,
      // exactly like the first payment (LowProfile/Create) succeeded without us
      // sending an expiration. Sending an empty/wrong CardExpiration is what caused
      // error 60000416 ("invalid expiration format"), so we DO NOT send it by default.
      const payload = {
        TerminalNumber: TERMINAL,
        ApiName: API_NAME,
        Amount: amount,
        ISOCoinId: 1,
        ExternalUniqTranId: sub.id + '-' + today, // idempotency: don't double-charge same day
        ReturnValue: sub.id,
        Token: sub.cardcom_token,
      };

      // If a properly-formatted expiration IS stored (MMYY, exactly 4 digits), include it -
      // some terminals require it. Otherwise we omit it entirely.
      const exp = (sub.cardcom_token_exp || '').replace(/\D/g, ''); // digits only
      if (exp.length === 4) {
        payload.CardExpiration = exp;
      }

      try {
        const r = await fetch('https://secure.cardcom.solutions/api/v11/Transactions/Transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        const ok = data.ResponseCode === 0;

        // DEBUG: surface the entire Cardcom response (and what we sent) without touching data.
        if (debugMode) {
          log.push({
            user: sub.id,
            sent: { ...payload, Token: '***hidden***' }, // don't echo the raw token
            cardcom_response: data,
          });
          continue; // skip DB writes in debug mode
        }

        if (ok) {
          const newNext = nextDate(sub.next_charge_date || today, cycle);
          await fetch(`${SUPA_URL}/rest/v1/user_profiles?id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: supaHeaders(),
            body: JSON.stringify({
              next_charge_date: newNext,
              trial_ends_at: newNext, // keep frontend access window in sync
              status: 'active',
            }),
          });
          // Record the payment (amount stored in agorot to match admin stats: amount_ils)
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
          // Charge declined - stop access. (Optionally add a grace/retry window here.)
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
