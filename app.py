import fnmatch
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
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


# Metric mapping metadata exposed to the UI.
@dataclass(frozen=True)
class Metric:
    metric_id: str
    name: str
    unit: Optional[str]
    type: str
    chart_options: dict[str, Any]


@dataclass(frozen=True)
class MetricSeries(Metric):
    series: list[tuple[str, Optional[Any]]] = field(default_factory=list)
    value: Optional[Any] = None


@dataclass(frozen=True)
class Entity:
    entity_id: str
    unit: Optional[str]
    friendly_name: Optional[str]


@dataclass
class CacheEntry:
    value: Any
    stored_at: datetime


class TTLCache:
    def __init__(self) -> None:
        self._items: dict[str, CacheEntry] = {}

    def get(self, key: str, ttl_seconds: int) -> Optional[Any]:
        ttl_seconds = max(ttl_seconds, 0)
        if ttl_seconds <= 0:
            return None
        entry = self._items.get(key)
        if not entry:
            return None
        age = datetime.now(timezone.utc) - entry.stored_at
        if age.total_seconds() > ttl_seconds:
            logger.debug("Cache expired for key=%s", key)
            self._items.pop(key, None)
            return None
        return entry.value

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        ttl_seconds = max(ttl_seconds, 0)
        if ttl_seconds <= 0:
            return
        self._items[key] = CacheEntry(value=value, stored_at=datetime.now(timezone.utc))


# Centralized environment-backed settings and non-DB helpers.
class AppConfig:
    def __init__(self, config_path: Optional[str] = None) -> None:
        self.include_entity_globs = self._split_env_list(
            os.getenv("INCLUDE_ENTITY_GLOBS", "")
        )
        self.config_path = config_path or os.getenv("CONFIG_PATH", "config.yaml")
        self.config = self._load_yaml(self.config_path)

        db_config = self.config.get("db", {}) or {}

        self.database_url = os.getenv("DATABASE_URL") or db_config.get("url")
        self.pg_host = (
            os.getenv("POSTGRES_HOST") or db_config.get("host") or "localhost"
        )
        self.pg_port = str(
            os.getenv("POSTGRES_PORT") or db_config.get("port") or "5432"
        )
        self.pg_db = (
            os.getenv("POSTGRES_DB") or db_config.get("name") or "homeassistant"
        )
        self.pg_user = (
            os.getenv("POSTGRES_USER") or db_config.get("user") or "homeassistant"
        )
        self.pg_password = (
            os.getenv("POSTGRES_PASSWORD") or db_config.get("password") or "password"
        )
        self.pg_sslmode = (
            os.getenv("POSTGRES_SSLMODE") or db_config.get("sslmode") or ""
        )
        self.log_dsn_unmasked = (
            os.getenv("LOG_DSN_UNMASKED") == "1"
            if os.getenv("LOG_DSN_UNMASKED") is not None
            else bool(db_config.get("log_dsn_unmasked", False))
        )
        self.image_build_date = os.getenv("IMAGE_BUILD_DATE", "unknown")
        self.port = int(os.getenv("PORT", "5000"))
        self.metrics_cache_ttl = int(
            os.getenv(
                "METRICS_CACHE_TTL",
                self.config.get("metrics_cache_ttl", 300),
            )
        )

    @staticmethod
    def _split_env_list(raw_value: str) -> list[str]:
        return [glob.strip() for glob in raw_value.split(",") if glob.strip()]

    @staticmethod
    def _load_yaml(path: str) -> dict:
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8") as handle:
            return yaml.safe_load(handle) or {}


