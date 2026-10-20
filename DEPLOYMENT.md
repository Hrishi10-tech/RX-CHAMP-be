# Deployment — AWS Lightsail + PM2 + nginx + Let's Encrypt

> **Upgrading production to 4.0?** Follow `docs/4.0/DEPLOY.md` (snapshot, the three
> 4.0 migrations, organisation setup, agent publish). This file describes setting up
> a new server from scratch; its server, nginx and PM2 steps are unchanged in 4.0.

Production runbook for the Time Champ backend (NestJS + Prisma, Socket.IO, S3).
Target: a single Lightsail instance in **Mumbai (ap-south-1)** talking to the
existing **RDS Aurora PostgreSQL** instance.

> **Docker alternative.** `docker-compose.yml` in this repo is a complete,
> validated alternative to steps 6–10 (it bundles nginx in a container). Use
> *either* that *or* this PM2 guide — not both, they both bind :80/:443. This
> guide is the PM2 path.

Placeholders used throughout: `<STATIC_IP>`, `api.rxvision.shop` (your API
domain), `ubuntu` (default Lightsail user on Ubuntu images).

---

## 1. Create the instance

Lightsail console → **Create instance**:

| Field | Value |
|---|---|
| Region / AZ | **Mumbai, ap-south-1** (Zone A) |
| Platform | **Linux/Unix** → *Linux operating system*, **not** "Linux apps" |
| Blueprint | **Ubuntu 24.04 LTS** |
| Plan type | **General purpose** |
| Network type | **Dual-stack** (needs a public IPv4 — agents connect over v4) |
| Size | **$24/mo — 4 GB RAM, 2 vCPU, 80 GB SSD, 2 TB transfer** |
| Instance name | `rxchamp-backend-prod` |
| Automatic snapshots | **Enabled** |

Do **not** pick an app blueprint (OpenClaw, Node.js, LAMP). Those are
pre-baked stacks that fight the setup below. You want a bare OS.

Why 4 GB: `nest build` plus `prisma generate` reliably OOMs on the 2 GB ($12)
plan. Step 6 adds swap as further insurance.

## 2. Static IP

Lightsail → **Networking** → *Create static IP* → attach to the instance.

Free while attached. This matters more than usual here: the agent installer
bakes `AGENT_PUBLIC_API_BASE_URL` in at download time, so every installer
already distributed keeps calling the old address if the IP changes.

## 3. Firewall

Instance → **Networking** → *IPv4 Firewall*. Target state:

| Application | Port | Restricted to |
|---|---|---|
| SSH | 22 | **Your office/home IP only** |
| HTTP | 80 | Anywhere |
| HTTPS | 443 | Anywhere |

Delete anything else. Port `4000` must **not** be open — nginx is the only
public entry point, and the app binds `127.0.0.1:4000` behind it.

## 4. DNS

Point an A record at the static IP:

```
api.rxvision.shop.    A    <STATIC_IP>
```

Use Lightsail's DNS zone or your existing registrar. Verify before step 8 —
certbot's HTTP-01 challenge fails if DNS hasn't propagated:

```bash
dig +short api.rxvision.shop
```

## 5. Let the instance reach RDS  ← most common blocker

Lightsail runs in its own AWS-managed VPC, separate from the EC2 VPC holding
your RDS instance. Out of the box the connection just hangs. Pick one:

**Option A — VPC peering (preferred, keeps RDS off the internet)**

1. Lightsail console → account menu → **Account** → *Advanced* →
   enable **VPC peering** for `ap-south-1`.
2. In the RDS security group, add an inbound rule: PostgreSQL / TCP 5432,
   source = the default VPC CIDR (typically `172.31.0.0/16`).

**Option B — public RDS locked to one IP**

1. RDS → modify instance → *Publicly accessible: Yes*.
2. RDS security group inbound: PostgreSQL / TCP 5432, source `<STATIC_IP>/32`.

Verify from the instance once step 6 is done:

```bash
sudo apt install -y postgresql-client
psql "postgresql://postgres:<PW>@rhythmrx-db-timechamp.<...>.ap-south-1.rds.amazonaws.com:5432/timechamp?sslmode=require" -c '\dn'
```

You should see the `timechamp` schema listed.

## 6. Base server setup

SSH in (`ssh ubuntu@<STATIC_IP>`), then:

```bash
sudo apt update && sudo apt upgrade -y

# Node 20 — matches the Dockerfile's node:20-alpine base
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential git nginx

node -v   # expect v20.x
```

