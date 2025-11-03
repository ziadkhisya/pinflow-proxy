// server.js
import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP = express();
APP.use(express.json({ limit: "2mb" }));

// ---- CONFIG & DIAGNOSTICS ---------------------------------------------------
const API_KEY = (process.env.API_KEY || process.env.GEMINI_API_KEY || "").trim();
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash"; // free-tier friendly
const PORT = process.env.PORT || 10000;

const hasKey = () => API_KEY.length > 0;

const genClient = () => new GoogleGenerativeAI(API_KEY);
const fileMgr   = () => new GoogleAIFileManager({ apiKey: API_KEY });

const log = (...a) => console.log(...a);

// simple helpers
const tmpPath = (ext=".mp4") =>
  path.join(os.tmpdir(), `pinflow_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);

async function downloadToFile(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`proxy_non_200 ${r.status}`);
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await r.arrayBuffer());
  const out = tmpPath("." + (mime.split("/")[1] || "bin"));
  await fs.writeFile(out, buf);
  return { path: out, bytes: buf.length, mime };
}

async function waitActive(fm, name, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = await fm.getFile(name);
    if (f?.state === "ACTIVE") return f;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("file_not_active_timeout");
}

function normalizeBody(body) {
  // accept both legacy and new field names
  const url = body.resolved_url || body.resolvedUrl || body.url;
  const niche = body.niche || body.nicheBrief || body.brief || "";
  return { url, niche };
}

// ---- ROUTES -----------------------------------------------------------------
APP.get("/health", (_req, res) => {
  res.json({ ok: true, hasKey: hasKey(), model: MODEL_ID });
});

APP.get("/selftest", (_req, res) => {
  res.json({ ok: true, text: "Ping!" });
});

// quick key sanity check (text-only call, no uploads)
APP.get("/diag", async (_req, res) => {
  try {
    if (!hasKey()) return res.status(400).json({ ok: false, error: "NO_KEY" });
    const model = genClient().getGenerativeModel({ model: MODEL_ID });
    await model.countTokens({ contents: [{ role: "user", parts: [{ text: "ping" }]}] });
    res.json({ ok: true, keyLen: API_KEY.length, model: MODEL_ID });
  } catch (e) {
    res.status(500).json({ ok: false, error: "GEN_INTERNAL", detail: String(e) });
  }
});

// main scoring endpoint
APP.post("/score", async (req, res) => {
  const { url, niche } = normalizeBody(req.body || {});
  log("[REQ] /score bodyKeys=%s url=%s nicheLen=%s",
      Object.keys(req.body || {}).join(","), url, (niche || "").length);

  if (!hasKey()) return res.status(401).json({ error: "API_KEY_INVALID" });
  if (!url)      return res.status(400).json({ error: "MISSING_FIELDS" });

  let tempFile = null;
  let uploadedName = null;

  try {
    // 1) Download
    log("[STEP] download start %s", url);
    const dl = await downloadToFile(url);
    tempFile = dl.path;
    log("[STEP] download ok bytes=%s mime=%s", dl.bytes, dl.mime);

    // 2) Upload
    log("[STEP] files.upload (path)");
    const fm = fileMgr();
    const up = await fm.uploadFile(tempFile, {
      mimeType: dl.mime,
      displayName: path.basename(tempFile),
    });
    uploadedName = up?.file?.name;
    if (!uploadedName) throw new Error("upload_failed_no_name");

    // wait ACTIVE
    const active = await waitActive(fm, uploadedName);
    const fileUri = active.uri;
    log("[STEP] file ACTIVE name=%s", uploadedName);

    // 3) Generate (Flash by default)
    const model = genClient().getGenerativeModel({ model: MODEL_ID });
    const prompt = [
      "You are scoring short social-video relevance.",
      "Return only a single integer 0–10 where 0=totally off-niche, 10=perfect match.",
      "Niche brief:\n" + (niche || "(none)")
    ].join("\n");

    log("[MODEL] generate start");
    const resp = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { fileData: { mimeType: dl.mime, fileUri } }
        ]
      }],
      generationConfig: { temperature: 0.2, topP: 0.9 },
    });

    const text = resp?.response?.text?.() ?? "";
    // extract first integer 0..10
    const m = text.match(/(?:^|\D)(10|[0-9])(?:\D|$)/);
    const score = m ? parseInt(m[1], 10) : 0;
    log("[DONE] score=%s", score);

    res.json({ ok: true, score });
    // 4) Cleanup
    try { await fm.deleteFile(uploadedName); log("[CLEANUP] delete ok name=%s", uploadedName); } catch {}
  } catch (e) {
    // map common errors to your app’s codes
    const msg = String(e);
    log("[ERR] %s", msg);

    if (msg.includes("API key not valid") || msg.includes("API_KEY_INVALID")) {
      return res.status(401).json({ error: "API_KEY_INVALID" });
    }
    if (msg.startsWith("proxy_non_")) {
      const code = msg.split(" ")[0];
      return res.status(500).json({ error: code });
    }
    return res.status(500).json({ error: "GEN_INTERNAL" });
  } finally {
    if (tempFile) {
      try { await fs.unlink(tempFile); log("[CLEANUP] temp deleted %s", tempFile); } catch {}
    }
  }
});

// boot
APP.listen(PORT, () => {
  console.log(`[BOOT] node=${process.version}, keyLen=${API_KEY.length}, model=${MODEL_ID}`);
  console.log(`pinflow-proxy up on :${PORT}`);
});
