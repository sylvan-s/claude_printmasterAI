import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";
import { initDatabase, pool } from "./src/db/pool";
import * as db from "./src/db/queries";
import { getAppraiser, getAppraiserFromConfig, appraiserConfigs } from "./src/appraisal/appraiser";
import { STANDARD_PROMPT_TEMPLATE, SIMPLIFIED_PROMPT_TEMPLATE, STRICT_PROMPT_TEMPLATE } from "./src/appraisal/prompts";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const DATA_DIR = path.join(process.cwd(), "data");
const USER_RECORDS_DIR = path.join(DATA_DIR, "user_records");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(USER_RECORDS_DIR)) {
  fs.mkdirSync(USER_RECORDS_DIR, { recursive: true });
}
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}

// Set up large JSON body limits for handling Base64 photo uploads
app.use(express.json({ limit: "25mb" }));

// Lazy initializer for the server-side Gemini client
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY environment variable is not defined. Please add your key through the AI Studio panel or .env file."
      );
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Helper to resolve user image input (data URLs, local user-images URLs, or raw Base64 strings)
const resolveImageInput = (
  input: string | undefined, 
  defaultMimeType: string | undefined
): { base64: string; mimeType: string } | null => {
  if (!input) return null;
  
  if (input.startsWith("/api/user-images/")) {
    const relativePart = input.replace("/api/user-images/", "");
    const localFilePath = path.join(USER_RECORDS_DIR, relativePart);
    if (fs.existsSync(localFilePath)) {
      const fileBuffer = fs.readFileSync(localFilePath);
      const base64 = fileBuffer.toString("base64");
      const ext = path.extname(localFilePath).toLowerCase();
      let mimeType = "image/jpeg";
      if (ext === ".png") mimeType = "image/png";
      else if (ext === ".webp") mimeType = "image/webp";
      return { base64, mimeType };
    }
  }

  // Handle standard data URI format
  if (input.startsWith("data:")) {
    const matches = input.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.*)$/);
    if (matches && matches.length === 3) {
      return { mimeType: matches[1], base64: matches[2] };
    }
  }

  // Remove potential data URL prefix if any
  const base64 = input.replace(/^data:image\/\w+;base64,/, "");

  return {
    base64,
    mimeType: defaultMimeType || "image/jpeg"
  };
};

// ----------------------------------------
// API ENDPOINTS
// ----------------------------------------

// Health check route
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Get available appraisal methods route
app.get("/api/appraisal-methods", async (req, res) => {
  try {
    const methods = await db.getAppraisalMethods();
    res.json(methods);
  } catch (err: any) {
    console.error("Failed to load appraisal methods:", err);
    res.status(500).json({ error: "Failed to load appraisal methods." });
  }
});

// Art Print Photo Analysis Route
app.post("/api/analyze-print", async (req, res) => {
  try {
    const { 
      imageBase64, 
      mimeType, 
      userNotes,
      signatureBase64,
      signatureMimeType,
      damageBase64,
      damageMimeType,
      scaleBase64,
      scaleMimeType,
      currency = "USD",
      method = "gemini-3stage"
    } = req.body;

    const resolvedImage = resolveImageInput(imageBase64, mimeType);
    if (!resolvedImage) {
      return res.status(400).json({ error: "Missing uploaded image content." });
    }

    const resolvedSignature = resolveImageInput(signatureBase64, signatureMimeType) || undefined;
    const resolvedDamage = resolveImageInput(damageBase64, damageMimeType) || undefined;
    const resolvedScale = resolveImageInput(scaleBase64, scaleMimeType) || undefined;

    const methodConfig = await db.getAppraisalMethodById(method);
    if (!methodConfig) {
      return res.status(404).json({ error: `Appraisal method ${method} not found.` });
    }

    const ai = getAiClient();
    const appraiser = getAppraiserFromConfig(methodConfig, ai);

    const reportData = await appraiser.appraise({
      imageBase64: resolvedImage.base64,
      mimeType: resolvedImage.mimeType,
      userNotes,
      signatureBase64: resolvedSignature?.base64,
      signatureMimeType: resolvedSignature?.mimeType,
      damageBase64: resolvedDamage?.base64,
      damageMimeType: resolvedDamage?.mimeType,
      scaleBase64: resolvedScale?.base64,
      scaleMimeType: resolvedScale?.mimeType,
      currency
    });

    return res.json(reportData);
  } catch (error: any) {
    console.error("Print appraisal failed:", error);
    return res.status(500).json({
      error: error.message || "An unexpected error occurred during print analysis.",
    });
  }
});


