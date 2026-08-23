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

const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

async function verifyRLS() {
  const client = await pool.connect();
  try {
    console.log("=== Checking Table Row Level Security (RLS) Status ===");
    const tableRes = await client.query(`
      SELECT
          c.relname AS table_name,
          c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN ('users', 'catalogues', 'lots', 'items', 'images', 'appraisals', 'appraisal_methods')
      ORDER BY table_name;
    `);

    let allTablesOK = true;
    for (const row of tableRes.rows) {
      console.log(`Table: ${row.table_name.padEnd(20)} | RLS Enabled: ${row.rls_enabled ? "✓ YES" : "❌ NO"}`);
      if (!row.rls_enabled) {
        allTablesOK = false;
      }
    }

    console.log("\n=== Checking View Security Invoker Status ===");
    const viewRes = await client.query(`
      SELECT
          c.relname AS view_name,
          c.reloptions AS view_options
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'v'
        AND c.relname IN ('lot_appraisals', 'catalogue_summary')
      ORDER BY view_name;
    `);

    let allViewsOK = true;
    for (const row of viewRes.rows) {
      const options = row.view_options || [];
      const hasSecurityInvoker = options.includes('security_invoker=true');
      console.log(`View: ${row.view_name.padEnd(20)} | Security Invoker: ${hasSecurityInvoker ? "✓ YES" : "❌ NO"} (Options: ${options.join(', ') || 'none'})`);
      if (!hasSecurityInvoker) {
        allViewsOK = false;
      }
    }

    if (allTablesOK && allViewsOK) {
      console.log("\n✅ Database security verification completed successfully! All security changes are active.");
    } else {
      console.error("\n❌ Verification failed. Some tables or views are not properly secured.");
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Failed to query database security catalog:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

verifyRLS();
