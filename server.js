import http from "node:http";
import { tmpdir } from "node:os";
import { createWriteStream, promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, toFile } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
// Accept either name so AI Studio and Render env both work.
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";
const MODEL_ID = process.env.MODEL || "gemini-2.5-flash";

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

async function waitActive(fileMgr, fileId, timeoutMs = 30000) {
  const t0 = Date.now();
  while (true) {
    const f = await fileMgr.getFile(fileId);
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error("file_failed");
    if (Date.now() - t0 > timeoutMs) throw new Error("file_not_active_timeout");
    await new Promise((r) => setTimeout(r, 400));
  }
}

function normalizeModelText(resp) {
  const txt = resp?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return (txt || "").trim();
}
function extractResultObject(text) {
  let t = text.trim();
  // strip markdown fences
  if (t.startsWith("```")) {
    const i = t.indexOf("\n"); t = t.slice(i + 1);
    const j = t.lastIndexOf("```"); if (j !== -1) t = t.slice(0, j);
  }
  try { const obj = JSON.parse(t); if (obj && typeof obj === "object") return obj; } catch {}
  const m = t.match(/"score"\s*:\s*(\d+)[\s\S]*?"reason"\s*:\s*"([\s\S]*?)"[\s\S]*?"confidence"\s*:\s*(\d+)/i);
  if (m) return { score: +m[1], reason: m[2], confidence: +m[3] };
  return { score: 0, reason: t, confidence: 0 };
}

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

  // 2) upload
  const genAI = new GoogleGenerativeAI(API_KEY);
  const fileMgr = new GoogleAIFileManager(API_KEY);
  let uploaded;
  try {
    uploaded = await fileMgr.uploadFile(toFile(temp, "video/mp4"));
    await waitActive(fileMgr, uploaded.file.name);
    log("[STEP] upload ok id=%s", uploaded.file.name);
  } catch (e) {
    elog("[upload:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "upload_error" });
  }

  // 3) score
  let out = { score: 0, reason: "", confidence: 0 };
  try {
    const model = genAI.getGenerativeModel({ model: MODEL_ID });
    const system = `
You score short videos for niche fit. Output strict JSON:
{"score": <0..10>, "reason": "<1-2 sentence justification>", "confidence": <0..100>}
Only score high if the video clearly relates to the niche.
Niche brief:
${niche}
`.trim();

    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: system },
            { fileData: { fileUri: uploaded.file.uri, mimeType: "video/mp4" } }
          ]
        }
      ]
    });

    const text = normalizeModelText(resp);
    out = extractResultObject(text);
    log("[OK] scored -> %j", out);
  } catch (e) {
    elog("[gen:error]", e?.message || e);
    await fsp.rm(temp).catch(() => {});
    return fail(res, { error: "GEN_INTERNAL" });
  }

  await fsp.rm(temp).catch(() => {});
  ok(res, {
    ok: true,
    model: MODEL_ID,
    result: {
      score: Number(out.score) || 0,
      reason: String(out.reason || "").slice(0, 500),
      confidence: Number(out.confidence) || 0
    }
  });
}

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