Add 2 GB swap so the TypeScript build can't OOM:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm Swap: 2.0Gi
```

Create the app directory and log directory:

```bash
sudo mkdir -p /opt/rxchamp /var/log/rxchamp
sudo chown -R ubuntu:ubuntu /opt/rxchamp /var/log/rxchamp
```

## 7. Deploy the code

The repo is `https://github.com/Hrishi10-tech/RX-CHAMP-be.git`. If it's
private, add a read-only **deploy key** (Settings → Deploy keys) and clone over
SSH; otherwise clone over HTTPS.

```bash
git clone https://github.com/Hrishi10-tech/RX-CHAMP-be.git /opt/rxchamp
cd /opt/rxchamp
npm ci
```

**Upload the environment file.** From your laptop — note it must land as
`.env`, not `.env.production`. `ConfigModule.forRoot()` sets no `envFilePath`,
so the app reads only `.env` from its working directory; a file named
`.env.production` is silently ignored and boot fails validation on
`DATABASE_URL`.

```bash
scp .env.production ubuntu@<STATIC_IP>:/opt/rxchamp/.env
```

Then on the server, lock it down and fill in the two placeholders:

```bash
chmod 600 /opt/rxchamp/.env
nano /opt/rxchamp/.env      # replace CORS_ORIGINS and AGENT_PUBLIC_API_BASE_URL
```

3.1 adds one optional variable, `PORTAL_PUBLIC_URL`: the portal address the 3.1
agent opens for "Open approvals" (for example `https://vision.example.com`). When
it is unset the first `CORS_ORIGINS` entry is used, so set it when that entry is
not the portal people sign in to. It must be an `http(s)` URL; a wildcard is never
used.

Build and apply migrations:

```bash
cd /opt/rxchamp
npx prisma generate
npx prisma migrate deploy   # applies pending migrations to RDS — snapshot first
npm run build               # -> dist/main.js
```

> Take an RDS snapshot before `migrate deploy` on any release carrying schema
> changes. It writes directly to your production database.

### Upgrading to 3.1

PostgreSQL 12 or later (nothing needs an extension). Stop the API while the
migrations run, so no request holds a lock on the tables they alter:

```bash
cd /opt/rxchamp
pm2 stop rxchamp-api
# RDS snapshot now
git pull && npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
pm2 start rxchamp-api        # or pm2 restart rxchamp-api
```

Two migrations apply, in this order. Prisma sends each file as one batch, which
PostgreSQL runs as one transaction: each applies completely or not at all.

| Migration | What it does | Measured |
|---|---|---|
| `20261014_focus_meetings_reports` | Schema only, additive: new tables `work_sessions`, `meeting_records`, `app_settings`, `report_runs`, `month_locks`; new nullable or defaulted columns on `break_records` and `shift_breaks`; `shifts.overrun_grace_min` defaults to 3 (existing rows keep theirs). `lock_timeout` 15 s: a table still in use fails it in 15 s instead of stalling the database | 0.03 to 0.06 s |
| `20261014_focus_meetings_reports_backfill` | Data: lunch breaks not skippable, and shifts still on the 3.0 overrun grace of 2 minutes get 3 (rows changed after the schema migration are left alone); PENDING items get a due time 48 hours after the deploy (or after they were made, if later), so nobody is overdue on day one; 3.0 overruns sent for a decision with a reason count as asked to be focus time, with `overrun_sec` from the break's presence session; every past day in `work_day_ends` becomes one closed work session (source `BACKFILL`): login to End Day, or to the last keyboard or mouse input when End Day was never pressed, at most 14 hours. Today is left to the server, and a day that already has a work session is skipped, so it never inserts a day twice (a rerun, or a database that ran an earlier version). The last inputs are read in one pass over `activity_samples` | 4 to 6 s for 5.0 to 5.6 million activity samples and about 10,000 attendance days |

Measured inside the database on a scratch copy (2 vCPU, PostgreSQL 16; Prisma adds
about 1 s per `migrate deploy`) with `node test/live/migrations.live.mjs`
(`VOLUME=5` adds 5 million samples); the same
script checks every backfill rule on a copy of 3.0 data and drops the copy. The
backfill decides "today" in Asia/Kolkata (the `APP_TIMEZONE` default); with another
`APP_TIMEZONE`, edit the two `'Asia/Kolkata'` literals in its `migration.sql` before
deploying.

If a migration fails (for example the API was still running and a lock timed out),
nothing of it is applied. `migrate deploy` then refuses to continue (`P3009`) until
it is marked rolled back:

```bash
npx prisma migrate resolve --rolled-back 20261014_focus_meetings_reports_backfill   # the name it reported
npx prisma migrate deploy
```

