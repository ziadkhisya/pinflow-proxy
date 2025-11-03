import http from "node:http";
import { tmpdir } from "node:os";
import { createWriteStream, promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, toFile } from "@google/generative-ai/server";

// ---- config ----
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";
const MODEL_ID = process.env.MODEL || "gemini-2.5-flash";

// ---- helpers ----
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...headers
  });
  res.end(JSON.stringify(body));
};

const ok = (res, body) => send(res, 200, body);
const bad = (res, body) => send(res, 400, body);
const fail = (res, body) => send(res, 500, body);

const readJson = async (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const log = (...xs) => console.log(...xs);
const elog = (...xs) => console.error(...xs);

// Download to temp file
async function downloadToTemp(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_not_ok:${r.status}`);
  const name = basename(new URL(url).pathname || "video.mp4") || "video.mp4";
  const p = join(tmpdir(), `pinflow_${Date.now()}_${name}`);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(p);
    r.body.pipe(out);
    r.body.on("error", reject);
    out.on("finish", resolve);
  });
  return p;
}

// Wait for Gemini file ACTIVE
async function waitActive(fileMgr, fileId, timeoutMs = 30000) {
  const start = Date.now();
  while (true) {
    const f = await fileMgr.getFile(fileId);
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error("file_failed");
    if (Date.now() - start > timeoutMs) throw new Error("file_not_active_timeout");
    await new Promise((r) => setTimeout(r, 400));
  }
}

function normalizeModelText(resp) {
  const txt =
    resp?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return (txt || "").trim();
}

// Try to coerce model text to clean JSON object
function extractResultObject(text) {
  let t = text.trim();

  // strip fences if present
  if (t.startsWith("```")) {
    const i = t.indexOf("\n");
    t = t.slice(i + 1);
    const lastFence = t.lastIndexOf("```");
    if (lastFence !== -1) t = t.slice(0, lastFence);
  }

  // sometimes it returns stringified JSON inside a field
  try {
    const obj = JSON.parse(t);
    if (typeof obj === "object" && obj) return obj;
  } catch (_) {
    // fall through
  }

  // heuristics: pull out {"score":...,"reason":...,"confidence":...}
  const m = t.match(/"score"\s*:\s*(\d+)[\s\S]*?"reason"\s*:\s*"([\s\S]*?)"[\s\S]*?"confidence"\s*:\s*(\d+)/i);
  if (m) {
    return { score: Number(m[1]), reason: m[2], confidence: Number(m[3]) };
  }

  // last resort: return plain text as reason with score 0
  return { score: 0, reason: t, confidence: 0 };
}

// ---- core scoring ----
async function handleScore(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return bad(res, { error: "bad_json" });
  }

  const url =
    body.resolved_url || body.resolvedUrl || body.url || body.link || null;
  const niche = body.nicheBrief || body.niche || "";

  if (!url) return bad(res, { error: "missing_fields", need: ["resolved_url", "nicheBrief"] });
  if (!API_KEY) return fail(res, { error: "no_api_key" });

  log("[REQ] /score url=%s", url);

  // 1) download
  let temp;
  try {
    temp = await downloadToTemp(url);
  } catch (e) {
    elog("[download:error]", e?.message || e);
    return fail(res, { error: "network_error" });
  }

  // 2) upload
  const genAI = new GoogleGenerativeAI(API_KEY);
  const fileMgr = new GoogleAIFileManager(API_KEY);

  let uploaded;
  try {
    uploaded = await fileMgr.uploadFile(toFile(temp, "video/mp4"));
    await waitActive(fileMgr, uploaded.file.name); // poll ACTIVE
  } catch (e) {
    elog("[upload:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "upload_error" });
  }

  // 3) score
  let resultObj = { score: 0, reason: "", confidence: 0 };
  try {
    const model = genAI.getGenerativeModel({ model: MODEL_ID });

    const system = `
You are scoring short videos for niche fit. Output strict JSON:
{"score": <0..10>, "reason": "<1-2 sentence justification>", "confidence": <0..100>}
Score high ONLY if the video visibly/clearly relates to the niche.
Current niche brief:
${niche}
    `.trim();

    const resp = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: system }, { fileData: { fileUri: uploaded.file.uri, mimeType: "video/mp4" } }] }
      ]
    });

    const text = normalizeModelText(resp);
    resultObj = extractResultObject(text);
  } catch (e) {
    elog("[gen:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "GEN_INTERNAL" });
  }

  // 4) cleanup + return
  await fsp.rm(temp).catch(() => {});
  ok(res, {
    ok: true,
    model: MODEL_ID,
    result: {
      score: Number(resultObj.score) || 0,
      reason: String(resultObj.reason || "").slice(0, 500),
      confidence: Number(resultObj.confidence) || 0
    }
  });
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return ok(res, { ok: true });
    if (req.url === "/") return ok(res, { ok: true, name: "pinflow-proxy" });
    if (req.url === "/selftest") return ok(res, { ok: true, text: "Ping!" });
    if (req.url === "/diag")
      return ok(res, { ok: true, keyLen: (API_KEY || "").length, model: MODEL_ID });
    if (req.url === "/health")
      return ok(res, { ok: true, hasKey: !!API_KEY, model: MODEL_ID });

    if (req.url.startsWith("/score") && req.method === "POST") {
      return handleScore(req, res);
    }

    send(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    elog("[server:error]", e);
    fail(res, { error: "server_error" });
  }
});

server.listen(PORT, () => {
  console.log(`[BOOT] node=${process.version} model=${MODEL_ID}`);
  console.log(`pinflow-proxy up on :${PORT}`);
});
