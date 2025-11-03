import express from "express";
import cors from "cors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("[BOOT] Missing API key (set API_KEY)");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const genAI = new GoogleGenerativeAI({ apiKey: API_KEY });
const files = new GoogleAIFileManager({ apiKey: API_KEY });

app.get("/", (_, res) => res.send("pinflow-proxy"));
app.get("/health", (_, res) => res.json({ ok: true }));

async function downloadToTemp(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const p = path.join(os.tmpdir(), `pinflow_${Date.now()}.mp4`);
  await fs.promises.writeFile(p, buf);
  return p;
}

app.post("/score", async (req, res) => {
  const { resolvedUrl, nicheBrief } = req.body || {};
  const id = Math.random().toString(16).slice(2, 10);

  try {
    if (!resolvedUrl || !nicheBrief) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    console.log(`[${id}] [REQ] /score url=${resolvedUrl} nicheLen=${nicheBrief.length}`);

    // 1) Download
    const temp = await downloadToTemp(resolvedUrl);
    console.log(`[${id}] [STEP] download ok bytes=${(await fs.promises.stat(temp)).size}`);

    // 2) Upload
    const up = await files.uploadFile(temp, {
      mimeType: "video/mp4",
      displayName: path.basename(temp)
    });
    const fileName = up?.file?.name || up?.name;                 // e.g. "files/abc123"
    const fileUri = `https://generativelanguage.googleapis.com/v1beta/${fileName}`;
    console.log(`[${id}] [STEP] file ACTIVE name=${fileName}`);

    // delete temp asap
    fs.promises.unlink(temp).catch(() => {});

    // 3) Score with 2.5-flash, return strict JSON
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = [
      "You rate how well a video matches the niche.",
      "Return STRICT JSON only: {\"score\":int(0-10),\"rationale\":string,\"confidence\":number(0-1)}.",
      "No prose, no backticks, no extra keys.",
      "",
      "Niche brief:",
      nicheBrief
    ].join("\n");

    const resp = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { fileData: { fileUri, mimeType: "video/mp4" } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    });

    const text =
      resp?.response?.text?.() ??
      resp?.text?.() ??
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "";

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    if (!parsed || typeof parsed.score === "undefined") {
      console.warn(`[${id}] [WARN] bad JSON:`, text.slice(0, 200));
      res.status(200).json({ score: "PARSE_FAILED", rationale: "BAD_JSON", confidence: 0 });
    } else {
      const score = Number(parsed.score);
      const rationale = String(parsed.rationale ?? "");
      const confidence = Number(parsed.confidence ?? 0);
      console.log(`[${id}] [DONE] score=${score}`);
      res.json({ score, rationale, confidence });
    }

    // 4) Cleanup on Gemini
    files.deleteFile(fileName).then(
      () => console.log(`[${id}] [CLEANUP] delete ok name=${fileName}`),
      (e) => console.warn(`[${id}] [CLEANUP] delete failed`, e?.message)
    );

  } catch (e) {
    console.error(`[${id}] [ERR]`, e?.message || e);
    res.status(500).json({ error: "GEN_INTERNAL" });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] node=${process.version}`);
  console.log(`pinflow-proxy up on :${PORT}`);
});
