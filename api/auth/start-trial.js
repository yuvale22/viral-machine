// api/auth/start-trial.js
// POST — Fetches token from Cardcom LowProfile result, creates subscription

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

const PLAN_PRICES = {
  basic: { monthly: 9900, yearly: 99000 },   // ₪99/mo or ₪990/yr (in agorot)
  pro:   { monthly: 13900, yearly: 139000 }, // ₪139/mo or ₪1390/yr
  max:   { monthly: 25900, yearly: 259000 }, // ₪259/mo or ₪2590/yr
};
const TRIAL_DAYS = 5;

async function getUserFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': authHeader },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_KEY;
}

async function supaAdmin(method, path, body) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
  };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  return fetch(SUPA_URL + '/rest/v1/' + path, opts);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { low_profile_code, plan, cycle, immediate } = req.body || {};
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });

  const planName = plan || 'pro';
  const billingCycle = cycle || 'monthly';
  const isImmediate = immediate === true;
  const planPrices = PLAN_PRICES[planName] || PLAN_PRICES.pro;
  const amount = billingCycle === 'yearly' ? planPrices.yearly : planPrices.monthly;
  const TERMINAL = parseInt(process.env.CARDCOM_TERMINAL || '170602', 10);
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

  try {
    // 1. Fetch transaction details from Cardcom v11 (JSON API)
    const lpRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetLowProfileResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        TerminalNumber: TERMINAL,
        ApiName: API_NAME,
        LowProfileId: low_profile_code,
      }),
    });

    const lpData = await lpRes.json();

    // Log the full Cardcom response for debugging
    console.log('[start-trial] Cardcom response for', low_profile_code, ':', JSON.stringify(lpData).slice(0, 1000));

    if (lpData.ResponseCode !== 0) {
      console.error('[start-trial] Cardcom error code:', lpData.ResponseCode, lpData.Description);
      return res.status(400).json({ error: 'הכרטיס נדחה — ' + (lpData.Description || 'נסה כרטיס אחר') });
    }

    // 2. Extract token + card info from any of the possible v11 response shapes
    const cardToken =
      lpData.TokenInfo?.Token ||
      lpData.TranzactionInfo?.Token ||
      lpData.TransactionInfo?.Token ||
      lpData.UIValues?.CardOwnerToken ||
      null;

    const lastFour =
      lpData.TokenInfo?.Last4Digits ||
      lpData.TranzactionInfo?.Last4CardDigits ||
      lpData.TransactionInfo?.Last4CardDigits ||
      (lpData.UIValues?.CardNumber ? lpData.UIValues.CardNumber.slice(-4) : null) ||
      '****';

    const cardExpiry =
      lpData.TokenInfo?.TokenExDate ||
      lpData.TranzactionInfo?.CardValidity ||
      lpData.TransactionInfo?.CardValidity ||
      '';

    // If no token returned, log it but continue — we still want to give the user access
    if (!cardToken) {
      console.warn('[start-trial] No token in Cardcom response, but ResponseCode 0 — proceeding anyway');
    }

    // 3. Calculate subscription period
    const now = new Date();
    const periodDays = isImmediate
      ? (billingCycle === 'yearly' ? 365 : 30)
      : TRIAL_DAYS;
    const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const subStatus = isImmediate ? 'active' : 'trialing';
    const userStatus = isImmediate ? 'active' : 'trialing';

    // 4. Save subscription (best-effort — if it fails we still update profile)
    try {
      const subRes = await supaAdmin('POST', 'subscriptions', {
        user_id: user.id,
        cardcom_token: cardToken,
        cardcom_last_four: lastFour,
        cardcom_expiry: cardExpiry,
        plan: planName,
        billing_cycle: billingCycle,
        status: subStatus,
        amount_ils: amount,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        trial_end: isImmediate ? null : periodEnd.toISOString(),
        last_charge_status: isImmediate ? 'success' : 'pending',
        last_charge_date: isImmediate ? now.toISOString() : null,
      });

      if (!subRes.ok) {
        const subErr = await subRes.json().catch(() => ({}));
        console.error('[start-trial] Subscription insert error:', subErr);
      }
    } catch(subErr) {
      console.error('[start-trial] Subscription insert exception:', subErr.message);
    }

    // 5. Update user profile (CRITICAL — this is what gives the user access)
    const profileUpdateRes = await supaAdmin('PATCH', 'user_profiles?id=eq.' + user.id, {
      status: userStatus,
      plan: planName,
      billing_cycle: billingCycle,
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      trial_ends_at: isImmediate ? null : periodEnd.toISOString(),
    });

    if (!profileUpdateRes.ok) {
      const errText = await profileUpdateRes.text().catch(() => '');
      console.error('[start-trial] Profile update failed:', profileUpdateRes.status, errText);
      return res.status(500).json({ error: 'נכשל בעדכון פרופיל — צור קשר לתמיכה' });
    }

    return res.status(200).json({
      plan: planName,
      status: subStatus,
      immediate: isImmediate,
      trial_end: isImmediate ? null : periodEnd.toISOString(),
      period_end: periodEnd.toISOString(),
      period_end_display: periodEnd.toLocaleDateString('he-IL'),
      last_four: lastFour,
    });

  } catch (error) {
    console.error('[start-trial] Unexpected error:', error.message, error.stack);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
};
