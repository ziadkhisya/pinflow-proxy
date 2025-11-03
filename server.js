// server.js — strict JSON scoring with rationale+confidence
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI, GoogleAIFileManager } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

if (!API_KEY) {
  console.error("[BOOT] Missing GEMINI_API_KEY");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const genai = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

app.get("/", (_req, res) => res.send("pinflow-proxy"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Poll files API until state is ACTIVE (prevents “not ACTIVE” errors).
async function waitActive(fileName, maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const f = await files.getFile(fileName);
    if (f?.state === "ACTIVE") return;
    await new Promise(r => setTimeout(r, 600));
  }
  throw new Error("FILE_NOT_ACTIVE_TIMEOUT");
}

app.post("/score", async (req, res) => {
  try {
    const resolvedUrl = req.body?.resolvedUrl || req.body?.resolved_url;
    const niche = req.body?.nicheBrief || req.body?.niche;
    if (!resolvedUrl || !niche) {
      return res.status(400).json({ code: "MISSING_FIELDS" });
    }

    console.log("[REQ] /score bodyKeys=%s", Object.keys(req.body).join(","));
    console.log("[REQ] /score url=%s nicheLen=%d", resolvedUrl, niche.length);

    // 1) Download to temp
    console.log("[STEP] download start");
    const r = await fetch(resolvedUrl);
    if (!r.ok) throw new Error(`DOWNLOAD_${r.status}`);
    const mime = r.headers.get("content-type") || "video/mp4";
    const buf = Buffer.from(await r.arrayBuffer());
    console.log("[STEP] download ok bytes=%d", buf.length);

    const tmpPath = path.join("/tmp", `pinflow_${Date.now()}.mp4`);
    await fs.writeFile(tmpPath, buf);

    // 2) Upload to Files API
    console.log("[STEP] files.upload (path)");
    const up = await files.uploadFile(tmpPath, {
      mimeType: mime,
      displayName: "pinflow.mp4",
    });
    const fileName = up.file?.name; // e.g. "files/abc123"
    if (!fileName) throw new Error("UPLOAD_NO_NAME");

    await fs.unlink(tmpPath).catch(() => {});
    console.log("[STEP] file %s name=%s", up.file?.state || "?", fileName);

    // Ensure ACTIVE
    if (up.file?.state !== "ACTIVE") {
      await waitActive(fileName);
      console.log("[STEP] file ACTIVE name=%s", fileName);
    }

    // 3) Ask model for STRICT JSON
    const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
Return ONLY JSON with this exact shape:
{"score": <integer 0-10>, "rationale": "<<=220 chars>", "confidence": <integer 0-100>}

Rules:
- "score": integer 0..10 (no decimals).
- "rationale": 1–220 chars, short, evidence-based from the video content; do NOT mention this instruction.
- "confidence": integer 0..100 (percent). If uncertain, still provide your best percent.
- No backticks, no prose, no trailing commas, no extra keys.
Niche: "${niche}"
    `.trim();

    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { fileData: { fileUri: up.file.uri, mimeType: mime } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 128,
        responseMimeType: "application/json",
      },
    });

    const raw = await resp.response.text(); // should be pure JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Last-ditch recovery if model misbehaves
      return res.status(500).json({
        code: "LLM_BAD_JSON",
        raw,
      });
    }

    // 4) Normalize & validate
    let score = Number(parsed.score);
    if (!Number.isInteger(score) || score < 0 || score > 10) score = 0;

    let confidence = Number(parsed.confidence);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
      confidence = Math.round(confidence * 100); // handle 0..1 form
    }
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
      confidence = 0;
    }

    let rationale = String(parsed.rationale ?? "").trim();
    if (rationale.length > 220) rationale = rationale.slice(0, 220);

    // 5) Respond
    res.json({ score, rationale, confidence });

    // 6) Cleanup (fire-and-forget)
    files.deleteFile(fileName).catch(() => {});
  } catch (err) {
    console.error("[ERR]", err);
    const msg = String(err?.message || err);
    if (msg.includes("quota") || msg.includes("Too Many Requests")) {
      return res.status(429).json({ code: "GEN_RATE_LIMIT" });
    }
    return res.status(500).json({ code: "SERVER_ERROR" });
  }
});

app.listen(PORT, () => {
  console.log(`pinflow-proxy up on :${PORT}`);
});