// Propose cohesive Lot Details based on selected art records via Gemini
app.post("/api/propose-lot-name", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing or empty items list for lot proposal." });
    }

    const ai = getAiClient();
    
    // Create prompt from selected items metadata
    const itemsDescription = items.map((it: any, index: number) => {
      const techStr = Array.isArray(it.techniques) ? it.techniques.join(", ") : "";
      return `Item ${index + 1}: Title: "${it.title || "Unknown"}", Artist: "${it.artist || "Unknown"}", Period: "${it.period || "Unknown"}", Techniques: "${techStr}"`;
    }).join("\n");

    const prompt = `You are an elite Prints Specialist and fine art appraiser cataloging prints for a major gallery or auction house (like Christie's or Sotheby's).
Given these selected print works from an art portfolio, analyze their characteristics (shared artists, techniques, visual schools, movements, date periods, or themes) to suggest:
1. "proposedLotNumber": A professional lot identifier (e.g. "Lot 101", "Lot 15B", "Lot 210". If items are diverse or sequentially cataloged, choose a logical starter code).
2. "proposedLotTitle": A sophisticated, academically sound cataloging header to group them (e.g., "Important Woodblock Prints of the Shin-hanga Movement", "Modern Master Monotypes", "Post-War Screenprints & Multiples", or "Post-Minimalist Explorations").

If the group is highly diverse with no obvious technical or artist connection, formulate a cohesive unifying classification (e.g., "Selected Masterpieces of Twentieth-Century Printmaking" or "Works on Paper: From Etchings to Serigraphs").

Here are the selected items:
${itemsDescription}`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        proposedLotNumber: {
          type: Type.STRING,
          description: "A suitable auction lot number/code, e.g. 'Lot 102' or 'Lot 18C'."
        },
        proposedLotTitle: {
          type: Type.STRING,
          description: "An elegant, descriptive and scholarly lot heading designed to structure this group."
        }
      },
      required: ["proposedLotNumber", "proposedLotTitle"]
    };

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are an elite, highly professional art appraiser and catalog builder for prestigious fine art auction houses.",
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No output received from Gemini.");
    }

    const proposal = JSON.parse(textOutput.trim());
    return res.json(proposal);
  } catch (error: any) {
    console.error("Gemini lot proposal failed:", error);
    return res.status(500).json({
      error: error.message || "An unexpected error occurred during lot name proposal.",
    });
  }
});

// List files in a local folder
app.post("/api/list-local-directory", async (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath) {
      return res.status(400).json({ error: "Missing directory path parameter." });
    }

    const resolvedPath = path.resolve(dirPath);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "Directory does not exist." });
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path specified is not a directory." });
    }

    const files = fs.readdirSync(resolvedPath);
    const imageFiles = files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      })
      .map((file) => {
        const filePath = path.join(resolvedPath, file);
        const fileStat = fs.statSync(filePath);
        return {
          name: file,
          fullPath: filePath,
          size: fileStat.size,
          ext: path.extname(file).toLowerCase(),
        };
      });

    return res.json({ success: true, dirPath: resolvedPath, files: imageFiles });
  } catch (error: any) {
    console.error("Failed to read local directory:", error);
    return res.status(500).json({ error: error.message || "Failed to read directory." });
  }
});

// Fetch local file content as Base64
app.post("/api/get-local-file", async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "Missing file path parameter." });
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "File does not exist." });
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === ".png") mimeType = "image/png";
    if (ext === ".webp") mimeType = "image/webp";

    const content = fs.readFileSync(resolvedPath);
    const base64 = content.toString("base64");

    return res.json({
      success: true,
      fileName: path.basename(resolvedPath),
      mimeType,
      size: content.length,
      base64: `data:${mimeType};base64,${base64}`,
    });
  } catch (error: any) {
    console.error("Failed to read local file:", error);
    return res.status(500).json({ error: error.message || "Failed to read file." });
  }
});

