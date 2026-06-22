import { pool } from "./pool";
import { AnalysisHistoryItem, PrintAnalysisReport } from "../types";

// User Authentication
export async function findUserByEmail(email: string) {
  const query = `
    SELECT id, email, name, role, password_hash AS "passwordHash", created_at AS "createdAt", last_login_at AS "lastLoginAt"
    FROM users
    WHERE email = $1;
  `;
  const res = await pool.query(query, [email.trim().toLowerCase()]);
  return res.rows[0] || null;
}

export async function createUser(email: string, passwordHash: string, name?: string, role?: string) {
  let finalRole = role || 'seller';
  if (email.trim().toLowerCase() === 'sylvan_sitkey@hotmail.com') {
    finalRole = 'admin';
  }
  const query = `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ($1, $2, $3, $4)
    RETURNING id, email, name, role;
  `;
  const res = await pool.query(query, [email.trim().toLowerCase(), passwordHash, name || null, finalRole]);
  return res.rows[0];
}

export async function updateUserPassword(userId: string, passwordHash: string) {
  const query = `
    UPDATE users
    SET password_hash = $1
    WHERE id = $2;
  `;
  await pool.query(query, [passwordHash, userId]);
}

export async function updateLastLogin(userId: string) {
  const query = `
    UPDATE users
    SET last_login_at = NOW()
    WHERE id = $1;
  `;
  await pool.query(query, [userId]);
}

// Catalogues Registry
export async function getUserCataloguesList(userId: string) {
  const query = `
    SELECT id, name, created_at AS "createdAt"
    FROM catalogues
    WHERE user_id = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC;
  `;
  const res = await pool.query(query, [userId]);
  // Map PostgreSQL model to frontend expected format
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    timestamp: row.createdAt.toISOString(),
  }));
}

export async function createCatalogue(userId: string, name: string) {
  // Fetch user email to generate catalog ID of format userid-AuctionID
  const userRes = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
  const email = userRes.rows[0]?.email || "user";
  
  // Generate unique ID: userid followed by "-" then a 4-digit AuctionID
  const auctionId = Math.floor(1000 + Math.random() * 9000).toString();
  const finalId = `${email}-${auctionId}`;

  const query = `
    INSERT INTO catalogues (id, user_id, name)
    VALUES ($1, $2, $3)
    RETURNING id, name, created_at AS "createdAt";
  `;
  const res = await pool.query(query, [finalId, userId, name]);
  return {
    id: res.rows[0].id,
    name: res.rows[0].name,
    timestamp: res.rows[0].createdAt.toISOString(),
  };
}

export async function renameCatalogue(catalogueId: string, name: string) {
  const query = `
    UPDATE catalogues
    SET name = $1
    WHERE id = $2 AND deleted_at IS NULL;
  `;
  await pool.query(query, [name, catalogueId]);
}

export async function deleteCatalogue(catalogueId: string) {
  const query = `
    UPDATE catalogues
    SET deleted_at = NOW()
    WHERE id = $1;
  `;
  await pool.query(query, [catalogueId]);
}

