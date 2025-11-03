// server.js
import express from "express";
import morgan from "morgan";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Google GenAI SDK
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

// ---------- config ----------
const PORT = process.env.PORT || 10000;
const MODEL = process.env.GEN_MODEL || "gemini-2.5-flash";

// accept either env name
const API_KEY =
  process.env.API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY;

if (!API_KEY) {
  console.error("[BOOT] No API key in env (API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY).");
}

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(morgan("dev"));

// CORS: wide open for AI Studio
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Friendly root so you see a banner instead of "Cannot GET /"
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "pinflow-proxy", model: MODEL });
});

app.get("/selftest", (_req, res) => res.json({ ok: true, text: "Ping!" }));
app.get("/health", (_req, res) => res.json({ ok: true, hasKey: !!API_KEY }));
app.get("/diag", (_req, res) => res.json({ ok: true, keyLen: API_KEY?.length || 0, model: MODEL }));

// ---------- helpers ----------
const gen = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

async function downloadToTemp(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const filePath = path.join(os.tmpdir(), `pinflow_${Date.now()}.mp4`);
  await fs.writeFile(filePath, buf);
  return { filePath, bytes: buf.length, mime: r.headers.get("content-type") || "video/mp4" };
}

async function uploadAndWaitActive(localPath, mime) {
  const uploaded = await files.uploadFile(localPath, {
    mimeType: mime,
    displayName: path.basename(localPath),
  });

  // poll file status until ACTIVE or timeout
  const id = uploaded.file.name; // e.g. files/abcd123
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const info = await files.getFile(id);
    if (info.state === "ACTIVE") return info;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`file ${id} not ACTIVE after 30s`);
}

// ---------- main route ----------
app.post("/score", async (req, res) => {
  // accept both naming styles
  const resolvedUrl = req.body.resolved_url || req.body.resolvedUrl || req.body.url;
  const nicheBrief = req.body.niche || req.body.nicheBrief || "";

  if (!resolvedUrl) return res.status(400).json({ error: "MISSING_FIELDS", need: ["resolved_url", "niche"] });

  console.log("[REQ] /score url=%s nicheLen=%s", resolvedUrl, String(nicheBrief?.length ?? 0));

  let tempPath;
  try {
    // 1) download
    const d = await downloadToTemp(resolvedUrl);
    tempPath = d.filePath;
    console.log("[STEP] download ok bytes=%d mime=%s", d.bytes, d.mime);

    // 2) upload & wait ACTIVE
    console.log("[STEP] files.upload");
    const fileInfo = await uploadAndWaitActive(tempPath, d.mime);
    const file = { fileUri: fileInfo.uri, mimeType: d.mime };

    // 3) ask model
    const prompt = [
      {
        role: "user",
        parts: [
          { text: "You are scoring short-form videos for niche fit on a 0–10 scale." },
          { text: "Niche brief:\n" + nicheBrief },
          file,
          {
            text:
              "Return JSON with fields: score (0-10 integer), reason (<=2 sentences), confidence (0-100 integer). " +
              "Only return JSON.",
          },
        ],
      },
    ];

    const model = gen.getGenerativeModel({ model: MODEL });
    const out = await model.generateContent({ contents: prompt });
    const text = out.response.text().trim();

    // try to parse; fall back to text
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { score: null, reason: text, confidence: null };
    }

    return res.json({
      ok: true,
      model: MODEL,
      result: parsed,
    });
  } catch (err) {
    console.error("[ERR]", err?.stack || String(err));
    return res.status(500).json({ error: "GEN_INTERNAL" });
  } finally {
    if (tempPath) {
      try {
        await fs.unlink(tempPath);
        console.log("[CLEANUP] temp deleted %s", tempPath);
      } catch {}
    }
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log("[BOOT] node=%s", process.version);
  console.log("pinflow-proxy up on :%s", PORT);
});
