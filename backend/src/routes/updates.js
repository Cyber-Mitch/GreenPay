/**
 * src/routes/updates.js
 * GET  /api/updates/:projectId        — list updates for a project
 * POST /api/updates                   — create update + notify subscribers (admin)
 * POST /api/updates/:updateId/like — toggle like
 * GET  /api/updates/:updateId/likes — get like count and user's like status
 *
 * Rate limiters prevent admin update spam and like enumeration/spam.
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { mapProjectUpdateRow, mapProjectRow } = require("../services/store");
const { enqueueUpdateNotifications } = require("../services/email");
const { sendUpdatePushNotifications } = require("../services/push");
const { logAdminAction } = require("../services/audit");

const { adminRequired } = require("../middleware/auth");
const { createApiError } = require("../middleware/apiEnvelope");
const {
  TRANSLATION_STATUSES,
  requireContentLanguage,
  updateLocalizationSelect,
} = require("../services/contentLanguage");

// Rate limiter for admin update creation: an IP floor plus the real cap on the
// authenticated subject, so the same admin account is bounded regardless of
// which address it logs in from. 5 updates per admin per hour.
const updateCreationLimiter = createLayeredRateLimiter({
  name: "update-create",
  windowMinutes: 60,
  ip: 30,
  subject: 5,
});

// Rate limiter for like operations: coarse per-IP floor plus the real
// per-wallet cap. Prevents like enumeration/spam: 20 likes per donor per hour.
const likeLimiter = createLayeredRateLimiter({
  name: "update-like",
  windowMinutes: 1,
  ip: 60,
  wallet: 20,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

// GET /api/updates/:projectId — list updates for a project, newest first
router.get("/:projectId", async (req, res, next) => {
  try {
    const { cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    // Validated up front so an unsupported `lang` is rejected rather than
    // quietly served as source-language content under the requested label.
    const language = req.query.lang === undefined ? null : requireContentLanguage(req.query.lang);
    const cursorObj = decodeCursor(cursor);

    const where = ["u.project_id = $1"];
    const values = [req.params.projectId];

    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.id) {
        values.push(cursorObj.createdAt, cursorObj.id);
        where.push(`(u.created_at, u.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`u.created_at < $${values.length}::timestamptz`);
      }
    }

    let languageParam = null;
    if (language) {
      values.push(language);
      languageParam = `$${values.length}`;
    }
    // At most one approved translation per (update, language), so the join
    // cannot fan out rows and change what a page of `limit` rows means.
    const localization = updateLocalizationSelect(languageParam);

    values.push(parsedLimit + 1);
    const query = `SELECT u.*${localization.columns}${languageParam ? `, ${languageParam}::text AS requested_language` : ""}
       FROM project_updates u${localization.join}
       WHERE ${where.join(" AND ")}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
    });

    res.apiMeta(meta);
    res.json(data.map(mapProjectUpdateRow));
  } catch (e) {
    next(e);
  }
});

// POST /api/updates  (admin only)
// Rate-limited to prevent update spam
router.post("/", adminRequired, updateCreationLimiter, async (req, res, next) => {
  try {
    const { projectId, title, body } = req.body || {};
    const sourceLanguage = req.body?.sourceLanguage === undefined
      ? "en"
      : requireContentLanguage(req.body.sourceLanguage);

    if (!projectId || typeof projectId !== "string") {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "projectId is required");
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      throw createApiError(400, "TITLE_REQUIRED", "title is required");
    }
    if (!body || typeof body !== "string" || !body.trim()) {
      throw createApiError(400, "BODY_REQUIRED", "body is required");
    }

    // Verify project exists
    const projResult = await pool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    if (!projResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const project = mapProjectRow(projResult.rows[0]);

    // Insert update
    const id = uuidv4();
    const insertResult = await pool.query(
      `INSERT INTO project_updates (id, project_id, title, body, source_language)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, projectId, title.trim(), body.trim(), sourceLanguage],
    );
    const update = mapProjectUpdateRow(insertResult.rows[0]);

    // Fan out email notifications (non-blocking): reads subscribers in
    // bounded chunks and enqueues one retryable job per chunk rather than
    // loading every subscriber into memory and sending inline.
    enqueueUpdateNotifications({ project, update }).catch((err) => {
      console.error("[updates] Failed to enqueue email notifications:", err.message);
    });

    // Fan out push notifications (non-blocking): same chunked-queue pattern
    // for followers' device tokens.
    sendUpdatePushNotifications({ project, update }).catch((err) => {
      console.error("[updates] Failed to enqueue push notifications:", err.message);
    });

    res.status(201).json(update);
  } catch (e) {
    next(e);
  }
});



// POST /api/updates/:updateId/like — toggle like
// Rate-limited per donor to prevent like enumeration/spam
router.post("/:updateId/like", likeLimiter, async (req, res, next) => {
  try {
    const { donorAddress } = req.body || {};
    if (!donorAddress || typeof donorAddress !== "string") {
      throw createApiError(400, "DONOR_ADDRESS_REQUIRED", "donorAddress is required");
    }

    const updateResult = await pool.query(
      "SELECT id FROM project_updates WHERE id = $1",
      [req.params.updateId],
    );
    if (!updateResult.rows[0]) {
      throw createApiError(404, "UPDATE_NOT_FOUND", "Update not found");
    }

    // Toggle the like in one statement. Reading the `deleted` CTE from the
    // INSERT's WHERE forces Postgres to finish the DELETE before the INSERT
    // can produce a row, so "was this already liked?" is answered by the
    // DELETE's own row lock instead of by an earlier SELECT whose answer can
    // go stale before the write lands.
    //
    // Two concurrent likes therefore both reach the INSERT; the second blocks
    // on the UNIQUE(update_id, donor_address) index and is then turned into a
    // no-op by ON CONFLICT DO NOTHING. The duplicate is absorbed by the
    // constraint rather than raised as an error for the caller to catch, so
    // neither request fails and only one row is ever created.
    const toggleResult = await pool.query(
      `WITH deleted AS (
         DELETE FROM update_likes
          WHERE update_id = $1 AND donor_address = $2
         RETURNING id
       ),
       inserted AS (
         INSERT INTO update_likes (id, update_id, donor_address)
         SELECT $3, $1, $2
          WHERE NOT EXISTS (SELECT 1 FROM deleted)
         ON CONFLICT (update_id, donor_address) DO NOTHING
         RETURNING id
       )
       SELECT NOT EXISTS (SELECT 1 FROM deleted) AS liked`,
      [req.params.updateId, donorAddress, uuidv4()],
    );

    // Counted after the toggle, not inside it: a data-modifying CTE's changes
    // are not visible to the rest of the statement that made them, so an
    // inline COUNT(*) would report the pre-toggle total.
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );

    res.json({
      liked: toggleResult.rows[0].liked,
      likeCount: parseInt(countResult.rows[0].count),
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/updates/:updateId/likes — get like count and user's like status
router.get("/:updateId/likes", async (req, res, next) => {
  try {
    const { donorAddress } = req.query;
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );
    let liked = false;
    if (donorAddress) {
      const existing = await pool.query(
        "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [req.params.updateId, donorAddress],
      );
      liked = !!existing.rows[0];
    }
    res.json({
      likeCount: parseInt(countResult.rows[0].count),
      liked,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
