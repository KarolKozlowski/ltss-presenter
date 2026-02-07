# LTSS Presenter

Minimal Flask app for reading Home Assistant long-term statistics (LTSS) from Postgres and serving JSON for JavaScript plotting, plus a simple Apache ECharts page.

## Endpoints

- `GET /api/metrics` - List available metric IDs and units.
- `GET /api/timeseries?metric_id=...&value=state&start=...&end=...` - Time-series JSON: `{ labels, points }`.

## Configuration

Set `DATABASE_URL` (recommended for containers):

```
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

Fallback environment variables if `DATABASE_URL` is not set:

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

### Entity filters

The app can filter available entities using a Home Assistant style config file.
By default it looks for `config.yaml` in the app directory (optional). Use `config.yaml.example` as a template.
Override the location with `CONFIG_PATH`.

You can also define an include filter via environment variable:

```
INCLUDE_ENTITY_GLOBS=sensor.weather_*,sensor.outdoor_*
```

Example config (HA-style include/exclude lists):

```
entity_filter:
  exclude:
    entity_globs:
      - sensor.weather_*
    entities:
      - sun.sun
      - sensor.last_boot
      - sensor.date
  include:
    entities: []
    entity_globs: []

metrics:
  pc_monthly_energy:
    entity_id: sensor.pc_monthly_energy_consumption
    name: "PC monthly energy"
```

## Run locally

```
pip install -r requirements.txt
export DATABASE_URL=postgresql://user:pass@host:5432/dbname
python app.py
```

Open http://localhost:5000 to view the chart UI.

## Run with Docker

Build and run the container:

```
docker build -t ltss-presenter .
docker run -p 5000:5000 -e DATABASE_URL=postgresql://user:pass@host:5432/dbname ltss-presenter
```

Or use docker compose:

```
docker compose up --build
```

Or use the Makefile:

```
make build
make run
make compose
```

## Notes

- The API returns labels as ISO-8601 UTC timestamps and points as numeric values.
- For large ranges, consider adding downsampling or aggregation.
- `.env` is loaded automatically via `python-dotenv` if present.