// ============================================
// ia-voice-npc-backend | index.js  v2
// Groq Whisper STT + Groq LLM + Edge TTS
// ============================================

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const Groq       = require("groq-sdk");
const multer     = require("multer");
const { exec }   = require("child_process");
const fs         = require("fs");
const path       = require("path");
const crypto     = require("crypto");

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Carpeta de audios públicos
const AUDIO_DIR = path.join(__dirname, "public", "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use("/audio", express.static(AUDIO_DIR));

// ============================================
// VOCES (Edge TTS - 100% gratis)
// ============================================
const VOICES = {
  hombre: "es-AR-TomasNeural",
  mujer:  "es-AR-ElenaNeural",
};

// ============================================
// GENERAR AUDIO CON EDGE TTS
// ============================================
function generateTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const fileName = crypto.randomBytes(8).toString("hex") + ".mp3";
    const filePath = path.join(AUDIO_DIR, fileName);

    // Limpiar texto
    const clean = text
      .replace(/[^\w\s áéíóúüñÁÉÍÓÚÜÑ¿¡.,!?;:-]/g, "")
      .replace(/"/g, "'")
      .trim();

    const cmd = `edge-tts --voice "${voice}" --text "${clean}" --write-media "${filePath}"`;

    exec(cmd, { timeout: 20000 }, (err) => {
      if (err || !fs.existsSync(filePath)) {
        return reject(err || new Error("Audio no generado"));
      }
      resolve(fileName);
    });
  });
}

// Limpiar audios viejos cada 10 minutos
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(AUDIO_DIR).forEach((f) => {
      const fp = path.join(AUDIO_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 5 * 60 * 1000) fs.unlinkSync(fp);
    });
  } catch {}
}, 10 * 60 * 1000);

// ============================================
// ENDPOINT: Transcripción de voz (Whisper)
// Acepta multipart/form-data con campo "file"
// ============================================
app.post("/v1/transcribe", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió audio" });

  try {
    // Guardar buffer temporalmente (Groq necesita un stream con nombre)
    const tmpPath = path.join(__dirname, `tmp_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const transcription = await groq.audio.transcriptions.create({
      file:     fs.createReadStream(tmpPath),
      model:    "whisper-large-v3",
      language: "es",
    });

    fs.unlinkSync(tmpPath);

    const text = (transcription.text || "").trim();
    console.log(`[STT] Transcripción: "${text}"`);

    return res.json({ transcript: text });

  } catch (err) {
    console.error("[STT Error]", err.message);
    return res.status(500).json({ error: "Error al transcribir" });
  }
});

// ============================================
// ENDPOINT: Chat con el NPC
// ============================================
app.post("/v1/npc/chat", async (req, res) => {
  const {
    npcName       = "Rulo",
    npcPersonality = "",
    playerText    = "",
    isProactive   = false,
    gender        = "hombre",
    history       = [],
  } = req.body;

  console.log(`[CHAT] "${playerText}" | Proactivo: ${isProactive}`);

  const voice = VOICES[gender] || VOICES.hombre;

  // System prompt
  const systemPrompt = `Sos ${npcName}, un NPC de un servidor GTA V roleplay argentino.
Personalidad: ${npcPersonality}.

REGLAS:
- Hablás siempre en español rioplatense (vos, che, boludo, pibe, etc.)
- Respuestas CORTAS: 1 a 3 oraciones máximo, naturales y directas
- Si el jugador te da una ORDEN, la obedecés y comentás algo al respecto
- Recordás lo que se habló antes
- Si es proactivo, arrancá conversación de forma casual y natural

ACCIONES DISPONIBLES (solo usar cuando el jugador te lo pide explícitamente):
- FOLLOW     → seguirte, ir con vos
- STOP       → parar, quedarse, esperar
- ATTACK     → atacar a alguien
- ENTER_VEHICLE → subirse al auto/vehículo
- EXIT_VEHICLE  → bajarse del auto
- NONE       → conversación normal

RESPONDÉ ÚNICAMENTE con este JSON (sin markdown, sin comillas extras):
{"texto":"lo que decís","accion":"NONE"}`;

  // Construir mensajes
  const messages = [{ role: "system", content: systemPrompt }];
  history.slice(-12).forEach(m => messages.push(m));

  if (isProactive) {
    messages.push({ role: "user", content: `[SISTEMA]: ${playerText}` });
  } else {
    messages.push({ role: "user", content: playerText });
  }

  try {
    // Groq LLM
    const completion = await groq.chat.completions.create({
      model:           "llama-3.3-70b-versatile",
      messages,
      max_tokens:      120,
      temperature:     0.88,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    const npcText  = (parsed.texto  || "¿Decías algo?").trim();
    const npcAction = (parsed.accion || "NONE").toUpperCase();

    console.log(`[LLM] ${npcName}: "${npcText}" | Acción: ${npcAction}`);

    // Edge TTS
    let audioUrl = "";
    try {
      const file = await generateTTS(npcText, voice);
      const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      audioUrl = `${base}/audio/${file}`;
    } catch (ttsErr) {
      console.error("[TTS Error]", ttsErr.message);
    }

    return res.json({ texto: npcText, accion: npcAction, audioUrl });

  } catch (err) {
    console.error("[LLM Error]", err.message);
    return res.status(500).json({
      texto:    "Se me trabó la lengua, preguntame de vuelta",
      accion:   "NONE",
      audioUrl: "",
    });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ============================================
// ARRANCAR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 NPC-AI Backend corriendo en puerto ${PORT}`);
  console.log(`   STT : Groq Whisper large-v3`);
  console.log(`   LLM : Groq llama-3.3-70b`);
  console.log(`   TTS : Edge TTS (${Object.values(VOICES).join(", ")})\n`);
});
