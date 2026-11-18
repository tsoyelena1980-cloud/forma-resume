const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { generate } = require('./lib/generate');

const root = path.join(__dirname, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const kinds = ['summary', 'cover', 'recommendation', 'analysis', 'sample', 'translate'];
const keyFile = path.join(__dirname, 'data', 'openai-key.txt');
let apiKey = process.env.OPENAI_API_KEY || '';
try {
  if (!apiKey && fs.existsSync(keyFile)) apiKey = fs.readFileSync(keyFile, 'utf8').trim();
} catch { /* ключ можно ввести в форме */ }

function saveApiKey(value) {
  apiKey = String(value || '').trim();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  if (!apiKey) {
    fs.rmSync(keyFile, { force: true });
    return;
  }
  fs.writeFileSync(keyFile, apiKey, { mode: 0o600 });
}

async function readBody(req, limit) {
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > limit) {
      const error = new Error('too large');
      error.status = 413;
      throw error;
    }
  }
  return body;
}
const templates = ['classic', 'modern', 'creative', 'ats-minimal', 'rail', 'folio', 'band', 'timeline'];

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clipBlock(value, max) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function parseModelJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('ИИ не вернул образец в нужном формате');
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeSample(source) {
  const jobs = (Array.isArray(source.jobs) ? source.jobs : []).slice(0, 4).map(job => ({
    company: clip(job.company, 120),
    position: clip(job.position, 120),
    start: clip(job.start, 24),
    end: clip(job.end, 24),
    details: clipBlock(job.details, 800)
  })).filter(job => job.company || job.position || job.details);
  const schools = (Array.isArray(source.schools) ? source.schools : []).slice(0, 3).map(school => ({
    school: clip(school.school, 160),
    degree: clip(school.degree, 160),
    start: clip(school.start, 12),
    end: clip(school.end, 12)
  })).filter(school => school.school || school.degree);
  const sample = {
    firstName: clip(source.firstName, 60),
    lastName: clip(source.lastName, 60),
    middleName: clip(source.middleName, 60),
    role: clip(source.role, 120),
    email: clip(source.email, 120),
    phone: clip(source.phone, 40),
    country: clip(source.country, 80),
    city: clip(source.city, 80),
    summary: clipBlock(source.summary, 900),
    skills: clip(source.skills, 400),
    vacancy: clip(source.vacancy, 500),
    cover: clipBlock(source.cover, 1800),
    jobs,
    schools,
    template: templates.includes(source.template) ? source.template : 'folio'
  };
  if (!sample.role || !sample.summary || !jobs.length) throw new Error('Образец получился неполным. Повторите запрос.');
  return sample;
}

function normalizeTranslate(source) {
  const jobs = (Array.isArray(source.jobs) ? source.jobs : []).slice(0, 8).map(job => ({
    company: clip(job.company, 120),
    position: clip(job.position, 120),
    start: clip(job.start, 24),
    end: clip(job.end, 24),
    details: clipBlock(job.details, 800)
  }));
  const schools = (Array.isArray(source.schools) ? source.schools : []).slice(0, 6).map(school => ({
    school: clip(school.school, 160),
    degree: clip(school.degree, 160),
    start: clip(school.start, 12),
    end: clip(school.end, 12)
  }));
  return {
    role: clip(source.role, 120),
    summary: clipBlock(source.summary, 900),
    skills: clip(source.skills, 400),
    vacancy: clip(source.vacancy, 500),
    cover: clipBlock(source.cover, 1800),
    recommendation: clipBlock(source.recommendation, 1800),
    city: clip(source.city, 80),
    country: clip(source.country, 80),
    address: clip(source.address, 160),
    jobs,
    schools
  };
}

function safeError(message) {
  return String(message || 'Ошибка сервиса ИИ')
    .replace(/AQ\.[A-Za-z0-9._-]{8,}/g, 'ключ')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, 'ключ')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'ключ')
    .slice(0, 300);
}

async function completeText(instructions, input, maxTokens) {
  if (/^(AQ\.|AIza)/.test(apiKey)) {
    const models = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash').split(',').map(item => item.trim()).filter(Boolean);
    let last = 'Сервис Gemini сейчас перегружен. Повторите через минуту.';
    for (const model of models) {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
          generationConfig: { maxOutputTokens: maxTokens }
        })
      });
      const data = await response.json();
      if (response.status === 503 || response.status === 429) continue;
      if (response.status === 404) continue;
      if (!response.ok) throw Error(safeError(data.error?.message || 'Ошибка Gemini'));
      const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('\n').trim();
      if (!text) throw Error('ИИ вернул пустой ответ. Повторите запрос.');
      return text;
    }
    throw Error(last);
  }
  const response = await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions,
      input,
      max_output_tokens: maxTokens
    })
  });
  const data = await response.json();
  if (!response.ok) throw Error(safeError(data.error?.message || 'Ошибка сервиса ИИ'));
  return (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') || data.output_text || '';
}

function samplePreview(sample) {
  const jobs = sample.jobs.map(job => [job.position, job.company, [job.start, job.end].filter(Boolean).join(' — '), job.details].filter(Boolean).join('\n')).join('\n\n');
  const schools = sample.schools.map(school => [school.degree, school.school, [school.start, school.end].filter(Boolean).join(' — ')].filter(Boolean).join(', ')).join('\n');
  return [
    'Вымышленный образец. После применения замените его своими данными.',
    '',
    [sample.lastName, sample.firstName, sample.middleName].filter(Boolean).join(' '),
    sample.role,
    [sample.city, sample.country, sample.email, sample.phone].filter(Boolean).join(' · '),
    '',
    sample.summary,
    '',
    'Опыт',
    jobs,
    '',
    'Образование',
    schools,
    '',
    'Навыки',
    sample.skills
  ].join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/key' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      if (req.method === 'POST') {
        const payload = JSON.parse(await readBody(req, 4000) || '{}');
        saveApiKey(payload.key);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ configured: Boolean(apiKey) }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Не удалось сохранить ключ' }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    let body = '';
    try { body = await readBody(req, 150000); } catch {
      res.writeHead(413).end();
      return;
    }
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400).end('Invalid JSON');
      return;
    }
    try {
      const result = await generate(payload, apiKey);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.status || 502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, buf) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    }).end(buf);
  });
});

if (require.main === module) {
  server.listen(process.env.PORT || 3000, () => console.log('Откройте http://localhost:' + (process.env.PORT || 3000)));
}
module.exports = server;
