# Server plan: production on the MacBook Pro (FUTURE)

Agreed with the user on 2026-11-25. Nothing is done yet; the user will start it later. Task: TASKS.md "Future".

Production moves to the MacBook Pro (ssh alias `ssh_server`, user `emi2ai`, 192.168.1.36). The MacBook Air becomes dev only.

```
iPhone / iPad / Air ──Tailscale──► MacBook Pro = SERVER (24/7)
  Meowsic :5180 started at boot (LaunchDaemon, not a login LaunchAgent)
  DB + all files: the only writer (~/Documents/Meowsic)
  AI jobs (singing, OMR) with models in ~/ai/models
  Photos signed in to the user's Apple ID, iCloud Photos on (Optimize Storage) → "Sheet" album auto-import with the existing photos_album.py
  Claude session: daily Feedback check, fixes, deploys at quiet times, phone summary
  Nightly + pre-deploy backup → Synology NAS
MacBook Air = DEV: code, Claude, tests, test server :5181 on a read-only data copy; deploys via SSH/GitHub
```

## Decisions and why
- Synology Drive must NOT sync the live SQLite DB: it risks corruption and conflicts. Synology is only for backups and one-way copies; dev pulls a read-only copy.
- Single writer = the server.
- Deploy only when there is no active edit session.

## One-time steps for the user (on the Pro's screen)
- Sign in to the Apple ID, turn on iCloud Photos, open Photos, Allow the Photos permission for the importer.
- Stay logged in, or use auto-login.
- Power settings: never sleep on power, restart after a power failure, battery charge limit.
- FileVault: decide between unlocking by hand after power cuts or turning it off.

## Open question
- The Pro's chip and RAM.

## Migration steps
1. Freeze edits.
2. Back up.
3. Copy data and models.
4. Start on the Pro and verify.
5. Move Tailscale serve and the ts.net name to the Pro.
6. Stop the Air's live server.

Rollback stays possible until the user confirms.
