// server.js
import { createServer } from "http";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";
import path from "path";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
};
const clampInt = (n, min, max) => {
  n = Number.isFinite(+n) ? Math.round(+n) : min;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadToTemp(url) {
  console.log("[DL:start]", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`DOWNLOAD_FAILED ${r.status}`);
  const mime = r.headers.get("content-type") || "application/octet-stream";
  const ab = await r.arrayBuffer();
  const tmp = path.join(tmpdir(), `pinflow_${Date.now()}_${randomUUID()}.bin`);
  await writeFile(tmp, Buffer.from(ab));
  console.log("[DL:ok]", "bytes=", Buffer.byteLength(Buffer.from(ab)), "mime=", mime);
  return { tmp, mime };
}

// *** FIXED: use exactly TWO parts: file + mime_type. No display_name here. ***
async function uploadFile(filePath, mime) {
  const fd = new FormData();
  const buf = await readFile(filePath);
  fd.append("file", new Blob([buf]), "upload.bin");
  fd.append("mime_type", mime); // required, snake_case

  const r = await fetch(`${UPLOAD_BASE}/files`, {
    method: "POST",
    headers: { "X-Goog-Api-Key": API_KEY }, // put key in header
    body: fd,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`UPLOAD_FAILED ${r.status} ${t}`);
  }
  const j = await r.json(); // { name: "files/abc...", state: "PENDING"... }
  console.log("[UP:ok]", j.name, j.state || "UNKNOWN");
  return j;
}

async function waitActive(fileName, timeoutMs = 15000) {
  const start = Date.now();
  while (true) {
    const r = await fetch(`${API_BASE}/files/${encodeURIComponent(fileName)}?key=${API_KEY}`);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`FILES_GET_FAILED ${r.status} ${t}`);
    }
    const j = await r.json();
    const st = j.state || "STATE_UNKNOWN";
    console.log("[UP:wait]", "state=", st, "elapsed=", Date.now() - start, "ms");
    if (st === "ACTIVE") return j;
    if (Date.now() - start > timeoutMs) throw new Error("GEN_FILE_NOT_ACTIVE");
    await sleep(600);
  }
}

async function generateScore(fileUri, mime, niche) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "You are a strict rater. Score how relevant the video is to the niche brief on a 0–10 scale.\n" +
              'Return ONLY JSON with keys: {"score": int 0-10, "reason": string <=200 chars, "confidence": int 0-100}.\n' +
              "No prose, no markdown, no extra keys.",
          },
          { text: `Niche brief:\n${niche}` },
          { file_data: { file_uri: fileUri, mime_type: mime } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };

  const r = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GEN_CALL_FAILED ${r.status} ${t}`);
  }
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    try {
      obj = JSON.parse((text || "").trim().replace(/```(?:json)?/g, ""));
    } catch {
      obj = {};
    }
  }

  const score = clampInt(obj.score, 0, 10);
  const confidence = clampInt(obj.confidence, 0, 100);
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 200)
      : score === 0
      ? "No match with niche brief."
      : "Relevant.";

  console.log("[GEN:ok]", `score=${score} conf=${confidence}`);
  return { score, reason, confidence };
}

createServer(async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.end();

    if (req.url === "/") return json(res, 200, { ok: true, name: "pinflow-proxy" });
    if (req.url === "/health")
      return json(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL });
    if (req.url === "/diag")
      return json(res, 200, { ok: true, keyLen: API_KEY ? API_KEY.length : 0, model: MODEL });

    if (req.url === "/score" && req.method === "GET")
      return json(res, 405, { ok: false, error: "USE_POST" });

    if (req.url === "/score" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { ok: false, error: "BAD_JSON" });
      }

      const url = body.resolved_url || body.resolvedUrl || body.url;
      const niche = body.nicheBrief || body.niche || "";
      console.log("[REQ] /score", "url=", url, "nicheLen=", niche.length);

      if (!API_KEY) return json(res, 401, { ok: false, error: "API_KEY_MISSING" });
      if (!url || !niche) return json(res, 400, { ok: false, error: "MISSING_FIELDS", fields: Object.keys(body) });

      let tempPath, mime;
      try {
        const dl = await downloadToTemp(url);
        tempPath = dl.tmp;
        mime = dl.mime;

        const uploaded = await uploadFile(tempPath, mime);
        const fileMeta = await waitActive(uploaded.name);
        // safer fallback: uploaded.name is already "files/<id>"
        const fileUri = fileMeta?.uri || uploaded.name;

        const result = await generateScore(fileUri, mime, niche);
        return json(res, 200, { ok: true, model: MODEL, result });
      } catch (err) {
        const msg = String(err?.message || err);
        console.error("[ERR]", msg);

        let code = "GEN_INTERNAL";
        if (msg.includes("API key") || msg.includes("API_KEY_INVALID")) code = "API_KEY_INVALID";
        else if (msg.includes("GEN_FILE_NOT_ACTIVE")) code = "GEN_FILE_NOT_ACTIVE";
        else if (msg.startsWith("DOWNLOAD_FAILED")) code = "DOWNLOAD_FAILED";
        else if (msg.startsWith("UPLOAD_FAILED")) code = "UPLOAD_FAILED";
        else if (msg.startsWith("FILES_GET_FAILED")) code = "FILES_GET_FAILED";
        else if (msg.startsWith("GEN_CALL_FAILED")) code = "GEN_CALL_FAILED";

        return json(res, 500, { ok: false, error: code, details: msg });
      } finally {
        if (tempPath) try { await unlink(tempPath); } catch {}
      }
    }

    return json(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (e) {
    console.error("FATAL", e);
    return json(res, 500, { ok: false, error: "FATAL" });
  }
}).listen(PORT, () => {
  console.log("[BOOT]", "node=" + process.version, "model=" + MODEL);
  console.log("pinflow-proxy up on :" + PORT);
});
