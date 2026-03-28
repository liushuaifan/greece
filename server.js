/**
 * Letters to the Unfinished — Backend Server
 * Node.js + Express + sql.js
 * 使用豆包（字节跳动）API
 */

const express   = require('express');
const https     = require('https');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const initSqlJs = require('sql.js');

const PORT    = process.env.PORT || 3000;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'letters.db');

// ── 豆包 API 配置 ─────────────────────────────────────────
// 在这里填入你的豆包 API Key 和模型ID
// 获取地址：https://console.volcengine.com/ark
const DOUBAO_API_KEY   = process.env.DOUBAO_API_KEY   || '5ee9275f-f636-4122-ada9-2a4d0685b32d';
const DOUBAO_MODEL     = process.env.DOUBAO_MODEL     || 'doubao-1-5-lite-32k-250115';

// ── HELPERS ───────────────────────────────────────────────
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + 'letters-2025').digest('hex').slice(0, 16);
}
function detectLang(text) { return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en'; }
function isoNow() { return new Date().toISOString().slice(0,19)+'Z'; }
function formatDateZh(iso) {
  try {
    const d = new Date(iso);
    const m = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    return `公元${d.getFullYear()}年 · ${m[d.getMonth()]}`;
  } catch { return '未知时间'; }
}

// ── DB ────────────────────────────────────────────────────
let db;
function saveDb() {
  try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }
  catch(e) { console.error('DB save error:', e.message); }
}
function rowsOf(res) {
  if (!res[0]) return [];
  return res[0].values.map(row => {
    const obj = {};
    res[0].columns.forEach((c,i) => obj[c] = row[i]);
    return obj;
  });
}

async function bootstrap() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Anonymous Traveller',
    text TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'zh',
    created_at TEXT NOT NULL DEFAULT '',
    ip_hash TEXT,
    approved INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ca ON letters(created_at DESC)`);
  db.run(`CREATE TABLE IF NOT EXISTS chatlogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    messages TEXT NOT NULL,
    arch_eval TEXT,
    completed_at TEXT NOT NULL DEFAULT ''
  )`);

  const n = db.exec('SELECT COUNT(*) FROM letters')[0]?.values[0][0] ?? 0;
  if (n === 0) {
    const s = db.prepare('INSERT INTO letters(name,text,lang,created_at) VALUES(?,?,?,?)');
    [
      ['Alex R.',      'The stones remember what the books forgot. I came to listen.',                        'en','2025-03-01T08:00:00Z'],
      ['Sofia K.',     'To stand where you might have stood — that is enough.',                              'en','2025-03-03T10:00:00Z'],
      ['James M.',     'Unfinished does not mean forgotten. We are here.',                                   'en','2025-03-05T12:00:00Z'],
      ['Yuki M.',      'You never stood, yet you move me more than any completed temple.',                   'en','2025-03-08T09:00:00Z'],
      ['Anonymous',    'Every ruin is a question the past left open for us to answer.',                      'en','2025-03-10T14:00:00Z'],
      ['Elena V.',     'The fire took your walls, but not your meaning.',                                    'en','2025-03-12T16:00:00Z'],
      ['David L.',     'Two thousand years of silence — and still you speak.',                               'en','2025-03-15T11:00:00Z'],
      ['Mia T.',       'What was lost to flame lives on in those who choose to remember.',                   'en','2025-03-18T08:30:00Z'],
    ].forEach(r => s.run(r));
    s.free();
    saveDb();
    console.log('✓  已写入示例留言');
  }

  setInterval(saveDb, 30_000);
}

// ── EXPRESS ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.resolve(__dirname, 'public')));

// ── API ROUTES ────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const total = db.exec('SELECT COUNT(*) FROM letters WHERE approved=1')[0]?.values[0][0] ?? 0;
  res.json({ status: 'ok', letters: total, model: DOUBAO_MODEL });
});

app.get('/api/letters', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)||9, 200);
  const page   = Math.max(parseInt(req.query.page)||1, 1);
  const offset = (page-1)*limit;
  const total  = db.exec('SELECT COUNT(*) FROM letters WHERE approved=1')[0]?.values[0][0]??0;
  const rows   = rowsOf(db.exec(
    `SELECT id,name,text,lang,created_at FROM letters WHERE approved=1 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  ));
  res.json({ letters: rows.map(r=>({...r, display_date:formatDateZh(r.created_at)})), pagination:{total,page,limit,pages:Math.ceil(total/limit)} });
});

