const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getVideoData(videoId) {
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
    return null;
  }
}

async function getOnScreenText(coverUrl) {
  if (!coverUrl) return null;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "מהו הטקסט השיווקי שכתוב על המסך בתמונה הזו? תענה רק בטקסט עצמו. אם אין טקסט, תענה ללא." },
            { type: "image_url", image_url: { url: coverUrl } },
          ],
        },
      ],
    });
    const text = response.choices[0].message.content;
    return text === "ללא" ? null : text;
  } catch (e) {
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 YUMi Industrial Mode: Processing 100 Videos...");

  // הלימיט הוגדר ל-100 לעיבוד מאסיבי
  const { data: videos, error } = await supabase.from("cached_videos").select("video_id").limit(100);
  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }

  console.log("Found " + videos.length + " new videos to analyze.");

  for (const video of videos) {
    const id = video.video_id;
    
    // בדיקה אם כבר עובד (מונע כפילויות וביזבוז כסף)
    const { data: existing } = await supabase.from("video_analysis").select("aweme_id").eq("aweme_id", id).maybeSingle();
    if (existing) continue;

    console.log("--- Analyzing: " + id + " ---");

    const videoData = await getVideoData(id);
    if (!videoData?.playUrl) continue;

    const onScreenText = await getOnScreenText(videoData.coverUrl);
    
    let transcript = "";
    try {
      const audioRes = await fetch(videoData.playUrl);
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      const file = await OpenAI.toFile(buffer, "video.mp4");
      const result = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "he",
        prompt: "סרטון שיווקי. אם יש רק מוזיקה, אל תתמלל כלום."
      });
      transcript = result.text;
    } catch (e) {
      console.log("Audio process skipped for: " + id);
    }

    try {
      const finalResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `אתה מומחה שיווק וסושיאל מדיה עבור אפליקציית YUMi.
            תפקידך לייצר תסריט מראה (Script Mirror) שמשכפל את ההצלחה של הסרטון המקורי.
            
            חוק קריטי - זיהוי ג'יבריש:
            אם התמלול נראה כמו הברות חוזרות או ג'יבריש מוזיקלי (און גר, דעמי, תה תה), התעלם ממנו לחלוטין ובנה תסריט על בסיס ה-Vision וכותרת הסרטון בלבד.
            
            חוקי התסריט:
            1. פלואו זהה: עקוב אחרי סדר הפעולות של המקור (Hook -> Value -> CTA).
            2. שימוש בתגיות: השתמש ב-{{BUSINESS_NAME}} פעם אחת בלבד.
            3. אותנטיות: שמור על שפה טבעית וטיקטוקית.
            
            מבנה התשובה:
            ### 1. איפיון שיווקי
            (ניתוח ה-Hook ולמה זה עבד).
            ### 2. המלצות הפקה
            (איך לצלם ואיזה סאונד לשים).
            ### 3. תסריט ה-Vibe המקורי
            (תסריט מלא ללקוח עם תגיות {{BUSINESS_NAME}} ו-{{PRODUCT_NAME}}).
            
            תיקון: תקן 'תקרעו את התיאום' ל-'תקראו את התיאור'.`
          },
          {
            role: "user",
            content: "תמלול אודיו: " + transcript + "\nטקסט מהמסך: " + onScreenText + "\nכותרת מקורית: " + videoData.title
          }
        ]
      });

      const finalOutput = finalResponse.choices[0].message.content;

      await supabase.from("video_analysis").insert({
        aweme_id: id,
        transcript: finalOutput,
        source_url: videoData.playUrl
      });
      
      console.log("✅ Done: " + id);
    } catch (err) {
      console.error("AI Error for " + id + ":", err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 100-Video Batch Completed."));
