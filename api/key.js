module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const configured = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ configured, cloud: true });
};
