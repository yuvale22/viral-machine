const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  console.log(`📡 פונה ל-RapidAPI עבור סרטון: ${videoId}`);
  const url = `https://tiktok-scraper7.p.rapidapi.com/video/info?video_id=${videoId}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    const playUrl = data.data?.play || data.data?.wmplay || null;
    if (!playUrl) console.log(`⚠️ לא נמצא URL בתוך התשובה של RapidAPI`);
    return playUrl;
  } catch (e) {
    console.error(`❌ שגיאה ב-RapidAPI עבור ${videoId}:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 מתחיל אינדוקס חכם (גרסת דיבאג)...");

  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id')
    .limit(3); // נתחיל ב-3 כדי להיות בטוחים

  if (error) {
    console.error("❌ שגיאה בשליפת סרטונים מסופאבייס:", error.message);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לעיבוד.`);

  for (const video of videos) {
    const id = video.video_id;
    console.log(`------------------------------`);
    console.log(`🔍 בודק סרטון: ${id}`);

    // בדיקה אם קיים
    const { data: existing, error: checkError } = await supabase
      .from('video_analysis')
      .select('aweme_id')
      .eq('aweme_id', id)
      .maybeSingle();

    if (existing) {
      console.log(`⏭️ סרטון ${id} כבר תומלל בעבר, מדלג.`);
      continue;
    }

    const freshUrl = await getFreshVideoUrl(id);
    if (!freshUrl) continue;

    try {
      console.log(`🎙️ שולח ל-OpenAI (Whisper) תמלול...`);
      
      // הורדת הקובץ לזיכרון לפני השליחה
      const videoRes = await fetch(freshUrl);
      const blob = await videoRes.blob();
      const file = new File([blob], "video.mp4", { type: "video/mp4" });

      const transcription = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "he"
      });

      console.log(`✅ תמלול התקבל! שומר לסופאבייס...`);

      const { error: insertError } = await supabase.from('video_analysis').insert({
        aweme_id: id,
        transcript: transcription.text,
        source_url: freshUrl
      });

      if (insertError) {
        console.error(`❌ שגיאה בשמירה לסופאבייס:`, insertError.message);
      } else {
        console.log(`🎯 הצלחה מלאה עבור סרטון ${id}!`);
      }
    } catch (err) {
      console.error(`❌ שגיאה בתהליך התמלול של ${id}:`, err.message);
    }
  }
  console.log("🏁 הסתיים סבב עיבוד.");
}

// הפעלה בטוחה שמחכה לסיום
indexVideos().then(() => {
  console.log("✨ ה-Script סיים את עבודתו בהצלחה.");
}).catch(err => {
  console.error("💥 קריסה בלתי צפויה:", err);
  process.exit(1);
});
