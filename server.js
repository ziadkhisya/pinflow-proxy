import express from "express";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "100mb" }));

// CORS (browser → Render)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health checks
app.get("/", (_req, res) => res.send("pinflow-proxy OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, hasKey: !!process.env.GEMINI_API_KEY })
);

// Gemini client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("GEMINI_API_KEY not set (calls will fail).");
const ai = new GoogleGenerativeAI(apiKey);

// POST /fetch-and-upload  → { fileUri, mimeType }
app.post("/fetch-and-upload", async (req, res) => {
  try {
    const { resolved_url } = req.body || {};
    if (!resolved_url) return res.status(400).json({ error: "resolved_url required" });
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    // Download video bytes (must be a public direct-download link)
    const r = await fetch(resolved_url, {
      redirect: "follow",
      // Some Drive links behave better with a UA:
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) return res.status(502).json({ error: "FETCH_FAILED", status: r.status });

    const mimeType = r.headers.get("content-type") || "video/mp4";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) return res.status(502).json({ error: "FETCH_FAILED_EMPTY" });
    if (buf.length > 300 * 1024 * 1024) return res.status(413).json({ error: "FILE_TOO_LARGE" });

    // Upload to Gemini Files API
    const uploaded = await ai.files.upload({
      file: { data: buf, mimeType },
      displayName: `pinflow_${Date.now()}`
    });
    const fileUri = uploaded?.file?.uri;
    if (!fileUri) return res.status(502).json({ error: "UPLOAD_FAILED" });

    return res.json({ fileUri, mimeType });
  } catch (e) {
    console.error("fetch-and-upload error:", e?.message || e);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});

// POST /delete-file  ← { fileUri }
app.post("/delete-file", async (req, res) => {
  try {
    const { fileUri } = req.body || {};
    if (!fileUri) return res.status(400).json({ error: "fileUri required" });
    if (!apiKey) return res.status(500).json({ error: "NO_API_KEY" });

    await ai.files.delete({ fileUri });
    return res.json({ ok: true });
  } catch (e) {
    console.warn("delete-file error (non-fatal):", e?.message || e);
    return res.json({ ok: false, note: "delete failed (non-fatal)" });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("pinflow-proxy up on :" + PORT));
