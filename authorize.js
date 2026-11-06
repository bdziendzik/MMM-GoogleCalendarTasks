const fs = require("fs").promises;
const path = require("path");
const readline = require("readline");
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
    // A missing token is the first-run path, not a failure.
    if (err.code === "ENOENT") {
      return null;
    }
    console.error("MMM-GoogleCalendarTasks: Error loading credentials", err);
    return null;
  }
}

/**
 * Pull an OAuth code out of a pasted redirect URL, or return a raw code.
 * A redirect URL with no `code` parameter yields an empty string.
 *
 * @param {string} value
 * @return {string}
 */
function extractAuthCode(value) {
  if (typeof value !== "string") {
    return "";
  }
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) {
    return "";
  }

  const candidates = [trimmed];
  if (!/^https?:\/\//i.test(trimmed) && /code=/.test(trimmed)) {
    candidates.push(`http://${trimmed.replace(/^\/+/, "")}`);
  }

  for (const candidate of candidates) {
    try {
      const code = new URL(candidate).searchParams.get("code");
      if (code) {
        return code;
      }
    } catch {
      // Not a URL; the value may be the authorization code itself.
    }
  }

  if (/^https?:\/\//i.test(trimmed) || /code=/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

/**
 * Ask a question on stdin and resolve with the trimmed answer.
 *
 * @param {string} question
 * @return {Promise<string>}
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @param {object} key The `installed` object from credentials.json.
 * @return {Promise<void>}
 */
async function saveCredentials(client, key) {
  if (!client.credentials.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. In your Google account, remove this app's access, then run node authorize.js again."
    );
  }
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load Desktop-app OAuth client details from credentials.json.
 *
 * @return {Promise<object>}
 */
async function loadInstalledCredentials() {
  let content;
  try {
    content = await fs.readFile(CREDENTIALS_PATH);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Missing ${CREDENTIALS_PATH}. Download Desktop application credentials and save them as credentials.json in this directory.`
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Could not parse ${CREDENTIALS_PATH}: ${err.message}`);
  }

  const key = parsed.installed;
  if (!key || !key.client_id || !key.client_secret) {
    throw new Error(
      "credentials.json does not contain an 'installed' client_id and client_secret. Use Desktop application credentials."
    );
  }
  if (!key.redirect_uris || !key.redirect_uris[0]) {
    throw new Error(
      "credentials.json has no redirect_uris. Use Desktop application credentials."
    );
  }
  return key;
}

/**
 * Load or request authorization to call APIs.
 * On a machine with no local browser (SSH to a MagicMirror), print the URL
 * and read the redirect URL from the terminal instead of waiting on localhost.
 *
 * @return {Promise<OAuth2Client>}
 */
async function authorize() {
  const existing = await loadSavedCredentialsIfExist();
  if (existing) {
    return existing;
  }

  const key = await loadInstalledCredentials();
  const redirectUri = key.redirect_uris[0];
  const oauth2Client = new google.auth.OAuth2(
    key.client_id,
    key.client_secret,
    redirectUri
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    redirect_uri: redirectUri
  });

  console.log(
    "MMM-GoogleCalendarTasks: No saved token. Open this URL in a browser on any device and approve access."
  );
  console.log(
    "After approval the browser page may not load. Copy the full address-bar URL anyway, paste it here, and press Enter.\n"
  );
  console.log(authorizeUrl);
  console.log("");

  const answer = await prompt("Paste the redirect URL or authorization code: ");
  const code = extractAuthCode(answer);
  if (!code) {
    throw new Error(
      "No authorization code found. Paste the full redirect URL from the browser address bar."
    );
  }

  const { tokens } = await oauth2Client.getToken({
    code,
    redirect_uri: redirectUri
  });
  oauth2Client.setCredentials(tokens);
  await saveCredentials(oauth2Client, key);
  console.log(`MMM-GoogleCalendarTasks: Saved ${TOKEN_PATH}`);
  return oauth2Client;
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

if (require.main === module) {
  authorize().then(listEvents).catch(console.error);
}

module.exports = { extractAuthCode };
