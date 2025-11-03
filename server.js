// server.js  — PinFlow proxy (ESM, Node ≥22)
// Single-file HTTP server with CORS, robust Google GenAI calls, and clear logs.

import http from "node:http";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

// ---------- config ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const ORIGIN = "*"; // CORS: allow AI Studio app

// ---------- utils ----------
const log = (...a) => console.log(...a);
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req
      .on("data", (c) => (data += c))
      .on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      })
      .on("error", reject);
  });
}
async function downloadToTemp(url) {
  log("[STEP] download start", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download_${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "pinflow_"));
  const filePath = join(dir, `${Date.now()}.bin`);
  await writeFile(filePath, buf);
  const ct = r.headers.get("content-type") || "application/octet-stream";
  log("[STEP] download ok bytes=%d mime=%s", buf.length, ct);
  return { filePath, mimeType: ct };
}
async function waitActive(fileMgr, name, maxMs = 30000) {
  const start = Date.now();
  for (;;) {
    const f = await fileMgr.getFile(name);
    if (f?.state === "ACTIVE") return f;
    if (f?.state === "FAILED") throw new Error("upload_failed");
    if (Date.now() - start > maxMs) throw new Error("upload_timeout");
    await new Promise((r) => setTimeout(r, 800));
  }
}
function parseNumeric(v, lo, hi, d = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}

// ---------- Google clients ----------
if (!API_KEY) {
  console.error("[BOOT] Missing API key (set API_KEY or GEMINI_API_KEY)");
}
const genai = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

// ---------- handlers ----------
async function handleSelftest(req, res) {
  return sendJson(res, 200, { ok: true, text: "Ping!" });
}
async function handleHealth(req, res) {
  return sendJson(res, 200, {
    ok: true,
    hasKey: Boolean(API_KEY),
    model: MODEL,
  });
}
async function handleRoot(req, res) {
  cors(res);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PinFlow proxy: OK");
}

async function handleScore(req, res) {
  let tmp;
  const started = Date.now();
  try {
    const body = await readJson(req);
    // accept both camelCase and snake_case
    const resolvedUrl = body.resolved_url || body.resolvedUrl || body.url;
    const niche = body.niche || body.nicheBrief || "";
    log("[REQ] /score url=%s", resolvedUrl);

    if (!resolvedUrl || typeof resolvedUrl !== "string") {
      return sendJson(res, 400, { error: "MISSING_FIELDS", need: ["resolved_url", "niche"] });
    }
    if (!API_KEY) return sendJson(res, 401, { error: "API_KEY_MISSING" });

    // 1) download
    const dl = await downloadToTemp(resolvedUrl);
    tmp = dl.filePath;

    // 2) upload to Google
    log("[STEP] files.upload (path)");
    const uploaded = await files.uploadFile(dl.filePath, {
      mimeType: dl.mimeType,
      displayName: `pinflow-${randomUUID()}`,
    });
    const meta = await waitActive(files, uploaded.file.name);
    const fileUri = meta.uri;
    const mimeType = meta.mimeType || dl.mimeType;

    // 3) build request
    const model = genai.getGenerativeModel({ model: MODEL });
    const generationConfig = {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    };
    const instruction =
      "You score whether the video matches the given niche. " +
      "Return JSON: {\"score\":0-10, \"reason\": string ≤160 chars, \"confidence\":0-100}. " +
      "Be strict and concise.";
    const parts = [
      { fileData: { fileUri, mimeType } },
      { text: `${instruction}\n\nNiche: ${niche}` },
    ];

    // 4) call model (retry once on GEN_INTERNAL)
    async function callGen() {
      const r = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
      });
      return r.response;
    }
    let response;
    try {
      response = await callGen();
    } catch (e) {
      const msg = (e?.message || "").toUpperCase();
      if (msg.includes("GEN_INTERNAL") || /HTTP_5\d\d/.test(msg)) {
        await new Promise((r) => setTimeout(r, 1200));
        response = await callGen(); // one retry
      } else {
        throw e;
      }
    }

    // 5) parse
    let raw = (response.text && response.text()) || "";
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      // fallback if model didn't honor JSON
      parsed = { score: null, reason: raw.slice(0, 200), confidence: null };
    }
    const score = parseNumeric(parsed.score, 0, 10, 0);
    const confidence = parseNumeric(parsed.confidence, 0, 100, null);
    const reason = (parsed.reason || "").toString();

    const result = { score, reason, confidence };
    log("[OK] scored in %dms -> %j", Date.now() - started, result);
    return sendJson(res, 200, { ok: true, model: MODEL, result });
  } catch (err) {
    // unwrap Google errors usefully
    const payload = {
      error: (err?.errorDetails?.[0]?.reason ||
        err?.statusText ||
        err?.message ||
        "GEN_INTERNAL"),
      details: err?.errorDetails || undefined,
    };
    log("[ERR] %o", payload);
    return sendJson(res, 500, payload);
  } finally {
    if (tmp) {
      try {
        await unlink(tmp);
      } catch {}
    }
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return handleRoot(req, res);
    if (req.method === "GET" && url.pathname === "/selftest") return handleSelftest(req, res);
    if (req.method === "GET" && url.pathname === "/health") return handleHealth(req, res);
    if (req.method === "POST" && url.pathname === "/score") return handleScore(req, res);

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    log("[FATAL]", e?.message || e);
    sendJson(res, 500, { error: "GEN_INTERNAL" });
  }
});

server.listen(PORT, () => {
  log(`[BOOT] node=${process.version} model=${MODEL}`);
  log(`pinflow-proxy up on :${PORT}`);
});
