import express from "express";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "100mb" }));

// === Request log (so Render Logs show every call) ===
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// === CORS (browser → Render) ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// === Health ===
app.get("/", (_req, res) => res.send("pinflow-proxy OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, hasKey: !!process.env.GEMINI_API_KEY })
);

// === Gemini client ===
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("GEMINI_API_KEY not set (calls will fail).");
const ai = new GoogleGenerativeAI(apiKey);

// Helper: detect Drive HTML interstitials
const isHtml = (ctype = "") => ctype.includes("text/html");

// === /fetch-and-upload → { fileUri, mimeType } or detailed error ===
app.post("/fetch-and-upload", async (req, res) => {
  try {
    const { resolved_url } = req.body || {};
    if (!resolved_url) return res.status(400).json({ error: "resolved_url required" });
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    console.log("[STEP] Download start:", resolved_url);
    const r = await fetch(resolved_url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" } // helps with Drive
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

    // Upload to Gemini Files API (try files.upload, fallback uploadFile)
    let fileUri = null;
    try {
      console.log("[STEP] Gemini upload via files.upload");
      const up1 = await ai.files.upload({
        file: { data: buf, mimeType },
        displayName: `pinflow_${Date.now()}`
      });
      fileUri = up1?.file?.uri || null;
    } catch (e) {
      console.warn("[WARN] files.upload failed:", e?.message || e);
      try {
        console.log("[STEP] Gemini upload via uploadFile (fallback)");
        const up2 = await ai.uploadFile({
          file: { data: buf, mimeType },
          displayName: `pinflow_${Date.now()}`
        });
        fileUri = up2?.file?.uri || null;
      } catch (e2) {
        const msg = String(e2?.message || e2);
        console.error("[ERR] uploadFile failed:", msg);
        if (/invalid api key|unauthorized/i.test(msg)) {
          return res.status(401).json({ error: "INVALID_API_KEY" });
        }
        if (/quota|rate/i.test(msg)) {
          return res.status(429).json({ error: "QUOTA_EXCEEDED" });
        }
        return res.status(502).json({ error: "UPLOAD_FAILED", message: msg });
      }
    }

    if (!fileUri) {
      console.error("[ERR] No fileUri returned from Gemini");
      return res.status(502).json({ error: "UPLOAD_FAILED_NO_URI" });
    }

    console.log("[STEP] Upload ok, fileUri:", fileUri);
    return res.json({ fileUri, mimeType });
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("[ERR] SERVER_ERROR:", msg);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

// === /delete-file ← { fileUri } ===
app.post("/delete-file", async (req, res) => {
  try {
    const { fileUri } = req.body || {};
    if (!fileUri) return res.status(400).json({ error: "fileUri required" });
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    try {
      await ai.files.delete({ fileUri });
      console.log("[STEP] files.delete ok", fileUri);
    } catch (e) {
      console.warn("[WARN] files.delete failed, trying deleteFile:", e?.message || e);
      try {
        await ai.deleteFile({ fileUri });
        console.log("[STEP] deleteFile ok", fileUri);
      } catch (e2) {
        console.warn("[WARN] deleteFile failed (non-fatal):", e2?.message || e2);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    console.warn("[WARN] delete-file handler error (non-fatal):", e?.message || e);
    return res.json({ ok: false, note: "delete failed (non-fatal)" });
  }
});

// === Start ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("pinflow-proxy up on :" + PORT));
