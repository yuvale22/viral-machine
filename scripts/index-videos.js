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
  console.log("🚀 Starting YUMi Script Mirroring Machine...");

  const { data: videos, error } = await supabase.from("cached_videos").select("video_id").limit(3);
  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }

  for (const video of videos) {
    const id = video.video_id;
    console.log("Analyzing: " + id);

    const { data: existing } = await supabase.from("video_analysis").select("aweme_id").eq("aweme_id", id).maybeSingle();
    if (existing) continue;

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
      console.log("Audio failed, using Vision.");
    }

    try {
      console.log("🧠 Creating Script Mirror...");
      
      const finalResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `אתה מומחה שיווק וסושיאל מדיה עבור אפליקציית YUMi.
            תפקידך לייצר "תסריט מראה" (Script Mirror) שמשכפל את ההצלחה של הסרטון המקורי בצורה מדויקת.
            
            חוקי הברזל ליצירת התסריט:
            1. פלואו זהה: עקוב במדויק אחרי סדר הפעולות של הסרטון המקורי (הוק, מעברים, והנעה לפעולה).
            2. סגנון המלל: שמור על אותה שפה (סלנג, שפה מקצועית, הומור) שהופיעה במקור.
            3. שימוש בתגיות: השתמש בתגית {{BUSINESS_NAME}} פעם אחת בלבד לאורך כל התסריט.
            4. מינימליזם: אל תוסיף משפטי שיווק גנריים. אם המקור היה ספונטני, התסריט החדש חייב להיות ספונטני.
            
            מבנה התשובה:
            ### 1. איפיון שיווקי
            (ניתוח ה-Hook ולמה זה עבד).

            ### 2. המלצות הפקה
            (צילום וסאונד זהים למקור).

            ### 3. תסריט ה-Vibe המקורי
            תכתוב את התסריט החדש שמחקה את המקור אחד-לאחד, עם תגית {{BUSINESS_NAME}} ותגית {{PRODUCT_NAME}}.

            תיקון: תקן 'תקרעו את התיאום' ל-'תקראו את התיאור'. אם יש רק מוזיקה, התמקד בטקסט מהמסך.`
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
      
      console.log("🎯 Successfully mirrored script: " + id);
    } catch (err) {
      console.error("AI Error:", err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 Done."));