app.post('/api/letters', (req, res) => {
  const { name, text } = req.body||{};
  if (!text||typeof text!=='string') return res.status(400).json({error:'Please enter your letter.'});
  const t = text.trim();
  if (t.length<2)   return res.status(400).json({error:'Too short — please write more.'});
  if (t.length>200) return res.status(400).json({error:'Letters cannot exceed 200 characters.'});
  const n      = (name||'').trim().slice(0,40)||'Anonymous Traveller';
  const ip     = ((req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.ip||'0.0.0.0');
  const ipHash = hashIp(ip);
  const tenAgo = new Date(Date.now()-600_000).toISOString().slice(0,19)+'Z';
  const recent = db.exec(`SELECT COUNT(*) FROM letters WHERE ip_hash='${ipHash}' AND created_at>'${tenAgo}'`)[0]?.values[0][0]??0;
  if (recent>=5) return res.status(429).json({error:'Please wait a moment before trying again.'});
  try {
    const now=isoNow();
    db.run('INSERT INTO letters(name,text,lang,created_at,ip_hash) VALUES(?,?,?,?,?)',[n,t,detectLang(t),now,ipHash]);
    saveDb();
    const id=db.exec('SELECT last_insert_rowid()')[0]?.values[0][0];
    res.status(201).json({letter:{id,name:n,text:t,created_at:now,display_date:formatDateZh(now)}});
  } catch(err){ res.status(500).json({error:'Server error.'}); }
});

// ── 豆包 AI 代理 ──────────────────────────────────────────
// 豆包 API 兼容 OpenAI 格式，endpoint: ark.cn-beijing.volces.com
app.post('/api/chat', (req, res) => {
  const { messages, system } = req.body || {};
  if (!DOUBAO_API_KEY || DOUBAO_API_KEY === 'PASTE_YOUR_DOUBAO_KEY_HERE') {
    return res.status(503).json({ error: '请在 server.js 顶部填入豆包 API Key' });
  }
  if (!messages||!Array.isArray(messages)) return res.status(400).json({error:'messages required'});

  // 豆包使用 OpenAI 兼容格式，system 作为第一条消息
  const fullMessages = system
    ? [{ role: 'system', content: system }, ...messages.slice(-10)]
    : messages.slice(-10);

  const body = JSON.stringify({
    model: DOUBAO_MODEL,
    max_tokens: 600,
    messages: fullMessages,
  });

  const options = {
    hostname: 'ark.cn-beijing.volces.com',
    path: '/api/v3/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DOUBAO_API_KEY}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', () => {
      console.log('[豆包] status:', proxyRes.statusCode, '| body:', data.slice(0, 300));
      try {
        const parsed = JSON.parse(data);
        if (parsed.choices && parsed.choices[0]) {
          // 成功：转换为前端期望的格式
          res.json({
            content: [{ type: 'text', text: parsed.choices[0].message.content }]
          });
        } else if (parsed.error) {
          // 豆包返回错误
          console.error('[豆包] API error:', parsed.error);
          res.status(proxyRes.statusCode).json({ error: parsed.error.message || JSON.stringify(parsed.error) });
        } else {
          res.status(proxyRes.statusCode).json({ error: '豆包返回了未知格式', raw: data.slice(0,200) });
        }
      } catch(e) {
        res.status(500).json({ error: '豆包API响应解析失败', raw: data.slice(0,200) });
      }
    });
  });
  proxyReq.on('error', e => {
    console.error('[豆包] 连接失败:', e.message);
    res.status(500).json({ error: '无法连接到豆包服务器: ' + e.message });
  });
  proxyReq.write(body);
  proxyReq.end();
});

// ── 对话存储 ──────────────────────────────────────────────
app.post('/api/conversation', (req, res) => {
  const { messages, arch_eval, completed_at, name } = req.body||{};
  if (!messages||!Array.isArray(messages)) return res.status(400).json({error:'messages required'});
  try {
    db.run('INSERT INTO conversations(name,messages,arch_eval,completed_at) VALUES(?,?,?,?)',
      [name||'Traveller', JSON.stringify(messages), arch_eval||'', completed_at||isoNow()]);
    saveDb();
    const id=db.exec('SELECT last_insert_rowid()')[0]?.values[0][0];
    res.status(201).json({ok:true,id});
  } catch(e){ res.status(500).json({error:'Failed to save.'}); }
});

app.get('/api/conversations', (req, res) => {
  const limit=Math.min(parseInt(req.query.limit)||50,100);
  try {
    const rows=db.exec(`SELECT id,name,messages,arch_eval,completed_at FROM conversations ORDER BY completed_at DESC LIMIT ${limit}`);
    const convs=rows[0]?rows[0].values.map(r=>({
      id:r[0], name:r[1],
      messages:(()=>{try{return JSON.parse(r[2]||'[]');}catch(e){return[];}})(),
      arch_eval:r[3], completed_at:r[4],
    })):[];
    res.json({conversations:convs});
  } catch(e){ res.json({conversations:[]}); }
});

app.post('/api/chatlog', (req, res) => {
  const { log } = req.body||{};
  if (log) {
    try { db.run('INSERT INTO chatlogs(log,created_at) VALUES(?,?)',[log.slice(0,5000),isoNow()]); saveDb(); }
    catch(e){}
  }
  res.json({ok:true});
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({error:'not found'});
  res.sendFile(path.resolve(__dirname,'public','index.html'));
});

// ── 启动 ──────────────────────────────────────────────────
bootstrap().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   致未竟之作 · 服务器已启动                   ║
║   http://localhost:${PORT}                      ║
║   AI模型: ${DOUBAO_MODEL.padEnd(25)}║
╚══════════════════════════════════════════════╝`);
    if (DOUBAO_API_KEY === 'PASTE_YOUR_DOUBAO_KEY_HERE') {
      console.warn('⚠️  请在 server.js 顶部填入豆包 API Key！');
    }
  });
}).catch(e => { console.error('启动失败:', e); process.exit(1); });