const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function indexVideos() {
  console.log("🚀 מתחיל סריקת סרטונים לתמלול...");

  // 1. שליפת סרטונים שעדיין לא תומללו
  // שים לב: אני מניח ששם הטבלת המקור שלך הוא 'cached_videos' או 'discovered_accounts'
  // אם השם שונה, נצטרך לעדכן כאן.
  const { data: videos, error } = await supabase
    .from('discovered_accounts') 
    .select('aweme_id, video_url, music_url')
    .limit(10); // נתחיל ב-10 סרטונים בכל ריצה כדי לא להעמיס

  if (error) {
    console.error("❌ שגיאה בשליפת סרטונים:", error);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לעיבוד.`);

  for (const video of videos) {
    // בדיקה אם כבר קיים תמלול
    const { data: existing } = await supabase
      .from('video_analysis')
      .select('aweme_id')
      .eq('aweme_id', video.aweme_id)
      .single();

    if (existing) {
      console.log(`⏭️ סרטון ${video.aweme_id} כבר תומלל, מדלג...`);
      continue;
    }

    try {
      console.log(`🎙️ מתמלל סרטון ${video.aweme_id}...`);
      
      // שליחת הלינק של האודיו ל-Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(video.music_url || video.video_url),
        model: "whisper-1",
        language: "he"
      });

      // שמירה לסופאבייס
      await supabase.from('video_analysis').insert({
        aweme_id: video.aweme_id,
        transcript: transcription.text,
        source_url: video.video_url
      });

      console.log(`✅ סרטון ${video.aweme_id} נשמר בהצלחה.`);
    } catch (err) {
      console.error(`❌ שגיאה בעיבוד סרטון ${video.aweme_id}:`, err.message);
    }
  }
  console.log("🏁 הסתיים סבב התמלול.");
}

indexVideos();
