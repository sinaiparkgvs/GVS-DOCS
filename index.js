// ================================
// index.js (API) - App Platform ready (ESM)
// ================================

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ESM equivalents of __filename / __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------
// 1) Load env (LOCAL only)
// --------------------------------
const envPath = path.join(__dirname, ".env");

// Optional debug
console.log("Process CWD:", process.cwd());
console.log("Index.js dir:", __dirname);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT from env:", process.env.PORT);

if (process.env.NODE_ENV !== "production") {
  // In locale proviamo a caricare .env se esiste (senza crashare se manca)
  if (fs.existsSync(envPath)) {
    const r = dotenv.config({ path: envPath });
    if (r.error) {
      console.error("❌ dotenv failed to load .env:", r.error);
    } else {
      console.log("✅ dotenv loaded (local). Keys:", Object.keys(r.parsed || {}));
    }
  } else {
    console.warn("⚠️ .env not found (local). Path:", envPath);
  }
} else {
  console.log("✅ Production mode: using App Platform Environment Variables (no .env).");
}

// --------------------------------
// 2) Validate required env vars (do NOT require .env file)
// --------------------------------
const REQUIRED_ENV = [
  "DATABASE_URL",
  "SPACES_KEY",
  "SPACES_SECRET",
  "SPACES_REGION",
  "SPACES_ENDPOINT",
  "SPACES_BUCKET",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k].trim() === "");
if (missing.length > 0) {
  // In produzione è meglio NON fare exit immediato: almeno /health risponde
  console.error("❌ Missing required env vars:", missing.join(", "));
  console.error("👉 Set them in DigitalOcean App Platform → Settings → Environment Variables");
}

// Helpful debug (do NOT print secrets)
console.log("SPACES_REGION:", process.env.SPACES_REGION);
console.log("SPACES_ENDPOINT:", process.env.SPACES_ENDPOINT);
console.log("SPACES_BUCKET:", process.env.SPACES_BUCKET);
console.log("DATABASE_URL present:", !!process.env.DATABASE_URL);
console.log("SPACES_KEY present:", !!process.env.SPACES_KEY);
console.log("SPACES_SECRET present:", !!process.env.SPACES_SECRET);

// --------------------------------
// 3) Create Express app
// --------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// --------------------------------
// 4) Health check (must always work)
// --------------------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "api",
    time: new Date().toISOString(),
    hasEnv: missing.length === 0,
    missingEnv: missing, // utile in debug, non contiene segreti
  });
});

// --------------------------------
// 5) DB (Postgres)
// --------------------------------
let pool = null;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "") {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: true, // su DO managed PG spesso serve
  });

  // Optional: quick DB test on startup (non blocca)
  (async () => {
    try {
      const r = await pool.query("SELECT now() as now");
      console.log("✅ DB connected. Server time:", r.rows[0].now);
    } catch (err) {
      console.error("❌ DB connection failed:", err?.message || err);
      // NON uscire: lascia /health vivo
    }
  })();
} else {
  console.warn("⚠️ DATABASE_URL not set: DB features disabled until env vars are configured.");
}

// --------------------------------
// 6) S3 client for DigitalOcean Spaces
// --------------------------------
let s3 = null;

const SPACES_REGION = (process.env.SPACES_REGION || "").trim();
const SPACES_ENDPOINT = (process.env.SPACES_ENDPOINT || "").trim();
const SPACES_BUCKET = (process.env.SPACES_BUCKET || "").trim();
const SPACES_KEY = (process.env.SPACES_KEY || "").trim();
const SPACES_SECRET = (process.env.SPACES_SECRET || "").trim();

if (SPACES_REGION && SPACES_ENDPOINT && SPACES_BUCKET && SPACES_KEY && SPACES_SECRET) {
  s3 = new S3Client({
    region: SPACES_REGION,
    endpoint: SPACES_ENDPOINT,
    credentials: {
      accessKeyId: SPACES_KEY,
      secretAccessKey: SPACES_SECRET,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
} else {
  console.warn("⚠️ Spaces env vars missing: Spaces features disabled until env vars are configured.");
}

// --------------------------------
// 7) QR endpoint
// --------------------------------
app.get("/IFU/:slug", async (req, res) => {
  try {
    if (!pool) return res.status(500).send("DB not configured (missing DATABASE_URL)");
    if (!s3) return res.status(500).send("Spaces not configured (missing SPACES_* env vars)");

    const slug = req.params.slug;

    // TODO: sostituisci con la tua query reale
    const query = `
      SELECT 'Products/02-800-CE - RPB Astro.pdf' as spaces_key
      LIMIT 1;
    `;
    const result = await pool.query(query /*, [slug]*/);

    if (result.rowCount === 0) return res.status(404).send("Document not found");

    const { spaces_key } = result.rows[0];

    const command = new GetObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: spaces_key,
    });

    const signedUrl = await getSignedUrl(s3, command, {
      expiresIn: 60 * 10,
      unhoistableHeaders: new Set(["x-amz-checksum-mode"]),
    });

    return res.redirect(302, signedUrl);
  } catch (err) {
    console.error("❌ /IFU/:slug error:", err);
    return res.status(500).send("Internal server error");
  }
});

// --------------------------------
// 8) Start server (App Platform)
// --------------------------------
const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ API listening on 0.0.0.0:${PORT}`);
});