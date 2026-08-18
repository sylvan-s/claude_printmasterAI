import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

function fixConnectionString(url?: string): string | undefined {
  if (!url) return url;
  if (url.includes("%3F")) return url;

  try {
    const match = url.match(/^(postgres(?:ql)?:\/\/)([^:]+):(.*)@([^@]+)$/);
    if (match) {
      const [_, proto, user, pwd, hostDb] = match;
      const encodedPwd = encodeURIComponent(pwd);
      return `${proto}${user}:${encodedPwd}@${hostDb}`;
    }
  } catch (err) {
    console.error("Failed to auto-encode database URL password:", err);
  }
  return url;
}

const rawDbUrl = process.env.DATABASE_URL;
const dbUrl = fixConnectionString(rawDbUrl);

export const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : undefined,
});

// Prevent unhandled error event crashes from idle database connections
pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err);
});


export async function initDatabase() {
  if (!dbUrl) {
    console.warn("⚠️ DATABASE_URL is not defined. PostgreSQL integration is offline.");
    return;
  }

  console.log("Connecting to PostgreSQL database to initialize schema...");
  const client = await pool.connect();
  try {
    // Check if the 'users' table already exists
    const checkTableQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `;
    const checkRes = await client.query(checkTableQuery);
    const tableExists = checkRes.rows[0].exists;

    if (!tableExists) {
      console.log("Schema 'users' table not found. Initializing database schema from schema.sql...");
      const schemaPath = path.join(process.cwd(), "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, "utf8");
        await client.query(schemaSql);
        console.log("✓ Database schema initialized successfully!");
      } else {
        console.error("❌ schema.sql file not found in workspace root. Skipping database setup.");
      }
    } else {
      console.log("✓ PostgreSQL database schema is already initialized.");
    }

    // Run migrations
    console.log("Running schema migrations...");
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('seller', 'buyer', 'curator', 'admin'));
    `);

    await client.query(`
      UPDATE users
      SET role = 'admin'
      WHERE email = 'sylvan_sitkey@hotmail.com';
    `);

    await client.query(`
      ALTER TABLE appraisal_methods
      ADD COLUMN IF NOT EXISTS stage1_model        TEXT,
      ADD COLUMN IF NOT EXISTS stage2_model        TEXT,
      ADD COLUMN IF NOT EXISTS stage2a_model       TEXT,
      ADD COLUMN IF NOT EXISTS stage2b_model       TEXT,
      ADD COLUMN IF NOT EXISTS stage3_model        TEXT,
      ADD COLUMN IF NOT EXISTS stage1b_model       TEXT,
      ADD COLUMN IF NOT EXISTS enable_visual_search BOOLEAN NOT NULL DEFAULT true;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS appraisal_methods (
          id                      TEXT PRIMARY KEY,
          name                    TEXT NOT NULL,
          description             TEXT,
          model_name              TEXT NOT NULL,
          temperature             REAL NOT NULL,
          prompt_key              TEXT NOT NULL,
          prompt_text             TEXT,
          image_quality           TEXT NOT NULL DEFAULT 'original',
          include_auxiliary_scans BOOLEAN NOT NULL DEFAULT true,
          provider                TEXT NOT NULL DEFAULT 'gemini',
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    
    // Enable Row Level Security (RLS) on all tables and update views to security_invoker = true
    console.log("Applying Row Level Security (RLS) configurations and securing views...");
    await client.query(`
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE catalogues ENABLE ROW LEVEL SECURITY;
      ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE images ENABLE ROW LEVEL SECURITY;
      ALTER TABLE appraisals ENABLE ROW LEVEL SECURITY;
      ALTER TABLE appraisal_methods ENABLE ROW LEVEL SECURITY;

      -- Set security_invoker = true on views (supported on PG 15+)
      ALTER VIEW lot_appraisals SET (security_invoker = true);
      ALTER VIEW catalogue_summary SET (security_invoker = true);
    `);

    console.log("✓ Schema migrations applied successfully.");
  } catch (err) {
    console.error("❌ Failed to initialize database schema:", err);
    throw err;
  } finally {
    client.release();
  }
}
