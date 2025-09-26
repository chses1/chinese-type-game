// server/server.js
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";

// === 路徑 ===
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.join(__dirname, "..");

// === 環境變數（本機可用 .env）===
if (!process.env.MONGODB_URI) {
  try {
    const { config } = await import("dotenv");
    config();
    console.log("[dotenv] loaded .env for local dev");
  } catch {
    console.log("[dotenv] dotenv not installed; skip");
  }
}

const app = express();
app.use(express.json());
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

// 健康檢查
app.get("/healthz", (req, res) => res.send("ok"));

// 前端靜態檔案
app.use(express.static(ROOT_DIR));

// === MongoDB ===
const mongoUri = process.env.MONGODB_URI;
const dbName   = process.env.DB_NAME || "zhuyin";

let client, db, students;

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
    await students.createIndex({ sid: 1 }, { unique: true });
    await students.createIndex({ best: -1, updatedAt: -1 });
    console.log("[mongo] connected:", dbName);
  } catch (err) {
    console.error("[mongo] connect failed:", err.message);
  }
}
await initMongo();

function requireDB(res) {
  if (!students) {
    res.status(503).json({ ok: false, error: "db_unavailable", msg: "Database not ready" });
    return false;
  }
  return true;
}

// === 一般 API ===
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

// 支援班級過濾：/api/leaderboard?limit=20&classPrefix=301   // NEW
app.get("/api/leaderboard", async (req, res) => {
  if (!requireDB(res)) return;
  const limit = Math.min(Number(req.query.limit || 10), 100);
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

app.get("/api/student/:sid", async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.params.sid;
  if (!/^\d{5}$/.test(sid)) return res.status(400).json({ ok: false, error: "sid_invalid" });
  const doc = await students.findOne({ sid }, { projection: { _id: 0, sid: 1, best: 1 } });
  res.json({ ok: true, data: { sid, best: Number(doc?.best || 0) } });
});

// 取得現有班級清單與統計（依前三碼分組） // NEW
app.get("/api/classes", async (req, res) => {
  if (!requireDB(res)) return;
  const pipeline = [
    { $project: { _id: 0, sid: 1, best: 1, class: { $substr: ["$sid", 0, 3] } } },
    { $group: { _id: "$class", count: { $sum: 1 }, top: { $max: "$best" }, avg: { $avg: "$best" } } },
    { $project: { class: "$_id", _id: 0, count: 1, top: 1, avg: { $round: ["$avg", 1] } } },
    { $sort: { class: 1 } }
  ];
  const data = await students.aggregate(pipeline).toArray();
  res.json({ ok: true, data });
});

// === 教師權限 ===
const TEACHER_TOKEN = process.env.TEACHER_TOKEN || "1070"; // CHG: 可改環境變數
function adminAuth(req, res, next) {
  const token = req.header("x-teacher-token") || req.query.token;
  if (token !== TEACHER_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// 清除某班
app.post('/api/admin/clear-class', adminAuth, async (req, res) => {
  const { classPrefix, mode } = req.body;
  if (!/^[1-9]\d{2}$/.test(classPrefix)) {
    return res.status(400).json({ ok:false, error:"class_prefix_invalid" });
  }
  try {
    if (mode === "delete") {
      // 刪掉整個班級的紀錄（包含學號）
      await Score.deleteMany({ sid: new RegExp("^" + classPrefix) });
    } else {
      // 只把分數清零
      await Score.updateMany({ sid: new RegExp("^" + classPrefix) }, { $set: { best: 0 } });
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// 清除全部
app.post('/api/admin/clear-all', adminAuth, async (req, res) => {
  const { mode } = req.body;
  try {
    if (mode === "delete") {
      await Score.deleteMany({});
    } else {
      await Score.updateMany({}, { $set: { best: 0 } });
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});


// API 404
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "not_found" }));

// 在其他路由之上加入（確保位於 SPA fallback 前）
app.get("/teacher", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "teacher.html"));
});


// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
