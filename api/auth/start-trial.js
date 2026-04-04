// api/auth/start-trial.js
// POST — Fetches token from Cardcom LowProfile result, creates subscription

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const PLAN_PRICES = { basic: 9900, pro: 19900, agency: 39900 };

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

  const { low_profile_code, plan } = req.body || {};
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });

  const planName = plan || 'pro';
  const amount = PLAN_PRICES[planName] || PLAN_PRICES.pro;
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

    // 2. Calculate trial
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // 3. Save subscription (service_role bypasses RLS)
    const subRes = await supaAdmin('POST', 'subscriptions', {
      user_id: user.id,
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      cardcom_expiry: cardExpiry,
      plan: planName,
      status: 'trialing',
      amount_ils: amount,
      current_period_start: now.toISOString(),
      current_period_end: trialEnd.toISOString(),
      trial_end: trialEnd.toISOString(),
      last_charge_status: 'pending',
    });

    if (!subRes.ok) {
      const subErr = await subRes.json().catch(() => ({}));
      console.error('Subscription insert error:', subErr);
      // Don't fail — profile update is more important
    }

    // 4. Update user profile
    await supaAdmin('PATCH', 'user_profiles?id=eq.' + user.id, {
      status: 'trialing',
      cardcom_token: cardToken,
      cardcom_last_four: lastFour,
      trial_ends_at: trialEnd.toISOString(),
    });

    return res.status(200).json({
      plan: planName,
      status: 'trialing',
      trial_end: trialEnd.toISOString(),
      trial_end_display: trialEnd.toLocaleDateString('he-IL'),
      last_four: lastFour,
    });

  } catch (error) {
    console.error('Start trial error:', error);
    return res.status(500).json({ error: error.message || 'שגיאה — נסה שוב' });
  }
};
