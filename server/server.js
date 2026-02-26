// server/server.js (ESM) — 완성형
import "dotenv/config";
import express from "express";
import cors from "cors";
import sharp from "sharp";
import { fetch } from "undici";

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-2.5-flash-image";

// ALLOWED_ORIGINS="http://localhost:5500,https://xxx.netlify.app"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

console.log("ENV KEY EXISTS?", !!API_KEY);
console.log("MODEL:", MODEL);
console.log("ALLOWED_ORIGINS:", ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "(allow all)");

const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json({ limit: "25mb" }));

// ✅ Render / 브라우저에서 확인용
app.get("/", (req, res) => res.status(200).send("decotile-server OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

function getGeminiError(data) {
  return data?.error?.message || "Gemini error";
}

// candidates 전체 + parts 전체에서 가장 긴 base64를 이미지로 간주
function findLargestInlineImage(data) {
  const candidates = data?.candidates || [];
  let best = null;

  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      const camelData = p?.inlineData?.data;
      const camelMime = p?.inlineData?.mimeType;
      const snakeData = p?.inline_data?.data;
      const snakeMime = p?.inline_data?.mime_type;

      const dataStr = camelData || snakeData;
      const mimeStr = camelMime || snakeMime;

      if (typeof dataStr === "string" && dataStr.length > 0) {
        if (!best || dataStr.length > best.data.length) {
          best = { data: dataStr, mime: mimeStr || "image/png" };
        }
      }
    }
  }
  return best;
}

function luminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 이미지 평균 RGB(샘플 전체 또는 결과 바닥 추정 영역)
async function meanRgb(imageB64, region = "full") {
  const buf = Buffer.from(imageB64, "base64");
  const img = sharp(buf);
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return null;

  let extract;
  if (region === "bottom") {
    // 결과 이미지에서 바닥은 대체로 아래쪽에 많으니 아래 45% 추정
    const top = Math.floor(h * 0.55);
    const height = h - top;
    extract = img.extract({ left: 0, top, width: w, height });
  } else {
    extract = img;
  }

  const { data, info } = await extract.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const n = info.width * info.height;

  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

function buildPrompt(tileName = "", extra = "") {
  const base = [
    "You are a professional architectural surface editor.",
    "You will edit a ROOM PHOTO using a TILE SAMPLE.",
    "",
    "TASK:",
    "Replace ONLY the entire visible FLOOR area with the TILE SAMPLE texture and color.",
    "Everything else must remain unchanged.",
    "",
    "ABSOLUTE REPLACEMENT:",
    "Completely replace the floor everywhere it is visible.",
    "No mixing with the original floor texture.",
    "",
    "COLOR / BRIGHTNESS MATCH (HIGHEST PRIORITY):",
    "Treat the TILE SAMPLE as the ground-truth reference for base color (albedo).",
    "The edited floor's base color MUST match the TILE SAMPLE closely.",
    "Do NOT globally darken the floor to remove reflections.",
    "Do NOT apply tone-mapping, contrast boost, vignette, or global relighting.",
    "Keep the tile base brightness consistent with the TILE SAMPLE.",
    "Only apply mild contact shadows at object contact areas; shadows must not shift tile base color.",
    "",
    "MATTE PVC (CRITICAL):",
    "The tile is MATTE PVC and must look non-reflective.",
    "Remove shiny glare/wet look/specular highlights by suppressing ONLY highlights, not by darkening the whole floor.",
    "Highlights must be soft and subtle (diffuse), never sharp or glossy.",
    "",
    "PERSPECTIVE / SCALE:",
    "Apply the tile pattern with correct perspective and realistic scale.",
    "If grout lines exist, keep them consistent and realistic across the floor.",
    "",
    "PRESERVE EVERYTHING ELSE:",
    "Do NOT change walls, furniture, objects, lighting temperature, overall exposure, or camera look.",
    "Only the floor changes.",
    "",
    `Tile name: ${tileName}`,
    "",
    "OUTPUT:",
    "Return ONLY the final edited IMAGE. No text."
  ].join("\n");

  return extra ? `${base}\n\n${extra}` : base;
}

async function callGemini({ userMime, userB64, tileMime, tileB64, tileName, extraInstruction = "" }) {
  if (!API_KEY) throw new Error("Missing GEMINI_API_KEY in env");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: buildPrompt(tileName, extraInstruction) },
        { inline_data: { mime_type: userMime, data: userB64 } },
        { inline_data: { mime_type: tileMime, data: tileB64 } }
      ]
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      temperature: 0.05, // 색 흔들림 최소화
      topP: 0.7
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();

  if (!resp.ok) {
    return { ok: false, error: getGeminiError(data), raw: data };
  }

  const img = findLargestInlineImage(data);
  if (!img?.data) {
    return { ok: false, error: "NO_IMAGE", raw: data, parts: data?.candidates?.[0]?.content?.parts || [] };
  }

  if (img.data.length < 10000) {
    return { ok: false, error: "IMAGE_TOO_SMALL", length: img.data.length, raw: data };
  }

  return { ok: true, imageB64: img.data, mime: img.mime };
}

app.post("/api/floor/edit", async (req, res) => {
  try {
    const { userMime, userB64, tileMime, tileB64, tileName } = req.body || {};

    if (!API_KEY) return res.status(500).json({ error: "Missing GEMINI_API_KEY in env" });
    if (!userMime || !userB64 || !tileMime || !tileB64) {
      return res.status(400).json({ error: "Missing required fields: userMime,userB64,tileMime,tileB64" });
    }

    // ✅ 기준: 타일 샘플 전체 평균 밝기
    const tileMean = await meanRgb(tileB64, "full").catch(() => null);
    const tileLum = tileMean ? luminance(tileMean) : null;

    // 1차 시도
    let result = await callGemini({ userMime, userB64, tileMime, tileB64, tileName });

    if (!result.ok) {
      return res.status(200).json({
        error: result.error,
        ...(result.length ? { length: result.length } : {}),
        ...(result.parts ? { parts: result.parts } : {}),
        raw: result.raw
      });
    }

    // ✅ 블루그레이(혹은 밝기 민감 타일) 자동 보정: 결과 바닥(아래쪽) 평균 밝기 비교 후 재시도
    if (tileLum != null) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const outMean = await meanRgb(result.imageB64, "bottom").catch(() => null);
        if (!outMean) break;

        const outLum = luminance(outMean);

        // 타일 대비 10% 이상 어두우면 재시도
        if (outLum < tileLum * 0.90) {
          const retry = await callGemini({
            userMime, userB64, tileMime, tileB64, tileName,
            extraInstruction:
              "CRITICAL FIX: The edited floor is darker than the TILE SAMPLE. " +
              "Match the TILE SAMPLE base brightness and color exactly. " +
              "Remove reflections by reducing ONLY specular highlights, NOT by darkening the whole floor. " +
              "Keep MATTE PVC (no gloss). Change nothing else."
          });
          if (retry.ok) result = retry;
          continue;
        }

        // 타일 대비 10% 이상 밝으면 재시도
        if (outLum > tileLum * 1.10) {
          const retry = await callGemini({
            userMime, userB64, tileMime, tileB64, tileName,
            extraInstruction:
              "CRITICAL FIX: The edited floor is brighter than the TILE SAMPLE. " +
              "Reduce ONLY the floor base brightness to match the TILE SAMPLE. " +
              "Keep MATTE PVC (no gloss). Change nothing else."
          });
          if (retry.ok) result = retry;
          continue;
        }

        break; // 범위 내면 종료
      }
    }

    return res.json({ imageB64: result.imageB64, mime: result.mime });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});