const kinds = ['summary', 'cover', 'recommendation', 'analysis', 'sample', 'translate'];
const templates = ['classic', 'modern', 'creative', 'ats-minimal', 'rail', 'folio', 'band', 'timeline'];

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clipBlock(value, max) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeError(message) {
  return String(message || 'Ошибка сервиса ИИ')
    .replace(/AQ\.[A-Za-z0-9._-]{8,}/g, 'ключ')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, 'ключ')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'ключ')
    .slice(0, 300);
}

function parseModelJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('ИИ не вернул образец в нужном формате', 502);
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
  if (!sample.role || !sample.summary || !jobs.length) throw fail('Образец получился неполным. Повторите запрос.', 502);
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

async function completeText(apiKey, instructions, input, maxTokens) {
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
      if (!response.ok) throw fail(safeError(data.error?.message || 'Ошибка Gemini'), 502);
      const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('\n').trim();
      if (!text) throw fail('ИИ вернул пустой ответ. Повторите запрос.', 502);
      return text;
    }
    throw fail(last, 502);
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
  if (!response.ok) throw fail(safeError(data.error?.message || 'Ошибка сервиса ИИ'), 502);
  return (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') || data.output_text || '';
}

async function generate(payload, fallbackKey) {
  const apiKey = String(payload?.apiKey || fallbackKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw fail('Вставьте ключ Google AI Studio или OpenAI в поле над формой и сохраните его.', 503);
  const kind = kinds.includes(payload.kind) ? payload.kind : 'summary';
  const cv = payload.cv || {};
  delete cv.photo;
  delete cv.apiKey;
  const instructions = {
    summary: 'Составь краткое профессиональное описание для резюме на русском языке (2–4 предложения).',
    cover: 'Составь мотивационное письмо на русском языке с обращением и подписью от соискателя.',
    recommendation: 'Составь только ЧЕРНОВИК рекомендательного письма от третьего лица, без вымышленных фактов, подписей и утверждений о реальном одобрении. Укажи, что текст должен быть проверен и утверждён рекомендателем.',
    analysis: 'Дай краткий анализ: подтверждённые сильные стороны и зоны, которые стоит уточнить. Не делай выводов о личности и не придумывай достижения.',
    sample: 'Собери полный ВЫМЫШЛЕННЫЙ учебный образец резюме на русском языке. Верни только JSON без markdown. Схема: {"firstName","lastName","middleName","role","email","phone","city","country","summary","skills","vacancy","cover","template","jobs":[{"company","position","start","end","details"}],"schools":[{"school","degree","start","end"}]}. Два места работы и одно образование. В details по две-три строки с задачами. skills — строка через запятую, у двух навыков уровень: "Excel 85". summary — 3–4 предложения. cover — короткое мотивационное письмо. template — одно из rail, folio, band, timeline, classic. Email только на example.com, телефон вымышленный. Если во входном JSON уже есть имя, фамилия или должность, сохрани их и дострой образец вокруг должности. Не используй имена известных людей и узнаваемые компании.'
  };
  const target = payload.lang === 'en' ? 'английский' : 'русский';
  if (kind === 'translate') {
    instructions.translate = 'Переведи резюме на ' + target + ' язык. Верни только JSON без markdown с полями firstName, lastName, middleName, role, summary, skills, vacancy, cover, recommendation, city, country, address, jobs, schools. jobs: [{company, position, start, end, details}]. schools: [{school, degree, start, end}]. Сохрани число записей, даты, email, телефон, числа и уровни навыков. Не добавляй фактов. Имена транслитерируй латиницей для английского и кириллицей для русского. Названия разделов не включай.';
  }
  const base = kind === 'sample'
    ? 'Ты собираешь учебный образец резюме. Все недостающие факты вымышленные. '
    : 'Ты помощник по карьере. Используй только факты из JSON пользователя. Не выдумывай работодателей, даты, цифры, образование, рекомендации и навыки. Не повторяй личные адреса без необходимости. ';
  try {
    const text = await completeText(apiKey, base + instructions[kind], JSON.stringify(cv), kind === 'sample' || kind === 'translate' ? 1600 : 850);
    if (kind === 'sample' || kind === 'translate') {
      const parsed = parseModelJson(text);
      const sample = kind === 'sample' ? normalizeSample(parsed) : normalizeTranslate(parsed);
      return { text: samplePreview(sample), sample };
    }
    return { text };
  } catch (error) {
    throw fail(safeError(error.message), error.status || 502);
  }
}

module.exports = { generate };