Rollback to 3.0 is code only: the 3.1 schema is additive, so check out the 3.0
build, `npm ci && npm run build`, and restart. 3.0's `prisma migrate deploy`
reports "No pending migrations" (it ignores the two it does not know), and the new
columns have defaults for the rows 3.0 writes. Going forward to 3.1 again needs no
migration. Restore the snapshot only to undo the data itself.

3.1 also changes these:

- Rate limits per client address are sized for an office of 100+ people behind one
  NAT address: sign-in 300 a minute, token refresh 600, socket tickets 600 (30 per
  person), activity reports 1200 (120 per person); everything else keeps
  `RATE_LIMIT_MAX` (120) per `RATE_LIMIT_TTL` (60 s), per person or address. Wrong
  passwords are still stopped per account (10 within 15 minutes pause that
  account's sign-in for 15 minutes) and now per address too: 30 within 10 minutes
  and that address may only sign in people who signed in from it in the last 30
  days (429 for anyone else), so password spraying stops while the office keeps
  working. nginx must pass the client address (the shipped
  config does) or everyone shares one bucket.
- `PORTAL_PUBLIC_URL` (optional, below).
- Two jobs run shortly after every start: the monthly report catch-up (20 s; makes
  last month's runs if the 1st-of-month job was missed, but never for a month
  before 3.1's first boot, which it records once in `app_settings`) and the hourly
  cache warm-up (45 s; a few seconds of database reads).

Deploy the API first, then roll out the 3.1 agents; 3.0 and 2.9.1 agents keep
working against the 3.1 API.

Smoke-test before involving PM2:

```bash
node dist/main.js
# expect: "RX Vision API on http://localhost:4000/api/v1"
# Ctrl-C once it boots cleanly
```

## 8. PM2

```bash
sudo npm install -g pm2
cd /opt/rxchamp
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# run the sudo command it prints, then:
pm2 save
```

`ecosystem.config.js` pins **fork mode, one instance** on purpose. Do not raise
`instances` or switch to cluster mode: the app has five Socket.IO gateways and
no Redis adapter, so multiple workers would break long-polling handshakes
("Session ID unknown") and silently deliver broadcasts to only a fraction of
connected agents. Scaling out needs `@socket.io/redis-adapter` plus sticky
sessions first.

Useful commands:

```bash
pm2 status
pm2 logs rxchamp-api --lines 100
pm2 restart rxchamp-api
pm2 monit
```

## 9. nginx

`nginx/` is tracked, so the config arrives with the clone and already carries
the real `server_name` — install it straight from the checkout:

```bash
sudo cp nginx/rxchamp-host.conf /etc/nginx/sites-available/rxchamp
sudo ln -s /etc/nginx/sites-available/rxchamp /etc/nginx/sites-enabled/rxchamp
sudo rm -f /etc/nginx/sites-enabled/default   # drop the "Welcome to nginx" site

sudo nginx -t          # must print "syntax is ok" / "test is successful"
sudo systemctl reload nginx
```

Check it over plain HTTP before adding TLS:

```bash
curl -i http://api.rxvision.shop/health
```

Re-installing later, once step 10 has run: **don't `cp` over it.** certbot
rewrites this file in place, so the copy in git no longer has the 443 block —
overwriting drops TLS. Check with `grep -c "listen 443"
/etc/nginx/sites-available/rxchamp` and edit in place if it returns non-zero.

That config carries three things this app specifically needs: a
`location /socket.io/` block with `Upgrade`/`Connection` headers and a 3600s
read timeout (all five gateways are namespaces sharing one engine path, and a
60s timeout would cut idle sockets mid-session); `client_max_body_size 12m` for
base64 screenshot payloads; and `proxy_buffering off` on the agent-download
route so the multi-MB `.exe` streams instead of buffering to disk.

## 10. SSL (Let's Encrypt)

Not optional — plain HTTP is a dead end for two independent reasons:

- Auth cookies are issued `Secure` whenever `NODE_ENV=production`
  (`auth-cookie.service.ts`). Over `http://` the client discards them, so login
  returns 200 and then every following request is unauthenticated.
- The agent runs with `AllowAutoRedirect = false` (`ApiClient.cs`), so it will
  not follow the http→https redirect certbot installs. An installer baked
  against `http://` stays broken even after TLS is working.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.rxvision.shop
```

Choose **redirect HTTP → HTTPS** when prompted. certbot rewrites the site file
in place, adding the 443 server block and the redirect — don't hand-write TLS
directives, and re-run `sudo nginx -t` after.

Renewal installs as a systemd timer automatically. Confirm:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

## 11. Agent binary → S3

The Linux server has no `timechamp-agent-installer/publish/` folder, so the
on-disk default for the agent binary can't resolve. `.env.production` sets
`AGENT_S3_KEY=agent/RXChampAgent.exe`, which switches `agent.module.ts` to
serve from S3.

From RX Vision Agent 3.0 the agents are built from the `agent/` folder beside
this backend, and uploaded with their version and SHA-256 stamped on the S3
object (agents refuse an update without a checksum, so never upload with a
plain `aws s3 cp`):

```bash
# Windows installer (on Windows):
powershell -ExecutionPolicy Bypass -File scripts/publish-agent.ps1
# or on Linux/macOS:
bash ../agent/build/publish-windows.sh

# macOS, Apple Silicon and Intel (Linux or macOS):
bash ../agent/build/build-mac.sh && bash ../agent/build/publish-mac.sh --skip-build
```

Then set, once, in `.env`: `AGENT_S3_KEY=agent/RXChampAgent.exe`,
`AGENT_MAC_S3_KEY=agent/RXVision-mac.zip` and
`AGENT_MAC_X64_S3_KEY=agent/RXVision-mac-intel.zip`. Uploading is the release:
every installed agent picks the new version up within about 15 minutes, so
upload only after testing. The version comes from `agent/Directory.Build.props`.

## 12. Verify

```bash
curl -i https://api.rxvision.shop/health
curl -i https://api.rxvision.shop/api/v1/agent/version

# Socket.IO handshake — expect HTTP 200 and a JSON payload with "sid"
curl -i "https://api.rxvision.shop/socket.io/?EIO=4&transport=polling"
```

Then confirm end-to-end: install an agent from the download endpoint on a test
machine and watch `pm2 logs rxchamp-api` for its activity reports.

---

## Routine operations

**Deploy an update**

```bash
cd /opt/rxchamp
pm2 stop rxchamp-api         # when the release carries migrations (3.1 does)
git pull
npm ci
npx prisma generate          # the client must match the new schema
npx prisma migrate deploy    # snapshot RDS first if migrations are included
npm run build
pm2 restart rxchamp-api
pm2 logs rxchamp-api --lines 50
```

**Rollback**

```bash
cd /opt/rxchamp
git log --oneline -10
git checkout <previous-sha>
npm ci && npm run build
pm2 restart rxchamp-api
```

Note that `prisma migrate deploy` is **not** reversible by checking out an
older commit. A release whose migrations are additive (3.1's are) can still be
rolled back by code alone, as above; otherwise rolling back across a schema change
means restoring the RDS snapshot you took before the deploy.

**Logs**

```bash
pm2 logs rxchamp-api          # app
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| App boot fails: `Invalid environment configuration: DATABASE_URL` | File uploaded as `.env.production` instead of `.env` |
| Boot hangs, then connection timeout to RDS | Step 5 not done — VPC peering / security group |
| `502 Bad Gateway` | App not running (`pm2 status`) or not on port 4000 |
| Sockets connect then drop every ~60s | `location /socket.io/` block missing or timeout too low |
| Sockets fail with "Session ID unknown" | PM2 was switched to cluster mode / `instances > 1` |
| Agent download 500s | `AGENT_S3_KEY` unset, or the exe was never uploaded (step 11) |
| `Cannot find module './app.module'` after a deploy | Incomplete `dist/` from a stale TypeScript incremental cache. Fixed by `tsBuildInfoFile` living inside `dist/`; if you see it, delete `dist/` and any stray root `*.tsbuildinfo`, then rebuild |
| Rate limiting 429s everyone at once | `trust proxy` not applied — check `configure-app.ts` is on the deployed build |
| `migrate deploy` fails with `P3009` | An earlier migration failed (nothing of it was applied): `npx prisma migrate resolve --rolled-back <name>`, then deploy again |
| A 3.1 migration fails with `lock timeout` | The API (or another client) was still using the table: `pm2 stop rxchamp-api`, resolve as above, deploy again |
| CORS errors in browser | `CORS_ORIGINS` still `https://app.REPLACE-ME.com` |
| certbot fails HTTP-01 | DNS not propagated, or port 80 closed in the Lightsail firewall |


## Optional: failed sign-ins per address
`LOGIN_FAILED_PER_IP_MAX` (default 30) and `LOGIN_FAILED_PER_IP_WINDOW_MIN` (default 10). If the whole office signs in from one public address and the first morning trips the limit (sign-in answers "Sign-in paused" for people who have not signed in from that address before), raise `LOGIN_FAILED_PER_IP_MAX` to 100 in `.env` and restart the API.
