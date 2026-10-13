#!/bin/sh
# Creates the "langfuse" bucket in MinIO — the only bucket this stack needs.
set -e

echo "waiting for S3 endpoint $ENDPOINT ..."
i=1
while [ "$i" -le 60 ]; do
  if aws --endpoint-url "$ENDPOINT" s3 ls >/dev/null 2>&1; then
    echo "S3 endpoint is up"
    break
  fi
  i=$((i + 1))
  sleep 3
done

if aws --endpoint-url "$ENDPOINT" s3 ls "s3://langfuse" >/dev/null 2>&1; then
  echo "bucket langfuse already exists"
else
  echo "creating bucket langfuse"
  aws --endpoint-url "$ENDPOINT" s3 mb "s3://langfuse"
fi

echo "bucket init done"
