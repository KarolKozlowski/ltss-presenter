import fnmatch
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, List, Optional

import psycopg2
import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from psycopg2.extras import DictCursor

load_dotenv()

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("ltss-presenter")

app = Flask(__name__)


def _get_db_dsn() -> str:
    dsn = os.getenv("DATABASE_URL")
    if dsn:
        return dsn

    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    dbname = os.getenv("POSTGRES_DB", "homeassistant")
    user = os.getenv("POSTGRES_USER", "postgres")
    password = os.getenv("POSTGRES_PASSWORD", "")
    sslmode = os.getenv("POSTGRES_SSLMODE", "")
    ssl_part = f" sslmode={sslmode}" if sslmode else ""
    return f"host={host} port={port} dbname={dbname} user={user} password={password}{ssl_part}"


def _get_conn():
    dsn = _get_db_dsn()
    if os.getenv("LOG_DSN_UNMASKED") == "1":
        logger.debug("DB DSN (unmasked): %s", dsn)
    else:
        logger.debug("DB DSN: %s", _mask_dsn(dsn))
    return psycopg2.connect(dsn)


def _mask_dsn(dsn: str) -> str:
    masked = re.sub(r"(password=)([^\s]+)", r"\1***", dsn)
    masked = re.sub(r"(://[^:/\s]+:)([^@/\s]+)@", r"\1***@", masked)
    return masked


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_filter_config() -> dict:
    path = os.getenv("CONFIG_PATH", "config.yaml")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def _compile_globs(globs: list[str]) -> list[re.Pattern[str]]:
    return [re.compile(fnmatch.translate(glob)) for glob in globs]


def _build_filter_state(config: dict) -> dict:
    entity_filter = config.get("entity_filter", {})
    include = entity_filter.get("include", {}) or {}
    exclude = entity_filter.get("exclude", {}) or {}

    include_entities = set(include.get("entities", []) or [])
    include_globs = include.get("entity_globs", []) or []
    exclude_entities = set(exclude.get("entities", []) or [])
    exclude_globs = exclude.get("entity_globs", []) or []

    env_include_globs = os.getenv("INCLUDE_ENTITY_GLOBS", "")
    if env_include_globs:
        include_globs = [
            glob.strip() for glob in env_include_globs.split(",") if glob.strip()
        ]

    return {
        "include_entities": include_entities,
        "exclude_entities": exclude_entities,
        "include_patterns": _compile_globs(include_globs),
        "exclude_patterns": _compile_globs(exclude_globs),
    }


def _build_metric_map(config: dict) -> dict[str, dict[str, str]]:
    metrics = config.get("metrics", {}) or {}
    metric_map: dict[str, dict[str, str]] = {}

    for metric_id, entry in metrics.items():
        if not isinstance(entry, dict):
            logger.warning("Invalid metrics entry for %s", metric_id)
            continue
        entity_id = entry.get("entity_id")
        if not entity_id:
            logger.warning("Missing entity_id for metric %s", metric_id)
            continue
        name = entry.get("name", "")
        metric_map[metric_id] = {"entity_id": entity_id, "name": name}

    return metric_map


FILTER_STATE = _build_filter_state(_load_filter_config())
METRIC_MAP = _build_metric_map(_load_filter_config())


def _matches_patterns(entity_id: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(pattern.match(entity_id) for pattern in patterns)


def _filter_entity_ids(entity_ids: list[str]) -> list[str]:
    include_entities = FILTER_STATE["include_entities"]
    exclude_entities = FILTER_STATE["exclude_entities"]
    include_patterns = FILTER_STATE["include_patterns"]
    exclude_patterns = FILTER_STATE["exclude_patterns"]

    filtered: list[str] = []
    for entity_id in entity_ids:
        in_include = entity_id in include_entities or _matches_patterns(
            entity_id, include_patterns
        )
        in_exclude = entity_id in exclude_entities or _matches_patterns(
            entity_id, exclude_patterns
        )

        if in_include and not in_exclude:
            filtered.append(entity_id)

    return filtered


def _resolve_metric(metric_id: str) -> tuple[str, str]:
    if metric_id in METRIC_MAP:
        mapping = METRIC_MAP[metric_id]
        return mapping["entity_id"], mapping.get("name", "")
    return metric_id, ""


@app.route("/")
def index():
    build_date = os.getenv("IMAGE_BUILD_DATE", "unknown")
    return render_template("index.html", build_date=build_date)


@app.route("/api/metrics")
def metrics():
    query = """
        SELECT
            entity_id,
            MAX(attributes->>'unit_of_measurement') AS unit,
            MAX(attributes->>'friendly_name') AS friendly_name
        FROM ltss
        GROUP BY entity_id
        ORDER BY entity_id
    """
    with _get_conn() as conn, conn.cursor(cursor_factory=DictCursor) as cur:
        cur.execute(query)
        rows = cur.fetchall()

    allowed = set(_filter_entity_ids([row["entity_id"] for row in rows]))

    rows = [row for row in rows if (row["entity_id"] in allowed)]

    return jsonify(
        [
            {
                "entity_id": row["entity_id"],
                "unit": row["unit"],
                "name": row["friendly_name"],
            }
            for row in rows
        ]
    )


@app.route("/api/timeseries")
def timeseries():
    metric_id = request.args.get("metric_id") or request.args.get("entity_id")
    if not metric_id:
        return jsonify({"error": "metric_id is required"}), 400

    entity_id, mapped_name = _resolve_metric(metric_id)
    allowed = metric_id in METRIC_MAP or _filter_entity_ids([entity_id])
    if not allowed:
        logger.warning("Blocked metric_id=%s entity_id=%s by filter", metric_id, entity_id)
        return jsonify({"error": "metric_id is not allowed"}), 404

    start = _parse_iso(request.args.get("start"))
    end = _parse_iso(request.args.get("end"))
    value = request.args.get("value", "state").lower()

    if value != "state":
        return jsonify({"error": "value must be state"}), 400

    where = ["entity_id = %s"]
    params: List[Any] = [entity_id]

    if start:
        where.append("time >= %s")
        params.append(start)
    if end:
        where.append("time <= %s")
        params.append(end)

    where_sql = " AND ".join(where)
    query = f"""
        SELECT
            time,
            CASE
                WHEN state ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN state::double precision
                ELSE NULL
            END AS value
        FROM ltss
        WHERE {where_sql}
        ORDER BY time ASC
    """

    with _get_conn() as conn, conn.cursor(cursor_factory=DictCursor) as cur:
        cur.execute(query, params)
        rows = cur.fetchall()

    labels: List[str] = []
    points: List[Optional[float]] = []
    for row in rows:
        labels.append(_iso(row["time"]))
        points.append(row["value"])

    return jsonify(
        {
            "metric_id": metric_id,
            "entity_id": entity_id,
            "name": mapped_name,
            "value": value,
            "labels": labels,
            "points": points,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
