const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
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

const UTC_OFFSET = -6;

function toUTC(date, time) {
  if (!date || !time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  const utcHours = hours - UTC_OFFSET;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCHours(utcHours, minutes, 0, 0);
  return d.toISOString().slice(0, 19);
}

app.get('/people', async (req, res) => {
  try {
    const r = await fetch(`${FUB_BASE}/people?limit=10`, { headers: fubHeaders() });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/users', async (req, res) => {
  try {
    const r = await fetch(`${FUB_BASE}/users`, { headers: fubHeaders() });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/people', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const nameParts = name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';
    const body = { firstName, lastName, source: 'Manual Entry' };
    if (phone) body.phones = [{ value: phone, type: 'mobile' }];
    if (email) body.emails = [{ value: email, type: 'home' }];
    const r = await fetch(`${FUB_BASE}/people`, {
      method: 'POST', headers: fubHeaders(), body: JSON.stringify(body)
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/debug-parse', async (req, res) => {
  try {
    const { message } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: `You are a CRM assistant. Parse and return ONLY JSON. today is ${today}, now is ${now}.`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await claudeRes.json();
    const rawText = data.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      parsed = { raw: rawText, parseError: e.message };
    }
    res.json({ claudeRaw: rawText, parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/parse-and-update', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: `You are a CRM assistant for a real estate agent named Reese. Parse natural language CRM updates and return ONLY a JSON object. No preamble, no markdown, no backticks.

Return this structure:
{
  "contact_name": "full name mentioned",
  "create_new_contact": false,
  "new_contact_phone": "phone number if creating new contact or null",
  "new_contact_email": "email if creating new contact or null",
  "actions": [
    {
      "type": "note" | "task" | "appointment" | "status" | "call" | "collaborator",
      "content": "description of the note, task, or appointment",
      "due_date": "YYYY-MM-DD or null",
      "due_time": "HH:MM in 24hr format or null",
      "end_time": "HH:MM in 24hr format or null",
      "status": "Active | Attempting Contact | Under Contract | Closed | Nurture | Trash | Sold | Unqualified or null",
      "duration_minutes": number or null,
      "send_invite": true or false,
      "collaborator_name": "first name of team member to add or null"
    }
  ],
  "summary": "one sentence summary of what will be done"
}

Rules:
- If the message says "new contact", "new lead", "add contact", "create contact", or "create a new", set create_new_contact to true
- For appointments, always extract the date AND time if mentioned
- end_time should be 1 hour after due_time if not specified
- send_invite defaults to false unless user says "send invite" or "invite them"
- collaborator_name should be first name only: Cooper, Dawson, Scott, Tyson, Jackson, or Reese
- For status, map to one of the valid FUB stages
- today is ${today}, current time is ${now}
- Always extract stage updates even when mentioned alongside other actions
- Always include a short human-readable summary`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content) {
      return res.status(500).json({ error: 'Claude API error: ' + JSON.stringify(claudeData) });
    }

    const rawText = claudeData.content.map(b => b.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      return res.status(500).json({ error: 'Could not parse AI response. Try rephrasing.' });
    }

    const msgLower = message.toLowerCase();
    const isNewContactRequest = parsed.create_new_contact ||
      msgLower.includes('new contact') ||
      msgLower.includes('create a new') ||
      msgLower.includes('add a new') ||
      msgLower.includes('create contact') ||
      msgLower.includes('add contact');

    const nameParts = parsed.contact_name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ');

    let match = null;
    let personId, personName, wasCreated = false;

    if (!isNewContactRequest) {
      const searchUrl = lastName
        ? `${FUB_BASE}/people?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&limit=10`
        : `${FUB_BASE}/people?firstName=${encodeURIComponent(firstName)}&limit=10`;
      const searchRes = await fetch(searchUrl, { headers: fubHeaders() });
      const searchData = await searchRes.json();
      match = (searchData.people || [])[0] || null;
    }

    if (!match) {
      if (isNewContactRequest) {
        const newBody = {
          firstName,
          lastName,
          source: 'Manual Entry'
        };
        if (parsed.new_contact_phone) newBody.phones = [{ value: parsed.new_contact_phone, type: 'mobile' }];
        if (parsed.new_contact_email) newBody.emails = [{ value: parsed.new_contact_email, type: 'home' }];
        const createRes = await fetch(`${FUB_BASE}/people`, {
          method: 'POST', headers: fubHeaders(), body: JSON.stringify(newBody)
        });
        const created = await createRes.json();
        console.log('FUB create response:', JSON.stringify(created));
        if (!createRes.ok) {
          return res.status(500).json({ error: 'FUB create failed: ' + JSON.stringify(created) });
        }
        personId = created.id || created.person?.id;
        personName = parsed.contact_name;
        wasCreated = true;
      } else {
        return res.status(404).json({
          error: `No contact found for "${parsed.contact_name}". Try using their full name, or say "new contact: [name], [phone]" to create them.`,
          suggestion: 'create_new',
          contact_name: parsed.contact_name
        });
      }
    } else {
      personId = match.id;
      personName = match.name;
    }

    const usersRes = await fetch(`${FUB_BASE}/users`, { headers: fubHeaders() });
    const usersData = await usersRes.json();
    const allUsers = usersData.users || [];
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
        if (action.due_date) {
          body.dueDate = action.due_time
            ? toUTC(action.due_date, action.due_time)
            : action.due_date;
        }
        const r = await fetch(`${FUB_BASE}/tasks`, {
          method: 'POST', headers: fubHeaders(), body: JSON.stringify(body)
        });
        results.push({ type: 'task', ok: r.ok, content: action.content, due: action.due_date, time: action.due_time });

      } else if (action.type === 'appointment') {
        const startDateTime = action.due_date && action.due_time
          ? toUTC(action.due_date, action.due_time)
          : action.due_date ? toUTC(action.due_date, '09:00') : null;

        const endDateTime = action.due_date && action.end_time
          ? toUTC(action.due_date, action.end_time)
          : startDateTime
            ? (() => {
                const d = new Date(startDateTime + 'Z');
                d.setUTCHours(d.getUTCHours() + 1);
                return d.toISOString().slice(0, 19);
              })()
            : null;

        const apptBody = {
          title: action.content,
          start: startDateTime,
          end: endDateTime,
          timezone: 'America/Denver',
          allDay: false,
          invitees: [{ personId: personId, userId: null, relationshipId: null }]
        };

        const r = await fetch(`${FUB_BASE}/appointments`, {
          method: 'POST', headers: fubHeaders(), body: JSON.stringify(apptBody)
        });
        results.push({ type: 'appointment', ok: r.ok, content: action.content, date: action.due_date, time: action.due_time, invite: action.send_invite });

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

      } else if (action.type === 'collaborator') {
        const collab = allUsers.find(u => u.name.toLowerCase().includes(action.collaborator_name.toLowerCase()));
        if (collab) {
          const r = await fetch(`${FUB_BASE}/people/${personId}`, {
            method: 'PUT', headers: fubHeaders(),
            body: JSON.stringify({
              collaborators: [{ userId: collab.id }]
            })
          });
          const collabData = await r.json();
          console.log('Collaborator response:', JSON.stringify(collabData));
          results.push({ type: 'collaborator', ok: r.ok, content: collab.name });
        } else {
          results.push({ type: 'collaborator', ok: false, content: `User "${action.collaborator_name}" not found` });
        }
      }
    }

    res.json({ success: true, personName, wasCreated, parsed, results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
