// server.js  — ESM, Node 22+
//
// Fixes: r.body.pipe is not a function (uses arrayBuffer -> writeFile)
// Adds: file ACTIVE wait, tight error mapping, CORS, robust JSON shaping

import http from "node:http";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { GoogleGenerativeAI, GoogleAIFileManager } from "@google/generative-ai";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODEL = process.env.MODEL || "gemini-2.5-flash";

const genAI = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

const ok = (res, body) => json(res, 200, body);
const bad = (res, code, msg) => json(res, code, { error: msg });

function json(res, code, obj) {
  const txt = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(txt),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST,GET,OPTIONS",
  });
  res.end(txt);
}

function notFound(res) { bad(res, 404, "not_found"); }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchToFile(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      // Drive sometimes behaves better with a UA
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!r.ok) throw new Error(`download_non_200 ${r.status}`);
  const ab = await r.arrayBuffer();                    // <-- Web stream safe
  const tmp = join(tmpdir(), `pinflow_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.bin`);
  await writeFile(tmp, Buffer.from(ab));
  const mime = (r.headers.get("content-type") || "application/octet-stream").split(";")[0];
  return { path: tmp, mime, bytes: Buffer.byteLength(Buffer.from(ab)) };
}

async function waitFileActive(fileName, timeoutMs = 45000) {
  const start = Date.now();
  while (true) {
    // Use raw REST to avoid SDK gaps
    const metaUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(API_KEY)}`;
    const r = await fetch(metaUrl);
    const j = await r.json().catch(() => ({}));
    const state = j?.state || j?.file?.state;
    if (state === "ACTIVE") return j;
    if (Date.now() - start > timeoutMs) throw new Error("file_not_active_timeout");
    await sleep(1000);
  }
}

function buildPrompt(nicheBrief) {
  return `
You're scoring if a short video is relevant to this niche:

Niche brief:
${nicheBrief || "(none provided)"}

Score STRICTLY as JSON only:
{"score": <0-10>, "reason": "<1-2 sentences plain text>", "confidence": <0-100>}

- score: 0 (not related) … 10 (perfectly on-topic)
- reason: do NOT return JSON here; plain text sentence only.
- confidence: subjective certainty in the score (0–100).
Return ONLY that JSON object.`;
}

async function handleScore(req, res) {
  if (!API_KEY) return bad(res, 401, "API_KEY_INVALID");
  let body;
  try { body = await parseBody(req); }
  catch { return bad(res, 400, "bad_json"); }

  // accept both old and new keys
  const videoUrl = body.resolved_url || body.resolvedUrl || body.url || body.URL || body.link || body.video_url;
  const niche = body.niche || body.nicheBrief || "";

  if (!videoUrl) return bad(res, 400, "MISSING_FIELDS");

  try {
    console.log("[REQ] /score", "url=" + videoUrl);
    // 1) Download to temp file
    console.log("[STEP] download start", videoUrl);
    const dl = await fetchToFile(videoUrl);
    console.log("[STEP] download ok bytes=%d mime=%s", dl.bytes, dl.mime);

    // 2) Upload file
    console.log("[STEP] files.upload (path)");
    const up = await files.uploadFile(dl.path, {
      mimeType: dl.mime,
      displayName: "video",
    });
    const uploaded = up?.file || up; // SDK returns {file:{...}}
    const fileName = uploaded?.name;
    const fileUri  = uploaded?.uri;
    if (!fileName || !fileUri) throw new Error("upload_failed");

    // 3) Wait ACTIVE to avoid GEN_INTERNAL
    await waitFileActive(fileName);

    // 4) Ask model
    const model = genAI.getGenerativeModel({ model: MODEL });
    const prompt = buildPrompt(niche);
    const resp = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        { role: "user", parts: [{ fileData: { fileUri, mimeType: dl.mime } }] },
      ],
    });

    const text = (resp?.response?.text?.() ?? "").trim();
    const clean = text.replace(/^```json\s*|\s*```$/g, ""); // strip fences if any

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      // fallback: treat full text as reason if non-JSON
      parsed = { score: 0, reason: clean.slice(0, 500), confidence: 0 };
    }

    // normalize types
    const out = {
      score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : 0,
      reason: String(parsed.reason ?? "").slice(0, 500),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    };

    console.log("[OK] scored ->", out);
    ok(res, { ok: true, model: MODEL, result: out });
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("[ERR]", msg);
    bad(res, 500, msg.includes("download_non_200") ? "download_non_200"
         : msg.includes("file_not_active")        ? "file_not_active"
         : msg.includes("API key not valid")      ? "API_KEY_INVALID"
         : "GEN_INTERNAL");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return ok(res, { ok: true });

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("pinflow-proxy");
    return;
  }
  if (req.method === "GET" && req.url === "/selftest") return ok(res, { ok: true, text: "Ping!" });
  if (req.method === "GET" && req.url === "/health")   return ok(res, { ok: true, hasKey: !!API_KEY, model: MODEL });
  if (req.method === "GET" && req.url === "/diag")     return ok(res, { ok: true, keyLen: (API_KEY||"").length, model: MODEL });

  if (req.method === "POST" && req.url === "/score")   return handleScore(req, res);

  return notFound(res);
});

server.listen(PORT, () => {
  console.log(`[BOOT] node=${process.versions.node} model=${MODEL}`);
  console.log(`pinflow-proxy up on :${PORT}`);
});
