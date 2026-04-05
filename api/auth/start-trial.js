// api/auth/start-trial.js
// POST — Fetches token from Cardcom LowProfile result, creates subscription

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const PLAN_PRICES = {
  basic: { monthly: 9900, yearly: 99000 },  // ₪99/mo or ₪990/yr
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
  const isImmediate = immediate === true; // PRO/MAX pay now, no trial
  const planPrices = PLAN_PRICES[planName] || PLAN_PRICES.pro;
  const amount = billingCycle === 'yearly' ? planPrices.yearly : planPrices.monthly;
  const TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';

  try {
    // 1. Fetch token from Cardcom
    const lpParams = new URLSearchParams({
      'TerminalNumber': TERMINAL,
      'ApiName': API_NAME,
      'LowProfileCode': low_profile_code,
    });

    const lpRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/GetResults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: lpParams.toString(),
    });
    const lpData = await lpRes.json();

    if (String(lpData.ResponseCode) !== '0') {
      console.error('Cardcom LpResult error:', lpData);
      return res.status(400).json({ error: 'הכרטיס נדחה — ' + (lpData.Description || 'נסה כרטיס אחר') });
    }

    const cardToken = lpData.Token;
    const lastFour = lpData.Last4CardDigits || (lpData.CardNumber ? lpData.CardNumber.slice(-4) : '****');
    const cardExpiry = lpData.CardValidity || '';

    if (!cardToken) return res.status(400).json({ error: 'לא התקבל אסימון — נסה שוב' });

    // 2. Calculate period
    const now = new Date();
    const periodDays = isImmediate
      ? (billingCycle === 'yearly' ? 365 : 30)  // Paid: full period
      : TRIAL_DAYS;                              // Trial: 5 days
    const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const subStatus = isImmediate ? 'active' : 'trialing';
    const userStatus = isImmediate ? 'active' : 'trialing';

    // 3. Save subscription (service_role bypasses RLS)
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
      console.error('Subscription insert error:', subErr);
    }

    // 4. Update user profile
    await supaAdmin('PATCH', 'user_profiles?id=eq.' + user.id, {
      status: userStatus,
      plan: planName,
      billing_cycle: billingCycle,
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      trial_ends_at: isImmediate ? null : periodEnd.toISOString(),
    });

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
    console.error('Start trial error:', error);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
};
