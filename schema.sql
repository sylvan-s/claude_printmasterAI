-- ============================================================
--  IMAGE CATALOGUE APP — DATABASE SCHEMA (ITEM-FIRST EDITION)
-- ============================================================
--  Conventions:
--    - All primary keys are UUID (gen_random_uuid())
--    - Timestamps are TIMESTAMPTZ (UTC)
--    - Soft deletes via deleted_at (NULL = active)
--    - ENUM-like values use TEXT with CHECK constraints
-- ============================================================


-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    name            TEXT,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('seller', 'buyer', 'curator', 'admin')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ
);


-- ------------------------------------------------------------
-- CATALOGUES
-- Catalogues are logical groups to partition items.
-- ------------------------------------------------------------
CREATE TABLE catalogues (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    is_public       BOOL NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ             -- soft delete
);


-- ------------------------------------------------------------
-- LOTS
-- A lot is an auction grouping of one or more items.
-- ------------------------------------------------------------
CREATE TABLE lots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'submitted', 'appraised')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ             -- soft delete
);


-- ------------------------------------------------------------
-- ITEMS
-- Core entity representing a unique print supporting appraisals,
-- catalogues, and lots classifications.
-- ------------------------------------------------------------
CREATE TABLE items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lot_id          UUID REFERENCES lots(id) ON DELETE SET NULL,
    catalogue_id    TEXT REFERENCES catalogues(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ             -- soft delete
);


-- ------------------------------------------------------------
-- IMAGES
-- Main print scans and auxiliary closeup highlights.
-- ------------------------------------------------------------
CREATE TABLE images (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id             UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    storage_key         TEXT NOT NULL,      -- path in local storage / cloud bucket
    image_type          TEXT NOT NULL DEFAULT 'primary'
                            CHECK (image_type IN ('primary', 'supplementary')),
    description         TEXT,               -- 'primary', 'signature', 'damage', 'scale', etc.
    original_filename   TEXT,
    content_type        TEXT,
    file_size_bytes     INT,
    position            INT,                -- display order
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- APPRAISALS
-- Valuation runs conducted on a specific item.
-- ------------------------------------------------------------
CREATE TABLE appraisals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    model_name      TEXT NOT NULL,          -- e.g. 'gemini-2.5-flash'
    result          JSONB,                  -- full structured LLM response
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    error_message   TEXT,                   -- populated if status = 'failed'
    processing_ms   INT,                    -- latency tracking
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);


-- ============================================================
--  INDEXES
-- ============================================================

-- User lookups
CREATE UNIQUE INDEX idx_users_email         ON users (email);

-- Item mappings
CREATE INDEX idx_items_user_id              ON items (user_id);
CREATE INDEX idx_items_lot_id               ON items (lot_id);
CREATE INDEX idx_items_catalogue_id         ON items (catalogue_id);
CREATE INDEX idx_items_active               ON items (user_id) WHERE deleted_at IS NULL;

-- Images mapping
CREATE INDEX idx_images_item_id             ON images (item_id);
CREATE INDEX idx_images_type                ON images (item_id, image_type);

-- Appraisals
CREATE INDEX idx_appraisals_item_id         ON appraisals (item_id);
CREATE INDEX idx_appraisals_status          ON appraisals (status) WHERE status IN ('pending', 'processing');

-- Group lookups
CREATE INDEX idx_lots_user_id               ON lots (user_id);
CREATE INDEX idx_lots_active                ON lots (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_catalogues_user_id         ON catalogues (user_id);
CREATE INDEX idx_catalogues_active          ON catalogues (user_id) WHERE deleted_at IS NULL;


-- ============================================================
--  USEFUL VIEWS
-- ============================================================

-- All appraisals for a lot (via its items)
CREATE VIEW lot_appraisals WITH (security_invoker = true) AS
SELECT
    l.id            AS lot_id,
    l.name          AS lot_name,
    i.id            AS image_id,
    i.storage_key   AS image_storage_key,
    a.id            AS appraisal_id,
    a.model_name,
    a.status        AS appraisal_status,
    a.result,
    a.created_at    AS appraised_at
FROM lots l
JOIN items it       ON it.lot_id = l.id
JOIN images i       ON i.item_id = it.id AND i.image_type = 'primary'
JOIN appraisals a   ON a.item_id = it.id;


-- Summary of a catalogue with lot and item counts
CREATE VIEW catalogue_summary WITH (security_invoker = true) AS
SELECT
    c.id            AS catalogue_id,
    c.name          AS catalogue_name,
    c.user_id,
    COUNT(DISTINCT it.lot_id)   AS lot_count,
    COUNT(DISTINCT it.id)        AS item_count,
    c.created_at
FROM catalogues c
LEFT JOIN items it            ON it.catalogue_id = c.id AND it.deleted_at IS NULL
WHERE c.deleted_at IS NULL
GROUP BY c.id, c.name, c.user_id, c.created_at;


-- ------------------------------------------------------------
-- APPRAISAL METHODS
-- Configurations for built-in and custom prompts and models.
-- ------------------------------------------------------------
CREATE TABLE appraisal_methods (
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


-- ============================================================
--  ROW LEVEL SECURITY (RLS)
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_methods ENABLE ROW LEVEL SECURITY;

