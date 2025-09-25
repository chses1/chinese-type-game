// server/server.js
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";

// === 路徑設定：server 在 /server，前端檔案在專案根目錄 ===
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.join(__dirname, ".."); // <-- 重要：指向專案根目錄

// === 本機可選載入 .env（Render 不需要安裝 dotenv 也不會炸） ===
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

// 只有前後端不同網域時才需要 CORS
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

// 健康檢查
app.get("/healthz", (req, res) => res.send("ok"));

// 提供前端靜態檔案（index.html / main.js / style.css / img/*）
app.use(express.static(ROOT_DIR));

// === MongoDB 連線 ===
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

// === API: 建立/更新學生 ===
app.post("/api/upsert-student", async (req, res) => {
  if (!requireDB(res)) return;
  const { sid, name = "" } = req.body || {};
  if (!/^\d{5}$/.test(String(sid))) {
    return res.status(400).json({ ok: false, error: "sid_invalid" });
  }
  const now = new Date();
  await students.updateOne(
    { sid: String(sid) },
    { $setOnInsert: { best: 0, createdAt: now }, $set: { name, updatedAt: now } },
    { upsert: true }
  );
  const doc = await students.findOne({ sid: String(sid) });
  res.json({ ok: true, data: { sid: doc.sid, name: doc.name, best: doc.best } });
});

// === API: 更新最佳分數 ===
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

// === API: 排行榜 ===
app.get("/api/leaderboard", async (req, res) => {
  if (!requireDB(res)) return;
  const limit = Math.min(Number(req.query.limit || 10), 100);
  const list  = await students
    .find({}, { projection: { _id: 0, sid: 1, name: 1, best: 1 } })
    .sort({ best: -1, updatedAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ ok: true, data: list });
});

// === API: 查單一學生 ===
app.get("/api/student/:sid", async (req, res) => {
  if (!requireDB(res)) return;
  const sid = req.params.sid;
  if (!/^\d{5}$/.test(sid)) {
    return res.status(400).json({ ok: false, error: "sid_invalid" });
  }
  const doc = await students.findOne({ sid });
  res.json({ ok: true, data: { sid, best: Number(doc?.best || 0) } });
});

// === API 未命中時回 404（避免被 SPA fallback 吃掉） ===
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

// === SPA fallback：只處理非 /api/* 路徑 ===
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

// === 啟動 ===
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on :${port}`));
