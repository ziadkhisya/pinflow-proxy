// server.js — pinflow-proxy with hard diagnostics
import express from "express";
import cors from "cors";
import os from "os";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || process.env.GOOGLE_API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// simple req-id for correlation
app.use((req, _res, next) => {
  req.reqId = crypto.randomBytes(6).toString("hex");
  next();
});

function log(req, ...args) {
  console.log(`[${req.reqId}]`, ...args);
}

// health + diag
app.get("/", (_req, res) => res.type("text/plain").send("pinflow-proxy OK"));
app.get("/health", (_req, res) => res.json({ ok: true, hasKey: Boolean(API_KEY) }));
app.get("/diag", (_req, res) =>
  res.json({
    ok: true,
    node: process.versions.node,
    env: { hasKey: Boolean(API_KEY) },
    time: new Date().toISOString(),
  })
);

// util: safe JSON error
function sendError(req, res, at, err, code = "SERVER_ERROR") {
  const detail = (err && err.message) ? err.message : String(err);
  log(req, `[ERR] at=${at} code=${code} detail=${detail}`);
  // Always return JSON so the client never sees HTML
  res.status(200).json({ error: code, at, detail, reqId: req.reqId });
}

// POST /score  { resolved_url, nicheBrief }
app.post("/score", async (req, res) => {
  const { resolved_url, nicheBrief } = req.body || {};
  const genAI = new GoogleGenerativeAI(API_KEY);
  const files = new GoogleAIFileManager(API_KEY);

  if (!resolved_url || !nicheBrief) {
    return sendError(req, res, "input", new Error("Missing resolved_url or nicheBrief"), "BAD_INPUT");
  }
  log(req, `[REQ] /score url=${resolved_url}`);

  // 1) Download bytes → temp file
  const tmp = path.join(os.tmpdir(), `pinflow_${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`);
  let fileName = null;
  let fileUri = null;
  let mimeType = "video/mp4";

  try {
    log(req, "[STEP] download start");
    const r = await fetch(resolved_url);
    if (!r.ok) throw new Error(`download status ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(tmp, buf);
    log(req, `[STEP] download ok bytes=${buf.length}`);

    // 2) Upload to Files API (path upload is most reliable)
    log(req, "[STEP] files.upload (path)");
    const up = await files.uploadFile(tmp, { mimeType, displayName: path.basename(tmp) });
    // Google returns { file: { uri, name } } on older SDKs, and sometimes { uri, name } directly on newer.
    const f = up.file || up;
    fileUri = f.uri;
    fileName = f.name; // e.g. "files/abc123"
    log(req, `[STEP] upload ok uri=${fileUri} name=${fileName}`);

  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return sendError(req, res, "upload", err, "UPLOAD_FAILED");
  } finally {
    // cleanup temp immediately after upload
    await fs.rm(tmp, { force: true }).catch(() => {});
  }

  // 3) Model call
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const prompt = `Return a single integer 0–10 ONLY (no words): how well this video matches the niche.
Niche: "${nicheBrief}"`;

    log(req, "[MODEL] generate start");
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{ text: prompt }, { fileData: { fileUri, mimeType } }]
      }],
      generationConfig: { temperature: 0.0 }
    });

    const text = result?.response?.text?.() ?? result?.text ?? "";
    log(req, `[MODEL] generate ok text="${String(text).slice(0, 60)}"`);

    const n = Number(String(text).trim());
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return sendError(req, res, "parse", new Error(`bad score "${text}"`), "PARSE_FAILED");
    }

    res.json({ score: n, reqId: req.reqId });

  } catch (err) {
    return sendError(req, res, "model", err, "GEN_INTERNAL");
  } finally {
    // 4) Best-effort delete on Gemini Files
    if (fileName) {
      try {
        await files.deleteFile(fileName); // must be the short "files/xxx" name
        log(req, `[STEP] delete ok name=${fileName}`);
      } catch (e) {
        log(req, `[WARN] delete failed name=${fileName} detail=${e?.message || e}`);
      }
    }
  }
});

// legacy endpoints kept for safety (always JSON)
app.post("/fetch-and-upload", (_req, res) => res.status(200).json({ error: "DISABLED_USE_SCORE", at: "router" }));
app.post("/delete-file", (_req, res) => res.status(200).json({ ok: true, note: "handled in /score" }));

app.listen(PORT, () => {
  console.log(`pinflow-proxy up on :${PORT}`);
});
