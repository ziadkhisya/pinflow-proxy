import http from "node:http";
import { tmpdir } from "node:os";
import { createWriteStream, promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { Blob } from "node:buffer";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";
const MODEL_ID = process.env.MODEL || "gemini-2.5-flash"; // same as before

// ---------- tiny helpers ----------
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
const ok = (res, b) => send(res, 200, b);
const bad = (res, b) => send(res, 400, b);
const fail = (res, b) => send(res, 500, b);

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

const log = (...xs) => console.log(...xs);
const elog = (...xs) => console.error(...xs);

// ---------- download from GDrive (or any URL) ----------
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

// ---------- REST upload to Gemini Files API ----------
async function uploadFile(path) {
  const buf = await fsp.readFile(path);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "video/mp4" }), "video.mp4");

  const u = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
  const r = await fetch(u, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload_not_ok:${r.status}`);
  return await r.json(); // { file: { name, uri, state } }
}

async function getFile(fileName) {
  const u = `https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileName)}?key=${API_KEY}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`file_get_not_ok:${r.status}`);
  return await r.json(); // { name, state, ... }
}

async function waitActive(fileName, timeoutMs = 30000) {
  const t0 = Date.now();
  while (true) {
    const f = await getFile(fileName);
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error("file_failed");
    if (Date.now() - t0 > timeoutMs) throw new Error("file_not_active_timeout");
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------- call generateContent ----------
async function genScore({ fileUri, niche }) {
  const systemText = `
You are scoring a short video for niche fit.

Niche brief:
${niche}

Return STRICT JSON only:
{"score": <0..10>, "reason": "<1-2 sentences>", "confidence": <0..100>}
`.trim();

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemText },
          { fileData: { fileUri, mimeType: "video/mp4" } }
        ]
      }
    ]
  };

  const u = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${API_KEY}`;
  const r = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`gen_not_ok:${r.status}`);
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  // try strict JSON; otherwise salvage numbers
  let out = { score: 0, reason: text, confidence: 0 };
  try {
    const parsed = JSON.parse(
      text.startsWith("```") ? text.replace(/```[\s\S]*?\n?|\n?```/g, "").trim() : text
    );
    if (parsed && typeof parsed === "object") out = parsed;
  } catch {
    const m = text.match(
      /"score"\s*:\s*(\d+)[\s\S]*?"reason"\s*:\s*"([\s\S]*?)"[\s\S]*?"confidence"\s*:\s*(\d+)/i
    );
    if (m) out = { score: +m[1], reason: m[2], confidence: +m[3] };
  }
  return {
    score: Number(out.score) || 0,
    reason: String(out.reason || "").slice(0, 500),
    confidence: Number(out.confidence) || 0
  };
}

// ---------- main handler ----------
async function handleScore(req, res) {
  let body;
  try { body = await readJson(req); } catch { return bad(res, { error: "bad_json" }); }

  const url = body.resolved_url || body.resolvedUrl || body.url || body.link || null;
  const niche = body.nicheBrief || body.niche || "";
  if (!url) return bad(res, { error: "missing_fields", need: ["resolved_url", "nicheBrief"] });
  if (!API_KEY) return fail(res, { error: "no_api_key" });

  log("[REQ] /score url=%s", url);

  // 1) download
  let temp;
  try {
    temp = await downloadToTemp(url);
    log("[STEP] download ok -> %s", temp);
  } catch (e) {
    elog("[download:error]", e?.message || e);
    return fail(res, { error: "network_error" });
  }

  // 2) upload + wait ACTIVE
  let file;
  try {
    const up = await uploadFile(temp);
    file = up.file;
    await waitActive(file.name);
    log("[STEP] upload ok id=%s", file.name);
  } catch (e) {
    elog("[upload:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "upload_error" });
  }

  // 3) score
  try {
    const result = await genScore({ fileUri: file.uri, niche });
    await fsp.rm(temp).catch(() => {});
    return ok(res, { ok: true, model: MODEL_ID, result });
  } catch (e) {
    elog("[gen:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "GEN_INTERNAL" });
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return ok(res, { ok: true });
    if (req.url === "/") return ok(res, { ok: true, name: "pinflow-proxy" });
    if (req.url === "/selftest") return ok(res, { ok: true, text: "Ping!" });
    if (req.url === "/diag") return ok(res, { ok: true, keyLen: (API_KEY || "").length, model: MODEL_ID });
    if (req.url === "/health") return ok(res, { ok: true, hasKey: !!API_KEY, model: MODEL_ID });
    if (req.url.startsWith("/score") && req.method === "POST") return handleScore(req, res);
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
