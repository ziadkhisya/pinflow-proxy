import express from "express";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const app = express();
app.use(express.json({ limit: "100mb" }));

// Request log
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/", (_req, res) => res.send("pinflow-proxy OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, hasKey: !!process.env.GEMINI_API_KEY })
);

// Gemini clients
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("GEMINI_API_KEY not set (calls will fail).");
const ai = new GoogleGenerativeAI(apiKey);
const files = new GoogleAIFileManager(apiKey);

const isHtml = (ctype = "") => ctype.includes("text/html");

// POST /fetch-and-upload → { fileUri, fileName, mimeType }
app.post("/fetch-and-upload", async (req, res) => {
  let tmpPath = null;
  try {
    const { resolved_url } = req.body || {};
    if (!resolved_url) return res.status(400).json({ error: "resolved_url required" });
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    console.log("[STEP] Download start:", resolved_url);
    const r = await fetch(resolved_url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) {
      console.error("[ERR] DRIVE_FETCH_FAILED status:", r.status);
      return res.status(502).json({ error: "FETCH_FAILED", status: r.status });
    }

    const mimeType = r.headers.get("content-type") || "video/mp4";
    if (isHtml(mimeType)) {
      const peek = (await r.text()).slice(0, 200);
      console.error("[ERR] DRIVE_HTML_PAGE (quota/scan). Peek:", peek);
      return res.status(502).json({ error: "DRIVE_HTML_PAGE", peek });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    console.log("[STEP] Download ok, bytes:", buf.length, "mime:", mimeType);
    if (buf.length === 0) return res.status(502).json({ error: "FETCH_FAILED_EMPTY" });
    if (buf.length > 300 * 1024 * 1024) return res.status(413).json({ error: "FILE_TOO_LARGE" });

    // ✅ Write to temp file (Render allows /tmp)
    const base = `pinflow_${Date.now()}.mp4`;
    tmpPath = path.join("/tmp", base);
    await fs.writeFile(tmpPath, buf);
    console.log("[STEP] Wrote temp file:", tmpPath);

    // Upload by file path
    console.log("[STEP] Gemini upload via FileManager.uploadFile (path)");
    const uploaded = await files.uploadFile(tmpPath, {
      mimeType,
      displayName: base
    });

    const fileUri  = uploaded?.file?.uri || null;   // for generateContent
    const fileName = uploaded?.file?.name || null;  // for deletion
    if (!fileUri) {
      console.error("[ERR] No fileUri returned");
      return res.status(502).json({ error: "UPLOAD_FAILED_NO_URI" });
    }

    console.log("[STEP] Upload ok, fileUri:", fileUri, "fileName:", fileName);
    return res.json({ fileUri, fileName, mimeType });
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("[ERR] SERVER_ERROR:", msg);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  } finally {
    // Clean temp file
    if (tmpPath) {
      try { await fs.unlink(tmpPath); console.log("[STEP] Temp deleted:", tmpPath); }
      catch { /* ignore */ }
    }
  }
});

// POST /delete-file ← { fileUri?, fileName? }  (best-effort)
app.post("/delete-file", async (req, res) => {
  try {
    const { fileUri, fileName } = req.body || {};
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    const target = fileName || fileUri;
    if (!target) return res.status(400).json({ error: "fileName or fileUri required" });

    try {
      await files.deleteFile(target);
      console.log("[STEP] deleteFile ok:", target);
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[WARN] deleteFile failed (non-fatal):", e?.message || e);
      return res.json({ ok: false, note: "delete failed (non-fatal)" });
    }
  } catch (e) {
    console.warn("[WARN] delete-file handler error (non-fatal):", e?.message || e);
    return res.json({ ok: false, note: "delete failed (non-fatal)" });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("pinflow-proxy up on :" + PORT));
