# Deploying To AWS With S3 And Lambda

This project is now prepared for a split deployment:

- `S3` hosts the static frontend (`index.html`, `styles.css`, `script.js`, `config.js`)
- `Lambda` runs the FastAPI backend from `main.py`
- `S3` also stores the CSV data files used by the backend

## 1. Create the data bucket

Create or choose an S3 bucket for CSV storage, for example:

- Bucket: `weighter-data-prod`
- Prefix: `weights`

The Lambda function needs read/write access to this bucket.

## 2. Package the Lambda function

From the project root:

```powershell
New-Item -ItemType Directory -Force build
pip install -r requirements.txt -t build
Copy-Item main.py build\
Compress-Archive -Path build\* -DestinationPath lambda.zip -Force
```

If you want the Lambda to also serve the static files, copy these too:

```powershell
Copy-Item index.html build\
Copy-Item styles.css build\
Copy-Item script.js build\
Copy-Item config.js build\
```

For the S3-hosted frontend pattern, only `main.py` is required in the zip.

## 3. Create the Lambda function

Recommended settings:

- Runtime: `Python 3.11`
- Handler: `main.handler`
- Architecture: `x86_64` or `arm64`
- Memory: `512 MB`
- Timeout: `15 seconds`

Set these environment variables:

- `AWS_STORAGE_BUCKET=weighter-data-prod`
- `AWS_STORAGE_PREFIX=weights`

## 4. Grant Lambda access to the data bucket

Attach an IAM policy like this to the Lambda execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::weighter-data-prod",
        "arn:aws:s3:::weighter-data-prod/weights/*"
      ]
    }
  ]
}
```

If you use no prefix, change the object ARN to `arn:aws:s3:::weighter-data-prod/*`.

## 5. Expose the Lambda API

Use one of these:

- `Lambda Function URL`
- `API Gateway HTTP API`

For a small app, a Lambda Function URL is the quickest option.

If you use a browser-based frontend from S3, configure CORS on the Lambda/API to allow:

- `GET`
- `POST`
- `DELETE`
- `OPTIONS`
- `Content-Type` header

## 6. Configure the frontend API URL

Edit `config.js` before uploading the frontend:

```js
window.WEIGHT_API_BASE_URL = "https://your-api-id.lambda-url.region.on.aws";
```

If you deploy through API Gateway, use that HTTPS base URL instead.

## 7. Upload the frontend to an S3 website bucket

Create a second S3 bucket for the website, for example `weighter-web-prod`.

Upload:

- `index.html`
- `styles.css`
- `script.js`
- `config.js`

Then enable either:

- S3 static website hosting, or
- CloudFront in front of the bucket

CloudFront is the better production option.

## 8. Seed your CSV data

Upload your existing local CSV files to the data bucket prefix, for example:

- `data.csv`
- `data_alice.csv`
- `data_bob.csv`

Stored as:

- `weights/data.csv`
- `weights/data_alice.csv`
- `weights/data_bob.csv`

Daily backups are also written there automatically as files like:

- `weights/data_default_20260401.csv`

## 9. Test the deployment

Check:

- `GET /api/users`
- `GET /api/weights?user=default`
- `POST /api/weights?user=default`
- `DELETE /api/weights/{row_id}?user=default`

Then open the S3-hosted frontend and confirm create/delete flows work.

## Notes

- Lambda does not keep local files between requests, so S3-backed storage is required for this app design.
- This app rewrites the whole CSV on delete, which is fine for small personal datasets but not ideal for high traffic.
- If you expect concurrent users or lots of writes, DynamoDB would be a stronger long-term backend than CSV files in S3.
