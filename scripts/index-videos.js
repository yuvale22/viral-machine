const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// פונקציה לשליפת מידע מלא על הסרטון מרפיד
async function getVideoData(videoId) {
  console.log(`📡 פונה ל-RapidAPI עבור סרטון: ${videoId}`);
  const url = `https://tiktok-scraper7.p.rapidapi.com/?url=${videoId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    return {
      playUrl: data.data?.play || data.data?.wmplay || null,
      coverUrl: data.data?.cover || null,
      title: data.data?.title || ""
    };
  } catch (e) {
    console.error(`❌ שגיאה ב-RapidAPI עבור ${videoId}:`, e.message);
    return null;
  }
}

// פונקציה לקריאת טקסט מהמסך (Vision)
async function getOnScreenText(coverUrl) {
  if (!coverUrl) return null;
  try {
    console.log(`👁️ מנסה לקרוא טקסט מהמסך (Vision)...`);
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "מהו הטקסט השיווקי שכתוב על המסך בתמונה הזו? תענה רק בטקסט עצמו בצורה מדויקת. אם אין טקסט, תענה 'ללא'." },
            { type: "image_url", image_url: { url: coverUrl } },
          ],
        },
      ],
    });
    const text = response.choices[0].message.content;
    return text === 'ללא' ? null : text;
  } catch (e) {
    console.error("❌ שגיאה בקריאת תמונה:", e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת סבב אינדוקס
