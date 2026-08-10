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
