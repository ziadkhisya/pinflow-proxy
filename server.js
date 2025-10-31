import express from "express";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "100mb" }));

// CORS so your AI Studio app can call this server from the browser
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/", (req, res) => res.send("pinflow-proxy OK"));

// Env: set this on Render, do NOT hardcode
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("GEMINI_API_KEY not set (will fail calls).");
const ai = new GoogleGenerativeAI(apiKey);

// 1) Download bytes from Drive direct-download URL and upload to Gemini Files API
app.post("/fetch-and-upload", async (req, res) => {
  try {
    const { resolved_url } = req.body || {};
    if (!resolved_url) return res.status(400).json({ error: "resolved_url required" });

    // Download video bytes (the URL must be public direct-download)
    const r = await fetch(resolved_url, { redirect: "follow" });
    if (!r.ok) return res.status(502).json({ error: "FETCH_FAILED", status: r.status });
    const mimeType = r.headers.get("content-type") || "video/mp4";
    const arrayBuf = await r.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    if (bytes.length === 0) return res.status(502).json({ error: "FETCH_FAILED_EMPTY" });
    if (bytes.length > 300 * 1024 * 1024) return res.status(413).json({ error: "FILE_TOO_LARGE" }); // 300MB cap

    // Upload to Gemini Files API → returns file.uri
    const uploaded = await ai.files.upload({
      file: { data: bytes, mimeType },
      displayName: `pinflow_${Date.now()}`
    });
    const fileUri = uploaded?.file?.uri;
    if (!fileUri) return res.status(502).json({ error: "UPLOAD_FAILED" });

    return res.json({ fileUri, mimeType, bytes: bytes.length });
  } catch (e) {
    return res.status(500).json({ error: "SERVER_ERROR", message: String(e) });
  }
});

// 2) Delete the uploaded file on Gemini (cleanup)
app.post("/delete-file", async (req, res) => {
  try {
    const { fileUri } = req.body || {};
    if (!fileUri) return res.status(400).json({ error: "fileUri required" });

    // New SDK: files.delete needs fileUri
    await ai.files.delete({ fileUri });
    return res.json({ ok: true });
  } catch (e) {
    // Not fatal for you; just log and return ok
    console.warn("Delete failed:", e?.message || e);
    return res.json({ ok: false, note: "delete failed (non-fatal)" });
  }
});

// Render will set PORT
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("pinflow-proxy up on :" + PORT));
