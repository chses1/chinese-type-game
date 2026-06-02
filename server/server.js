// server/server.js — ESM 版本，支援 "type": "module"
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();

// 目錄定位：同時支援兩種放法
// 1. server.js 放在專案根目錄
// 2. server.js 放在 /server 子資料夾
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = ["index.html", "teacher.html", "main.js", "style.css"].every(name => fs.existsSync(path.join(__dirname, name)))
  ? __dirname
  : path.resolve(__dirname, "..");
const SERVER_DIR = __dirname;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, max, keyFn, message = "too_many_requests" }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = String((keyFn ? keyFn(req) : getClientIp(req)) || "anonymous");
    const row = buckets.get(key);
    if (!row || now >= row.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    row.count += 1;
    if (row.count > max) {
      const retryAfter = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, error: message, retryAfterSec: retryAfter });
    }
    next();
  };
}

const adminLoginRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFn: req => `admin-login:${getClientIp(req)}`,
  message: "too_many_admin_login_attempts"
});

const heartbeatRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: req => `heartbeat:${String(req.header("x-student-session") || req.body?.sid || getClientIp(req))}`,
  message: "heartbeat_rate_limited"
});

const classroomStateRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 90,
  keyFn: req => `classroom-state:${getClientIp(req)}`,
  message: "classroom_state_rate_limited"
});

// 避免教室競賽狀態被瀏覽器或代理快取，造成老師已開啟但前端仍顯示未開啟
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// CORS（有需要再設）
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

// 健康檢查
app.get("/healthz", (_req, res) => res.send("ok"));

// 前端靜態檔案（index.html、teacher.html、JS/CSS…）
app.use(express.static(ROOT_DIR));

// ====== MongoDB ======
const mongoUri = process.env.MONGODB_URI;
const dbName   = process.env.DB_NAME || "zhuyin";

let client, db, students, classroomStates;
const CLASSES_CACHE_TTL_MS = 30000;
let classesCache = { data: null, expiresAt: 0 };

function invalidateClassesCache() {
  classesCache = { data: null, expiresAt: 0 };
}

async function initMongo() {
  if (!mongoUri) {
    console.warn("[mongo] MONGODB_URI not set; API will return 503");
    return;
  }
  try {
    client   = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db       = client.db(dbName);
    students = db.collection("students");
    classroomStates = db.collection("classroom_states");
    await students.createIndex({ sid: 1 }, { unique: true });
    await students.createIndex({ googleSub: 1 }, { unique: true, sparse: true });
    await students.createIndex({ email: 1 });
    await students.createIndex({ classPrefix: 1, seatNo: 1 });
    await students.createIndex({ best: -1, updatedAt: -1 });
    await students.createIndex({ lastSeenAt: -1 });
    await students.createIndex({ sid: 1, lastSeenAt: -1 });
    await students.createIndex({ lastSeenAt: -1, currentScore: -1, best: -1, sid: 1 });
    await classroomStates.createIndex({ key: 1 }, { unique: true });
    await classroomStates.updateOne(
      { key: "global" },
      {
        $setOnInsert: {
          key: "global",
          enabled: false,
          classPrefix: "",
          status: "idle",
          roundId: 0,
          updatedAt: Date.now(),
          startAt: null,
          countdownSec: 0,
          forcedEventId: "",
          forcedEventNonce: 0,
          forcedEventIssuedAt: null,
          forcedMissionId: "",
          forcedMissionNonce: 0,
          forcedMissionIssuedAt: null
        }
      },
      { upsert: true }
    );
    console.log("[mongo] connected:", dbName);
  } catch (err) {
    console.error("[mongo] connect failed:", err.message);
  }
}
initMongo();

function requireDB(res) {
  if (!students) {
    res.status(503).json({ ok: false, error: "db_unavailable", msg: "Database not ready" });
    return false;
  }
  return true;
}

// ====== Google 登入 / Session ======
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "chinese-type-game";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const STUDENT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const studentSessions = new Map();
let firebaseCertCache = { certs: null, expiresAt: 0 };

