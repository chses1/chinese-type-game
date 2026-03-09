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
app.use(express.json());

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
    await students.createIndex({ best: -1, updatedAt: -1 });
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
          countdownSec: 0
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

// ====== 一般 API ======
app.post("/api/upsert-student", async (req, res) => {
  if (!requireDB(res)) return;
  const { sid, name = "" } = req.body || {};
  if (!/^\d{5}$/.test(String(sid))) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const now = new Date();
  await students.updateOne(
    { sid: String(sid) },
    { $setOnInsert: { best: 0, createdAt: now }, $set: { name, updatedAt: now } },
    { upsert: true }
  );
  const doc = await students.findOne({ sid: String(sid) }, { projection: { _id: 0, sid: 1, name: 1, best: 1 } });
  res.json({ ok: true, data: doc });
});

app.post("/api/update-best", async (req, res) => {
  if (!requireDB(res)) return;
  const { sid, score } = req.body || {};
  if (!/^\d{5}$/.test(String(sid)) || typeof score !== "number") {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  const doc  = await students.findOne({ sid: String(sid) });
  const best = Math.max(Number(doc?.best || 0), Number(score || 0));
  await students.updateOne(
    { sid: String(sid) },
    { $set: { best, updatedAt: new Date() } }
  );
  res.json({ ok: true, data: { sid: String(sid), best } });
});

// 排行榜（支援班級過濾：?limit=50&classPrefix=301）
app.get("/api/leaderboard", async (req, res) => {
  if (!requireDB(res)) return;
  const limit = Math.min(Number(req.query.limit || 10), 500);
  const classPrefix = (req.query.classPrefix || "").trim();
  const filter = {};
  if (/^\d{3}$/.test(classPrefix)) filter.sid = new RegExp("^" + classPrefix);

  const list  = await students
    .find(filter, { projection: { _id: 0, sid: 1, name: 1, best: 1 } })
    .sort({ best: -1, updatedAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ ok: true, data: list });
});

app.post("/api/student/heartbeat", async (req, res) => {
  if (!requireDB(res)) return;
  const { sid, score = 0, status = "online", classroom = false } = req.body || {};
  if (!/^\d{5}$/.test(String(sid))) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const now = new Date();
  await students.updateOne(
    { sid: String(sid) },
    {
      $setOnInsert: { best: 0, createdAt: now },
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
  res.json({ ok: true, data: { sid: String(sid), lastSeenAt: now } });
});

app.get("/api/student/:sid", async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.params.sid;
  if (!/^\d{5}$/.test(sid)) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const doc = await students.findOne({ sid }, { projection: { _id: 0, sid: 1, best: 1 } });
  res.json({ ok: true, data: { sid, best: Number(doc?.best || 0) } });
});

// 班級統計
app.get("/api/classes", async (_req, res) => {
  if (!requireDB(res)) return;
  const pipeline = [
    { $project: { _id: 0, sid: 1, best: 1, class: { $substr: ["$sid", 0, 3] } } },
    { $group:   { _id: "$class", count: { $sum: 1 }, top: { $max: "$best" }, avg: { $avg: "$best" } } },
    { $project: { class: "$_id", _id: 0, count: 1, top: 1, avg: { $round: ["$avg", 1] } } },
    { $sort:    { class: 1 } }
  ];
  const data = await students.aggregate(pipeline).toArray();
  res.json({ ok: true, data });
});

app.get("/api/admin/online-students", adminAuth, async (req, res) => {
  if (!requireDB(res)) return;
  const classPrefix = String(req.query.classPrefix || "").trim();
  const cutoff = new Date(Date.now() - 15000);
  const filter = { lastSeenAt: { $gte: cutoff } };
  if (/^\d{3}$/.test(classPrefix)) filter.sid = new RegExp("^" + classPrefix);

  const list = await students
    .find(filter, {
      projection: { _id: 0, sid: 1, best: 1, currentScore: 1, onlineStatus: 1, inClassroomMode: 1, lastSeenAt: 1, updatedAt: 1 }
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
      projection: { _id: 0, sid: 1, best: 1, currentScore: 1, onlineStatus: 1, inClassroomMode: 1, lastSeenAt: 1 }
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
  countdownSec: 0
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

app.get("/api/classroom/state", async (_req, res) => {
  const s = await normalizeClassroomState();
  res.json({ ok: true, data: { ...s, now: Date.now() } });
});

// ====== 教師權限 ======
const TEACHER_TOKEN = process.env.TEACHER_TOKEN || "1070";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

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

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "").trim();
  if (!password || password !== TEACHER_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const sessionToken = createAdminSession();
  res.json({ ok: true, data: { sessionToken, expiresInMs: ADMIN_SESSION_TTL_MS } });
});

app.post("/api/admin/logout", (req, res) => {
  const sessionToken = getAdminSessionToken(req);
  if (sessionToken) adminSessions.delete(sessionToken);
  res.json({ ok: true });
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
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

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
    countdownSec: 0
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

app.post("/api/admin/classroom/close", adminAuth, async (_req, res) => {
  const state = await writeClassroomState({
    enabled: false,
    classPrefix: "",
    status: "idle",
    startAt: null,
    countdownSec: 0
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
