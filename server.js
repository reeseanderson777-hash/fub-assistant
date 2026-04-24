const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const FUB_API_KEY = process.env.FUB_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FUB_BASE = 'https://api.followupboss.com/v1';

function fubHeaders() {
  return {
    'Authorization': 'Basic ' + Buffer.from(FUB_API_KEY + ':').toString('base64'),
    'Content-Type': 'application/json'
  };
}

app.post('/parse-and-update', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });

    const today = new Date().toISOString().split('T')[0];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a CRM assistant for a real estate agent. Parse natural language CRM updates and return ONLY a JSON object. No preamble, no markdown, no backticks.

Return this structure:
{
  "contact_name": "first or full name mentioned",
  "actions": [
    {
      "type": "note" | "task" | "status" | "call",
      "content": "the note, task, or call description",
      "due_date": "YYYY-MM-DD or null",
      "status": "Active | Attempting Contact | Under Contract | Closed | Nurture | Trash | Sold | Unqualified or null",
      "duration_minutes": number or null
    }
  ],
  "summary": "one sentence summary of what will be done"
}

Rules:
- contact_name must be extracted from the message
- actions array can have multiple items if multiple things are requested
- For tasks, extract any due date mentioned — today is ${today}
- For status updates, map to one of the valid FUB stages listed above
- Always include a short human-readable summary`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse AI response. Try rephrasing.' });
    }

    const search = await fetch(`${FUB_BASE}/people?name=${encodeURIComponent(parsed.contact_name)}&limit=5`, {
      headers: fubHeaders()
    });
    const searchData = await search.json();
    const people = searchData.people || [];

    if (people.length === 0) {
      return res.status(404).json({ error: `No contact found for "${parsed.contact_name}"` });
    }

    const personId = people[0].id;
    const personName = people[0].name;
    const results = [];

    for (const action of parsed.actions) {
      if (action.type === 'note') {
        const r = await fetch(`${FUB_BASE}/notes`, {
          method: 'POST', headers: fubHeaders(),
          body: JSON.stringify({ personId, body: action.content })
        });
        results.push({ type: 'note', ok: r.ok, content: action.content });
      } else if (action.type === 'task') {
        const body = { personId, name: action.content };
        if (action.due_date) body.dueDate = action.due_date;
        const r = await fetch(`${FUB_BASE}/tasks`, {
          method: 'POST', headers: fubHeaders(),
          body: JSON.stringify(body)
        });
        results.push({ type: 'task', ok: r.ok, content: action.content, due: action.due_date });
      } else if (action.type === 'status') {
        const r = await fetch(`${FUB_BASE}/people/${personId}`, {
          method: 'PUT', headers: fubHeaders(),
          body: JSON.stringify({ stage: action.status })
        });
        results.push({ type: 'status', ok: r.ok, content: action.status });
      } else if (action.type === 'call') {
        const r = await fetch(`${FUB_BASE}/calls`, {
          method: 'POST', headers: fubHeaders(),
          body: JSON.stringify({ personId, note: action.content, duration: action.duration_minutes ? action.duration_minutes * 60 : null })
        });
        results.push({ type: 'call', ok: r.ok, content: action.content });
      }
    }

    res.json({ success: true, personName, parsed, results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('FUB Assistant server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