// Fetch User's Entire Item Database
export async function getUserItems(userId: string): Promise<AnalysisHistoryItem[]> {
  const query = `
    SELECT
      it.id AS item_id,
      it.lot_id AS lot_id,
      it.catalogue_id AS catalogue_id,
      l.name AS lot_number,
      l.description AS lot_title,
      i.storage_key AS image_url,
      i.original_filename AS image_file_name,
      i.file_size_bytes AS file_size,
      a.id AS appraisal_id,
      a.created_at AS timestamp,
      a.result AS report
    FROM items it
    LEFT JOIN lots l ON l.id = it.lot_id AND l.deleted_at IS NULL
    LEFT JOIN images i ON i.item_id = it.id AND i.image_type = 'primary'
    LEFT JOIN appraisals a ON a.item_id = it.id AND a.status = 'complete'
    WHERE it.user_id = $1 AND it.deleted_at IS NULL
    ORDER BY it.created_at DESC;
  `;
  const res = await pool.query(query, [userId]);
  
  const items: AnalysisHistoryItem[] = [];
  for (const row of res.rows) {
    // Fetch visual evidence highlights (cropped appraisal images)
    const imgQuery = `
      SELECT storage_key, description
      FROM images
      WHERE item_id = $1 AND image_type = 'supplementary';
    `;
    const imgRes = await pool.query(imgQuery, [row.item_id]);
    
    let signatureImageUrl: string | undefined;
    let damageImageUrl: string | undefined;
    let scaleImageUrl: string | undefined;

    for (const img of imgRes.rows) {
      if (img.description === "signature") signatureImageUrl = img.storage_key;
      else if (img.description === "damage") damageImageUrl = img.storage_key;
      else if (img.description === "scale") scaleImageUrl = img.storage_key;
    }

    items.push({
      id: row.item_id,
      timestamp: row.timestamp ? new Date(row.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) : new Date().toLocaleDateString("en-US"),
      imageUrl: row.image_url || "",
      imageFileName: row.image_file_name || "Uploaded_Print.png",
      imageSize: row.file_size ? `${(row.file_size / 1024).toFixed(1)} KB` : "Split Scan Crop",
      report: row.report as PrintAnalysisReport,
      lotNumber: row.lot_number || undefined,
      lotTitle: row.lot_title || undefined,
      signatureImageUrl,
      damageImageUrl,
      scaleImageUrl,
      catalogue_id: row.catalogue_id || null,
      lot_id: row.lot_id || null
    });
  }

  return items;
}

// Fetch Items for a Catalog (deprecation wrapper for tests compatibility)
export async function getCatalogueItems(catalogueId: string): Promise<AnalysisHistoryItem[]> {
  const query = `
    SELECT
      it.id AS item_id,
      it.lot_id AS lot_id,
      it.catalogue_id AS catalogue_id,
      l.name AS lot_number,
      l.description AS lot_title,
      i.storage_key AS image_url,
      i.original_filename AS image_file_name,
      i.file_size_bytes AS file_size,
      a.id AS appraisal_id,
      a.created_at AS timestamp,
      a.result AS report
    FROM items it
    LEFT JOIN lots l ON l.id = it.lot_id AND l.deleted_at IS NULL
    LEFT JOIN images i ON i.item_id = it.id AND i.image_type = 'primary'
    LEFT JOIN appraisals a ON a.item_id = it.id AND a.status = 'complete'
    WHERE it.catalogue_id = $1 AND it.deleted_at IS NULL
    ORDER BY it.created_at DESC;
  `;
  const res = await pool.query(query, [catalogueId]);
  
  const items: AnalysisHistoryItem[] = [];
  for (const row of res.rows) {
    const imgQuery = `
      SELECT storage_key, description
      FROM images
      WHERE item_id = $1 AND image_type = 'supplementary';
    `;
    const imgRes = await pool.query(imgQuery, [row.item_id]);
    
    let signatureImageUrl: string | undefined;
    let damageImageUrl: string | undefined;
    let scaleImageUrl: string | undefined;

    for (const img of imgRes.rows) {
      if (img.description === "signature") signatureImageUrl = img.storage_key;
      else if (img.description === "damage") damageImageUrl = img.storage_key;
      else if (img.description === "scale") scaleImageUrl = img.storage_key;
    }

    items.push({
      id: row.item_id,
      timestamp: row.timestamp ? new Date(row.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) : new Date().toLocaleDateString("en-US"),
      imageUrl: row.image_url || "",
      imageFileName: row.image_file_name || "Uploaded_Print.png",
      imageSize: row.file_size ? `${(row.file_size / 1024).toFixed(1)} KB` : "Split Scan Crop",
      report: row.report as PrintAnalysisReport,
      lotNumber: row.lot_number || undefined,
      lotTitle: row.lot_title || undefined,
      signatureImageUrl,
      damageImageUrl,
      scaleImageUrl,
      catalogue_id: row.catalogue_id || null,
      lot_id: row.lot_id || null
    });
  }

  return items;
}

