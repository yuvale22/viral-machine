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
  console.log("🚀 Starting YUMi Full-System Indexer...");

  const { data: videos, error } = await supabase.from("cached_videos").select("video_id").limit(3);
  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }

  for (const video of videos) {
    const id = video.video_id;
    console.log("Processing Video: " + id);

    const { data: existing } = await supabase.from("video_analysis").select("aweme_id").eq("aweme_id", id).maybeSingle();
    if (existing) {
      console.log("Skipping, already exists.");
      continue;
    }

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
      console.log("Audio failed, relying on Vision.");
    }

    try {
      console.log("🧠 Generating Analysis and Script with Tags...");
      
      const finalResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `אתה מומחה שיווק וסושיאל מדיה עבור אפליקציית YUMi.
            עליך לייצר פלט במבנה הבא בדיוק (חובה למלא את כל 3 הסעיפים):

            ### 1. איפיון שיווקי
            (ניתוח ה-Hook, הפסיכולוגיה של הוויראליות וההצעה השיווקית בסרטון המקורי).

            ### 2. המלצות הפקה
            (הוראות צילום, סוג סאונד וקצב מומלץ לעריכה).

            ### 3. תסריט יישומי ללקוח
            תכתוב תסריט מלא לצילום המבוסס על המבנה המנצח של הסרטון המקורי.
            חובה להשתמש בתגיות הבאות למילוי אוטומטי של שם העסק והמוצר:
            - לשם העסק: {{BUSINESS_NAME}}
            - לשם המוצר/המנה: {{PRODUCT_NAME}}

            דוגמה לשימוש בתגיות: "בואו לגלות את הדיל החדש של {{BUSINESS_NAME}} על ה-{{PRODUCT_NAME}} שלנו!"

            חוקים: תקן 'תקרעו את התיאום' ל-'תקראו את התיאור'. אם יש רק ג'יבריש מוזיקלי, התעלם ממנו והסתמך על הטקסט מהמסך (Vision).`
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
      
      console.log("🎯 Successfully indexed and scripted: " + id);
    } catch (err) {
      console.error("AI Generation error:", err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 All jobs done."));
