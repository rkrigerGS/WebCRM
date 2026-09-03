# GovSpring Prospecting - Setup Guide (Windows host machine)

This app runs as a small web server on one always-on computer (the host). You use it by
opening a browser on that computer and going to http://localhost:3000. Nothing is on the
public internet; all data stays on the host machine.

There are two parts: a one-time setup, and (optionally) making it start automatically
whenever the computer boots. Total setup time is about 15 minutes.

--------------------------------------------------------------------
## PART 1 - One-time setup
--------------------------------------------------------------------

### Step 1. Install Node.js
1. Go to https://nodejs.org
2. Download the "LTS" version for Windows and run the installer.
3. Click through with all the default options. (This is the engine the app runs on.)

### Step 2. Put the app folder somewhere permanent
1. Unzip the govspring-prospecting folder.
2. Move it somewhere it will live permanently, for example:
      C:\GovSpring\govspring-prospecting
   Avoid the Downloads folder (things get cleaned out of there).

### Step 3. Install the app's parts
1. Open the app folder in File Explorer.
2. Click in the address bar at the top, type  cmd  and press Enter.
   (A black command window opens, already pointed at the folder.)
3. Type this and press Enter:
      npm install
4. Wait for it to finish (about a minute). It downloads the app's building blocks.
   There is no compiling and no error-prone steps here - it just works.

### Step 4. Start the app
In that same command window, type:
      npm start
You should see:  "GovSpring Prospecting is running."

### Step 5. Open it and create the admin account
Open a browser (Chrome, Edge, whatever) ON THIS COMPUTER and go to:
      http://localhost:3000
The first time anyone opens the app, it asks you to create an account instead of just a
password. This first account is automatically the admin. Pick a username and a password
(at least 8 characters) and click Enter. The admin can later create accounts for other
people from the "Users" panel in the sidebar (admin-only), and can see a full log of who
did what and when from "Audit log" (also admin-only).

### Step 6. Add your Anthropic API key
1. In the app, click "Settings" (left sidebar).
2. Paste the Anthropic API key (starts with sk-ant-). Click Save.
   Drafting is disabled until a key is added. The key stays on this machine only.

### Step 7. Point it at your research folder
1. In Settings, next to "Research output folder", click "Choose folder".
2. Paste the full path to the folder your research writes dossiers into
   (for example  C:\Users\Marcos\Desktop\prospect-research\outputs ).
3. Existing dossiers load immediately; new ones appear automatically as research finishes.

### Step 8. Connect Gmail (admin only, one-time)
Outreach emails send from marcos@govspringlegal.com through this connection, no matter
who is logged in when the "Save as sent" button is clicked. This needs a one-time setup
in Google Cloud Console, done by whoever administers the GovSpring Legal Workspace:

1. In Google Cloud Console (console.cloud.google.com), create a project under the
   GovSpring Legal Workspace org (or use an existing one) and enable the Gmail API
   (APIs & Services -> Library -> search "Gmail API" -> Enable).
2. APIs & Services -> OAuth consent screen -> User Type "Internal" (only shows up when
   the project belongs to the Workspace org). Fill in the app name and contact emails,
   and add the scope  https://www.googleapis.com/auth/gmail.modify .
   "Internal" apps skip Google's verification review entirely.
3. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> Web
   application. Add these as Authorized redirect URIs:
      http://localhost:3000/api/admin/gmail/callback   (local testing)
      https://<your-production-domain>/api/admin/gmail/callback   (once deployed)
   Save, and copy the Client ID and Client Secret it gives you.
4. Back in the app: Settings -> "Google OAuth client" -> paste the Client ID and Client
   Secret -> "Save Google credentials".
5. Click "Connect Gmail". You'll be sent to a Google sign-in/consent screen -- sign in as
   marcos@govspringlegal.com and approve. You're returned to the app, and Settings now
   shows "Connected as marcos@govspringlegal.com."

The connection refreshes itself automatically from then on. If it's ever disconnected
(or access is revoked from myaccount.google.com/permissions), reconnect the same way --
no need to touch Google Cloud Console again unless the Client ID/Secret themselves need
to change.

--------------------------------------------------------------------
## PART 2 - Make it start automatically on boot (recommended)
--------------------------------------------------------------------

Because the host computer stays on, you can have the app start by itself whenever
Windows starts, so it is always available and you never think about it.

### Step 1. Open the Startup folder
1. Press  Windows key + R  (a small "Run" box opens).
2. Type:  shell:startup   and press Enter.
   A folder opens - anything in here runs automatically when Windows starts.

