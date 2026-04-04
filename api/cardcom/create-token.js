// api/cardcom/create-token.js
// POST — Creates Cardcom Low Profile page for tokenization

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

async function getUserFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';
  const plan = (req.body || {}).plan || 'pro';

  const baseUrl = req.headers.origin || 'https://viral-machine-alpha.vercel.app';
  const successUrl = baseUrl + '?cardcom_success=1&user_id=' + user.id + '&plan=' + plan;
  const failUrl = baseUrl + '?cardcom_fail=1';
  const ipnUrl = baseUrl + '/api/cardcom/ipn';

  try {
    const params = new URLSearchParams({
      'TerminalNumber': TERMINAL,
      'ApiName': API_NAME,
      'ReturnValue': user.id,
      'Operation': '2',
      'Amount': '1',
      'Currency': '1',
      'Language': 'he',
      'TokenToReturn': 'true',
      'SuccessRedirectUrl': successUrl,
      'ErrorRedirectUrl': failUrl,
      'IndicatorUrl': ipnUrl,
      'ProductName': 'YUMi ' + plan.toUpperCase() + ' - 7 ימי ניסיון',
      'IsIframe': 'true',
      'HideCardOwnerName': 'false',
      'ShowCardOwnerEmail': 'true',
      'CardOwnerEmail': user.email || '',
      'MaxNumOfPayments': '1',
      'CustomFields.Field1': user.id,
      'CustomFields.Field2': plan,
    });

    const cardcomRes = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/Create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const cardcomData = await cardcomRes.json();

    if (String(cardcomData.ResponseCode) !== '0') {
      console.error('Cardcom error:', cardcomData);
      return res.status(400).json({ error: 'שגיאה בקארדקום: ' + (cardcomData.Description || 'Unknown') });
    }

    return res.status(200).json({
      url: cardcomData.Url,
      low_profile_code: cardcomData.LowProfileCode,
    });
  } catch (error) {
    console.error('Cardcom create-token error:', error);
    return res.status(500).json({ error: 'שגיאה בחיבור לקארדקום' });
  }
};
