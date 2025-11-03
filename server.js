// server.js  — pinflow proxy
// ESM only. Requires Node 22.16.x (you already pinned this in Render).

import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, toFile } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpFile = (ext = ".bin") =>
  path.join(os.tmpdir(), `pinflow_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

function bodyVal(obj, keys, def = undefined) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return def;
}

// ---------- health / diag ----------
app.get("/", (_req, res) => res.type("text/plain").send("pinflow-proxy up"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, hasKey: !!API_KEY })
);
app.get("/diag", (_req, res) =>
  res.json({ ok: true, node: process.version, env: { hasKey: !!API_KEY }, time: new Date().toISOString() })
);

// ---------- /score ----------
app.post("/score", async (req, res) => {
  try {
    console.log("[REQ] /score bodyKeys=%s", Object.keys(req.body || {}).join(","));

    if (!API_KEY) {
      console.error("[ERR] API_KEY_MISSING");
      return res.status(500).json({ error: "API_KEY_MISSING" });
    }

    // Accept both old and new client keys
    const resolvedUrl = bodyVal(req.body, ["resolved_url", "resolvedUrl", "url"]);
    const nicheBrief = bodyVal(req.body, ["niche", "nicheBrief", "brief"], "");

    if (!resolvedUrl) {
      console.error("[ERR] MISSING_FIELDS (resolvedUrl)");
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // ---- download to temp ----
    console.log("[STEP] download start url=%s", resolvedUrl);
    const resp = await fetch(resolvedUrl, { redirect: "follow" });
    if (!resp.ok) {
      console.error("[ERR] proxy_non_200 status=%s", resp.status);
      return res.status(500).json({ error: "proxy_non_200", status: resp.status });
    }
    const ab = await resp.arrayBuffer();
    const mime = resp.headers.get("content-type") || "video/mp4";
    const ext = mime.includes("mp4") ? ".mp4" : ".bin";
    const tmp = tmpFile(ext);
    await fs.writeFile(tmp, Buffer.from(ab));
    console.log("[STEP] download ok bytes=%d mime=%s tmp=%s", ab.byteLength, mime, tmp);

    const fm = new GoogleAIFileManager(API_KEY);
    console.log("[STEP] files.upload (path)");
    const up = await fm.uploadFile(toFile(tmp, mime), {
      mimeType: mime,
      displayName: path.basename(tmp),
    });

    let file = up.file || up;
    console.log("[STEP] upload ok name=%s state=%s uri=%s", file.name, file.state, file.uri);

    // ---- wait ACTIVE (poll up to 90s) ----
    const t0 = Date.now();
    while (file.state !== "ACTIVE" && Date.now() - t0 < 90_000) {
      await sleep(1000);
      file = await fm.getFile(file.name);
    }
    if (file.state !== "ACTIVE") {
      console.error("[ERR] FILE_NOT_ACTIVE state=%s", file.state);
      try { await fs.unlink(tmp).catch(() => {}); } catch {}
      try { await fm.deleteFile(file.name).catch(() => {}); } catch {}
      return res.status(500).json({ error: "FILE_NOT_ACTIVE" });
    }
    console.log("[STEP] file ACTIVE name=%s", file.name);

    // ---- model call ----
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL_ID,
      // Response is plain text "0".."10" to keep client unchanged
      generationConfig: { responseMimeType: "text/plain" },
    });

    const prompt = [
      "You score how well a video matches a target niche/topic.",
      "Niche brief:",
      nicheBrief || "(none provided)",
      "",
      "Rules:",
      "• Output a single integer 0..10 on the first line only. No words.",
      "• 0 = unrelated; 10 = perfectly on-topic.",
    ].join("\n");

    console.log("[MODEL] generate start model=%s", MODEL_ID);
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: file.uri, mimeType: mime } },
            { text: prompt },
          ],
        },
      ],
    });

    const text = (result?.response?.text?.() || "").trim();
    let score = Number.parseInt(text, 10);
    if (!Number.isFinite(score) || score < 0 || score > 10) score = 0;
    console.log("[DONE] score=%d", score);

    // ---- cleanup ----
    try { await fs.unlink(tmp); console.log("[CLEANUP] temp deleted %s", tmp); } catch {}
    try { await fm.deleteFile(file.name); console.log("[CLEANUP] delete ok name=%s", file.name); } catch {}

    return res.json({ ok: true, score });
  } catch (err) {
    console.error("[ERR] GEN_INTERNAL", err?.stack || err?.message || err);
    return res.status(500).json({ error: "GEN_INTERNAL" });
  }
});

// ---------- boot ----------
app.listen(PORT, () => {
  console.log("[BOOT] key=%s (len %d) node=%s", API_KEY.slice(0, 5) + "…", API_KEY.length, process.version);
  console.log(`pinflow-proxy up on :${PORT}`);
});

// last-chance logging
process.on("unhandledRejection", (e) => console.error("[UNHANDLED_REJECTION]", e));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT_EXCEPTION]", e));
