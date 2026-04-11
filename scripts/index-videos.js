const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function indexVideos() {
  console.log("🚀 מתחיל סריקת סרטונים מ-cached_videos...");

  // 1. שליפת סרטונים מהטבלה הנכונה
  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id, video_url') // וודא שבסופאבייס העמודה נקראת video_url
    .limit(10); 

  if (error) {
    console.error("❌ שגיאה בשליפת סרטונים:", error.message);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לבדיקה.`);

  for (const video of videos) {
    // בדיקה אם כבר תמללנו את הסרטון הזה בעבר
    const { data: existing } = await supabase
      .from('video_analysis')
      .select('aweme_id')
      .eq('aweme_id', video.video_id)
      .single();

    if (existing) {
      console.log(`⏭️ סרטון ${video.video_id} כבר קיים במאגר, מדלג...`);
      continue;
    }

    if (!video.video_url) {
      console.log(`⚠️ לסרטון ${video.video_id} אין לינק (video_url), מדלג...`);
      continue;
    }

    try {
      console.log(`🎙️ מתמלל סרטון ${video.video_id}...`);
      
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(video.video_url),
        model: "whisper-1",
        language: "he"
      });

      // שמירה לטבלת הניתוח
      await supabase.from('video_analysis').insert({
        aweme_id: video.video_id,
        transcript: transcription.text,
        source_url: video.video_url
      });

      console.log(`✅ סרטון ${video.video_id} תומלל ונשמר!`);
    } catch (err) {
      console.error(`❌ שגיאה בתימלול ${video.video_id}:`, err.message);
    }
  }
  console.log("🏁 הסתיים סבב עיבוד.");
}

indexVideos();
