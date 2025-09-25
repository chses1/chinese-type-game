import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(express.json());
app.use(helmet());
app.use(compression());
app.use(morgan('tiny'));

const ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: ORIGIN }));

// 基本限流，避免暴力灌分
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600 }));

// Mongo 連線
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}
await mongoose.connect(MONGODB_URI, { dbName: process.env.DB_NAME || 'zhuyin' });

// Schema：用 sid（五碼座號）做唯一索引，best 存最佳分數
const scoreSchema = new mongoose.Schema({
  sid: { type: String, required: true, index: true, unique: true },
  name: { type: String, default: '' },
  best: { type: Number, default: 0 }
}, { timestamps: true });

const Score = mongoose.model('scores', scoreSchema);

// 健康檢查
app.get('/healthz', (req, res) => res.send('ok'));

// Upsert 學生（登入時建立/更新名稱，可選）
app.post('/api/upsert-student', async (req, res) => {
  try {
    const { sid, name = '' } = req.body || {};
    if (!/^\d{5}$/.test(sid)) return res.status(400).json({ error: 'sid invalid' });
    const doc = await Score.findOneAndUpdate(
      { sid },
      { $setOnInsert: { sid }, $set: { name } },
      { new: true, upsert: true }
    );
    res.json({ ok: true, data: { sid: doc.sid, name: doc.name, best: doc.best } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 更新最佳（僅提升不下降）
app.post('/api/update-best', async (req, res) => {
  try {
    const { sid, score } = req.body || {};
    if (!/^\d{5}$/.test(sid)) return res.status(400).json({ error: 'sid invalid' });
    if (!Number.isFinite(score)) return res.status(400).json({ error: 'score invalid' });

    const doc = await Score.findOneAndUpdate(
      { sid, best: { $lt: score } },
      { $set: { best: score } },
      { new: true }
    );

    // 若沒有更好成績，就回傳現況
    const finalDoc = doc || await Score.findOne({ sid });
    res.json({ ok: true, data: { sid: finalDoc.sid, name: finalDoc.name, best: finalDoc.best } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 排行榜（預設前 20）
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await Score.find({}, { _id: 0, __v: 0 })
      .sort({ best: -1, updatedAt: 1 }).limit(limit).lean();
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on :${PORT}`));
