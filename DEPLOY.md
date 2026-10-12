# Deploying QuickSell

One cloud VPS runs everything: nginx, the API (Bun), Postgres (Docker) and the
built frontend.

| | |
|---|---|
| Server | `<server-ip>` — Ubuntu 24.04, 2 vCPU / 4 GB / 100 GB, KZ |
| App | **https://web.quicksell.kz** — frontend + API under `/api` |
| Landing | `quicksell.kz`, `www.quicksell.kz` — Netlify, not this server |
| API host | `api.quicksell.kz` — optional, see §9 |
| Deploy branch | `server` in both repos |

SSH access is by key.

## 1. Base system — done on 2026-09-23

Kept here so the server can be rebuilt the same way.

```bash
apt-get update && apt-get -y dist-upgrade && reboot    # dist-upgrade: plain `upgrade` skips new kernels
apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx nodejs npm unzip
systemctl enable --now docker

fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab && echo 'vm.swappiness=10' >> /etc/sysctl.conf

adduser --disabled-password --gecos "" quicksell && usermod -aG docker quicksell
su - quicksell -c 'curl -fsSL https://bun.sh/install | bash'
# Bun's installer only adds PATH for interactive shells; cron and `ssh -c` need it too
su - quicksell -c 'printf "export BUN_INSTALL=\"\$HOME/.bun\"\nexport PATH=\"\$BUN_INSTALL/bin:\$PATH\"\n" >> ~/.profile'

# The provider advertises IPv6 but doesn't route it: v6 connections time out
# (npm, git, certbot, calls to Resend/OpenAI) instead of failing fast.
echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf

ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

SSH brute-force protection (bots start guessing root passwords within hours of a server going online). `apt-get install -y fail2ban`, then
`/etc/fail2ban/jail.local`:

```ini
[DEFAULT]
maxretry = 5              # 5 wrong passwords within 10 min → 1 h ban
findtime = 10m
bantime  = 1h
bantime.increment = true  # repeat offenders: doubled each time, max a week
bantime.maxtime   = 1w
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
backend = systemd         # 24.04 cloud images log SSH to the journal only
```

Bans are enforced with nftables (`nft list table inet f2b-table`), not iptables.
`fail2ban-client status sshd` lists them; `fail2ban-client set sshd unbanip <IP>`
lifts one. Locked out yourself: wait an hour, use another network, or the
provider's web console (not SSH, so never banned).

Ubuntu's Compose package is `docker-compose-v2` (`docker-compose-plugin` only
exists in Docker's own repo). The provider's cloud firewall already lets 80 and
443 through; `ufw` is the only filter on the box.

The app runs as the unprivileged `quicksell` user; root is for administration.

## 2. DNS — at hoster.kz

Add one record:

| Type | Name | Value |
|---|---|---|
| A | `web` | `<server-ip>` |

Do **not** touch `quicksell.kz` / `www` (the Netlify landing) or the Resend
records (`resend._domainkey`, `send`, SPF) — password-reset email depends on them.

## 3. Code

If the repos are private, give the server a read-only deploy key and add it
to both repositories (read access only). Then:

```bash
su - quicksell
git clone -b server <backend-repo-url> ~/quickanal/backend
git clone -b server <frontend-repo-url> ~/quickanal/frontend
```

## 4. Environment and secrets — before the database

Postgres sets its password only the **first** time the container starts, so
generate it first:

```bash
cd ~/quickanal/backend
bash scripts/generate-secrets.sh
```

It creates `.env`, fills `JWT_SECRET`, `CREDENTIALS_ENC_KEY` and
`POSTGRES_PASSWORD`, sets mode 600, and refuses to overwrite anything later.

> **Back up `CREDENTIALS_ENC_KEY` off the server** (password manager). Every
> stored Kaspi login and cookie is encrypted with it; without it a database
> backup is unreadable.

Then set in `.env`:

```
NODE_ENV=production
DATABASE_URL=postgres://analytics:<POSTGRES_PASSWORD>@localhost:5432/quick_analytics
APP_BASE_URL=https://web.quicksell.kz
TRUST_PROXY=1
RESEND_API_KEY=re_...
OPENAI_API_KEY=sk-...      # AI insights (Pro)
# SWAGGER_USER / SWAGGER_PASSWORD — leave unset to keep /docs off in production
```

The API binds to `127.0.0.1` in production, so only nginx can reach it.

## 5. Database, migrations, API

```bash
docker compose up -d        # reads POSTGRES_PASSWORD from .env
bun install
bun run db:migrate          # every pending migration
bun run build
```

`/etc/systemd/system/quicksell-api.service` (as root):

```ini
[Unit]
Description=QuickSell API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=quicksell
WorkingDirectory=/home/quicksell/quickanal/backend
ExecStart=/home/quicksell/.bun/bin/bun run dist/main.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now quicksell-api
```

## 6. Frontend

```bash
cd ~/quickanal/frontend && npm ci && npm run build        # as quicksell
rsync -a --delete /home/quicksell/quickanal/frontend/dist/ /var/www/quicksell/   # as root
```

## 7. nginx and HTTPS

The frontend calls the API at `/api/...` on its own origin, so one server
block serves the site and forwards `/api` — the same thing the Vite dev proxy
does. No CORS involved.

`/etc/nginx/sites-available/quicksell`:

```nginx
server {
  listen 80;
  server_name web.quicksell.kz;
  root /var/www/quicksell;

  # The app bundle is ~600 KB of JS; compressed it is ~220 KB.
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;
  gzip_min_length 1024;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;

  # Trailing slash on proxy_pass strips the prefix: /api/auth/login → /auth/login
  location /api/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # A first-time 89-day order backfill can take minutes; the default 60 s
    # would answer 504 while the API keeps working.
    proxy_read_timeout 300s;
  }

  # Hashed build assets never change under the same name.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable" always;
    add_header X-Content-Type-Options nosniff always;
  }

  # SPA: unknown paths return index.html, otherwise /reset-password 404s.
  # index.html is never cached, so a deploy reaches users immediately.
  # (add_header in a location replaces the server-level ones, hence repeated.)
  location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
  }
}
```

```bash
ln -s /etc/nginx/sites-available/quicksell /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d web.quicksell.kz      # after the DNS record resolves
```

## 8. Backups

`/home/quicksell/backup-db.sh` dumps the database and keeps 14 days:

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR=/home/quicksell/backups
mkdir -p "$DIR"
OUT="$DIR/qa-$(date +%F-%H%M).sql.gz"
docker exec quick_analytics_db pg_dump -U analytics quick_analytics | gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"            # only a complete dump gets the real name
find "$DIR" -name "qa-*.sql.gz" -mtime +14 -delete
```