### Step 2. Add a shortcut to the silent launcher
1. In the app folder, right-click the file  Start-GovSpring-Hidden.vbs
2. Choose "Show more options" then "Create shortcut" (or just "Create shortcut").
3. Drag that new shortcut into the Startup folder you opened in Step 1.

Done. From now on, every time the computer starts, the app starts silently in the
background. You just open http://localhost:3000 in the browser whenever you want it.
(Tip: bookmark that address, or set it as the browser's home page.)

--------------------------------------------------------------------
## Everyday use
--------------------------------------------------------------------
- Open the browser to  http://localhost:3000
- If it does not load, the server is not running. If you set up Part 2, restart the
  computer, or just double-click  Start-GovSpring.bat  in the app folder.

## Stopping / restarting manually
- If you started it with  npm start , close that command window to stop it.
- To start it again by hand, double-click  Start-GovSpring.bat

## Where the data lives
Everything is in the  data  folder inside the app folder:
  data\govspring.json      - all prospects and their tracking
  data\config.json         - the API key and settings
  data\users.json          - user accounts (usernames, roles, password hashes)
  data\audit-log.json      - the full history of who did what and when
  data\approved-emails\    - the learning library
  data\catalogs\ (or the catalogs folder) - firm facts and services
Back up the  data  folder to keep everything safe. Copying it to another machine's app
folder moves everything over.

## A note on updates
When you get a new version, replace everything EXCEPT the  data  folder. Keeping the
data folder preserves all prospects, settings, and the learning library.

--------------------------------------------------------------------
## Environment variables
--------------------------------------------------------------------

### APP_BASE_URL  (REQUIRED in production - the app will not start without it)
The public address of this app, e.g.  https://webcrm-production-4555.up.railway.app
(no trailing path needed - anything after the host is ignored).

Every link the app emails out - password resets, user invites, and the "pick a time"
booking buttons in outreach emails - is built from this value. It used to be taken from
the incoming web request instead, which meant anyone could forge it and make the app
email a real, working password-reset link pointing at their own site. The app now refuses
to start in production rather than guess, because guessing wrong silently recreates that
problem on exactly the deploy where it matters.

- On Railway: set it in the service's Variables tab, then redeploy.
- On the Windows host, if the app is only ever opened in a browser ON that same machine
  (http://localhost:3000), you can leave it unset - it defaults to http://localhost:PORT,
  which is correct in that case.
- IMPORTANT - on the Windows host, if anyone opens the app from ANOTHER computer on the
  office network (e.g. http://192.168.1.50:3000), you MUST set APP_BASE_URL to that
  address. Otherwise password-reset and invite emails will contain links saying
  "localhost", which only work on the host machine itself and will look broken to
  everyone else. Set it to the same address people actually type into their browser.
- It can also be set as  baseUrl  in  data\config.json  if you prefer; the environment
  variable wins if both are present.

If it is missing or malformed in production, the startup log says so explicitly and the
app exits. Setting the variable and redeploying is the whole fix.

### ENABLE_DEV_LOGIN  (use  1  to enable,  0  to disable; disabled by default)
Reaches an admin session without a password, for when you are locked out. When it is not
exactly  1  the route does not exist at all - the address 404s like any unknown path.

Recommended: keep the variable set to  0  in Railway so it is visible and easy to flip,
and set it to  1  only for as long as you need it.

HOW TO USE IT
1. Railway > Variables > set ENABLE_DEV_LOGIN to 1 > Deploy.
2. Open the service's Deploy Logs and find the block "DEVELOPER LOGIN LINK".
3. Copy the whole https://... link underneath it and open it in your browser.
   You are logged in as dev_rafael (admin).
4. Set the variable back to 0 and deploy.

The link is SINGLE USE and expires after 30 minutes. Following it logs you in and
immediately mints a replacement link into the log, so the log always holds exactly one
live link. Following an expired link also prints a fresh one, so a stale copy is never a
dead end - just go back to the log and take the newest.

Single use is the point. A token in a web address normally ends up in the platform's
access logs, the proxy's logs, your browser history, and the Referer header sent to the
next site you visit. Because the link dies the instant it is used, every one of those
copies is worthless. That is safer than the original backdoor, which used a link that
stayed valid and reusable until the next restart.

Five wrong attempts from one address in 15 minutes invalidates the outstanding link and
prints a new one. Every attempt, successful or not, is written to the audit log with the
source address.

### Others already in use
- PORT - which port to listen on (default 3000).
- RAILWAY_VOLUME_MOUNT_PATH - set by Railway; where the persistent data volume is
  mounted. The app refuses to start on Railway without it, so a detached volume can't
  silently look like an empty database.
- DEV_AUTOLOGIN - local development only; runs every session as the named existing user.
  Hard-refused when production markers are present.
