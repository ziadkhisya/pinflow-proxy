// server.js — Node 22+, ESM

import http from "node:http";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT  = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY =
  process.env.API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const MODEL = process.env.MODEL || "gemini-2.5-flash";

const genAI = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ok  = (res, obj) => send(res, 200, obj);
const err = (res, code, msg) => send(res, code, { error: msg });

function send(res, code, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST,GET,OPTIONS"
  });
  res.end(text);
}

function notFound(res) { err(res, 404, "not_found"); }

function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function fetchToFile(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36"
    }
  });
  if (!r.ok) throw new Error(`download_non_200 ${r.status}`);

  // Web stream in Node 22 — use arrayBuffer, not .pipe()
  const ab   = await r.arrayBuffer();
  const buf  = Buffer.from(ab);
  const file = join(tmpdir(), `pinflow_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.bin`);
  await writeFile(file, buf);
  const mime = (r.headers.get("content-type") || "application/octet-stream").split(";")[0];
  return { path: file, mime, bytes: buf.length };
}

async function waitActive(name, timeoutMs = 45000) {
  const start = Date.now();
  while (true) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(API_KEY)}`;
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    const state = j?.state || j?.file?.state;
    if (state === "ACTIVE") return;
    if (Date.now() - start > timeoutMs) throw new Error("file_not_active_timeout");
    await sleep(1000);
  }
}

function promptFor(niche) {
  return `
You're scoring if a short video is relevant to this niche:

Niche brief:
${niche || "(none provided)"}

Return ONLY this JSON (no code fences):
{"score": <0-10>, "reason": "<1-2 sentences plain text>", "confidence": <0-100>}
`;
}

async function handleScore(req, res) {
  if (!API_KEY) return err(res, 401, "API_KEY_INVALID");

  let body;
  try { body = await parseJSON(req); }
  catch { return err(res, 400, "bad_json"); }

  const videoUrl = body.resolved_url || body.resolvedUrl || body.url || body.video_url || body.link;
  const niche    = body.niche || body.nicheBrief || "";

  if (!videoUrl) return err(res, 400, "MISSING_FIELDS");

  try {
    console.log("[REQ] /score", videoUrl);

    // 1) download
    console.log("[STEP] download start");
    const dl = await fetchToFile(videoUrl);
    console.log("[STEP] download ok bytes=%d mime=%s", dl.bytes, dl.mime);

    // 2) upload
    console.log("[STEP] files.upload");
    const up = await files.uploadFile(dl.path, {
      mimeType: dl.mime,
      displayName: "video"
    });
    const uploaded = up?.file || up;
    const fileName = uploaded?.name;
    const fileUri  = uploaded?.uri;
    if (!fileName || !fileUri) throw new Error("upload_failed");

    // 3) wait ACTIVE (prevents GEN_INTERNAL)
    await waitActive(fileName);

    // 4) score
    const model  = genAI.getGenerativeModel({ model: MODEL });
    const prompt = promptFor(niche);

    const resp = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        { role: "user", parts: [{ fileData: { fileUri, mimeType: dl.mime } }] }
      ]
    });

    const raw = (resp?.response?.text?.() ?? "").trim();
    const clean = raw.replace(/^```json\s*|\s*```$/g, "");
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { score: 0, reason: clean.slice(0, 500), confidence: 0 }; }

    const out = {
      score: Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : 0,
      reason: String(parsed.reason ?? "").slice(0, 500),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0
    };

    console.log("[OK] scored ->", out);
    ok(res, { ok: true, model: MODEL, result: out });
  } catch (e) {
    const m = String(e?.message || e);
    console.error("[ERR]", m);
    err(
      res,
      500,
      m.includes("download_non_200") ? "download_non_200"
      : m.includes("file_not_active") ? "file_not_active"
      : m.includes("API key not valid") ? "API_KEY_INVALID"
      : "GEN_INTERNAL"
    );
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
