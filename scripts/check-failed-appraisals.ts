import { pool } from "../src/db/pool";

async function main() {
  try {
    const res = await pool.query(`
      SELECT a.id, a.item_id, a.model_name, a.status, a.error_message, a.created_at, i.original_filename
      FROM appraisals a
      LEFT JOIN items it ON it.id = a.item_id
      LEFT JOIN images i ON i.item_id = it.id AND i.image_type = 'primary'
      ORDER BY a.created_at DESC
      LIMIT 10;
    `);
    console.log("Recent appraisal runs:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error("Database query failed:", err);
  } finally {
    await pool.end();
  }
}

main();
