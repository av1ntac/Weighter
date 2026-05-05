from __future__ import annotations

import csv
import io
import os
import re
from datetime import datetime
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from mangum import Mangum
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
FRONTEND_DIR = REPO_ROOT / "frontend"
STATIC_DIR = FRONTEND_DIR / "static"
DATA_DIR = REPO_ROOT / "data"
USER_FILE_PATTERN = re.compile(r"^data_(?P<user>[a-z0-9_-]+)\.csv$")
BACKUP_FILE_PATTERN = re.compile(r"^data_(?P<user>[a-z0-9_-]+)_(?P<date>\d{8})\.csv$")
CSV_FIELDNAMES = ["date", "time", "weight", "desired_weights"]
AWS_STORAGE_BUCKET = os.getenv("AWS_STORAGE_BUCKET", "").strip()
AWS_STORAGE_PREFIX = os.getenv("AWS_STORAGE_PREFIX", "").strip().strip("/")
USE_S3_STORAGE = bool(AWS_STORAGE_BUCKET)


def normalize_user_name(user: str | None) -> str:
    value = (user or "default").strip().lower()
    sanitized = re.sub(r"[^a-z0-9_-]+", "_", value).strip("_")
    if not sanitized:
        raise HTTPException(status_code=400, detail="User name must contain letters or numbers.")
    return sanitized


def format_user_label(user: str) -> str:
    if user == "default":
        return "Default"
    return " ".join(part.capitalize() for part in user.replace("-", "_").split("_") if part)


def is_backup_name(name: str) -> bool:
    return BACKUP_FILE_PATTERN.match(name) is not None


def parse_desired_weights(raw_value: str) -> list[float]:
    normalized = raw_value.strip()
    if not normalized:
        return []

    for separator in (";", "|"):
        normalized = normalized.replace(separator, ",")

    weights: list[float] = []
    for part in normalized.split(","):
        value = part.strip()
        if not value:
            continue
        weights.append(float(value))

    return weights


class StorageBackend:
    def get_csv_key(self, user: str | None) -> str:
        normalized_user = normalize_user_name(user)
        if normalized_user == "default":
            return "data.csv"
        return f"data_{normalized_user}.csv"

    def get_backup_key(self, user: str | None, backup_date: datetime | None = None) -> str:
        normalized_user = normalize_user_name(user)
        date_value = (backup_date or datetime.now()).strftime("%Y%m%d")
        return f"data_{normalized_user}_{date_value}.csv"

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def read_text(self, key: str) -> str:
        raise NotImplementedError

    def write_text(self, key: str, content: str) -> None:
        raise NotImplementedError

    def copy(self, source_key: str, destination_key: str) -> None:
        raise NotImplementedError

    def list_csv_names(self) -> list[str]:
        raise NotImplementedError


class LocalStorageBackend(StorageBackend):
    def _path(self, key: str) -> Path:
        return DATA_DIR / key

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def read_text(self, key: str) -> str:
        return self._path(key).read_text(encoding="utf-8")

    def write_text(self, key: str, content: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="")

    def copy(self, source_key: str, destination_key: str) -> None:
        source_path = self._path(source_key)
        destination_path = self._path(destination_key)
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        destination_path.write_bytes(source_path.read_bytes())

    def list_csv_names(self) -> list[str]:
        return [path.name for path in DATA_DIR.glob("*.csv")]


class S3StorageBackend(StorageBackend):
    def __init__(self, bucket: str, prefix: str = "") -> None:
        self.bucket = bucket
        self.prefix = prefix
        self.client = boto3.client("s3")

    def _object_key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._object_key(key))
            return True
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def read_text(self, key: str) -> str:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self._object_key(key))
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                raise FileNotFoundError(key) from exc
            raise
        return response["Body"].read().decode("utf-8")

    def write_text(self, key: str, content: str) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._object_key(key),
            Body=content.encode("utf-8"),
            ContentType="text/csv; charset=utf-8",
        )

    def copy(self, source_key: str, destination_key: str) -> None:
        self.client.copy_object(
            Bucket=self.bucket,
            CopySource={"Bucket": self.bucket, "Key": self._object_key(source_key)},
            Key=self._object_key(destination_key),
            ContentType="text/csv; charset=utf-8",
            MetadataDirective="REPLACE",
        )

    def list_csv_names(self) -> list[str]:
        names: list[str] = []
        continuation_token: str | None = None

        while True:
            kwargs = {
                "Bucket": self.bucket,
                "Prefix": f"{self.prefix}/" if self.prefix else "",
            }
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token

            response = self.client.list_objects_v2(**kwargs)
            for item in response.get("Contents", []):
                object_key = item.get("Key", "")
                name = object_key.rsplit("/", maxsplit=1)[-1]
                if name.endswith(".csv"):
                    names.append(name)

            if not response.get("IsTruncated"):
                break
            continuation_token = response.get("NextContinuationToken")

        return names


storage: StorageBackend
if USE_S3_STORAGE:
    storage = S3StorageBackend(AWS_STORAGE_BUCKET, AWS_STORAGE_PREFIX)
else:
    storage = LocalStorageBackend()


app = FastAPI(title="Weight Tracker API")
if not USE_S3_STORAGE:
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class WeightEntry(BaseModel):
    weight: float = Field(gt=0)
    date: str
    time: str


