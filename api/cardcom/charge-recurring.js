// api/cardcom/charge-recurring.js
// POST — Cron job: charges all due subscriptions via Cardcom token
// Called daily by Vercel Cron or external scheduler
// Security: requires CRON_SECRET header to prevent unauthorized calls

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CARDCOM_TERMINAL = process.env.CARDCOM_TERMINAL || '170602';
const CARDCOM_API_NAME = process.env.CARDCOM_API_NAME || 'nBpN6Pz2AqazwWsiicQM';
const CARDCOM_API_PASSWORD = process.env.CARDCOM_API_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

async function supaAdmin(method, path, body) {
  const opts = {
    method,
    headers: {
      'apikey': SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (method === 'POST') opts.headers['Prefer'] = 'return=representation';
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, opts);
  return r.json();
}

async function chargeCardcomToken(token, amount, productName) {
  const params = new URLSearchParams({
    'TerminalNumber': CARDCOM_TERMINAL,
    'ApiName': CARDCOM_API_NAME,
    'TokenToCharge.Token': token,
    'TokenToCharge.SumToBill': String(amount / 100),  // Cardcom expects NIS, not agorot
    'TokenToCharge.CoinId': '1',                      // ILS
    'TokenToCharge.NumOfPayments': '1',
    'ProductName': productName,
    'IsRefund': 'false',
  });

  // Add password if available
  if (CARDCOM_API_PASSWORD) {
    params.set('ApiPassword', CARDCOM_API_PASSWORD);
  }

  const r = await fetch('https://secure.cardcom.solutions/api/v11/BillGold/ChargeToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Security: verify cron secret
  const secret = req.headers['x-cron-secret'] || req.headers.authorization?.replace('Bearer ', '');
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Find all subscriptions due for charge
    //    - Trialing + trial ended → first charge
    //    - Active + period ended → renewal
    //    - Less than 3 failures (dunning limit)
    const subs = await supaAdmin('GET',
      'subscriptions?select=*&or=(and(status.eq.trialing,trial_end.lte.now()),and(status.eq.active,current_period_end.lte.now()))&cancel_at_period_end=eq.false&charge_failures=lt.3&order=created_at.asc'
    );

    if (!Array.isArray(subs) || subs.length === 0) {
      return res.status(200).json({ message: 'No subscriptions due', charged: 0 });
    }

    console.log(`Found ${subs.length} subscriptions to charge`);

    const results = [];

    for (const sub of subs) {
      if (!sub.cardcom_token) {
        // No token — lock user
        await supaAdmin('PATCH', `user_profiles?id=eq.${sub.user_id}`, { status: 'read_only' });
        results.push({ sub_id: sub.id, status: 'skipped', reason: 'no_token' });
        continue;
      }

      const planLabel = { basic: 'Basic', pro: 'Pro', agency: 'Agency' }[sub.plan] || sub.plan;
      const productName = `YUMi ${planLabel} — חיוב חודשי`;

      try {
        // 2. Charge via Cardcom
        const chargeResult = await chargeCardcomToken(sub.cardcom_token, sub.amount_ils, productName);

        const success = chargeResult.ResponseCode === '0' || chargeResult.ResponseCode === 0;

        // 3. Log the charge attempt
        await supaAdmin('POST', 'billing_log', {
          user_id: sub.user_id,
          subscription_id: sub.id,
          cardcom_deal_id: chargeResult.InternalDealNumber || chargeResult.DealId || null,
          amount_ils: sub.amount_ils,
          status: success ? 'success' : 'failed',
          cardcom_response: chargeResult,
          failure_reason: success ? null : (chargeResult.Description || 'Unknown'),
        });

        if (success) {
          // 4a. Charge succeeded — extend period
          const newPeriodStart = new Date();
          const newPeriodEnd = new Date(newPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

          await supaAdmin('PATCH', `subscriptions?id=eq.${sub.id}`, {
            status: 'active',
            current_period_start: newPeriodStart.toISOString(),
            current_period_end: newPeriodEnd.toISOString(),
            last_charge_date: newPeriodStart.toISOString(),
            last_charge_status: 'success',
            charge_failures: 0,
            updated_at: new Date().toISOString(),
          });

          await supaAdmin('PATCH', `user_profiles?id=eq.${sub.user_id}`, {
            status: 'active',
          });

          results.push({ sub_id: sub.id, status: 'charged', amount: sub.amount_ils });
          console.log(`✅ Charged user ${sub.user_id}: ₪${sub.amount_ils / 100}`);

        } else {
          // 4b. Charge failed — increment failure counter
          const failures = (sub.charge_failures || 0) + 1;
          const newStatus = failures >= 3 ? 'past_due' : sub.status;

          await supaAdmin('PATCH', `subscriptions?id=eq.${sub.id}`, {
            last_charge_status: 'failed',
            charge_failures: failures,
            status: newStatus,
            updated_at: new Date().toISOString(),
          });

          // After 3 failures → lock user
          if (failures >= 3) {
            await supaAdmin('PATCH', `user_profiles?id=eq.${sub.user_id}`, {
              status: 'read_only',
            });
          }

          results.push({
            sub_id: sub.id, status: 'failed',
            reason: chargeResult.Description, failures
          });
          console.log(`❌ Charge failed for user ${sub.user_id}: ${chargeResult.Description} (${failures}/3)`);
        }

      } catch (chargeError) {
        console.error(`Error charging sub ${sub.id}:`, chargeError);
        results.push({ sub_id: sub.id, status: 'error', reason: chargeError.message });
      }

      // Rate limit: wait 1 second between charges
      await new Promise(r => setTimeout(r, 1000));
    }

    return res.status(200).json({
      message: `Processed ${results.length} subscriptions`,
      results,
    });

  } catch (error) {
    console.error('Charge recurring error:', error);
    return res.status(500).json({ error: error.message });
  }
}