# Postgres connectivity and DSN masking.
class Database:
    def __init__(self, config: AppConfig) -> None:
        self.database_url = config.database_url
        self.pg_host = config.pg_host
        self.pg_port = config.pg_port
        self.pg_db = config.pg_db
        self.pg_user = config.pg_user
        self.pg_password = config.pg_password
        self.pg_sslmode = config.pg_sslmode
        self.log_dsn_unmasked = config.log_dsn_unmasked
        self._cache = TTLCache()
        self._metrics_cache_ttl = config.metrics_cache_ttl
        self._series_cache_ttl = 60

    def db_dsn(self) -> str:
        if self.database_url:
            return self.database_url

        ssl_part = f" sslmode={self.pg_sslmode}" if self.pg_sslmode else ""
        return (
            "host={host} port={port} dbname={dbname} user={user} "
            "password={password}{ssl_part}"
        ).format(
            host=self.pg_host,
            port=self.pg_port,
            dbname=self.pg_db,
            user=self.pg_user,
            password=self.pg_password,
            ssl_part=ssl_part,
        )

    def _masked_dsn(self) -> str:
        dsn = self.db_dsn()
        masked = re.sub(r"(password=)([^\s]+)", r"\1***", dsn)
        masked = re.sub(r"(://[^:/\s]+:)([^@/\s]+)@", r"\1***@", masked)
        return masked

    def _connect(self):
        dsn = self.db_dsn()
        if self.log_dsn_unmasked:
            logger.debug("DB DSN (unmasked): %s", dsn)
        else:
            logger.debug("DB DSN: %s", self._masked_dsn())
        return psycopg2.connect(dsn)

    def fetch_metrics(self) -> list[Entity]:
        cached = self._cache.get("metrics", self._metrics_cache_ttl)
        if cached is not None:
            return list(cached)

        query = """
            SELECT
                entity_id,
                MAX(attributes->>'unit_of_measurement') AS unit,
                MAX(attributes->>'friendly_name') AS friendly_name
            FROM ltss
            GROUP BY entity_id
            ORDER BY entity_id
        """
        with self._connect() as conn, conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(query)
            rows = cur.fetchall()

        metrics = [
            Entity(
                entity_id=row["entity_id"],
                unit=row["unit"],
                friendly_name=row["friendly_name"],
            )
            for row in rows
        ]
        self._cache.set("metrics", list(metrics), self._metrics_cache_ttl)
        return metrics

    def fetch_timeseries(
        self,
        entity_id: str,
        metric: Metric,
        start: Optional[datetime],
        end: Optional[datetime],
        latest_only: bool,
    ) -> MetricSeries:
        cache_key = self._series_cache_key(entity_id, start, end, latest_only)
        cached = self._cache.get(cache_key, self._series_cache_ttl)
        if cached is not None:
            return cached

        where = ["entity_id = %s"]
        params: List[Any] = [entity_id]

        if not latest_only:
            if start:
                where.append("time >= %s")
                params.append(start)
            if end:
                where.append("time <= %s")
                params.append(end)

        where_sql = " AND ".join(where)
        if metric.type == "text":
            value_sql = "state"
        else:
            value_sql = (
                "CASE WHEN state ~ '^-?[0-9]+(\\.[0-9]+)?$' "
                "THEN state::double precision ELSE NULL END"
            )

        limit_value = 1
        order_dir = "DESC" if latest_only else "ASC"
        limit_clause = f"LIMIT {limit_value}" if latest_only else ""

        query = f"""
            SELECT
                time,
                {value_sql} AS value
            FROM ltss
            WHERE {where_sql}
            ORDER BY time {order_dir}
            {limit_clause}
        """

        with self._connect() as conn, conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(query, params)
            rows = cur.fetchall()

        series: list[tuple[str, Optional[Any]]] = []
        latest_value: Optional[Any] = None
        for row in rows:
            timestamp = row["time"].isoformat()
            value = row["value"]
            if metric.type != "text":
                series.append((timestamp, value))
            if value is not None:
                latest_value = value

        metric_series = MetricSeries(
            metric_id=metric.metric_id,
            name=metric.name,
            unit=metric.unit,
            type=metric.type,
            chart_options=metric.chart_options,
            series=series,
            value=latest_value if metric.type == "text" else None,
        )
        self._cache.set(cache_key, metric_series, self._series_cache_ttl)
        return metric_series

    def _series_cache_key(
        self,
        entity_id: str,
        start: Optional[datetime],
        end: Optional[datetime],
        latest_only: bool,
    ) -> str:
        start_key = start.isoformat() if start else ""
        end_key = end.isoformat() if end else ""
        return f"series:{entity_id}:{latest_only}:{start_key}:{end_key}"


