import http from "node:http";
import { tmpdir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const MODEL = process.env.MODEL || "gemini-2.5-flash";

// Accept either env name
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY || "";
if (!API_KEY) {
  console.error("[BOOT] NO API KEY in env (API_KEY or GEMINI_API_KEY)");
} else {
  console.log(`[BOOT] node=${process.version} model=${MODEL}`);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const files = new GoogleAIFileManager(API_KEY);

const ok = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const bad = (res, code, msg, extra) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg, ...(extra || {}) }));
};

const readJsonBody = async (req) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch (e) { reject(e); }
    });
  });

async function downloadToTmp(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const p = join(tmpdir(), `pinflow_${Date.now()}.mp4`);
  await writeFile(p, buf);
  return { path: p, bytes: buf.length, mime };
}

async function uploadWithWait(path, mime) {
  const up = await files.uploadFile(path, { mimeType: mime, displayName: "pinflow-video" });
  const name = up.file?.name || up.name; // SDK shapes vary slightly
  const deadline = Date.now() + 30000;
  let state = "PROCESSING", last;
  while (Date.now() < deadline) {
    last = await files.getFile(name);
    state = last.state || last.file?.state || state;
    if (state === "ACTIVE") break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (state !== "ACTIVE") throw Object.assign(new Error("upload_timeout"), { state });
  const fileUri = (last.uri || last.file?.uri);
  return { name, uri: fileUri, state: "ACTIVE" };
}

function sanitizeReason(x) {
  let s = String(x ?? "");
  // If the model ever returns a JSON blob mistakenly inside reason, strip braces
  if (s.trim().startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (typeof j.reason === "string") s = j.reason;
    } catch { /* ignore */ }
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 240) s = s.slice(0, 240);
  return s;
}

async function handleScore(req, res) {
  let tmp = null;
  try {
    const body = await readJsonBody(req);
    const url = body.resolved_url || body.resolvedUrl;
    const niche = body.niche || body.nicheBrief || "";
    if (!url) return bad(res, 400, "MISSING_FIELDS", { need: ["resolved_url|resolvedUrl","niche|nicheBrief"] });

    console.log("[REQ] /score url=%s", url);
    const dl = await downloadToTmp(url);
    console.log("[STEP] download ok bytes=%d mime=%s", dl.bytes, dl.mime);
    tmp = dl.path;

    const up = await uploadWithWait(dl.path, dl.mime);
    // STRICT JSON schema + mime
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            score: { type: "integer" },
            reason: { type: "string" },
            confidence: { type: "integer" }
          },
          required: ["score","reason","confidence"]
        }
      }
    });

    const sys = [
      "You rate if the video matches the target niche.",
      "Return STRICT JSON ONLY with {score,reason,confidence}.",
      "score: 0..10 (10 = perfect on-topic).",
      "reason: <= 200 chars, one sentence, no JSON.",
      "confidence: 0..100 (how confident you are)."
    ].join(" ");

    const user = `Target niche brief:\n${niche}\nScoring task: Does this video belong to the niche?`;

    const resp = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          {fileData: { fileUri: up.uri, mimeType: dl.mime }},
          {text: `${sys}\n\n${user}`}
        ]
      }]
    });

    let text = resp.response.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      // emergency rescue: extract first {...}
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error("PARSE_FAIL");
    }

    let score = Math.max(0, Math.min(10, parseInt(parsed.score ?? 0, 10)));
    let confidence = Math.max(0, Math.min(100, parseInt(parsed.confidence ?? 0, 10)));
    let reason = sanitizeReason(parsed.reason);

    const result = { score, reason, confidence };
    console.log("[OK] scored -> %j", result);
    return ok(res, 200, { ok: true, model: MODEL, result });
  } catch (e) {
    const msg = e?.status === 400 && e?.statusText ? "GEN_400" : (e?.message || "GEN_INTERNAL");
    console.error("[ERR]", e);
    return ok(res, 500, { error: msg });
  } finally {
    if (tmp) { try { await rm(tmp, { force: true }); } catch {} }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && u.pathname === "/selftest") return ok(res, 200, { ok:true, text:"Ping!" });
  if (req.method === "GET" && u.pathname === "/health")  return ok(res, 200, { ok:true, hasKey: !!API_KEY, model: MODEL });
  if (req.method === "GET" && u.pathname === "/diag")    return ok(res, 200, { ok:true, keyLen: API_KEY.length, model: MODEL });

  if (req.method === "POST" && u.pathname === "/score")  return handleScore(req, res);

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Cannot " + req.method + " " + u.pathname);
});

server.listen(PORT, () => console.log(`pinflow-proxy up on :${PORT}`));
