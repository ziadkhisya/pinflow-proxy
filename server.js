// server.js
import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP = express();
APP.use(express.json({ limit: "2mb" }));

// ---- config
const PORT = process.env.PORT || 10000;
const API_KEY = (process.env.API_KEY || process.env.GEMINI_API_KEY || "").trim();
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ---- tiny utils
const log = (...a) => console.log(...a);
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

function normalizeBody(body) {
  const url = body.resolved_url || body.resolvedUrl || body.url;
  const niche = body.niche || body.nicheBrief || body.brief || "";
  return { url, niche };
}

// ---- health
APP.get("/selftest", (_req, res) => res.json({ ok: true, text: "Ping!" }));
APP.get("/health",  (_req, res) => res.json({ ok: true, hasKey: !!API_KEY, model: MODEL_ID }));

// simple Gemini key sanity without uploads
APP.get("/diag", async (_req, res) => {
  try {
    if (!API_KEY) return res.status(400).json({ ok:false, error:"NO_KEY" });
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({ model: MODEL_ID });
    await model.countTokens({ contents:[{ role:"user", parts:[{ text:"ping"}]}] });
    res.json({ ok:true, keyLen: API_KEY.length, model: MODEL_ID });
  } catch (e) {
    res.status(500).json({ ok:false, error:"GEN_INTERNAL", detail:String(e) });
  }
});

// ---- main scoring
APP.post("/score", async (req, res) => {
  const { url, niche } = normalizeBody(req.body || {});
  log("[REQ] /score bodyKeys=%s url=%s nicheLen=%s",
      Object.keys(req.body || {}).join(","), url, (niche||"").length);

  if (!API_KEY) return res.status(401).json({ error: "API_KEY_INVALID" });
  if (!url)     return res.status(400).json({ error: "MISSING_FIELDS" });

  let tempFile = null, uploadedName = null;

  try {
    // defer SDK imports so startup can never crash
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const { GoogleAIFileManager } = await import("@google/generative-ai/server");

    // 1) download
    log("[STEP] download start %s", url);
    const dl = await downloadToFile(url);
    tempFile = dl.path;
    log("[STEP] download ok bytes=%s mime=%s", dl.bytes, dl.mime);

    // 2) upload
    const fm = new GoogleAIFileManager({ apiKey: API_KEY });
    log("[STEP] files.upload (path)");
    const up = await fm.uploadFile(tempFile, {
      mimeType: dl.mime,
      displayName: path.basename(tempFile),
    });
    uploadedName = up?.file?.name;
    if (!uploadedName) throw new Error("upload_failed_no_name");

    // wait ACTIVE
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const f = await fm.getFile(uploadedName);
      if (f?.state === "ACTIVE") { log("[STEP] file ACTIVE name=%s", uploadedName); break; }
      await new Promise(r => setTimeout(r, 500));
    }

    // 3) score (Flash; low cost)
    const gen = new GoogleGenerativeAI(API_KEY)
      .getGenerativeModel({ model: MODEL_ID });
    const prompt = [
      "You are scoring short social-video relevance.",
      "Return ONLY one integer 0–10. No words, no JSON.",
      "Niche brief:\n" + (niche || "(none)")
    ].join("\n");

    log("[MODEL] generate start");
    const resp = await gen.generateContent({
      contents: [{ role:"user", parts:[
        { text: prompt }, { fileData: { mimeType: dl.mime, fileUri: up.file.uri } }
      ]}],
      generationConfig: { temperature: 0.2, topP: 0.9 }
    });

    const text = resp?.response?.text?.() ?? "";
    const m = text.match(/(?:^|\D)(10|[0-9])(?:\D|$)/);
    const score = m ? parseInt(m[1], 10) : 0;
    log("[DONE] score=%s", score);

    res.json({ ok:true, score });

    try { await fm.deleteFile(uploadedName); log("[CLEANUP] delete ok name=%s", uploadedName); } catch {}
  } catch (e) {
    const msg = String(e);
    log("[ERR] %s", msg);
    if (msg.includes("API key not valid") || msg.includes("API_KEY_INVALID"))
      return res.status(401).json({ error: "API_KEY_INVALID" });
    if (msg.startsWith("proxy_non_"))
      return res.status(500).json({ error: msg.split(" ")[0] });
    return res.status(500).json({ error: "GEN_INTERNAL" });
  } finally {
    if (tempFile) { try { await fs.unlink(tempFile); log("[CLEANUP] temp deleted %s", tempFile); } catch {} }
  }
});

// ---- boot
APP.listen(PORT, () => {
  console.log(`[BOOT] node=${process.version} keyLen=${API_KEY.length} model=${MODEL_ID}`);
  console.log(`pinflow-proxy up on :${PORT}`);
});