// Detect if image contains multiple distinct artworks
app.post("/api/detect-artworks", async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    const resolvedImage = resolveImageInput(imageBase64, mimeType);
    if (!resolvedImage) {
      return res.status(400).json({ error: "Missing uploaded image content." });
    }

    const ai = getAiClient();
    const cleanBase64 = resolvedImage.base64;
    const cleanMimeType = resolvedImage.mimeType;

    const parts = [
      {
        inlineData: {
          data: cleanBase64,
          mimeType: cleanMimeType,
        },
      },
      {
        text: `Analyze this image scan. Determine if it contains multiple distinct artwork pieces, fine art prints, or paintings (e.g. a collage, multiple separate print sheets scanned or photographed together on a single background or scanner bed).

RULES FOR MULTIPLE ARTWORKS:
- Draw a TIGHT bounding box around each individual artwork, hugging its outer edges closely.
- Each bounding box must enclose exactly ONE artwork — boxes must NOT overlap each other and must NOT contain more than one artwork.
- Do NOT include neighbouring artworks inside another artwork's box.
- If artworks are side by side, the right edge of the left box and the left edge of the right box should be at the gap between them.
- If artworks are stacked vertically, the bottom edge of the upper box and the top edge of the lower box should be at the gap between them.

RULES FOR SINGLE ARTWORK:
- If the image contains only a single artwork, return containsMultipleArtworks as false and a single bounding box [0, 0, 1000, 1000].

Coordinates MUST be normalized to a 0–1000 scale, formatted as [ymin, xmin, ymax, xmax] relative to the overall image height and width.`,
      },
    ];

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        containsMultipleArtworks: {
          type: Type.BOOLEAN,
          description: "True if there are multiple separate prints or distinct artworks visible in the single scan."
        },
        artworks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: {
                type: Type.STRING,
                description: "Label for this artwork item, e.g. 'Artwork A', 'Artwork B'."
              },
              box_2d: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
                description: "Normalized bounding box coordinates [ymin, xmin, ymax, xmax] from 0 to 1000."
              }
            },
            required: ["label", "box_2d"]
          },
          description: "Bounding boxes enclosing each detected artwork."
        }
      },
      required: ["containsMultipleArtworks", "artworks"]
    };

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.1,
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE
          },
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE
          }
        ]
      },
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No output received from Gemini detection.");
    }

    const detection = JSON.parse(textOutput.trim());

    // Post-process: if multiple artworks detected but any box spans >85% of the
    // full image in both axes, Gemini gave us a containing box rather than a tight
    // one.  Remove such boxes — the remaining boxes are the real artworks.
    if (detection.containsMultipleArtworks && Array.isArray(detection.artworks) && detection.artworks.length > 1) {
      const filtered = detection.artworks.filter((art: any) => {
        const [ymin, xmin, ymax, xmax] = art.box_2d;
        const wFrac = (xmax - xmin) / 1000;
        const hFrac = (ymax - ymin) / 1000;
        // Drop any box that covers almost the entire image in both dimensions
        return !(wFrac > 0.85 && hFrac > 0.85);
      });
      if (filtered.length >= 2) {
        detection.artworks = filtered;
      }
      // If boxes overlap significantly, try to partition them by splitting at midpoints
      // Sort artworks left-to-right by xmin
      detection.artworks.sort((a: any, b: any) => a.box_2d[1] - b.box_2d[1]);
      for (let i = 0; i < detection.artworks.length - 1; i++) {
        const cur = detection.artworks[i];
        const next = detection.artworks[i + 1];
        const [, , , curXmax] = cur.box_2d;
        const [, nextXmin] = next.box_2d;
        if (curXmax > nextXmin) {
          // Overlap on x-axis — split at the midpoint between the two xmins
          const splitX = Math.round((cur.box_2d[1] + next.box_2d[1] + cur.box_2d[3] + next.box_2d[3]) / 4);
          cur.box_2d[3] = splitX;   // curXmax = splitX
          next.box_2d[1] = splitX;  // nextXmin = splitX
        }
      }
      // Also fix vertical overlaps
      detection.artworks.sort((a: any, b: any) => a.box_2d[0] - b.box_2d[0]);
      for (let i = 0; i < detection.artworks.length - 1; i++) {
        const cur = detection.artworks[i];
        const next = detection.artworks[i + 1];
        const curYmax = cur.box_2d[2];
        const nextYmin = next.box_2d[0];
        if (curYmax > nextYmin) {
          const splitY = Math.round((cur.box_2d[0] + next.box_2d[0] + cur.box_2d[2] + next.box_2d[2]) / 4);
          cur.box_2d[2] = splitY;
          next.box_2d[0] = splitY;
        }
      }
    }

    // Add padding to each crop (20 units = 2% on 0–1000 scale) so tight Gemini
    // boxes don't clip artwork edges.  Clamp to image bounds and shrink neighbours
    // to avoid overlap at the shared boundary.
    const PAD = 40;
    if (Array.isArray(detection.artworks)) {
      detection.artworks = detection.artworks.map((art: any) => {
        let [ymin, xmin, ymax, xmax] = art.box_2d;
        ymin = Math.max(0, ymin - PAD);
        xmin = Math.max(0, xmin - PAD);
        ymax = Math.min(1000, ymax + PAD);
        xmax = Math.min(1000, xmax + PAD);
        return { ...art, box_2d: [ymin, xmin, ymax, xmax] };
      });
      // Re-resolve overlaps introduced by padding — split at the midpoint gap
      if (detection.artworks.length > 1) {
        detection.artworks.sort((a: any, b: any) => a.box_2d[1] - b.box_2d[1]);
        for (let i = 0; i < detection.artworks.length - 1; i++) {
          const cur = detection.artworks[i]; const next = detection.artworks[i + 1];
          if (cur.box_2d[3] > next.box_2d[1]) {
            const mid = Math.round((cur.box_2d[3] + next.box_2d[1]) / 2);
            cur.box_2d[3] = mid; next.box_2d[1] = mid;
          }
        }
        detection.artworks.sort((a: any, b: any) => a.box_2d[0] - b.box_2d[0]);
        for (let i = 0; i < detection.artworks.length - 1; i++) {
          const cur = detection.artworks[i]; const next = detection.artworks[i + 1];
          if (cur.box_2d[2] > next.box_2d[0]) {
            const mid = Math.round((cur.box_2d[2] + next.box_2d[0]) / 2);
            cur.box_2d[2] = mid; next.box_2d[0] = mid;
          }
        }
      }
    }

    const detectionJson = JSON.stringify(detection, null, 2);
    console.log("Detection result:", detectionJson);
    try { fs.writeFileSync("/tmp/last-detection.json", detectionJson); } catch (_) {}
    return res.json(detection);
  } catch (error: any) {
    console.error("Gemini artwork detection failed:", error);
    return res.status(500).json({
      error: error.message || "An unexpected error occurred during artwork detection.",
    });
  }
});