// Save/Sync User's Item Database
export async function saveUserItems(userId: string, items: AnalysisHistoryItem[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 1. Sync deletions: Soft-delete items in DB that are not in the client array
    const activeIds = items.map(it => it.id).filter(id => uuidRegex.test(id));
    if (activeIds.length > 0) {
      const deleteQuery = `
        UPDATE items
        SET deleted_at = NOW()
        WHERE user_id = $1 AND id NOT IN (${activeIds.map((_, idx) => `$${idx + 2}`).join(", ")});
      `;
      await client.query(deleteQuery, [userId, ...activeIds]);
    } else {
      // If client sends an empty list, soft delete all of user's items
      await client.query("UPDATE items SET deleted_at = NOW() WHERE user_id = $1", [userId]);
    }

    // 2. Loop and upsert each item
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];

      // A. Resolve or Create the Lot
      let lotId: string | null = null;
      if (item.lotNumber) {
        const checkLotQuery = `
          SELECT id FROM lots 
          WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL;
        `;
        const lotRes = await client.query(checkLotQuery, [userId, item.lotNumber]);
        if (lotRes.rows.length > 0) {
          lotId = lotRes.rows[0].id;
          // Update lot title/description if provided
          if (item.lotTitle) {
            await client.query("UPDATE lots SET description = $1 WHERE id = $2", [item.lotTitle, lotId]);
          }
        } else {
          const insertLotQuery = `
            INSERT INTO lots (user_id, name, description)
            VALUES ($1, $2, $3)
            RETURNING id;
          `;
          const insertLotRes = await client.query(insertLotQuery, [userId, item.lotNumber, item.lotTitle || null]);
          lotId = insertLotRes.rows[0].id;
        }
      }

      // B. Resolve or Create Item
      let itemId = item.id;
      const isValidUuid = uuidRegex.test(itemId);

      if (!isValidUuid) {
        const uuidRes = await client.query("SELECT gen_random_uuid() AS uuid;");
        itemId = uuidRes.rows[0].uuid;
        item.id = itemId; // Sync back to memory
      }

      // Check if item exists (including soft-deleted)
      const checkItemQuery = `SELECT id FROM items WHERE id = $1;`;
      const itemRes = await client.query(checkItemQuery, [itemId]);

      const catalogueId = item.catalogue_id && typeof item.catalogue_id === "string" ? item.catalogue_id : null;

      if (itemRes.rows.length === 0) {
        const insertItemQuery = `
          INSERT INTO items (id, user_id, lot_id, catalogue_id)
          VALUES ($1, $2, $3, $4);
        `;
        await client.query(insertItemQuery, [itemId, userId, lotId, catalogueId]);
      } else {
        const updateItemQuery = `
          UPDATE items
          SET lot_id = $1, catalogue_id = $2, deleted_at = NULL
          WHERE id = $3;
        `;
        await client.query(updateItemQuery, [lotId, catalogueId, itemId]);
      }

      // C. Save/Verify Primary Image
      const checkImgQuery = `SELECT id FROM images WHERE item_id = $1 AND image_type = 'primary';`;
      const imgRes = await client.query(checkImgQuery, [itemId]);

      if (imgRes.rows.length === 0) {
        const insertImgQuery = `
          INSERT INTO images (user_id, item_id, storage_key, original_filename, image_type, description, position)
          VALUES ($1, $2, $3, $4, 'primary', 'primary', $5);
        `;
        await client.query(insertImgQuery, [
          userId,
          itemId,
          item.imageUrl || "",
          item.imageFileName || null,
          idx
        ]);
      } else {
        const updateImgQuery = `
          UPDATE images
          SET storage_key = $1, original_filename = $2, position = $3
          WHERE item_id = $4 AND image_type = 'primary';
        `;
        await client.query(updateImgQuery, [
          item.imageUrl || "",
          item.imageFileName || null,
          idx,
          itemId
        ]);
      }

      // D. Save/Verify Appraisal Record
      const checkAppQuery = `SELECT id FROM appraisals WHERE item_id = $1;`;
      const appRes = await client.query(checkAppQuery, [itemId]);
      
      const modelName = item.report?.modelUsed || 'gemini-2.5-flash';
      let appraisalId: string;
      const reportContent = item.report ? JSON.stringify(item.report) : JSON.stringify({
        techniques: [],
        artworkTitle: (item as any).title || 'Untitled',
        likelyArtist: 'Unknown',
        conditionNotes: {},
        creationPeriod: 'Unknown',
        auctionEstimate: { min: 0, max: 0, formattedEstimate: '$0' },
        titleConfidence: 0,
        artistConfidence: 0,
        modelUsed: 'gemini-2.5-flash'
      });

      if (appRes.rows.length === 0) {
        const insertAppQuery = `
          INSERT INTO appraisals (item_id, model_name, result, status, completed_at)
          VALUES ($1, $2, $3, 'complete', NOW())
          RETURNING id;
        `;
        const insertAppRes = await client.query(insertAppQuery, [
          itemId,
          modelName,
          reportContent
        ]);
        appraisalId = insertAppRes.rows[0].id;
      } else {
        appraisalId = appRes.rows[0].id;
        const updateAppQuery = `
          UPDATE appraisals
          SET model_name = $1, result = $2, status = 'complete', completed_at = NOW()
          WHERE item_id = $3;
        `;
        await client.query(updateAppQuery, [modelName, reportContent, itemId]);
      }

      // E. Save/Verify Supplementary Crops in images table
      // Clear existing supplementary crops for this item and rewrite
      await client.query("DELETE FROM images WHERE item_id = $1 AND image_type = 'supplementary';", [itemId]);

      if (item.signatureImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'signature');
        `;
        await client.query(insertHighlight, [userId, itemId, item.signatureImageUrl]);
      }
      if (item.damageImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'damage');
        `;
        await client.query(insertHighlight, [userId, itemId, item.damageImageUrl]);
      }
      if (item.scaleImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'scale');
        `;
        await client.query(insertHighlight, [userId, itemId, item.scaleImageUrl]);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to save user items transaction:", err);
    throw err;
  } finally {
    client.release();
  }
}

// Deprecated wrapper for tests compatibility (updated to prevent wiping other catalogs)
export async function saveCatalogueItems(userId: string, catalogueId: string, items: AnalysisHistoryItem[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 1. Sync deletions: Soft-delete items in DB that belong to this catalogue but are not in the client array
    const activeIds = items.map(it => it.id).filter(id => uuidRegex.test(id));
    if (activeIds.length > 0) {
      const deleteQuery = `
        UPDATE items
        SET deleted_at = NOW()
        WHERE user_id = $1 AND catalogue_id = $2 AND id NOT IN (${activeIds.map((_, idx) => `$${idx + 3}`).join(", ")});
      `;
      await client.query(deleteQuery, [userId, catalogueId, ...activeIds]);
    } else {
      // If client sends an empty list for this catalogue, soft delete all of user's items in this catalogue
      await client.query("UPDATE items SET deleted_at = NOW() WHERE user_id = $1 AND catalogue_id = $2", [userId, catalogueId]);
    }

    // 2. Loop and upsert each item
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];

      // A. Resolve or Create the Lot
      let lotId: string | null = null;
      if (item.lotNumber) {
        const checkLotQuery = `
          SELECT id FROM lots 
          WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL;
        `;
        const lotRes = await client.query(checkLotQuery, [userId, item.lotNumber]);
        if (lotRes.rows.length > 0) {
          lotId = lotRes.rows[0].id;
          if (item.lotTitle) {
            await client.query("UPDATE lots SET description = $1 WHERE id = $2", [item.lotTitle, lotId]);
          }
        } else {
          const insertLotQuery = `
            INSERT INTO lots (user_id, name, description)
            VALUES ($1, $2, $3)
            RETURNING id;
          `;
          const insertLotRes = await client.query(insertLotQuery, [userId, item.lotNumber, item.lotTitle || null]);
          lotId = insertLotRes.rows[0].id;
        }
      }

      // B. Resolve or Create Item
      let itemId = item.id;
      const isValidUuid = uuidRegex.test(itemId);

      if (!isValidUuid) {
        const uuidRes = await client.query("SELECT gen_random_uuid() AS uuid;");
        itemId = uuidRes.rows[0].uuid;
        item.id = itemId;
      }

      const checkItemQuery = `SELECT id FROM items WHERE id = $1;`;
      const itemRes = await client.query(checkItemQuery, [itemId]);

      if (itemRes.rows.length === 0) {
        const insertItemQuery = `
          INSERT INTO items (id, user_id, lot_id, catalogue_id)
          VALUES ($1, $2, $3, $4);
        `;
        await client.query(insertItemQuery, [itemId, userId, lotId, catalogueId]);
      } else {
        const updateItemQuery = `
          UPDATE items
          SET lot_id = $1, catalogue_id = $2, deleted_at = NULL
          WHERE id = $3;
        `;
        await client.query(updateItemQuery, [lotId, catalogueId, itemId]);
      }

      // C. Save/Verify Primary Image
      const checkImgQuery = `SELECT id FROM images WHERE item_id = $1 AND image_type = 'primary';`;
      const imgRes = await client.query(checkImgQuery, [itemId]);

      if (imgRes.rows.length === 0) {
        const insertImgQuery = `
          INSERT INTO images (user_id, item_id, storage_key, original_filename, image_type, description, position)
          VALUES ($1, $2, $3, $4, 'primary', 'primary', $5);
        `;
        await client.query(insertImgQuery, [
          userId,
          itemId,
          item.imageUrl || "",
          item.imageFileName || null,
          idx
        ]);
      } else {
        const updateImgQuery = `
          UPDATE images
          SET storage_key = $1, original_filename = $2, position = $3
          WHERE item_id = $4 AND image_type = 'primary';
        `;
        await client.query(updateImgQuery, [
          item.imageUrl || "",
          item.imageFileName || null,
          idx,
          itemId
        ]);
      }

      // D. Save/Verify Appraisal Record
      const checkAppQuery = `SELECT id FROM appraisals WHERE item_id = $1;`;
      const appRes = await client.query(checkAppQuery, [itemId]);
      
      const modelName = item.report?.modelUsed || 'gemini-2.5-flash';
      const reportContent = item.report ? JSON.stringify(item.report) : JSON.stringify({
        techniques: [],
        artworkTitle: (item as any).title || 'Untitled',
        likelyArtist: 'Unknown',
        conditionNotes: {},
        creationPeriod: 'Unknown',
        auctionEstimate: { min: 0, max: 0, formattedEstimate: '$0' },
        titleConfidence: 0,
        artistConfidence: 0,
        modelUsed: 'gemini-2.5-flash'
      });

      if (appRes.rows.length === 0) {
        const insertAppQuery = `
          INSERT INTO appraisals (item_id, model_name, result, status, completed_at)
          VALUES ($1, $2, $3, 'complete', NOW());
        `;
        await client.query(insertAppQuery, [
          itemId,
          modelName,
          reportContent
        ]);
      } else {
        const updateAppQuery = `
          UPDATE appraisals
          SET model_name = $1, result = $2, status = 'complete', completed_at = NOW()
          WHERE item_id = $3;
        `;
        await client.query(updateAppQuery, [modelName, reportContent, itemId]);
      }

      // E. Save/Verify Supplementary Crops
      await client.query("DELETE FROM images WHERE item_id = $1 AND image_type = 'supplementary';", [itemId]);

      if (item.signatureImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'signature');
        `;
        await client.query(insertHighlight, [userId, itemId, item.signatureImageUrl]);
      }
      if (item.damageImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'damage');
        `;
        await client.query(insertHighlight, [userId, itemId, item.damageImageUrl]);
      }
      if (item.scaleImageUrl) {
        const insertHighlight = `
          INSERT INTO images (user_id, item_id, storage_key, image_type, description)
          VALUES ($1, $2, $3, 'supplementary', 'scale');
        `;
        await client.query(insertHighlight, [userId, itemId, item.scaleImageUrl]);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to save catalogue items transaction:", err);
    throw err;
  } finally {
    client.release();
  }
}


// Purge User Data or Account Details
export async function deleteUserData(userId: string, deleteType: "data-only" | "account") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (deleteType === "data-only") {
      // Deletes all lots, images, items, and appraisals
      await client.query("DELETE FROM catalogues WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM lots WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM items WHERE user_id = $1", [userId]);
    } else {
      // Delete user profile entirely (ON DELETE CASCADE deletes catalogues, lots, items, etc. automatically)
      await client.query("DELETE FROM users WHERE id = $1", [userId]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Failed to execute user deletion type ${deleteType}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

// Appraisal Methods
const APPRAISAL_METHOD_COLUMNS = `
  id, name, description,
  model_name              AS "modelName",
  temperature,
  prompt_key              AS "promptKey",
  prompt_text             AS "promptText",
  image_quality           AS "imageQuality",
  include_auxiliary_scans AS "includeAuxiliaryScans",
  provider,
  stage1_model            AS "stage1Model",
  stage2_model            AS "stage2Model",
  stage2a_model           AS "stage2aModel",
  stage2b_model           AS "stage2bModel",
  stage3_model            AS "stage3Model"
