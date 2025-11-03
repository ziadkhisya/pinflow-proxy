// server.js (PinFlow proxy) – 2025-11-03
// ESM-only. Node >= 20.10. Uses native fetch and @google/generative-ai.

import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT  = Number(process.env.PORT || 10000);
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const API_KEY = (process.env.API_KEY || process.env.GEMINI_API_KEY || "").trim();

function jres(res, code, data) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function bad(res, code, msg) {
  jres(res, code, { error: msg });
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function downloadToTemp(url) {
  console.log("[STEP] download start %s", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download_non_200 ${r.status}`);
  const mime = r.headers.get("content-type") || "video/mp4";
  const p = pathJoin(tmpdir(), `pinflow_${Date.now()}.mp4`);
  const ws = createWriteStream(p);
  // Convert WHATWG stream to Node stream
  const rs = Readable.fromWeb(r.body);
  await pipeline(rs, ws);
  const stat = await fs.stat(p);
  console.log("[STEP] download ok bytes=%d mime=%s", stat.size, mime);
  return { path: p, mime };
}

// Wait until uploaded file becomes ACTIVE
async function waitForActive(fm, name, { pollMs = 900, maxMs = 60000 } = {}) {
  const t0 = Date.now();
  while (true) {
    const f = await fm.getFile(name);
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error(`file_failed ${f.stateMessage || "unknown"}`);
    if (Date.now() - t0 > maxMs) throw new Error(`file_not_active_timeout state=${f.state}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const server = createServer(async (req, res) => {
  try {
    // Simple routing
    if (req.method === "GET" && req.url === "/selftest") {
      return jres(res, 200, { ok: true, text: "Ping" });
    }
    if (req.method === "GET" && req.url === "/health") {
      return jres(res, 200, { ok: true, hasKey: Boolean(API_KEY), model: MODEL });
    }
    if (req.method === "GET" && req.url === "/diag") {
      return jres(res, 200, { ok: true, keyLen: API_KEY.length, model: MODEL });
    }

    if (req.method === "POST" && req.url === "/score") {
      if (!API_KEY) return bad(res, 401, "API_KEY_INVALID");

      // Accept both naming styles from the app
      const body = await getBody(req);
      const resolvedUrl = body.resolved_url || body.resolvedUrl || body.url;
      const nicheBrief = body.nicheBrief || body.niche || "";

      console.log("[REQ] /score bodyKeys=%s", Object.keys(body).join(","));
      if (!resolvedUrl) return bad(res, 400, "MISSING_FIELDS");

      // Download
      const { path: tmpPath, mime } = await downloadToTemp(resolvedUrl);

      // Upload -> wait ACTIVE
      const fm = new GoogleAIFileManager(API_KEY);
      console.log("[STEP] files.upload (path)");
      const up = await fm.uploadFile(tmpPath, {
        mimeType: mime,
        displayName: `pinflow_${Date.now()}.mp4`,
      });
      console.log("[STEP] files.upload name=%s state=%s", up.file.name, up.file.state);

      const active = await waitForActive(fm, up.file.name);
      console.log("[STEP] file ACTIVE uri=%s", active.uri);

      // Generate
      const genAI = new GoogleGenerativeAI(API_KEY);
      const model = genAI.getGenerativeModel({ model: MODEL });

      const prompt =
        `You are scoring TikTok/short videos for niche fit.\n` +
        `Niche brief: """${nicheBrief}"""\n` +
        `Return ONLY this compact line (no JSON):\n` +
        `score=<0-10>; reason=<<=160 chars plain sentence>; confidence=<low|med|high>`;

      const resp = await model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { fileData: { fileUri: active.uri, mimeType: mime } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.2 },
      });

      const text = resp.response.text();
      console.log("[STEP] model ok len=%d", (text || "").length);

      // Cleanup the temp file, ignore errors
      try { await fs.unlink(tmpPath); console.log("[CLEANUP] temp deleted %s", tmpPath); } catch {}

      // Contract: return plain data the Studio app can parse
      return jres(res, 200, { ok: true, text });
    }

    // Fallback
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Cannot GET " + req.url);
  } catch (err) {
    console.error("[ERR]", err);
    return bad(res, 500, "GEN_INTERNAL");
  }
});

server.listen(PORT, () => {
  console.log(`[BOOT] node=${process.version}`);
  console.log("pinflow-proxy up on :" + PORT);
});
