// Google Calendar routes — loaded by server.js
const { google } = require('googleapis');

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

module.exports = function registerCalendarRoutes(app) {

  // POST /api/calendar/event — create a calendar event
  app.post('/api/calendar/event', async (req, res) => {
    const { summary, description, start, end, attendees, timeZone } = req.body;
    if (!summary || !start || !end)
      return res.status(400).json({ error: 'summary, start, end required' });
    try {
      const cal = getCalendarClient();
      const event = await cal.events.insert({
        calendarId: 'primary',
        sendUpdates: 'all',
        resource: {
          summary,
          description: description || '',
          start: { dateTime: start, timeZone: timeZone || 'Europe/Berlin' },
          end:   { dateTime: end,   timeZone: timeZone || 'Europe/Berlin' },
          attendees: (attendees || []).map(e => ({ email: e }))
        }
      });
      console.log('[CALENDAR] event created:', event.data.id, summary);
      res.json({ ok: true, eventId: event.data.id, htmlLink: event.data.htmlLink });
    } catch (e) {
      console.error('[CALENDAR] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/calendar/slots?date=YYYY-MM-DD — show busy slots for a day
  app.get('/api/calendar/slots', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    try {
      const cal = getCalendarClient();
      const timeMin = new Date(date + 'T00:00:00+01:00').toISOString();
      const timeMax = new Date(date + 'T23:59:59+01:00').toISOString();
      const r = await cal.freebusy.query({
        resource: { timeMin, timeMax, timeZone: 'Europe/Berlin', items: [{ id: 'primary' }] }
      });
      const busy = r.data.calendars.primary.busy || [];
      res.json({ date, busy });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

};