// ----------------------------------------
// USER ACCOUNTS & PERSISTENCE ENDPOINTS
// ----------------------------------------

// Expose static middleware for user uploaded images/scans
app.use("/api/user-images", express.static(USER_RECORDS_DIR));

// Helper to resolve user from headers
async function resolveUser(usernameHeader: any) {
  if (!usernameHeader || typeof usernameHeader !== "string") {
    throw new Error("Unauthorized. Missing user header.");
  }
  const cleanUsername = usernameHeader.trim().toLowerCase();
  const user = await db.findUserByEmail(cleanUsername);
  if (!user) {
    throw new Error("User profile not found.");
  }
  return user;
}

// GET user profile
app.get("/api/user/profile", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const user = await resolveUser(username);
    return res.json({
      username: user.email,
      name: user.name,
      role: user.role
    });
  } catch (err: any) {
    console.error("Failed to fetch user profile:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to fetch profile." });
  }
});

// GET default prompts (Admin Only)
app.get("/api/admin/prompts", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const user = await resolveUser(username);
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admin only." });
    }
    return res.json({
      standard: STANDARD_PROMPT_TEMPLATE,
      simplified: SIMPLIFIED_PROMPT_TEMPLATE,
      strict: STRICT_PROMPT_TEMPLATE
    });
  } catch (err: any) {
    console.error("Failed to fetch default prompts:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to fetch prompts." });
  }
});

// POST save custom appraisal method (Admin Only)
app.post("/api/appraisal-methods", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const user = await resolveUser(username);
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admin only." });
    }

    const { id, name, description, modelName, temperature, promptKey, promptText, imageQuality, includeAuxiliaryScans, provider } = req.body;
    if (!id || !name || !modelName || temperature === undefined || !promptKey) {
      return res.status(400).json({ error: "Missing required config parameters." });
    }

    const savedMethod = await db.saveAppraisalMethod({
      id,
      name,
      description,
      modelName,
      temperature,
      promptKey,
      promptText,
      imageQuality,
      includeAuxiliaryScans,
      provider
    });

    return res.json({ success: true, method: savedMethod });
  } catch (err: any) {
    console.error("Failed to save custom appraisal method:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to save appraisal method." });
  }
});

