from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "data.csv"

app = FastAPI(title="Weight Tracker API")
app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")


def load_weights() -> list[dict[str, str | float]]:
    if not CSV_PATH.exists():
        raise HTTPException(status_code=404, detail="CSV file not found.")

    rows: list[dict[str, str | float]] = []

    with CSV_PATH.open("r", encoding="utf-8", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        required_headers = {"date", "time", "weight"}

        if reader.fieldnames is None or not required_headers.issubset(reader.fieldnames):
            raise HTTPException(
                status_code=400,
                detail="CSV must contain date, time, and weight columns.",
            )

        for index, row in enumerate(reader, start=2):
            try:
                date_value = (row.get("date") or "").strip()
                time_value = (row.get("time") or "").strip()
                weight_value = float((row.get("weight") or "").strip())
                timestamp = datetime.fromisoformat(f"{date_value}T{time_value}")
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid row at line {index}: {exc}",
                ) from exc

            rows.append(
                {
                    "date": date_value,
                    "time": time_value,
                    "weight": weight_value,
                    "timestamp": timestamp.isoformat(),
                }
            )

    rows.sort(key=lambda item: str(item["timestamp"]))
    return rows


@app.get("/api/weights")
def get_weights() -> dict[str, list[dict[str, str | float]]]:
    return {"items": load_weights()}


@app.get("/")
def get_index() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")
