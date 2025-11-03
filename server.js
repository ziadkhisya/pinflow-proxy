// server.js — pinflow-proxy
import express from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
// Accept both names so we never get bitten by this again:
const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

console.log(
  `[BOOT] node=${process.version} keySource=${
    process.env.GEMINI_API_KEY ? "GEMINI_API_KEY"
    : process.env.API_KEY ? "API_KEY"
    : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY"
    : "none"
  }`
);

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
const files = API_KEY ? new GoogleAIFileManager({ apiKey: API_KEY }) : null;

app.get("/health", (req, res) => res.json({ ok: true, hasKey: !!API_KEY }));
app.get("/diag", (req, res) =>
  res.json({ ok: true, node: process.version, hasKey: !!API_KEY, time: new Date().toISOString() })
);
app.get("/selftest", async (req, res) => {
  try {
    if (!API_KEY) return res.status(400).json({ ok: false, error: "NO_API_KEY" });
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const r = await model.generateContent("pong");
    return res.json({ ok: true, text: r.response.text() });
  } catch (e) {
    console.error("[SELFTEST ERR]", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

async function downloadToTmp(url) {
  console.log("[STEP] download start", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `pinflow_${Date.now()}.mp4`);
  await fs.writeFile(tmp, buf);
  const mime = r.headers.get("content-type") || "video/mp4";
  console.log("[STEP] download ok bytes=%d mime=%s", buf.length, mime);
  return { tmp, mime };
}

async function waitActive(name, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const f = await files.getFile(name);
    if (f.state === "ACTIVE") return f;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("upload_not_active");
}

app.post("/score", async (req, res) => {
  const url = req.body?.resolved_url || req.body?.resolvedUrl || req.body?.url || "";
  const niche = req.body?.niche || req.body?.nicheBrief || req.body?.brief || "";

  console.log("[REQ] /score bodyKeys=%s", Object.keys(req.body || {}).join(","));
  console.log("[REQ] /score url=%s nicheLen=%s", url, niche?.length || 0);

  if (!url) return res.status(400).json({ error: "MISSING_FIELDS" });
  if (!API_KEY) return res.status(500).json({ error: "NO_API_KEY" });

  let tmpPath = null, uploadedName = null;

  try {
    const dl = await downloadToTmp(url);
    tmpPath = dl.tmp;

    console.log("[STEP] files.upload (path)");
    const up = await files.uploadFile(tmpPath, {
      mimeType: dl.mime,
      displayName: path.basename(tmpPath),
    });
    uploadedName = up.file.name; // e.g. files/abc123
    console.log("[STEP] upload ok name=%s uri=%s", uploadedName, up.file.uri);

    await waitActive(uploadedName);
    console.log("[STEP] file ACTIVE name=%s", uploadedName);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt =
      `You score how well a video matches this niche: "${niche}".\n` +
      `Return ONLY JSON: {"score":0..10,"reason":"<=160 chars","confidence":0..100}\n` +
      `No prose, no extra keys.`;

    console.log("[MODEL] generate start");
    const out = await model.generateContent([
      { fileData: { fileUri: up.file.uri, mimeType: dl.mime } },
      { text: prompt },
    ]);

    const text = out.response.text().trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      return res.status(200).json({ score: 0, reason: "BAD_JSON", confidence: null, raw: text });
    }

    const score = Math.max(0, Math.min(10, parseInt(parsed.score ?? 0, 10)));
    const reason = (parsed.reason || "").slice(0, 200);
    const confidence = parsed.confidence == null ? null :
      Math.max(0, Math.min(100, parseInt(parsed.confidence, 10)));

    console.log("[DONE] score=%s", score);
    return res.json({ score, reason, confidence });
  } catch (e) {
    const msg = String(e?.message || e);
    const is429 = /Too Many Requests|quota|Rate|retry/i.test(msg) || e?.status === 429;
    const isKey = /API key not valid|API_KEY_INVALID/i.test(msg);
    console.error("[ERR]", e);
    return res
      .status(isKey ? 401 : is429 ? 429 : 500)
      .json({ error: isKey ? "API_KEY_INVALID" : is429 ? "RATE_LIMIT" : "GEN_INTERNAL", detail: msg });
  } finally {
    if (uploadedName) { try { await files.deleteFile(uploadedName); console.log("[CLEANUP] delete ok name=%s", uploadedName); } catch {} }
    if (tmpPath) { try { await fs.unlink(tmpPath); console.log("[CLEANUP] temp deleted %s", tmpPath); } catch {} }
  }
});

app.listen(PORT, () => console.log(`pinflow-proxy up on :${PORT}`));
