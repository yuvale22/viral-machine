// api/cardcom/ipn.js
// POST — Cardcom IPN (Instant Payment Notification)
// Called by Cardcom after tokenization or charge events
// Used primarily for the token creation flow callback

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supaAdmin(method, path, body) {
  const opts = {
    method,
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${SUPA_URL}/rest/v1/${path}`, opts);
}

export default async function handler(req, res) {
  // Cardcom sends IPN as POST with form-encoded or JSON body
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const data = req.body;
    console.log('Cardcom IPN received:', JSON.stringify(data));

    // Extract relevant fields (Cardcom sends various field names)
    const responseCode = data.ResponseCode || data.responsecode || '';
    const returnValue = data.ReturnValue || data.returnvalue || '';  // Our user_id
    const dealId = data.InternalDealNumber || data.internaldealid || '';
    const token = data.Token || data.token || '';
    const operation = data.Operation || data.operation || '';
    const lowProfileCode = data.LowProfileCode || data.lowprofilecode || '';

    const isSuccess = responseCode === '0' || responseCode === 0;

    console.log(`IPN: operation=${operation}, success=${isSuccess}, user=${returnValue}, deal=${dealId}`);

    // Log the IPN for debugging
    if (returnValue) {
      await supaAdmin('POST', 'billing_log', {
        user_id: returnValue,
        cardcom_deal_id: dealId || null,
        status: isSuccess ? 'success' : 'failed',
        cardcom_response: data,
        failure_reason: isSuccess ? null : (data.Description || data.description || 'IPN failure'),
      }).catch(e => console.error('IPN log error:', e));
    }

    // If this is a recurring charge IPN (not tokenization)
    if (operation !== '2' && dealId && returnValue) {
      if (isSuccess) {
        // Charge succeeded — ensure user is active
        await supaAdmin('PATCH', `user_profiles?id=eq.${returnValue}`, {
          status: 'active',
        });
      } else {
        // Charge failed via IPN
        // Update subscription failure count
        const subs = await (await fetch(`${SUPA_URL}/rest/v1/subscriptions?select=*&user_id=eq.${returnValue}&order=created_at.desc&limit=1`, {
          headers: {
            'apikey': SUPA_SERVICE_KEY,
            'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
          },
        })).json();

        if (subs?.[0]) {
          const failures = (subs[0].charge_failures || 0) + 1;
          await supaAdmin('PATCH', `subscriptions?id=eq.${subs[0].id}`, {
            last_charge_status: 'failed',
            charge_failures: failures,
            status: failures >= 3 ? 'past_due' : subs[0].status,
            updated_at: new Date().toISOString(),
          });

          if (failures >= 3) {
            await supaAdmin('PATCH', `user_profiles?id=eq.${returnValue}`, {
              status: 'read_only',
            });
          }
        }
      }
    }

    // Always return 200 to Cardcom (they retry on non-200)
    return res.status(200).send('OK');

  } catch (error) {
    console.error('IPN processing error:', error);
    // Still return 200 — log the error but don't make Cardcom retry
    return res.status(200).send('OK');
  }
}
