#!/bin/sh

set -x

is_true() {
  value="$1"
  value_lower=$(echo "$value" | tr '[:upper:]' '[:lower:]')
  case "$value_lower" in
    1|true|yes|y)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

HOST=${HOST:-0.0.0.0}
PORT=${PORT:-5000}

if is_true "$DEBUG"; then
  echo "Running in debug mode, using Flask development server."
  exec flask run --host=$HOST --port=$PORT
else
  echo "Running in production mode, using Gunicorn."
  exec gunicorn --bind $HOST:$PORT app:app
fi
