import express from "express";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- 10 RPM limiter ----
const WINDOW_MS = 60_000;
const MAX_RPM = 10;
let starts = [];
async function takeSlot() {
  for (;;) {
    const now = Date.now();
    starts = starts.filter(t => now - t < WINDOW_MS);
    if (starts.length < MAX_RPM) { starts.push(now); return; }
    const waitMs = WINDOW_MS - (now - starts[0]) + 5;
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ---- Gemini clients ----
const fm = new GoogleAIFileManager(API_KEY);
const gen = new GoogleGenerativeAI(API_KEY);
const model = gen.getGenerativeModel({ model: "gemini-2.5-flash" });

// ---- helpers ----
async function downloadToTmp(url) {
  console.log(`[STEP] download start`);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`DOWNLOAD_FAILED ${r.status}`);

  const mime = r.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await r.arrayBuffer());   // << fix: Web stream → buffer
  const tmp = path.join(os.tmpdir(), `pinflow_${Date.now()}.bin`);
  fs.writeFileSync(tmp, buf);

  console.log(`[STEP] download ok bytes=${buf.length}`);
  return { tmpPath: tmp, mimeType: mime };
}

async function uploadAndWaitActive(tmpPath, mimeType) {
  console.log(`[STEP] files.upload (path)`);
  const up = await fm.uploadFile(tmpPath, { mimeType });
  const name = up.file.name;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const f = await fm.getFile(name);
    if (f.state === "ACTIVE") {
      console.log(`[STEP] file ACTIVE name=${name}`);
      return { fileName: name, fileUri: f.uri, mimeType: f.mimeType || mimeType };
    }
    if (Date.now() > deadline) throw new Error("UPLOAD_NOT_ACTIVE");
    await new Promise(r => setTimeout(r, 500));
  }
}

function parseRetryMs(err) {
  const s = String(err);
  const m1 = s.match(/Please retry in (\d+(?:\.\d+)?)s/);
  if (m1) return Math.ceil(parseFloat(m1[1]) * 1000);
  const m2 = s.match(/"retryDelay":"(\d+)s"/);
  if (m2) return parseInt(m2[1], 10) * 1000;
  return 6000;
}

async function scoreWithRetries({ fileUri, mimeType, niche }, attempts = 4) {
  const prompt = `Return a single integer 0–10: how well this video matches the niche. Niche: "${niche}". No text besides the number.`;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`[MODEL] generate start`);
      const res = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{ text: prompt }, { fileData: { fileUri, mimeType } }]
        }],
        generationConfig: { temperature: 0 }
      });
      const txt = res.response.text().trim();
      const n = Number(txt);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error("PARSE_FAILED");
      return n;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("429 Too Many Requests") || msg.includes("quota") || msg.includes("Rate limit")) {
        const wait = parseRetryMs(e);
        console.log(`[RATE] 429/backoff waitMs=${wait} attempt=${i}/${attempts}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.log(`[ERR] ${msg}`);
      throw e;
    }
  }
  throw new Error("RATE_LIMIT_PERSISTENT");
}

// ---- endpoints ----
app.get("/", (_, res) => res.type("text/plain").send("pinflow-proxy OK"));
app.get("/health", (_, res) => res.json({ ok: true, hasKey: !!API_KEY }));
app.get("/diag", (_, res) => res.json({ ok: true, node: process.version, env: { hasKey: !!API_KEY }, time: new Date().toISOString() }));

app.post("/score", async (req, res) => {
  try {
    const { resolved_url, niche } = req.body || {};
    const bodyKeys = Object.keys(req.body || {}).join(",");
    console.log(`[REQ] /score bodyKeys=${bodyKeys}`);
    if (!resolved_url || !niche) return res.status(400).json({ error: "MISSING_FIELDS" });

    await takeSlot();
    console.log(`[REQ] /score url=${resolved_url} nicheLen=${(niche || "").length}`);

    const { tmpPath, mimeType } = await downloadToTmp(resolved_url);
    const { fileName, fileUri } = await uploadAndWaitActive(tmpPath, mimeType);
    const score = await scoreWithRetries({ fileUri, mimeType, niche });
    console.log(`[DONE] score=${score}`);

    fs.unlink(tmpPath, () => console.log(`[STEP] temp deleted ${tmpPath}`));
    await fm.deleteFile(fileName).then(() => console.log(`[CLEANUP] delete ok name=${fileName}`)).catch(() => {});

    return res.json({ score });
  } catch (e) {
    const msg = String(e);
    console.log(`[ERR] ${msg}`);
    if (msg.includes("MISSING_FIELDS")) return res.status(400).json({ error: "MISSING_FIELDS" });
    if (msg.includes("DOWNLOAD_FAILED")) return res.status(400).json({ error: "DOWNLOAD_FAILED" });
    if (msg.includes("PARSE_FAILED")) return res.status(500).json({ error: "PARSE_FAILED" });
    if (msg.includes("RATE_LIMIT_PERSISTENT")) return res.status(429).json({ error: "RATE_LIMIT_PERSISTENT" });
    return res.status(500).json({ error: "GEN_INTERNAL" });
  }
});

app.listen(PORT, () => console.log(`pinflow-proxy up on :${PORT}`));