# Applies config-driven entity filtering and custom metric mapping.
class MetricRegistry:
    def __init__(self, config: AppConfig) -> None:
        self._filter_state = self._build_filter_state(config)
        self._metric_map = self._build_metric_map(config.config)
        self._metric_entity_map = self._build_metric_entities(config.config)
        self.default_metric = config.config.get("default_metric")

    def _build_filter_state(self, config: AppConfig) -> dict[str, Any]:
        entity_filter = config.config.get("entity_filter", {})
        include = entity_filter.get("include", {}) or {}
        exclude = entity_filter.get("exclude", {}) or {}

        include_entities = set(include.get("entities", []) or [])
        include_globs = include.get("entity_globs", []) or []
        exclude_entities = set(exclude.get("entities", []) or [])
        exclude_globs = exclude.get("entity_globs", []) or []

        if config.include_entity_globs:
            include_globs = config.include_entity_globs

        return {
            "include_entities": include_entities,
            "exclude_entities": exclude_entities,
            "include_patterns": self._compile_globs(include_globs),
            "exclude_patterns": self._compile_globs(exclude_globs),
        }

    def _build_metric_map(self, config: dict) -> dict[str, Metric]:
        metrics = config.get("metrics", {}) or {}
        metric_map: dict[str, Metric] = {}

        for metric_id, entry in metrics.items():
            if not isinstance(entry, dict):
                logger.warning("Invalid metrics entry for %s", metric_id)
                continue
            entity_id = entry.get("entity_id")
            if not entity_id:
                logger.warning("Missing entity_id for metric %s", metric_id)
                continue
            name = entry.get("name", "")
            metric_type = entry.get("type", "line")
            chart_options = entry.get("chart_options", {})
            if not isinstance(chart_options, dict):
                logger.warning("Invalid chart_options for metric %s", metric_id)
                chart_options = {}

            metric_map[metric_id] = Metric(
                metric_id=metric_id,
                name=name,
                unit=None,
                type=metric_type,
                chart_options=chart_options,
            )

        return metric_map

    # Build a mapping of metric_id to entity_id for fetching time-series data
    def _build_metric_entities(self, config: dict) -> dict[str, str]:
        metrics = config.get("metrics", {}) or {}
        metric_entities: dict[str, str] = {}

        for metric_id, entry in metrics.items():
            if not isinstance(entry, dict):
                continue
            entity_id = entry.get("entity_id")
            if not entity_id:
                continue
            metric_entities[metric_id] = entity_id

        return metric_entities

    def _matches_patterns(
        self, entity_id: str, patterns: list[re.Pattern[str]]
    ) -> bool:
        return any(pattern.match(entity_id) for pattern in patterns)

    @staticmethod
    def _compile_globs(globs: list[str]) -> list[re.Pattern[str]]:
        return [re.compile(fnmatch.translate(glob)) for glob in globs]

    def filter_entity_ids(self, entity_ids: list[str]) -> list[str]:
        include_entities = self._filter_state["include_entities"]
        exclude_entities = self._filter_state["exclude_entities"]
        include_patterns = self._filter_state["include_patterns"]
        exclude_patterns = self._filter_state["exclude_patterns"]

        filtered: list[str] = []
        for entity_id in entity_ids:
            in_include = entity_id in include_entities or self._matches_patterns(
                entity_id, include_patterns
            )
            in_exclude = entity_id in exclude_entities or self._matches_patterns(
                entity_id, exclude_patterns
            )

            if in_include and not in_exclude:
                filtered.append(entity_id)

        return filtered

    def resolve_metric(self, metric_id: str) -> Metric:
        if metric_id in self._metric_map:
            return self._metric_map[metric_id]
        return Metric(
            metric_id=metric_id,
            name="",
            unit=None,
            type="line",
            chart_options={},
        )

    def resolve_entity_id(self, metric_id: str) -> str:
        return self._metric_entity_map.get(metric_id, metric_id)

    def is_allowed_metric(self, metric_id: str) -> bool:
        if metric_id in self._metric_map:
            return True
        return bool(self.filter_entity_ids([metric_id]))

    def metrics_response(self, entity_rows: list[Entity]) -> list[Metric]:
        entity_by_id = {row.entity_id: row for row in entity_rows}
        allowed = set(self.filter_entity_ids(list(entity_by_id.keys())))
        mapped_entity_ids = set(self._metric_entity_map.values())
        response: list[Metric] = []

        for entity_id in allowed:
            if entity_id in mapped_entity_ids:
                continue
            row = entity_by_id[entity_id]
            response.append(
                Metric(
                    metric_id=entity_id,
                    name=row.friendly_name or entity_id,
                    unit=row.unit,
                    type="line",
                    chart_options={},
                )
            )

        for metric_id, metric in self._metric_map.items():
            entity_id = self._metric_entity_map.get(metric_id)
            row = entity_by_id.get(entity_id) if entity_id else None
            response.append(
                Metric(
                    metric_id=metric_id,
                    name=metric.name
                    or (row.friendly_name if row else metric_id)
                    or metric_id,
                    unit=row.unit if row else metric.unit,
                    type=metric.type,
                    chart_options=metric.chart_options,
                )
            )

        response.sort(key=lambda item: item.metric_id or "")
        return response


