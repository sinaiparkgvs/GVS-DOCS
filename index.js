// ================================
// index.js (API) - COMPLETE FILE
// ================================

// 1) Load .env BEFORE anything else (absolute path, ESM-safe)
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// ESM equivalents of __filename / __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to api/.env
const envPath = path.join(__dirname, ".env");

// Optional: show where we are running from
console.log("Process CWD:", process.cwd());
console.log("Index.js dir:", __dirname);
console.log("Looking for .env at:", envPath);

// Check .env exists
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file NOT FOUND at:", envPath);
  console.error("👉 Make sure you created it here: gvs-qr-docs/api/.env");
  process.exit(1);
}

// Load .env
const dotenvResult = dotenv.config({ path: envPath });

if (dotenvResult.error) {
  console.error("❌ dotenv failed to load .env:", dotenvResult.error);
  process.exit(1);
}

console.log("✅ dotenv loaded. Keys:", Object.keys(dotenvResult.parsed || {}));

// 2) Validate required env vars
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
  console.error("❌ Missing required env vars:", missing.join(", "));
  console.error("👉 Check api/.env format. Example:");
  console.error(`
SPACES_REGION=nyc3
SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
SPACES_BUCKET=gvs-docs
SPACES_KEY=xxxxx
SPACES_SECRET=yyyyy
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
`);
  process.exit(1);
}

// Helpful debug (do NOT print secrets)
console.log("SPACES_REGION:", process.env.SPACES_REGION);
console.log("SPACES_ENDPOINT:", process.env.SPACES_ENDPOINT);
console.log("SPACES_BUCKET:", process.env.SPACES_BUCKET);
console.log("DATABASE_URL present:", !!process.env.DATABASE_URL);
console.log("SPACES_KEY present:", !!process.env.SPACES_KEY);
console.log("SPACES_SECRET present:", !!process.env.SPACES_SECRET);

// 3) Imports after env is loaded
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// 4) Create Express app
const app = express();
app.use(cors());
app.use(express.json());

const caPath = path.join(__dirname, "certs", "ca-certificate.crt");
const ca = fs.readFileSync(caPath, "utf8");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true
});

// Optional: quick DB test on startup (comment out if you want)
(async () => {
  try {
    const r = await pool.query("SELECT now() as now");
    console.log("✅ DB connected. Server time:", r.rows[0].now);
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    // Do not exit if you want the app to still run /health
    // process.exit(1);
  }
})();


const SPACES_REGION = (process.env.SPACES_REGION || "").trim();
const SPACES_ENDPOINT = (process.env.SPACES_ENDPOINT || "").trim();
const SPACES_BUCKET = (process.env.SPACES_BUCKET || "").trim();
const SPACES_KEY = (process.env.SPACES_KEY || "").trim();
const SPACES_SECRET = (process.env.SPACES_SECRET || "").trim();

for (const [k, v] of Object.entries({
  SPACES_REGION, SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY, SPACES_SECRET
})) {
  if (!v) throw new Error(`Missing/empty ${k} (check api/.env formatting)`);
}


const s3 = new S3Client({
  region: SPACES_REGION,
  endpoint: SPACES_ENDPOINT,
  credentials: async () => ({   // ✅ bypassa la chain completamente
    accessKeyId: SPACES_KEY,
    secretAccessKey: SPACES_SECRET,
  }),
  requestChecksumCalculation: "WHEN_REQUIRED",   // ✅ disabilita checksum automatico
  responseChecksumValidation: "WHEN_REQUIRED",   // ✅ disabilita checksum automatico
});


// 7) Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "api", time: new Date().toISOString() });
});

// 8) QR endpoint: /m/:slug => lookup DB => presigned URL => redirect
app.get("/IFU/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;

    // Lookup "current" doc for this slug
    const query = `
      SELECT 'Products/02-800-CE - RPB Astro.pdf' as spaces_key
      LIMIT 1;
    `;

    const result = await pool.query(query);
    //const result = await pool.query(query, [slug]);

    if (result.rowCount === 0) {
      return res.status(404).send("Document not found");
    }

    const { spaces_key } = result.rows[0];

    // Create presigned GET URL (10 minutes)
    const command = new GetObjectCommand({
  Bucket: process.env.SPACES_BUCKET,
  Key: spaces_key, 
});

const signedUrl = await getSignedUrl(s3, command, {
  expiresIn: 60 * 10,
  unhoistableHeaders: new Set(["x-amz-checksum-mode"]),  // ✅ rimuove l'header
});

    // Redirect to signed URL
    return res.redirect(302, signedUrl);
  } catch (err) {
    console.error("❌ /m/:slug error:", err);
    return res.status(500).send("Internal server error");
  }
});

// 9) Start server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
});