// Signup route
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.@+-]+$/.test(cleanUsername) || cleanUsername === "." || cleanUsername === ".." || cleanUsername.includes("..")) {
      return res.status(400).json({ error: "Username or email can only contain alphanumeric characters, underscores, dashes, dots, plus signs, and at signs, and cannot contain consecutive dots." });
    }

    const existingUser = await db.findUserByEmail(cleanUsername);
    if (existingUser) {
      return res.status(400).json({ error: "Username already exists." });
    }

    const user = await db.createUser(cleanUsername, password, name, role);

    // Create user directories on local disk as fallback for uploaded assets
    const userFolder = path.join(USER_RECORDS_DIR, cleanUsername);
    const userImagesFolder = path.join(userFolder, "images");
    if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true });
    if (!fs.existsSync(userImagesFolder)) fs.mkdirSync(userImagesFolder, { recursive: true });

    // Create initial default catalogue in database
    await db.createCatalogue(user.id, "Default Catalogue");

    return res.json({ success: true, username: cleanUsername, name: user.name, role: user.role });
  } catch (err: any) {
    console.error("Signup failed:", err);
    return res.status(500).json({ error: err.message || "Internal server error during registration." });
  }
});

// Login route
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const cleanUsername = username.trim().toLowerCase();
    const user = await db.findUserByEmail(cleanUsername);

    if (!user || user.passwordHash !== password) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    await db.updateLastLogin(user.id);

    return res.json({ success: true, username: cleanUsername, name: user.name, role: user.role });
  } catch (err: any) {
    console.error("Login failed:", err);
    return res.status(500).json({ error: "Internal server error during authentication." });
  }
});

// Change password route
app.post("/api/auth/change-password", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required." });
    }

    const user = await resolveUser(username);

    if (user.passwordHash !== currentPassword) {
      return res.status(400).json({ error: "Incorrect current password." });
    }

    await db.updateUserPassword(user.id, newPassword);

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Change password failed:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to change password." });
  }
});

// Delete user data / account route
app.post("/api/user/delete-data", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { deleteType } = req.body;

    if (deleteType !== "data-only" && deleteType !== "account") {
      return res.status(400).json({ error: "Invalid deletion type. Must be 'data-only' or 'account'." });
    }

    const user = await resolveUser(username);
    await db.deleteUserData(user.id, deleteType);

    // Also wipe local directory assets
    const cleanUsername = user.email.trim().toLowerCase();
    const userFolder = path.join(USER_RECORDS_DIR, cleanUsername);
    if (fs.existsSync(userFolder)) {
      fs.rmSync(userFolder, { recursive: true, force: true });
    }

    return res.json({ success: true, message: deleteType === "data-only" ? "All appraisal data cleared successfully." : "User account and data deleted successfully." });
  } catch (err: any) {
    console.error("Delete data failed:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to delete data." });
  }
});

// GET catalogs metadata list route
app.get("/api/user/catalog-list", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const user = await resolveUser(username);

    let catalogs = await db.getUserCataloguesList(user.id);
    if (catalogs.length === 0) {
      const defaultCat = await db.createCatalogue(user.id, "Default Catalogue");
      catalogs = [defaultCat];
    }

    return res.json({ catalogs, activeCatalogId: catalogs[0].id });
  } catch (err: any) {
    console.error("Failed to load catalog list:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to load catalog list." });
  }
});

// POST catalogs metadata list route
app.post("/api/user/catalog-list", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { catalogs, activeCatalogId } = req.body;

    if (!catalogs || !Array.isArray(catalogs)) {
      return res.status(400).json({ error: "Invalid catalogs list." });
    }

    const user = await resolveUser(username);

    // Sync catalogues list: insert or update name
    const dbCatalogs = await db.getUserCataloguesList(user.id);

    for (const clientCat of catalogs) {
      const existing = dbCatalogs.find((c) => c.id === clientCat.id);
      if (existing) {
        if (existing.name !== clientCat.name) {
          await db.renameCatalogue(clientCat.id, clientCat.name);
        }
      } else {
        await db.upsertCatalogueById(clientCat.id, user.id, clientCat.name, clientCat.timestamp ? new Date(clientCat.timestamp) : undefined);
      }
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to save catalog list:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to save catalog list." });
  }
});

