#!/usr/bin/env bash
set -euo pipefail

PYTHON_VERSION="${LAMBDA_PYTHON_VERSION:-3.11}"
LAMBDA_ARCH="${LAMBDA_ARCH:-x86_64}"
PYTHON_BIN="${PYTHON_BIN:-}"

if [ -z "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    PYTHON_BIN="python"
  fi
fi

case "$LAMBDA_ARCH" in
  x86_64)
    PIP_PLATFORM="${LAMBDA_PIP_PLATFORM:-manylinux2014_x86_64}"
    ;;
  arm64 | aarch64)
    PIP_PLATFORM="${LAMBDA_PIP_PLATFORM:-manylinux2014_aarch64}"
    ;;
  *)
    echo "Unsupported LAMBDA_ARCH: $LAMBDA_ARCH" >&2
    echo "Use x86_64 or arm64." >&2
    exit 1
    ;;
esac

rm -rf build lambda.zip
mkdir -p build

"$PYTHON_BIN" -m pip install \
  --platform "$PIP_PLATFORM" \
  --implementation cp \
  --python-version "$PYTHON_VERSION" \
  --only-binary=:all: \
  --upgrade \
  --target build \
  -r requirements.txt

cp backend/main.py build/main.py

(
  cd build
  zip -r ../lambda.zip .
)

ZIP_LISTING="$(mktemp)"
trap 'rm -f "$ZIP_LISTING"' EXIT
unzip -l lambda.zip > "$ZIP_LISTING"

if ! grep -Eq 'pydantic_core/_pydantic_core.*\.so' "$ZIP_LISTING"; then
  echo "lambda.zip is missing pydantic_core/_pydantic_core*.so" >&2
  exit 1
fi

echo "Created lambda.zip for Python $PYTHON_VERSION on Lambda $LAMBDA_ARCH using $PIP_PLATFORM."
