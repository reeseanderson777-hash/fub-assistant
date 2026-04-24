const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const FUB_API_KEY = process.env.FUB_API_KEY;
const FUB_BASE = 'https://api.followupboss.com/v1';

function fubHeaders() {
  return {
    'Authorization': 'Basic ' + Buffer.from(FUB_API_KEY + ':').toString('base64'),
    'Content-Type': 'application/json'
  };
}

app.post('/update', async (req, res) => {
  try {
    const { action, contact_name, note, task, due_date, status, call_note, duration_minutes } = req.body;

    const search = await fetch(`${FUB_BASE}/people?name=${encodeURIComponent(contact_name)}&limit=5`, {
      headers: fubHeaders()
    });
    const searchData = await search.json();
    const people = searchData.people || [];

    if (people.length === 0) {
      return res.status(404).json({ error: `No contact found for "${contact_name}"` });
    }

    const personId = people[0].id;
    const personName = people[0].name;

    let result;

    if (action === 'note') {
      const r = await fetch(`${FUB_BASE}/notes`, {
        method: 'POST', headers: fubHeaders(),
        body: JSON.stringify({ personId, body: note })
      });
      result = await r.json();
    } else if (action === 'task') {
      const body = { personId, name: task };
      if (due_date) body.dueDate = due_date;
      const r = await fetch(`${FUB_BASE}/tasks`, {
        method: 'POST', headers: fubHeaders(),
        body: JSON.stringify(body)
      });
      result = await r.json();
    } else if (action === 'status') {
      const r = await fetch(`${FUB_BASE}/people/${personId}`, {
        method: 'PUT', headers: fubHeaders(),
        body: JSON.stringify({ stage: status })
      });
      result = await r.json();
    } else if (action === 'call') {
      const r = await fetch(`${FUB_BASE}/calls`, {
        method: 'POST', headers: fubHeaders(),
        body: JSON.stringify({ personId, note: call_note, duration: duration_minutes ? duration_minutes * 60 : null })
      });
      result = await r.json();
    } else {
      return res.status(400).json({ error: 'Unknown action type' });
    }

    res.json({ success: true, personName, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('FUB Assistant server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
