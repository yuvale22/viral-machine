// api/cardcom/ipn.js
// POST — Cardcom IPN (webhook) handler

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';

function getServiceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const data = req.body || {};
    console.log('Cardcom IPN:', JSON.stringify(data));

    const isSuccess = String(data.ResponseCode || '') === '0';
    const userId = data.ReturnValue || data.returnvalue || '';
    const dealId = data.InternalDealNumber || data.internaldealid || '';

    if (userId) {
      const key = getServiceKey();
      // Log the IPN
      await fetch(SUPA_URL + '/rest/v1/billing_log', {
        method: 'POST',
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ user_id: userId, cardcom_deal_id: dealId || null, status: isSuccess ? 'success' : 'failed', cardcom_response: data }),
      }).catch(e => console.error('IPN log error:', e));

      // Update user status if charge result
      if (isSuccess) {
        await fetch(SUPA_URL + '/rest/v1/user_profiles?id=eq.' + userId, {
          method: 'PATCH',
          headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        }).catch(() => {});
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('IPN error:', error);
    return res.status(200).send('OK');
  }
};
