// api/auth/start-trial.js
// POST — Fetches token from Cardcom v11 GetLpResult, creates subscription, updates profile

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

const PLAN_PRICES = {
  basic: { monthly: 9900, yearly: 99000 },
  pro:   { monthly: 13900, yearly: 139000 },
  max:   { monthly: 25900, yearly: 259000 },
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

async function fetchCardcomResult(terminal, apiName, lowProfileId) {
  // Try GET first (per Cardcom v11 docs)
  const url = 'https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult'
    + '?TerminalNumber=' + encodeURIComponent(terminal)
    + '&ApiName=' + encodeURIComponent(apiName)
    + '&LowProfileId=' + encodeURIComponent(lowProfileId);

  const getRes = await fetch(url, { method: 'GET' });
  const getData = await getRes.json().catch(() => null);

  if (getData && typeof getData.ResponseCode !== 'undefined') {
    return getData;
  }

  // Fallback: POST with JSON
  const postRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TerminalNumber: parseInt(terminal, 10),
      ApiName: apiName,
      LowProfileId: lowProfileId,
    }),
  });
  return await postRes.json().catch(() => ({}));
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
  const TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

  try {
    // 1. Fetch transaction details from Cardcom v11
    const lpData = await fetchCardcomResult(TERMINAL, API_NAME, low_profile_code);

    console.log('[start-trial]', low_profile_code, '→', JSON.stringify(lpData).slice(0, 1000));

    if (lpData.ResponseCode !== 0) {
      console.error('[start-trial] Cardcom error:', lpData.ResponseCode, lpData.Description || lpData.Message);
      return res.status(400).json({
        error: 'הכרטיס נדחה — ' + (lpData.Description || lpData.Message || 'נסה כרטיס אחר')
      });
    }

    // 2. Extract token + card info from any v11 response shape
    const cardToken =
      lpData.Token ||
      lpData.TokenInfo?.Token ||
      lpData.TranzactionInfo?.Token ||
      lpData.TransactionInfo?.Token ||
      lpData.UIValues?.CardOwnerToken ||
      null;

    const lastFour =
      lpData.TokenInfo?.Last4Digits ||
      lpData.TranzactionInfo?.Last4CardDigits ||
      lpData.TransactionInfo?.Last4CardDigits ||
      (lpData.CardMask ? String(lpData.CardMask).slice(-4) : null) ||
      (lpData.UIValues?.CardNumber ? lpData.UIValues.CardNumber.slice(-4) : null) ||
      '****';

    const cardExpiry =
      lpData.CardExpiration ||
      lpData.TokenInfo?.TokenExDate ||
      lpData.TranzactionInfo?.CardValidity ||
      '';

    if (!cardToken) {
      console.warn('[start-trial] No token in response — proceeding without saving token');
    }

    // 3. Calculate subscription period
    const now = new Date();
    const periodDays = isImmediate
      ? (billingCycle === 'yearly' ? 365 : 30)
      : TRIAL_DAYS;
    const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const subStatus = isImmediate ? 'active' : 'trialing';
    const userStatus = isImmediate ? 'active' : 'trialing';

    // 4. Save subscription (best-effort)
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
        const subErr = await subRes.text().catch(() => '');
        console.error('[start-trial] Sub insert error:', subErr);
      }
    } catch(subErr) {
      console.error('[start-trial] Sub insert exception:', subErr.message);
    }

    // 5. Update user profile (CRITICAL)
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
    console.error('[start-trial] Unexpected error:', error.message);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
};
