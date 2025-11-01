// server.js  — pinflow-proxy
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { GoogleGenerativeAI, GoogleAIFileManager } from "@google/generative-ai";
import { toFile } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

// ---------- helpers ----------
function now() { return new Date().toISOString(); }
function tmpFilePath(ext = ".mp4") {
  return path.join(os.tmpdir(), `pinflow_${Date.now()}${ext}`);
}

function ok(res, data) { res.status(200).json(data); }
function bad(res, code = "MISSING_FIELDS") { res.status(400).json({ error: code }); }
function serverErr(res, e) {
  console.error("[SERVER_ERR]", e);
  res.status(500).json({ error: "SERVER_ERROR" });
}

async function downloadToTemp(url) {
  console.log("[STEP] download start", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  console.log("[STEP] download ok bytes=", buf.length);
  const tmp = tmpFilePath(".mp4");
  await fs.writeFile(tmp, buf);
  console.log("[STEP] wrote temp", tmp);
  return { tmp, buf };
}

async function waitActive(fileMgr, name, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const meta = await fileMgr.getFile(name);
    if (meta.state === "ACTIVE") {
      console.log("[STEP] file ACTIVE name=", name);
      return;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error("file not ACTIVE in time");
}

// ---------- diagnostics ----------
app.get("/", (_, res) => res.type("text/plain").send("pinflow-proxy OK"));
app.get("/health", (_, res) => ok(res, { ok: true, hasKey: Boolean(API_KEY) }));
app.get("/diag", (_, res) => ok(res, { ok: true, node: process.versions.node, env: { hasKey: Boolean(API_KEY) }, time: now() }));

// ---------- main scoring endpoint ----------
app.options("/score", (_, res) => res.sendStatus(204));
app.post("/score", async (req, res) => {
  const { resolved_url, niche } = req.body || {};
  console.log("[REQ] /score", { url: resolved_url, nicheLen: (niche || "").length });

  if (!resolved_url || !niche) return bad(res, "MISSING_FIELDS");
  if (!API_KEY) return bad(res, "NO_API_KEY");

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
  const fileMgr = new GoogleAIFileManager(API_KEY);

  let tmp = null;
  let fileName = null;
  try {
    // 1) download
    const dl = await downloadToTemp(resolved_url);
    tmp = dl.tmp;

    // 2) upload to Files API
    console.log("[STEP] files.upload (path)");
    const fileMeta = await fileMgr.uploadFile(toFile(tmp, "video/mp4"));
    fileName = fileMeta.file?.name || fileMeta.name || fileMeta.fileUri || null;
    if (!fileName) throw new Error("upload returned no name");
    await waitActive(fileMgr, fileName);

    // 3) score via model.generateContent
    console.log("[MODEL] generate start");
    const prompt = `Return a single integer 0–10 for how well this video matches the niche. Niche: "${niche}". No text besides the number.`;
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { fileData: { fileUri: fileName.startsWith("files/") ? `https://generativelanguage.googleapis.com/v1beta/${fileName}` : fileName, mimeType: "video/mp4" } }
        ]
      }],
      generationConfig: { temperature: 0.0 }
    });

    const text = (result?.response?.text() ?? "").trim();
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      console.log("[MODEL] bad score text:", text);
      return ok(res, { score: "PARSE_FAILED" });
    }
    return ok(res, { score: String(n) });

  } catch (e) {
    console.error("[ERR]", e);
    return serverErr(res, e);

  } finally {
    // cleanup temp
    if (tmp) {
      try { await fs.unlink(tmp); console.log("[STEP] temp deleted", tmp); } catch {}
    }
    // cleanup remote file
    if (fileName) {
      try { await fileMgr.deleteFile(fileName); console.log("[STEP] delete ok name=", fileName); } catch (e) { console.warn("[WARN] delete failed:", e?.message); }
    }
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`pinflow-proxy up on :${PORT}`);
});