function getTeacherEmailSet() {
  return new Set(
    String(process.env.TEACHER_EMAILS || "")
      .split(",")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function createSessionToken(prefix = "sess") {
  const salt = SESSION_SECRET || crypto.randomBytes(16).toString("hex");
  return `${prefix}_${crypto.createHmac("sha256", salt).update(crypto.randomBytes(32)).digest("hex")}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of studentSessions.entries()) {
    if (!session || session.expiresAt <= now) studentSessions.delete(token);
  }
}, 10 * 60 * 1000).unref?.();

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    const err = new Error("google_client_id_not_set");
    err.status = 500;
    throw err;
  }
  if (!idToken || typeof idToken !== "string") {
    const err = new Error("missing_id_token");
    err.status = 400;
    throw err;
  }

  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  const resp = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error("google_token_invalid");
    err.status = 401;
    throw err;
  }
  if (data.aud !== GOOGLE_CLIENT_ID || !data.sub || data.email_verified !== "true") {
    const err = new Error("google_token_rejected");
    err.status = 401;
    throw err;
  }

  return {
    googleSub: String(data.sub),
    email: String(data.email || "").toLowerCase(),
    displayName: String(data.name || data.email || ""),
    picture: String(data.picture || "")
  };
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function decodeJwtPart(value) {
  return JSON.parse(base64UrlDecode(value).toString("utf8"));
}

async function getFirebaseCerts() {
  const now = Date.now();
  if (firebaseCertCache.certs && now < firebaseCertCache.expiresAt) return firebaseCertCache.certs;
  const resp = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  const certs = await resp.json();
  if (!resp.ok || !certs || typeof certs !== "object") {
    const err = new Error("firebase_certs_unavailable");
    err.status = 503;
    throw err;
  }
  const maxAgeMatch = String(resp.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 60 * 60 * 1000;
  firebaseCertCache = { certs, expiresAt: now + maxAgeMs };
  return certs;
}

async function verifyFirebaseIdToken(idToken) {
  if (!FIREBASE_PROJECT_ID) {
    const err = new Error("firebase_project_id_not_set");
    err.status = 500;
    throw err;
  }
  if (!idToken || typeof idToken !== "string") {
    const err = new Error("missing_id_token");
    err.status = 400;
    throw err;
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    const err = new Error("firebase_token_malformed");
    err.status = 401;
    throw err;
  }

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  const certs = await getFirebaseCerts();
  const cert = certs[header.kid];
  if (!cert || header.alg !== "RS256") {
    const err = new Error("firebase_token_unknown_key");
    err.status = 401;
    throw err;
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const valid = verifier.verify(cert, base64UrlDecode(parts[2]));
  const nowSec = Math.floor(Date.now() / 1000);
  const issuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
  if (!valid || payload.aud !== FIREBASE_PROJECT_ID || payload.iss !== issuer || !payload.sub || payload.exp <= nowSec || payload.iat > nowSec + 300 || payload.email_verified !== true) {
    const err = new Error("firebase_token_rejected");
    err.status = 401;
    throw err;
  }

  return {
    googleSub: String(payload.sub),
    email: String(payload.email || "").toLowerCase(),
    displayName: String(payload.name || payload.email || ""),
    picture: String(payload.picture || "")
  };
}

async function verifyLoginIdToken(idToken) {
  try {
    return await verifyFirebaseIdToken(idToken);
  } catch (firebaseErr) {
    if (!GOOGLE_CLIENT_ID) throw firebaseErr;
    return verifyGoogleIdToken(idToken);
  }
}

function publicStudent(doc, profile = null) {
  const src = doc || {};
  return {
    sid: src.sid || null,
    classPrefix: src.classPrefix || (src.sid ? String(src.sid).slice(0, 3) : ""),
    seatNo: src.seatNo || (src.sid ? String(src.sid).slice(3, 5) : ""),
    email: src.email || profile?.email || "",
    displayName: src.displayName || profile?.displayName || "",
    picture: src.picture || profile?.picture || "",
    best: Number(src.best || 0),
    bestLevel: Number(src.bestLevel || 0),
    progressLevel: Number(src.progressLevel || src.bestLevel || 0),
    bound: !!src.sid
  };
}

function createStudentSession(profile, doc = null) {
  const sessionToken = createSessionToken("stu");
  studentSessions.set(sessionToken, {
    profile,
    sid: doc?.sid || null,
    expiresAt: Date.now() + STUDENT_SESSION_TTL_MS
  });
  return sessionToken;
}

function getStudentSessionToken(req) {
  return req.header("x-student-session") || req.query.studentSession || "";
}

async function requireStudentAuth(req, res, next) {
  const sessionToken = getStudentSessionToken(req);
  const session = studentSessions.get(sessionToken);
  if (!session) return res.status(401).json({ ok: false, error: "student_unauthorized" });
  if (session.expiresAt <= Date.now()) {
    studentSessions.delete(sessionToken);
    return res.status(401).json({ ok: false, error: "student_session_expired" });
  }
  session.expiresAt = Date.now() + STUDENT_SESSION_TTL_MS;
  let doc = null;
  if (students && session.profile?.googleSub) {
    doc = await students.findOne(
      { googleSub: session.profile.googleSub },
      { projection: { _id: 0 } }
    );
    if (doc?.sid) session.sid = doc.sid;
  }
  req.studentSession = session;
  req.student = publicStudent(doc, session.profile);
  next();
}

// ====== 一般 API ======
app.post("/api/auth/google", async (req, res) => {
  if (!requireDB(res)) return;
  try {
    const profile = await verifyLoginIdToken(req.body?.idToken);
    const now = new Date();
    const doc = await students.findOne({ googleSub: profile.googleSub }, { projection: { _id: 0 } });
    if (doc?.sid) {
      await students.updateOne(
        { googleSub: profile.googleSub },
        { $set: { email: profile.email, displayName: profile.displayName, picture: profile.picture, lastLoginAt: now, updatedAt: now } }
      );
    }
    const refreshed = doc?.sid
      ? await students.findOne({ googleSub: profile.googleSub }, { projection: { _id: 0 } })
      : null;
    const sessionToken = createStudentSession(profile, refreshed);
    res.json({ ok: true, data: { sessionToken, expiresInMs: STUDENT_SESSION_TTL_MS, user: publicStudent(refreshed, profile) } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || "google_login_failed" });
  }
});

app.get("/api/me", requireStudentAuth, async (req, res) => {
  res.json({ ok: true, data: { user: req.student } });
});

app.post("/api/student/bind", requireStudentAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const classPrefix = String(req.body?.classPrefix || "").trim();
  const seatNo = String(req.body?.seatNo || "").trim().padStart(2, "0");
  if (!/^\d{3}$/.test(classPrefix)) return res.status(400).json({ ok: false, error: "class_prefix_invalid" });
  if (!/^\d{2}$/.test(seatNo) || seatNo === "00") return res.status(400).json({ ok: false, error: "seat_no_invalid" });

  const sid = `${classPrefix}${seatNo}`;
  const profile = req.studentSession.profile;
  const now = new Date();
  const current = await students.findOne({ googleSub: profile.googleSub });
  if (current?.sid && current.sid !== sid) {
    return res.status(409).json({ ok: false, error: "google_account_already_bound", sid: current.sid });
  }

  const sidOwner = await students.findOne({ sid });
  if (sidOwner?.googleSub && sidOwner.googleSub !== profile.googleSub) {
    return res.status(409).json({ ok: false, error: "sid_already_bound" });
  }

  await students.updateOne(
    { sid },
    {
      $setOnInsert: { best: 0, bestLevel: 0, progressLevel: 1, createdAt: now },
      $set: {
        googleSub: profile.googleSub,
        email: profile.email,
        displayName: profile.displayName,
        picture: profile.picture,
        classPrefix,
        seatNo,
        name: profile.displayName,
        lastLoginAt: now,
        updatedAt: now
      }
    },
    { upsert: true }
  );
  invalidateClassesCache();
  const doc = await students.findOne({ sid }, { projection: { _id: 0 } });
  req.studentSession.sid = sid;
  res.json({ ok: true, data: { user: publicStudent(doc, profile) } });
});

app.post("/api/upsert-student", async (req, res) => {
  if (!requireDB(res)) return;
  const { sid, name = "" } = req.body || {};
  if (!/^\d{5}$/.test(String(sid))) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const now = new Date();
  await students.updateOne(
    { sid: String(sid) },
    { $setOnInsert: { best: 0, bestLevel: 0, createdAt: now }, $set: { name, updatedAt: now } },
    { upsert: true }
  );
  invalidateClassesCache();
  const doc = await students.findOne({ sid: String(sid) }, { projection: { _id: 0, sid: 1, name: 1, best: 1 } });
  res.json({ ok: true, data: doc });
});

app.post("/api/update-best", requireStudentAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.student.sid;
  const { score, level = 0 } = req.body || {};
  if (!/^\d{5}$/.test(String(sid)) || typeof score !== "number") {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  const numericScore = Number(score || 0);
  const numericLevel = Math.max(0, Number(level || 0));
  const doc  = await students.findOne({ sid: String(sid) });
  const prevBest = Number(doc?.best || 0);
  const prevBestLevel = Number(doc?.bestLevel || 0);

  let nextBest = prevBest;
  let nextBestLevel = prevBestLevel;
  if (numericScore > prevBest) {
    nextBest = numericScore;
    nextBestLevel = numericLevel;
  } else if (numericScore === prevBest && numericScore > 0 && numericLevel > prevBestLevel) {
    nextBestLevel = numericLevel;
  }

  await students.updateOne(
    { sid: String(sid) },
    { $set: { best: nextBest, bestLevel: nextBestLevel, progressLevel: Math.max(numericLevel, Number(doc?.progressLevel || 0)), updatedAt: new Date() } }
  );
  invalidateClassesCache();
  res.json({ ok: true, data: { sid: String(sid), best: nextBest, bestLevel: nextBestLevel } });
});

// 排行榜（支援班級過濾：?limit=50&classPrefix=301）
app.get("/api/leaderboard", async (req, res) => {
  if (!requireDB(res)) return;
  const limit = Math.min(Number(req.query.limit || 10), 500);
  const classPrefix = (req.query.classPrefix || "").trim();
  const filter = {};
  if (/^\d{3}$/.test(classPrefix)) filter.sid = new RegExp("^" + classPrefix);

  const list  = await students
    .find(filter, { projection: { _id: 0, sid: 1, name: 1, displayName: 1, email: 1, classPrefix: 1, seatNo: 1, best: 1, bestLevel: 1, progressLevel: 1, lastSeenAt: 1, lastLoginAt: 1, updatedAt: 1 } })
    .sort({ best: -1, updatedAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ ok: true, data: list });
});

app.post("/api/student/heartbeat", heartbeatRateLimit, requireStudentAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.student.sid;
  const { score = 0, status = "online", classroom = false } = req.body || {};
  if (!/^\d{5}$/.test(String(sid))) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const now = new Date();
  await students.updateOne(
    { sid: String(sid) },
    {
      $setOnInsert: { best: 0, bestLevel: 0, createdAt: now },
      $set: {
        lastSeenAt: now,
        currentScore: Number(score || 0),
        onlineStatus: String(status || "online"),
        inClassroomMode: !!classroom,
        updatedAt: now
      }
    },
    { upsert: true }
  );
  invalidateClassesCache();
  res.json({ ok: true, data: { sid: String(sid), lastSeenAt: now } });
});

app.get("/api/student/:sid", requireStudentAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.params.sid;
  if (!/^\d{5}$/.test(sid)) return res.status(400).json({ ok: false, error: "sid_invalid" });
  if (sid !== req.student.sid) return res.status(403).json({ ok: false, error: "student_forbidden" });
  const doc = await students.findOne({ sid }, { projection: { _id: 0, sid: 1, best: 1, bestLevel: 1 } });
  res.json({ ok: true, data: { sid, best: Number(doc?.best || 0), bestLevel: Number(doc?.bestLevel || 0) } });
});

// 班級統計
app.get("/api/classes", async (req, res) => {
  if (!requireDB(res)) return;
  const forceRefresh = req.query.refresh === "1";
  const now = Date.now();

  if (!forceRefresh && classesCache.data && now < classesCache.expiresAt) {
    return res.json({ ok: true, data: classesCache.data, cached: true, cacheTtlMs: Math.max(0, classesCache.expiresAt - now) });
  }

  const pipeline = [
    { $project: { _id: 0, sid: 1, best: 1, class: { $substr: ["$sid", 0, 3] } } },
    { $group:   { _id: "$class", count: { $sum: 1 }, top: { $max: "$best" }, avg: { $avg: "$best" } } },
    { $project: { class: "$_id", _id: 0, count: 1, top: 1, avg: { $round: ["$avg", 1] } } },
    { $sort:    { class: 1 } }
  ];
  const data = await students.aggregate(pipeline).toArray();
  classesCache = { data, expiresAt: now + CLASSES_CACHE_TTL_MS };
  res.json({ ok: true, data, cached: false, cacheTtlMs: CLASSES_CACHE_TTL_MS });
});

app.get("/api/admin/online-students", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const classPrefix = String(req.query.classPrefix || "").trim();
  const cutoff = new Date(Date.now() - 15000);
  const filter = { lastSeenAt: { $gte: cutoff } };
  if (/^\d{3}$/.test(classPrefix)) filter.sid = new RegExp("^" + classPrefix);

  const list = await students
    .find(filter, {
      projection: { _id: 0, sid: 1, name: 1, displayName: 1, email: 1, classPrefix: 1, seatNo: 1, best: 1, bestLevel: 1, progressLevel: 1, currentScore: 1, onlineStatus: 1, inClassroomMode: 1, lastSeenAt: 1, lastLoginAt: 1, updatedAt: 1 }
    })
    .sort({ sid: 1 })
    .limit(200)
    .toArray();

  res.json({ ok: true, data: list });
});

app.get("/api/admin/live-leaderboard", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const classPrefix = String(req.query.classPrefix || "").trim();
  const cutoff = new Date(Date.now() - 15000);
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const filter = { lastSeenAt: { $gte: cutoff } };
  if (/^\d{3}$/.test(classPrefix)) filter.sid = new RegExp("^" + classPrefix);

  const list = await students
    .find(filter, {
      projection: { _id: 0, sid: 1, name: 1, displayName: 1, email: 1, classPrefix: 1, seatNo: 1, best: 1, bestLevel: 1, progressLevel: 1, currentScore: 1, onlineStatus: 1, inClassroomMode: 1, lastSeenAt: 1, lastLoginAt: 1 }
    })
    .sort({ currentScore: -1, best: -1, sid: 1 })
    .limit(limit)
    .toArray();

  res.json({ ok: true, data: list });
});

// ====== 教室競賽狀態（Mongo 優先；無 DB 時退回單機記憶體） ======
const classroomState = {
  enabled: false,
  classPrefix: "",
  status: "idle", // idle | countdown | running | paused
  roundId: 0,
  updatedAt: Date.now(),
  startAt: null,
  countdownSec: 0,
  forcedEventId: "",
  forcedEventNonce: 0,
  forcedEventIssuedAt: null,
  forcedMissionId: "",
  forcedMissionNonce: 0,
  forcedMissionIssuedAt: null
};

async function readClassroomState() {
  if (classroomStates) {
    const doc = await classroomStates.findOne({ key: "global" }, { projection: { _id: 0, key: 0 } });
    if (doc) Object.assign(classroomState, doc);
  }
  return classroomState;
}

async function writeClassroomState(patch = {}) {
  Object.assign(classroomState, patch, { updatedAt: Date.now() });
  if (classroomStates) {
    await classroomStates.updateOne(
      { key: "global" },
      { $set: { key: "global", ...classroomState } },
      { upsert: true }
    );
  }
  return classroomState;
}

async function normalizeClassroomState() {
  const s = await readClassroomState();
  if (s.enabled && s.status === "countdown" && s.startAt && Date.now() >= s.startAt) {
    await writeClassroomState({ status: "running" });
  }
  return classroomState;
}

app.get("/api/classroom/state", classroomStateRateLimit, async (_req, res) => {
  const s = await normalizeClassroomState();
  res.json({ ok: true, data: { ...s, now: Date.now() } });
});

// ====== 教師權限 ======
const TEACHER_TOKEN = process.env.TEACHER_TOKEN;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) adminSessions.delete(token);
  }
}, 10 * 60 * 1000).unref?.();

function createAdminSession() {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  adminSessions.set(sessionToken, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return sessionToken;
}

function getAdminSessionToken(req) {
  return req.header("x-admin-session") || req.query.session || "";
}

function adminAuth(req, res, next) {
  const sessionToken = getAdminSessionToken(req);
  const session = adminSessions.get(sessionToken);
  if (!session) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(sessionToken);
    return res.status(401).json({ ok: false, error: "session_expired" });
  }
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  next();
}

app.post("/api/admin/login", adminLoginRateLimit, (req, res) => {
  if (!TEACHER_TOKEN) {
    return res.status(500).json({ ok: false, error: "teacher_token_not_set" });
  }

  const password = String(req.body?.password || "").trim();
  if (!password || password !== TEACHER_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const sessionToken = createAdminSession();
  res.json({ ok: true, data: { sessionToken, expiresInMs: ADMIN_SESSION_TTL_MS } });
});

app.post("/api/admin/google-login", adminLoginRateLimit, async (req, res) => {
  try {
    const profile = await verifyLoginIdToken(req.body?.idToken);
    const teacherEmails = getTeacherEmailSet();
    if (!teacherEmails.size) {
      return res.status(500).json({ ok: false, error: "teacher_emails_not_set" });
    }
    if (!teacherEmails.has(profile.email)) {
      return res.status(403).json({ ok: false, error: "teacher_email_not_allowed" });
    }
    const sessionToken = createAdminSession();
    res.json({ ok: true, data: { sessionToken, expiresInMs: ADMIN_SESSION_TTL_MS, teacher: profile } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message || "teacher_google_login_failed" });
  }
});

// 清除某班（刪除 or 歸零）
app.post("/api/admin/clear-class", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const mode = String(req.body?.mode || "").trim();
  const classPrefix = String(req.body?.classPrefix || "").trim();
  if (!/^\d{3}$/.test(classPrefix)) {
    return res.status(400).json({ ok:false, error:"class_prefix_invalid", got: classPrefix });
  }
  try {
    const filter = { sid: new RegExp("^" + classPrefix) };
    if (mode === "delete") {
      await students.deleteMany(filter);
    } else {
      await students.updateMany(filter, { $set: { best: 0 } });
    }
    invalidateClassesCache();
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// 清除全部（刪除 or 歸零）
app.post("/api/admin/clear-all", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const mode = String(req.body?.mode || "").trim();
  try {
    if (mode === "delete") {
      await students.deleteMany({});
    } else {
      await students.updateMany({}, { $set: { best: 0 } });
    }
    invalidateClassesCache();
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});


// 刪除個別學生成績（刪除整筆學生資料）
app.post("/api/admin/delete-student", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const sid = String(req.body?.sid || "").trim();
  if (!/^\d{5}$/.test(sid)) {
    return res.status(400).json({ ok:false, error:"sid_invalid", got:sid });
  }
  try {
    const result = await students.deleteOne({ sid });
    invalidateClassesCache();
    if (!result.deletedCount) {
      return res.status(404).json({ ok:false, error:"student_not_found", sid });
    }
    res.json({ ok:true, data:{ sid } });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

const ALLOWED_CLASSROOM_EVENTS = new Set(["meteorShower", "iceWind", "goldRush", "bossWave"]);
const ALLOWED_CLASSROOM_MISSIONS = new Set(["goldHunter", "iceBreaker", "comboMaster", "quickShot", "bossBreaker", "random"]);

// ====== 教室競賽控制 API ======
app.post("/api/admin/classroom/open", adminAuth, async (req, res) => {
  const classPrefix = String(req.body?.classPrefix || "").trim();
  if (!/^\d{3}$/.test(classPrefix)) {
    return res.status(400).json({ ok:false, error:"class_prefix_invalid", got: classPrefix });
  }
  const state = await writeClassroomState({
    enabled: true,
    classPrefix,
    status: "idle",
    startAt: null,
    countdownSec: 0,
    forcedEventId: "",
    forcedEventNonce: 0,
    forcedEventIssuedAt: null,
    forcedMissionId: "",
    forcedMissionNonce: 0,
    forcedMissionIssuedAt: null
  });
  console.log(`[classroom] open class=${classPrefix}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/start", adminAuth, async (req, res) => {
  await readClassroomState();
  const classPrefix = String(req.body?.classPrefix || classroomState.classPrefix || "").trim();
  const countdownSec = Math.max(1, Math.min(Number(req.body?.countdownSec || 3), 10));
  if (!/^\d{3}$/.test(classPrefix)) {
    return res.status(400).json({ ok:false, error:"class_prefix_invalid", got: classPrefix });
  }

  if (classroomState.enabled && classroomState.classPrefix === classPrefix && classroomState.status === "paused") {
    const state = await writeClassroomState({
      enabled: true,
      classPrefix,
      status: "running",
      countdownSec: 0,
      startAt: null
    });
    console.log(`[classroom] resume class=${classPrefix} round=${state.roundId}`);
    return res.json({ ok:true, data: { ...state, resumed: true } });
  }

  const state = await writeClassroomState({
    enabled: true,
    classPrefix,
    status: "countdown",
    countdownSec,
    startAt: Date.now() + countdownSec * 1000,
    roundId: Number(classroomState.roundId || 0) + 1
  });
  console.log(`[classroom] start class=${classPrefix} countdown=${countdownSec}s round=${state.roundId}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/pause", adminAuth, async (_req, res) => {
  const current = await normalizeClassroomState();
  if (!current.enabled) return res.status(400).json({ ok:false, error:"classroom_not_open" });
  const state = await writeClassroomState({
    status: "paused",
    startAt: null,
    countdownSec: 0
  });
  console.log(`[classroom] pause class=${state.classPrefix}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/restart", adminAuth, async (req, res) => {
  await readClassroomState();
  const countdownSec = Math.max(1, Math.min(Number(req.body?.countdownSec || 3), 10));
  if (!classroomState.enabled || !/^\d{3}$/.test(classroomState.classPrefix)) {
    return res.status(400).json({ ok:false, error:"classroom_not_open" });
  }
  const state = await writeClassroomState({
    status: "countdown",
    countdownSec,
    startAt: Date.now() + countdownSec * 1000,
    roundId: Number(classroomState.roundId || 0) + 1
  });
  console.log(`[classroom] restart class=${state.classPrefix} countdown=${countdownSec}s round=${state.roundId}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/trigger-event", adminAuth, async (req, res) => {
  await readClassroomState();
  if (!classroomState.enabled || !/^\d{3}$/.test(classroomState.classPrefix)) {
    return res.status(400).json({ ok:false, error:"classroom_not_open" });
  }
  const eventId = String(req.body?.eventId || "").trim();
  if (!ALLOWED_CLASSROOM_EVENTS.has(eventId)) {
    return res.status(400).json({ ok:false, error:"event_invalid", got: eventId });
  }
  const state = await writeClassroomState({
    forcedEventId: eventId,
    forcedEventNonce: Number(classroomState.forcedEventNonce || 0) + 1,
    forcedEventIssuedAt: Date.now()
  });
  console.log(`[classroom] trigger-event class=${state.classPrefix} event=${eventId} nonce=${state.forcedEventNonce}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/assign-mission", adminAuth, async (req, res) => {
  await readClassroomState();
  if (!classroomState.enabled || !/^\d{3}$/.test(classroomState.classPrefix)) {
    return res.status(400).json({ ok:false, error:"classroom_not_open" });
  }
  const missionId = String(req.body?.missionId || "").trim();
  if (!ALLOWED_CLASSROOM_MISSIONS.has(missionId)) {
    return res.status(400).json({ ok:false, error:"mission_invalid", got: missionId });
  }
  const state = await writeClassroomState({
    forcedMissionId: missionId,
    forcedMissionNonce: Number(classroomState.forcedMissionNonce || 0) + 1,
    forcedMissionIssuedAt: Date.now()
  });
  console.log(`[classroom] assign-mission class=${state.classPrefix} mission=${missionId} nonce=${state.forcedMissionNonce}`);
  res.json({ ok:true, data: { ...state } });
});

app.post("/api/admin/classroom/close", adminAuth, async (_req, res) => {
  const state = await writeClassroomState({
    enabled: false,
    classPrefix: "",
    status: "idle",
    startAt: null,
    countdownSec: 0,
    forcedEventId: "",
    forcedEventNonce: 0,
    forcedEventIssuedAt: null,
    forcedMissionId: "",
    forcedMissionNonce: 0,
    forcedMissionIssuedAt: null
  });
  console.log(`[classroom] close`);
  res.json({ ok:true, data: { ...state } });
});

// API 404
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "not_found" }));

// 教師後台頁
app.get("/teacher", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "teacher.html"));
});

// SPA fallback（其餘路由丟給前端 index.html）
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// 啟動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