def read_csv_rows(key: str) -> tuple[list[dict[str, str]], list[str]]:
    try:
        content = storage.read_text(key)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="CSV file not found.") from exc

    reader = csv.DictReader(io.StringIO(content))
    fieldnames = reader.fieldnames
    required_headers = {"date", "time", "weight"}

    if fieldnames is None or not required_headers.issubset(fieldnames):
        raise HTTPException(
            status_code=400,
            detail="CSV must contain date, time, and weight columns.",
        )

    return list(reader), fieldnames


def write_csv_rows(key: str, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    storage.write_text(key, buffer.getvalue())


def create_empty_csv(key: str) -> None:
    write_csv_rows(key, [], CSV_FIELDNAMES)


def ensure_daily_backup(user: str | None = None) -> None:
    csv_key = storage.get_csv_key(user)
    backup_key = storage.get_backup_key(user)

    if storage.exists(backup_key):
        return

    if storage.exists(csv_key):
        storage.copy(csv_key, backup_key)
        return

    create_empty_csv(backup_key)


def list_users() -> list[dict[str, str]]:
    users: list[dict[str, str]] = []
    names = storage.list_csv_names()

    if "data.csv" in names:
        users.append({"id": "default", "label": "Default"})

    for name in names:
        if is_backup_name(name):
            continue
        match = USER_FILE_PATTERN.match(name)
        if match:
            user_id = match.group("user")
            users.append({"id": user_id, "label": format_user_label(user_id)})

    users.sort(key=lambda item: item["label"])
    return users


def load_weights(user: str | None = None) -> dict[str, str | list[dict[str, str | float]] | list[float]]:
    csv_key = storage.get_csv_key(user)
    normalized_user = normalize_user_name(user)
    rows, _ = read_csv_rows(csv_key)

    formatted_rows: list[dict[str, str | float]] = []
    desired_weights: set[float] = set()

    for index, row in enumerate(rows, start=2):
        try:
            date_value = (row.get("date") or "").strip()
            time_value = (row.get("time") or "").strip()
            weight_value = float((row.get("weight") or "").strip())
            desired_weight_values = parse_desired_weights(row.get("desired_weights") or "")
            timestamp = datetime.fromisoformat(f"{date_value}T{time_value}")
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid row at line {index}: {exc}",
            ) from exc

        desired_weights.update(desired_weight_values)
        formatted_rows.append(
            {
                "id": str(index),
                "date": date_value,
                "time": time_value,
                "weight": weight_value,
                "timestamp": timestamp.isoformat(),
            }
        )

    formatted_rows.sort(key=lambda item: str(item["timestamp"]))
    return {
        "user": normalized_user,
        "items": formatted_rows,
        "desired_weights": sorted(desired_weights, reverse=True),
    }


def append_weight(entry: WeightEntry, user: str | None = None) -> str:
    try:
        datetime.fromisoformat(f"{entry.date}T{entry.time}")
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="Date and time must be valid ISO values.",
        ) from exc

    csv_key = storage.get_csv_key(user)
    normalized_user = normalize_user_name(user)
    ensure_daily_backup(user)

    if storage.exists(csv_key):
        rows, fieldnames = read_csv_rows(csv_key)
    else:
        rows = []
        fieldnames = CSV_FIELDNAMES

    rows.append(
        {
            "date": entry.date,
            "time": entry.time,
            "weight": f"{entry.weight:.1f}",
            "desired_weights": "",
        }
    )
    write_csv_rows(csv_key, rows, fieldnames)
    return normalized_user


def delete_weight(row_id: int, user: str | None = None) -> dict[str, str]:
    csv_key = storage.get_csv_key(user)
    normalized_user = normalize_user_name(user)
    rows, fieldnames = read_csv_rows(csv_key)

    deleted_row: dict[str, str] | None = None
    kept_rows: list[dict[str, str]] = []

    for index, row in enumerate(rows, start=2):
        if index == row_id and deleted_row is None:
            deleted_row = row
            continue
        kept_rows.append(row)

    if deleted_row is None:
        raise HTTPException(status_code=404, detail="Weight entry not found.")

    write_csv_rows(csv_key, kept_rows, fieldnames)
    return {
        "id": str(row_id),
        "user": normalized_user,
        "date": (deleted_row.get("date") or "").strip(),
        "time": (deleted_row.get("time") or "").strip(),
        "weight": (deleted_row.get("weight") or "").strip(),
    }


@app.get("/api/users")
def get_users() -> dict[str, list[dict[str, str]]]:
    return {"users": list_users()}


@app.get("/api/weights")
def get_weights(user: str = Query(default="default")) -> dict[str, str | list[dict[str, str | float]] | list[float]]:
    return load_weights(user)


@app.post("/api/weights", status_code=201)
def create_weight(entry: WeightEntry, user: str = Query(default="default")) -> dict[str, str | float]:
    normalized_user = append_weight(entry, user)
    return {
        "user": normalized_user,
        "date": entry.date,
        "time": entry.time,
        "weight": round(entry.weight, 1),
    }


@app.delete("/api/weights/{row_id}")
def remove_weight(row_id: int, user: str = Query(default="default")) -> dict[str, str]:
    return delete_weight(row_id, user)


if not USE_S3_STORAGE:
    @app.get("/")
    def get_index() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "index.html")


handler = Mangum(app)