// GET catalog items route (by id parameter)
app.get("/api/user/catalog", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { id } = req.query;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Missing catalogue ID parameter." });
    }

    const user = await resolveUser(username);
    const catalog = await db.getCatalogueItems(id, user.id);
    return res.json(catalog);
  } catch (err: any) {
    console.error("Failed to load user catalog:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to load catalog." });
  }
});

// POST catalog items route (by id parameter)
app.post("/api/user/catalog", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { catalog } = req.body;
    const { id } = req.query;

    if (!catalog || !Array.isArray(catalog)) {
      return res.status(400).json({ error: "Catalog must be a valid array." });
    }
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Missing catalogue ID parameter." });
    }

    const user = await resolveUser(username);
    await db.saveCatalogueItems(user.id, id, catalog);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to save user catalog:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to save catalog." });
  }
});

// POST delete specific catalog route
app.post("/api/user/delete-catalog", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { id } = req.body;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Missing or invalid catalog id." });
    }

    const user = await resolveUser(username);
    await db.deleteCatalogue(id);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to delete catalog file:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to delete catalog." });
  }
});

// GET user items database
app.get("/api/user/items", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const user = await resolveUser(username);
    const items = await db.getUserItems(user.id);
    return res.json(items);
  } catch (err: any) {
    console.error("Failed to load user items:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to load items." });
  }
});

// POST user items database
app.post("/api/user/items", async (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "Items must be a valid array." });
    }

    const user = await resolveUser(username);
    await db.saveUserItems(user.id, items);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("Failed to save user items:", err);
    return res.status(err.message.includes("Unauthorized") || err.message.includes("not found") ? 401 : 500).json({ error: err.message || "Failed to save items." });
  }
});

// POST upload scan image route
app.post("/api/user/upload-scan", (req, res) => {
  try {
    const username = req.headers["x-user-header"];
    const { imageBase64 } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(401).json({ error: "Unauthorized. Missing user header." });
    }

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64 data." });
    }

    return res.json({ success: true, imageUrl: imageBase64 });
  } catch (err: any) {
    console.error("Failed to process user scan image:", err);
    return res.status(500).json({ error: err.message || "Failed to process scan image." });
  }
});

// ----------------------------------------
// WEB SERVER STATIC / MIDDLEWARE SETUPS
// WEB SERVER STATIC / MIDDLEWARE SETUPS
// ----------------------------------------

async function setupServer() {
  await initDatabase();

  // Seed/update default appraisal methods
  console.log("Syncing default appraisal methods with database...");
  const client = await pool.connect();
  try {
    console.log("Upserting default appraisal methods into database...");
    for (const config of appraiserConfigs) {
      await client.query(`
        INSERT INTO appraisal_methods (id, name, description, model_name, temperature, prompt_key, prompt_text, image_quality, include_auxiliary_scans, provider, stage1_model, stage1b_model, stage2_model, stage2a_model, stage2b_model, stage3_model, enable_visual_search)
        VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          model_name = EXCLUDED.model_name,
          temperature = EXCLUDED.temperature,
          prompt_key = EXCLUDED.prompt_key,
          image_quality = EXCLUDED.image_quality,
          include_auxiliary_scans = EXCLUDED.include_auxiliary_scans,
          provider = EXCLUDED.provider,
          stage1_model = EXCLUDED.stage1_model,
          stage1b_model = EXCLUDED.stage1b_model,
          stage2_model = EXCLUDED.stage2_model,
          stage2a_model = EXCLUDED.stage2a_model,
          stage2b_model = EXCLUDED.stage2b_model,
          stage3_model = EXCLUDED.stage3_model,
          enable_visual_search = EXCLUDED.enable_visual_search;
      `, [
        config.id,
        config.name,
        config.description,
        config.modelName,
        config.temperature,
        config.promptKey,
        config.imageQuality,
        config.includeAuxiliaryScans,
        config.provider || 'gemini',
        config.stage1Model || null,
        (config as any).stage1bModel || null,
        config.stage2Model || null,
        config.stage2aModel || null,
        config.stage2bModel || null,
        config.stage3Model || null,
        (config as any).enableVisualSearch ?? true,
      ]);
    }
    console.log("✓ Default appraisal methods synchronized.");
  } catch (err) {
    console.error("❌ Failed to sync default appraisal methods:", err);
  } finally {
    client.release();
  }

  if (process.env.NODE_ENV !== "production") {
    // Integrate Vite as a middleware for development
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve production static assets compiled under /dist
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is booted and listening on http://localhost:${PORT}`);
  });
}

setupServer();