`crontab -e` as `quicksell`:

```
CRON_TZ=Asia/Almaty
0 4 * * * /home/quicksell/backup-db.sh >> /home/quicksell/backups/backup.log 2>&1
```

Copy dumps off the server, prune old ones, and test a restore once. Also turn
on the provider's automatic snapshots — on a cloud VPS they cost little and
restore the whole machine.

## 9. Optional: `api.quicksell.kz`

The web app does not need it. Add it only for direct API clients (a mobile
app, integrations): an A record `api` → `<server-ip>`, a second server block
proxying `/` to `127.0.0.1:3000`, `certbot -d api.quicksell.kz`, and
`CORS_ORIGINS=https://web.quicksell.kz` if a browser app will call it.

## 10. After deploying, check

- `curl https://web.quicksell.kz/api/health` → `{"ok":true,...}`
- Register in the browser — proves the `/api` proxy and the consent checkbox
- Request a password reset — the link must open `web.quicksell.kz/reset-password`
- `/api/docs` → 404 (or a password prompt if Swagger credentials are set)
- After the first hourly sync, check `lastSyncAt` on a seller
- `journalctl -u quicksell-api -f` to watch it

## Updating

```bash
su - quicksell
cd ~/quickanal/backend && git pull && bun install && bun run db:migrate && bun run build
cd ~/quickanal/frontend && git pull && npm ci && npm run build
exit
rsync -a --delete /home/quicksell/quickanal/frontend/dist/ /var/www/quicksell/
systemctl restart quicksell-api
```

New work goes to `main`; merge `main` into `server` and push when it's ready.

## Kaspi note

Product sync relies on a Kaspi cabinet session tied to this server's IP.
Keep the IP — don't delete and recreate the VPS. A new IP makes Kaspi ask for
the emailed code again; the seller then sees «Kaspi запросил код…» in
Settings, automatic syncs pause for that store, and they press «Войти в Kaspi
заново» to enter it.
