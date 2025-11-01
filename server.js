// server.js  — Render proxy (ESM)
import express from "express";
import cors from "cors";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  GoogleAIFileManager
} from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// --- helpers -------------------------------------------------
const ok = (res, data) => res.json(data);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

app.get("/", (_req, res) => res.type("text/plain").send("pinflow-proxy OK"));
app.get("/health", (_req, res) => ok(res, { ok: true, hasKey: !!API_KEY }));
app.get("/diag", (_req, res) =>
  ok(res, { ok: true, node: process.version, env: { hasKey: !!API_KEY }, time: new Date().toISOString() })
);

// download Drive file to tmp
async function downloadToTmp(url, ext = ".mp4") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`DOWNLOAD_FAILED ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const p = join(tmpdir(), `pinflow_${Date.now()}${ext}`);
  await writeFile(p, buf);
  return { path: p, size: buf.length };
}

// poll Files API until ACTIVE
async function waitUntilActive(fileMgr, name, { tries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const f = await fileMgr.getFile(name);
    if (f?.state === "ACTIVE") return f;
    if (f?.state === "FAILED") throw new Error(`FILE_STATE_FAILED ${name}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`FILE_NOT_ACTIVE_TIMEOUT ${name}`);
}

// --- main scoring endpoint ----------------------------------
app.post("/score", async (req, res) => {
  const { resolved_url, niche } = req.body || {};
  if (!API_KEY) return bad(res, 500, "NO_API_KEY");
  if (!resolved_url || !niche) return bad(res, 400, "MISSING_FIELDS");

  const gen = new GoogleGenerativeAI(API_KEY);
  const files = new GoogleAIFileManager(API_KEY);

  let tmpPath = null;
  let uploaded = null;

  try {
    console.log("[REQ] /score url=%s", resolved_url);

    // 1) download to tmp
    const dl = await downloadToTmp(resolved_url, ".mp4");
    tmpPath = dl.path;
    console.log("[STEP] download ok bytes=%d", dl.size);

    // 2) upload file (path variant)
    console.log("[STEP] files.upload (path)");
    uploaded = await files.uploadFile(tmpPath, {
      mimeType: "video/mp4",
      displayName: `pinflow_${Date.now()}`
    });
    const fileName = uploaded?.file?.name;     // e.g. "files/abc123"
    const fileUri  = uploaded?.file?.uri;      // https URL
    if (!fileName || !fileUri) throw new Error("UPLOAD_MISSING_URI");

    // 3) WAIT until ACTIVE
    await waitUntilActive(files, fileName);
    console.log("[STEP] file ACTIVE name=%s", fileName);

    // 4) call model
    console.log("[MODEL] generate start");
    const resp = await gen.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{
        role: "user",
        parts: [
          { text: `Return a single integer 0–10 for how well this video fits the niche. Niche: "${niche}". Only return the number.` },
          { fileData: { fileUri, mimeType: "video/mp4" } }
        ]
      }],
      config: { temperature: 0.0 }
    });

    const txt = resp.text().trim();
    const n = Number(txt);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return ok(res, { score: "PARSE_FAILED" });
    }
    return ok(res, { score: String(n) });

  } catch (err) {
    console.error("[ERR]", err?.message || err);
    return ok(res, { score: "OTHER_FAILED" });
  } finally {
    // cleanup tmp + cloud file
    try { if (tmpPath) { await unlink(tmpPath); console.log("[STEP] temp deleted %s", tmpPath); } } catch {}
    try { if (uploaded?.file?.name) { await files.deleteFile(uploaded.file.name); console.log("[STEP] delete ok name=%s", uploaded.file.name); } } catch {}
  }
});

// (optional) old endpoints kept to avoid client 404s
app.post("/fetch-and-upload", (_req, res) => bad(res, 410, "MOVED_USE_/score"));
app.post("/delete-file", (_req, res) => ok(res, { ok: true }));

app.listen(PORT, () => {
  console.log(`pinflow-proxy up on :${PORT}`);
});
