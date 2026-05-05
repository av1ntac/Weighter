# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Weighter is a self-hosted personal weight tracker. Users log daily weights; the app stores them as CSV files and renders a custom SVG line chart. It supports multiple named users (one CSV per user).

## Running Locally

```bash
pixi install --locked
pixi run start        # uvicorn on http://127.0.0.1:8010 with hot-reload
```

Open `http://127.0.0.1:8010` — the backend serves the frontend directly.

To test against an S3 bucket instead of the local `data/` directory:

```bash
export AWS_STORAGE_BUCKET="your-bucket-name"
export AWS_STORAGE_PREFIX="optional/prefix"
pixi run start
```

## Building the Lambda Package

```bash
pixi run package-lambda   # or: bash scripts/package_lambda.sh
```

Produces `lambda.zip`. Accepts env vars `LAMBDA_PYTHON_VERSION` (default 3.11) and `LAMBDA_ARCH` (default x86_64; also supports arm64).

## Architecture

### Backend (`backend/main.py`)

Single-file FastAPI app served via Mangum for Lambda compatibility.

**Storage abstraction** — Two backends selected at startup:
- `LocalStorageBackend`: reads/writes from `data/` (activated when `AWS_STORAGE_BUCKET` is unset)
- `S3StorageBackend`: reads/writes to S3 (activated when `AWS_STORAGE_BUCKET` is set)

**Multi-user convention**: `data.csv` = default user; `data_<name>.csv` = named users. Daily backup copies written as `data_<name>_YYYYMMDD.csv`.

**API surface**:
- `GET /api/users` — lists users inferred from CSV filenames
- `GET /api/weights?user=<name>` — returns records + desired-weight targets
- `POST /api/weights?user=<name>` — appends a row
- `DELETE /api/weights/{row_id}?user=<name>` — removes a row by ID

### Frontend (`frontend/`)

Pure HTML/CSS/JS — no build step, no framework.

- `index.html` — layout skeleton
- `static/script.js` — all logic: API calls, chart rendering (custom SVG, not D3)
- `static/styles.css` — CSS custom properties for the warm color palette
- `static/config.js` — sets `window.WEIGHT_API_BASE_URL`: empty string on localhost, the hardcoded Lambda Function URL in production

**Important**: when redeploying to a new Lambda, update the URL in `static/config.js` and commit the change to `main` — Amplify will redeploy automatically.

### AWS Deployment

One S3 data bucket + one Lambda function + AWS Amplify hosting (see `DEPLOY_AWS.md` for the full step-by-step):
- **Data bucket** — stores CSV files; Lambda reads/writes via `boto3`
- **Amplify** — hosts the static `frontend/`; redeploys automatically on push to `main`
- **Lambda** — FastAPI via Mangum, accessed through a public Lambda Function URL with CORS enabled

## No Test Suite or Linter

There is currently no test framework (pytest) or linter (ruff/black) configured. Manual testing via the browser and `curl` against the local server is the current practice.
