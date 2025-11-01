// server.js  — full replacement
import express from "express";
import cors from "cors";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || "";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkId = () => crypto.randomBytes(4).toString("hex");

app.get("/", (_req, res) => res.type("text").send("pinflow-proxy OK"));
app.get("/health", (_req, res) => res.json({ ok: true, hasKey: !!API_KEY }));
app.get("/diag", (_req, res) =>
  res.json({ ok: true, node: process.versions.node, env: { hasKey: !!API_KEY }, time: new Date().toISOString() })
);

/**
 * POST /score
 * body: { resolved_url: string, niche: string }
 * returns: { score: number } or { code, detail }
 */
app.post("/score", async (req, res) => {
  const id = mkId();
  const { resolved_url, niche } = req.body || {};
  console.log(`[${id}] [REQ] /score url=${resolved_url}`);

  if (!API_KEY) return res.status(500).json({ code: "NO_API_KEY" });
  if (!resolved_url || !niche) return res.status(400).json({ code: "MISSING_FIELDS" });

  const tmpPath = path.join(os.tmpdir(), `pinflow_${Date.now()}_${id}.mp4`);
  let fileName = null;

  try {
    // 1) Download
    console.log(`[${id}] [STEP] download start`);
    const r = await fetch(resolved_url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return res.status(502).json({ code: "DL_FAILED", detail: r.status });
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    console.log(`[${id}] [STEP] download ok bytes=${buf.byteLength}`);
    await fs.writeFile(tmpPath, buf);

    // 2) Upload to Files API
    const fm = new GoogleAIFileManager(API_KEY);
    console.log(`[${id}] [STEP] files.upload (path)`);
    const up = await fm.uploadFile(tmpPath, { mimeType: "video/mp4", displayName: path.basename(tmpPath) });
    const uri = up?.file?.uri;
    fileName = up?.file?.name;
    if (!uri || !fileName) return res.status(500).json({ code: "UPLOAD_FAILED" });

    // 3) Wait for ACTIVE
    let state = "PENDING";
    for (let i = 0; i < 30; i++) {
      const f = await fm.getFile(fileName);
      state = f?.state || "UNKNOWN";
      if (state === "ACTIVE") break;
      await sleep(1000);
    }
    console.log(`[${id}] [STEP] file ${state} name=${fileName}`);
    if (state !== "ACTIVE") return res.status(500).json({ code: "FILE_NOT_ACTIVE", detail: state });

    // 4) Score with Gemini
    const ai = new GoogleGenerativeAI(API_KEY);
    const model = ai.getGenerativeModel({ model: "gemini-2.5-pro" });
    const prompt = `Return a single integer 0–10: how well this video matches the niche. Niche: "${niche}". No other text.`;

    console.log(`[${id}] [MODEL] generate start`);
    const result = await model.generateContent([
      { text: prompt },
      { fileData: { fileUri: uri, mimeType: "video/mp4" } },
    ]);
    const text = (await result.response.text()).trim();
    const n = Number(text);

    if (!Number.isInteger(n) || n < 0 || n > 10) {
      console.log(`[${id}] [ERR] PARSE_FAILED raw="${text}"`);
      return res.status(422).json({ code: "PARSE_FAILED", detail: text });
    }

    console.log(`[${id}] [DONE] score=${n}`);
    return res.json({ score: n });
  } catch (err) {
    console.log(`[${id}] [ERR]`, err?.message || String(err));
    return res.status(500).json({ code: "GEN_INTERNAL", detail: String(err?.message || err) });
  } finally {
    try { await fs.rm(tmpPath, { force: true }); } catch {}
    if (fileName) {
      try {
        const fm = new GoogleAIFileManager(API_KEY);
        await fm.deleteFile(fileName);
        console.log(`[${id}] [CLEANUP] delete ok name=${fileName}`);
      } catch (e) {
        console.log(`[${id}] [CLEANUP] delete failed name=${fileName} ${e?.message || e}`);
      }
    }
  }
});

app.listen(PORT, () => console.log(`pinflow-proxy up on :${PORT}`));
