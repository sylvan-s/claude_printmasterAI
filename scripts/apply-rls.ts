import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

function fixConnectionString(url?: string): string | undefined {
  if (!url) return url;
  if (url.includes('%3F')) return url;
  
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

const dbUrl = fixConnectionString(process.env.DATABASE_URL);
console.log("Connecting to database...");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

async function applyRLS() {
  const client = await pool.connect();
  try {
    console.log("Enabling Row Level Security (RLS) on all tables...");
    await client.query(`
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE catalogues ENABLE ROW LEVEL SECURITY;
      ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE images ENABLE ROW LEVEL SECURITY;
      ALTER TABLE appraisals ENABLE ROW LEVEL SECURITY;
      ALTER TABLE appraisal_methods ENABLE ROW LEVEL SECURITY;
    `);
    console.log("✓ RLS enabled on all 7 tables successfully.");

    console.log("Securing views with security_invoker = true...");
    await client.query(`
      ALTER VIEW lot_appraisals SET (security_invoker = true);
      ALTER VIEW catalogue_summary SET (security_invoker = true);
    `);
    console.log("✓ Secured both database views.");

    console.log("✓ Database migration script execution completed successfully!");
  } catch (err) {
    console.error("❌ Failed to apply RLS/view changes:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

applyRLS();