`;

export async function getAppraisalMethods() {
  const res = await pool.query(`SELECT ${APPRAISAL_METHOD_COLUMNS} FROM appraisal_methods ORDER BY created_at ASC`);
  return res.rows;
}

export async function getAppraisalMethodById(id: string) {
  const res = await pool.query(`SELECT ${APPRAISAL_METHOD_COLUMNS} FROM appraisal_methods WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

export async function saveAppraisalMethod(config: any) {
  const query = `
    INSERT INTO appraisal_methods (id, name, description, model_name, temperature, prompt_key, prompt_text, image_quality, include_auxiliary_scans, provider, stage1_model, stage2_model, stage2a_model, stage2b_model, stage3_model)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      model_name = EXCLUDED.model_name,
      temperature = EXCLUDED.temperature,
      prompt_key = EXCLUDED.prompt_key,
      prompt_text = EXCLUDED.prompt_text,
      image_quality = EXCLUDED.image_quality,
      include_auxiliary_scans = EXCLUDED.include_auxiliary_scans,
      provider = EXCLUDED.provider,
      stage1_model = EXCLUDED.stage1_model,
      stage2_model = EXCLUDED.stage2_model,
      stage2a_model = EXCLUDED.stage2a_model,
      stage2b_model = EXCLUDED.stage2b_model,
      stage3_model = EXCLUDED.stage3_model
    RETURNING ${APPRAISAL_METHOD_COLUMNS};
  `;
  const res = await pool.query(query, [
    config.id,
    config.name,
    config.description || null,
    config.modelName,
    config.temperature,
    config.promptKey,
    config.promptText || null,
    config.imageQuality || 'original',
    config.includeAuxiliaryScans ?? true,
    config.provider || 'gemini',
    config.stage1Model || null,
    config.stage2Model || null,
    config.stage2aModel || null,
    config.stage2bModel || null,
    config.stage3Model || null,
  ]);
  return res.rows[0];
}
