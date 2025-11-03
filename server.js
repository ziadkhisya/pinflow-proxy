// server.js
import http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const MODEL_NAME = process.env.MODEL_NAME || "gemini-2.5-flash";
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
const files = API_KEY ? new GoogleAIFileManager(API_KEY) : null;

const log = (...args) => console.log(...args);

// --- CORS helpers ---
const setCORS = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
};

// --- tiny utils ---
const json = (res, code, obj) => {
  setCORS(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
};

const notFound = (res) => json(res, 404, { ok: false, error: "not_found" });

// save a web ReadableStream to disk
async function saveWebStreamToFile(webStream, filePath) {
  const nodeStream = Readable.fromWeb(webStream);
  const chunks = [];
  for await (const chunk of nodeStream) chunks.push(chunk);
  await writeFile(filePath, Buffer.concat(chunks));
}

// --- main scoring handler ---
async function handleScore(req, res) {
  if (!API_KEY || !genAI || !files) {
    return json(res, 401, { error: "API_KEY_INVALID" });
  }

  let body = "";
  for await (const chunk of req) body += chunk.toString();
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch {
    return json(res, 400, { error: "BAD_JSON" });
  }

  const url = data.resolved_url || data.resolvedUrl;
  const niche = data.niche || data.nicheBrief || "";
  if (!url || !niche) return json(res, 400, { error: "MISSING_FIELDS" });

  log("[REQ] /score url=%s", url);

  // 1) Download the video
  const r = await fetch(url);
  if (!r.ok || !r.body) return json(res, 502, { error: "DOWNLOAD_FAILED" });

  const tmpPath = `${tmpdir()}/pinflow_${Date.now()}_${randomUUID()}.mp4`;
  try {
    await saveWebStreamToFile(r.body, tmpPath);

    // 2) Upload to Gemini Files API
    const uploaded = await files.uploadFile(tmpPath, {
      mimeType: "video/mp4",
      displayName: "video.mp4",
    });

    // 3) Ask the model to score
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const prompt = `
You are a strict niche-matching judge.
Niche brief: """${niche}"""
Score the video 0–10 for niche fit. Return ONLY a JSON object:
{"score": <0-10 integer>, "reason": "<one sentence>", "confidence": "<low|med|high>"}
`;

    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: uploaded.file.uri, mimeType: "video/mp4" } },
            { text: prompt },
          ],
        },
      ],
    });

    const text = resp.response.text().trim();
    // soft-parse JSON
    let out = {};
    try { out = JSON.parse(text); } catch { out = { score: 0, reason: "bad_json", confidence: "low", raw: text }; }

    return json(res, 200, { ok: true, model: MODEL_NAME, ...out });
  } catch (e) {
    log("[ERR] %s", e?.stack || e);
    return json(res, 500, { error: "GEN_INTERNAL" });
  } finally {
    try { await unlink(tmpPath); } catch {}
  }
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Handle preflight for all routes
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.url === "/selftest") {
    return json(res, 200, { ok: true, text: "Ping!" });
  }
  if (req.url === "/health") {
    return json(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL_NAME });
  }
  if (req.url === "/diag") {
    return json(res, 200, { ok: true, keyLen: API_KEY.length, model: MODEL_NAME });
  }
  if (req.url === "/score" && req.method === "POST") {
    try { return await handleScore(req, res); }
    catch (e) { log("[score:unhandled]", e); return json(res, 500, { error: "GEN_INTERNAL" }); }
  }

  // Cosmetic message on /
  if (req.url === "/" && req.method === "GET") {
    return json(res, 200, { ok: true, name: "pinflow-proxy", status: "up" });
  }

  return notFound(res);
});

server.listen(PORT, () => {
  log(`[BOOT] node=${process.version} port=${PORT}`);
});
