const fs = require("fs").promises;
const path = require("path");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

// If modifying these scopes, delete token.json.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks.readonly"
];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    console.error("MMM-GoogleCalendarTasks: Error loading credentials", err);
    return null;
  }
}

/**
 * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

/**
 * Lists the next 10 events on the user's primary calendar,
 * and all task lists with their pending tasks.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
async function listEvents(auth) {
  // --- Calendar events ---
  const calendar = google.calendar({ version: "v3", auth });
  const eventsRes = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: "startTime"
  });
  const events = eventsRes.data.items;
  if (!events || events.length === 0) {
    console.log("MMM-GoogleCalendarTasks: No upcoming events found.");
  } else {
    console.log("MMM-GoogleCalendarTasks: Upcoming 10 events:");
    events.forEach((event) => {
      const start = event.start.dateTime || event.start.date;
      console.log(`  ${start} - ${event.summary}`);
    });
  }

  // --- Google Tasks ---
  const tasks = google.tasks({ version: "v1", auth });

  // Fetch all task lists
  const taskListsRes = await tasks.tasklists.list({ maxResults: 100 });
  const taskLists = taskListsRes.data.items;

  if (!taskLists || taskLists.length === 0) {
    console.log("\nMMM-GoogleCalendarTasks: No task lists found.");
    return;
  }

  console.log("\nMMM-GoogleCalendarTasks: Task lists:");
  for (const taskList of taskLists) {
    console.log(`\n  [${taskList.id}] ${taskList.title}`);

    // Fetch tasks for this list
    const tasksRes = await tasks.tasks.list({
      tasklist: taskList.id,
      maxResults: 100,
      showCompleted: false,
      showHidden: false
    });
    const taskItems = tasksRes.data.items;

    if (!taskItems || taskItems.length === 0) {
      console.log("    (no pending tasks)");
    } else {
      taskItems.forEach((task) => {
        const due = task.due ? task.due.substring(0, 10) : "no due date";
        console.log(`    - [${due}] ${task.title}`);
      });
    }
  }
}

authorize().then(listEvents).catch(console.error);