class LTSSApi:
    def __init__(
        self,
        flask_app: Flask,
        registry: MetricRegistry,
        config: AppConfig,
        database: Database,
    ) -> None:
        self.app = flask_app
        self.registry = registry
        self.app_config = config
        self.database = database
        self._register_routes()

    def _register_routes(self) -> None:
        self.app.add_url_rule("/", view_func=self.index)
        self.app.add_url_rule("/api/metrics", view_func=self.metrics)
        self.app.add_url_rule("/api/config", view_func=self.config)
        self.app.add_url_rule("/api/timeseries", view_func=self.timeseries)

    def index(self):
        return render_template(
            "index.html",
        )

    @staticmethod
    # Guard against invalid or overly large ranges for time-series requests.
    def _validate_date_range(
        start: Optional[datetime], end: Optional[datetime]
    ) -> Optional[str]:
        if start and end and start >= end:
            return "start must be earlier than end"

        now = datetime.now(timezone.utc)
        oldest_allowed = now - timedelta(days=7)

        if start and start < oldest_allowed:
            return "start cannot be older than 7 days"
        if end and end < oldest_allowed:
            return "end cannot be older than 7 days"

        return None

    def metrics(self):
        metrics = self.database.fetch_metrics()
        response = [
            asdict(metric) for metric in self.registry.metrics_response(metrics)
        ]
        return jsonify(response)

    def config(self):
        return jsonify({"default_metric": self.app_config.config.get("default_metric")})

    def timeseries(self):
        metric_id = request.args.get("metric_id") or request.args.get("entity_id")
        if not metric_id:
            return jsonify({"error": "metric_id is required"}), 400

        metric = self.registry.resolve_metric(metric_id)
        entity_id = self.registry.resolve_entity_id(metric_id)
        allowed = self.registry.is_allowed_metric(metric_id)
        if not allowed:
            logger.warning(
                "Blocked metric_id=%s entity_id=%s by filter",
                metric_id,
                entity_id,
            )
            return jsonify({"error": "metric_id is not allowed"}), 404

        # Parse client-provided ISO timestamps without normalizing timezones.
        start_raw = request.args.get("start")
        end_raw = request.args.get("end")
        start = (
            datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
            if start_raw
            else None
        )
        end = (
            datetime.fromisoformat(end_raw.replace("Z", "+00:00")) if end_raw else None
        )
        # For text metrics, or if no range is provided, we only fetch the latest value without validating the range.
        latest_only = metric.type == "text" or (not start and not end)
        if not latest_only:
            validation_error = self._validate_date_range(start, end)
            if validation_error:
                return jsonify({"error": validation_error}), 400

        series = self.database.fetch_timeseries(
            entity_id,
            metric,
            start,
            end,
            latest_only,
        )

        return jsonify(asdict(series))


# Initialize configuration from environment
APP_CONFIG = AppConfig()
# Create metric registry and database connection
REGISTRY = MetricRegistry(APP_CONFIG)
# Create database instance from config
DATABASE = Database(APP_CONFIG)
# Initialize and register API routes
LTSSApi(app, REGISTRY, APP_CONFIG, DATABASE)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=APP_CONFIG.port)
