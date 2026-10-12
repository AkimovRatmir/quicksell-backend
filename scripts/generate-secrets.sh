#!/usr/bin/env bash
#
# Fills the production secrets in .env — run once, on the server, before the
# API is first started.
#
# It never overwrites a secret that already has a value. Re-keying
# CREDENTIALS_ENC_KEY after stores are connected makes every saved Kaspi login
# undecryptable, and that is not recoverable, so the safe move is to refuse and
# let a human decide.
#
#   bash scripts/generate-secrets.sh [path-to-env-file]

set -euo pipefail

ENV_FILE="${1:-.env}"
EXAMPLE_FILE="$(dirname "$0")/../.env.example"

rand_base64() { openssl rand -base64 32; }
# Hex, so it is alphanumeric by construction: this one goes inside DATABASE_URL,
# where +, / and = from base64 would have to be percent-encoded. 16 bytes = 128
# bits, plenty for a password only reachable from localhost.
rand_alnum() { openssl rand -hex 16; }

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$EXAMPLE_FILE" ]]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "Created $ENV_FILE from .env.example"
  else
    touch "$ENV_FILE"
    echo "Created empty $ENV_FILE"
  fi
fi

current() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | tr -d '"'; }

# Values that come from .env.example / docker-compose defaults, not from a
# human. Only the database password is on this list: re-keying JWT_SECRET is
# harmless, but CREDENTIALS_ENC_KEY must never be replaced on a guess, so
# those two are only filled when truly empty.
is_placeholder() {
  [[ "$1" == "POSTGRES_PASSWORD" && "$2" == "analytics" ]]
}

set_secret() {
  local key="$1" value="$2"
  local existing
  existing="$(current "$key")"
  if [[ -n "$existing" ]] && ! is_placeholder "$key" "$existing"; then
    echo "  $key — already set, left untouched"
    return 1
  fi
  if grep -qE "^$key=" "$ENV_FILE"; then
    # Portable in-place edit (BSD sed on macOS needs the empty -i argument).
    sed -i.bak "s|^$key=.*|$key=$value|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "  $key — generated"
  return 0
}

echo "Secrets in $ENV_FILE:"
JWT_VALUE="$(rand_base64)"
ENC_VALUE="$(rand_base64)"
PG_VALUE="$(rand_alnum)"

set_secret JWT_SECRET "$JWT_VALUE" || true
ENC_IS_NEW=0
set_secret CREDENTIALS_ENC_KEY "$ENC_VALUE" && ENC_IS_NEW=1
PG_IS_NEW=0
set_secret POSTGRES_PASSWORD "$PG_VALUE" && PG_IS_NEW=1

chmod 600 "$ENV_FILE"
echo "Permissions on $ENV_FILE set to 600 (owner only)."

if [[ "$PG_IS_NEW" == "1" ]]; then
  echo
  echo "Postgres password generated. Put the same value in DATABASE_URL:"
  echo "  DATABASE_URL=postgres://analytics:$PG_VALUE@localhost:5432/quick_analytics"
  echo "If the database container already exists with the old password, recreate"
  echo "it (docker compose down -v) BEFORE any real data is in there."
fi

if [[ "$ENC_IS_NEW" == "1" ]]; then
  cat <<EOF

=====================================================================
 COPY THIS INTO A PASSWORD MANAGER NOW — it is shown once.

   CREDENTIALS_ENC_KEY=$ENC_VALUE

 Every Kaspi login and session cookie in the database is encrypted
 with this key. Without it a database backup is unreadable and every
 connected store has to be reconnected by hand.

 It is NOT enough to have it in this file: if the server dies, the
 file dies with it. Store it somewhere else as well.
=====================================================================
EOF
fi
