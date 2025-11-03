// server.js  — pinflow-proxy (no external deps)
import http from "node:http";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
const MODEL  = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const json = (res, code, obj) => {
  res.writeHead(code, {"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(obj));
};

const bad = (res, msg, extra={}) => {
  console.error("[ERR]", msg, extra || "");
  json(res, 500, { ok:false, error: msg, ...("details" in extra ? {details:extra.details}: {}) });
};

const ok = (res, obj) => json(res, 200, { ok:true, ...obj });

const extFromMime = (mime) => {
  if (!mime) return ".bin";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("quicktime")) return ".mov";
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("x-msvideo") || mime.includes("avi")) return ".avi";
  return ".mp4"; // safest default for short social clips
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function downloadToBuffer(url) {
  console.log("[DL:start]", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`DOWNLOAD_FAILED ${r.status}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();

  // If Google Drive gives us an interstitial HTML page, bail early.
  if (ct.startsWith("text/html")) {
    const html = await r.text();
    throw Object.assign(new Error("DOWNLOAD_HTML"), { details: html.slice(0,512) });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  console.log("[DL:ok] bytes=", buf.length, "mime=", ct || "(none)");
  return { buf, mime: ct || "video/mp4" };
}

async function uploadFileToGemini(buf, mime, filename) {
  // IMPORTANT: exactly two parts: "file" (binary) and "metadata" (JSON)
  // and the binary *must* carry a real filename + correct Content-Type.
  const file = new File([buf], filename, { type: mime });

  const metaObj = { display_name: filename }; // snake_case per Files API
  const meta = new Blob([JSON.stringify(metaObj)], { type: "application/json; charset=UTF-8" });

  const form = new FormData();
  form.append("file", file);          // will carry Content-Type: <mime> with a filename
  form.append("metadata", meta);      // second and final part

  const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
  const r = await fetch(url, { method: "POST", body: form });
  if (!r.ok) {
    const text = await r.text().catch(()=> "");
    throw Object.assign(new Error("UPLOAD_FAILED " + r.status), { details: text });
  }
  const data = await r.json();
  // Response typically: { file: { name:"files/xxx", uri:"...", state:"PROCESSING", ... } }
  const fileObj = data.file || data;
  return fileObj;
}

async function waitActive(fileName, maxMs=45000) {
  const started = Date.now();
  while (true) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${API_KEY}`;
    const r = await fetch(url);
    const data = await r.json().catch(()=> ({}));
    const state = data.state || data.file?.state || "UNKNOWN";
    if (state === "ACTIVE") return data;             // ready
    if (state === "FAILED" || state === "DELETED") {
      throw new Error(`FILE_STATE_${state}`);
    }
    if (Date.now() - started > maxMs) {
      throw new Error("FILE_STATE_TIMEOUT");
    }
    await sleep(1000);
  }
}

function buildPrompt(niche) {
  return `You are a strict video relevance scorer.

Return ONLY a JSON object with this exact shape (no markdown, no prose):
{"score": <integer 0..10>, "reason": "<1-2 concise sentences>", "confidence": <integer 0..100>}

Scoring target (what the video must be about): ${niche}

Rules:
- If the clip has no clear tie to that topic, use score 0.
- Be conservative with confidence. No extra fields.`;
}

async function generateScore(fileUri, mime, niche) {
  const body = {
    contents: [{
      role: "user",
      parts: [
        { file_data: { file_uri: fileUri, mime_type: mime } },
        { text: buildPrompt(niche) }
      ]
    }],
    generationConfig: { temperature: 0 }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text().catch(()=> "");
    throw Object.assign(new Error("GEN_INTERNAL"), { details: text });
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join(" ").trim() || "";
  // Try to parse JSON robustly (strip fences if the model ignored the instruction)
  const m = text.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : "{}";
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const out = {
    score: Number.isFinite(+parsed.score) ? +parsed.score : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : (text || "No reason returned"),
    confidence: Number.isFinite(+parsed.confidence) ? +parsed.confidence : 0
  };
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", chunk => s += chunk);
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { method, url } = req;
    if (method === "GET" && url === "/") return ok(res, { name: "pinflow-proxy" });
    if (method === "GET" && url === "/health") return ok(res, { hasKey: !!API_KEY, model: MODEL });
    if (method === "GET" && url === "/diag") return ok(res, { keyLen: API_KEY.length, model: MODEL });

    if (method === "GET" && url.startsWith("/score")) {
      return json(res, 200, { ok:false, error:"USE_POST" });
    }

    if (method === "POST" && url.startsWith("/score")) {
      if (!API_KEY) return bad(res, "API_KEY_MISSING");

      const body = await readJson(req);
      const videoUrl = (body.resolved_url || body.url || "").trim();
      const niche = (body.niche || body.nicheBrief || "").trim();

      if (!videoUrl) return bad(res, "NO_URL");
      if (!niche)    return bad(res, "NO_NICHE");

      console.log("[REQ] /score url=", videoUrl, " nicheLen=", niche.length);

      // 1) Download
      const { buf, mime } = await downloadToBuffer(videoUrl);

      // 2) Upload (2-part multipart, proper filename + mime)
      const filename = "clip" + extFromMime(mime);
      const uploaded = await uploadFileToGemini(buf, mime, filename);

      // 3) Wait ACTIVE
      const name = uploaded.name || uploaded.file?.name || uploaded.id || "";
      const fileInfo = await waitActive(name);
      const fileUri = (fileInfo.uri || fileInfo.file?.uri || uploaded.uri);

      // 4) Generate score
      const result = await generateScore(fileUri, mime, niche);

      return ok(res, { model: MODEL, result });
    }

    json(res, 404, { ok:false, error:"NOT_FOUND" });
  } catch (e) {
    bad(res, e.message || "UNEXPECTED", { details: e.details || String(e) });
  }
});

server.listen(PORT, () => {
  console.log("[BOOT] node=" + process.version + " model=" + MODEL);
  console.log("pinflow-proxy up on :" + PORT);
});
