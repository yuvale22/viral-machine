// api/cardcom/check-status.js
// POST { low_profile_code } — Polls Cardcom v11 GetLpResult to check transaction status.
// Returns { status: 'pending' | 'completed' | 'failed' }
const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
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
  const { low_profile_code } = req.body || {};
  if (!low_profile_code) return res.status(400).json({ error: 'Missing low_profile_code' });
  const TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
  const API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';
  try {
    const lpData = await fetchCardcomResult(TERMINAL, API_NAME, low_profile_code);
    console.log('[check-status]', low_profile_code, '→', JSON.stringify(lpData).slice(0, 500));
    const code = lpData.ResponseCode;
    const desc = (lpData.Description || '').toLowerCase();

    // FIX: Cardcom returns code >= 700 for BOTH real failures AND "waiting for user".
    // Check the description to distinguish between them.
    // Hebrew "ממתינה" = waiting, "לא הושלמה" = not completed — both mean PENDING.
    const isWaiting = desc.includes('ממתינה') || desc.includes('waiting') || desc.includes('לא הושלמה') || desc.includes('not completed');

    // If code >= 700 but description says "waiting" → treat as pending
    if (typeof code === 'number' && code >= 700 && isWaiting) {
      return res.status(200).json({
        status: 'pending',
        reason: lpData.Description || 'Waiting for user'
      });
    }

    // Active failure (code >= 700 and NOT waiting — real card decline)
    if (typeof code === 'number' && code >= 700) {
      return res.status(200).json({
        status: 'failed',
        reason: lpData.Description || 'Card declined'
      });
    }

    // Success — ResponseCode 0 with completion data
    if (code === 0) {
      const hasCompletionData =
        lpData.TranzactionInfo ||
        lpData.TransactionInfo ||
        lpData.TokenInfo ||
        lpData.Token ||
        lpData.UIValues ||
        lpData.DealId;
      if (hasCompletionData) {
        return res.status(200).json({
          status: 'completed',
          token: lpData.Token || lpData.TokenInfo?.Token || lpData.TranzactionInfo?.Token || null,
          last_four: lpData.TokenInfo?.Last4Digits || lpData.TranzactionInfo?.Last4CardDigits || null,
        });
      }
      return res.status(200).json({ status: 'pending' });
    }
    return res.status(200).json({ status: 'pending' });
  } catch (error) {
    console.error('[check-status] Error:', error.message);
    return res.status(200).json({ status: 'pending' });
  }
};
