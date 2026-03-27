export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API key not configured' });

  const { file_base64, file_type } = req.body;
  if (!file_base64) return res.status(400).json({ error: 'No file provided' });

  try {
    const mediaType = file_type || 'application/pdf';
    const isImage = mediaType.startsWith('image/');

    const content = [
      isImage
        ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: file_base64 } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file_base64 } },
      {
        type: 'text',
        text: `אתה מומחה בקריאת חשבוניות ישראליות. נתח את החשבונית/קבלה הזו וחלץ את הפרטים הבאים.

הקטגוריות האפשריות למנהל סושיאל מדיה:
- כלי עבודה (Canva, Adobe, כלי עריכה, כלי תזמון פוסטים)
- פרסום ממומן (פייסבוק אדס, גוגל אדס, טיקטוק אדס, קידום פוסטים)
- ציוד (מצלמה, תאורה, מיקרופון, חצובה, טלפון)
- מנויים ותוכנות (ChatGPT, מנוי מוזיקה, אחסון ענן, דומיין)
- נסיעות (דלק, חניה, תחבורה ציבורית, נסיעות ללקוחות)
- שיווק (כרטיסי ביקור, פליירים, מתנות ללקוחות)
- חומרי לימוד (קורסים, סדנאות, ספרים)
- אחר

חובה: תחזיר רק JSON בלי שום טקסט נוסף:
{"amount": 123.45, "vendor": "שם הספק", "description": "תיאור קצר", "category": "הקטגוריה", "date": "2025-01-15", "confidence": "high/medium/low"}

אם לא מצליח לקרוא — תחזיר: {"error": "לא הצלחתי לקרוא את המסמך"}`
      }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const text = data.content?.[0]?.text || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json(parsed);
    }
    return res.status(200).json({ error: 'Could not parse invoice' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
