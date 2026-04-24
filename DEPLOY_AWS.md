# Deploying to AWS from Linux or WSL

This project uses a split AWS deployment:

- S3 website bucket: hosts `index.html` and the static frontend assets.
- Lambda Function URL: runs the FastAPI backend from `main.py`.
- S3 data bucket: stores the CSV files read and written by the backend.

The commands below are written for Ubuntu/Linux/WSL with `bash`.

## 1. Install local tools

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip zip unzip curl
```

Install or update the AWS CLI:

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update
aws --version
```

Configure AWS credentials:

```bash
aws configure
```

Use an AWS user or role with permissions to manage Lambda, IAM, S3, and Lambda Function URLs.

## 2. Set deployment variables

Choose globally unique S3 bucket names before running the commands.

```bash
export AWS_REGION="eu-north-1"
export DATA_BUCKET="weighter-data-prod"
export WEB_BUCKET="weighter-web-prod"
export DATA_PREFIX="weights"
export FUNCTION_NAME="weighter-api"
export ROLE_NAME="weighter-lambda-role"
export LAMBDA_ARCH="x86_64"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
```

If you use a different region, update `AWS_REGION`. Keep `LAMBDA_ARCH` set to `x86_64` unless you intentionally package for `arm64`.

## 3. Create the S3 data bucket

Create the data bucket:

```bash
aws s3api create-bucket \
  --bucket "$DATA_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

Enable server-side encryption:

```bash
aws s3api put-bucket-encryption \
  --bucket "$DATA_BUCKET" \
  --server-side-encryption-configuration '{
    "Rules": [
      {
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "AES256"
        }
      }
    ]
  }'
```

Seed the existing CSV data:

```bash
aws s3 cp data.csv "s3://$DATA_BUCKET/$DATA_PREFIX/data.csv"
aws s3 cp data_cpu.csv "s3://$DATA_BUCKET/$DATA_PREFIX/data_cpu.csv"
```

The app treats `data.csv` as the `default` user. Files named `data_<user>.csv`, such as `data_cpu.csv`, become additional users.

## 4. Create the Lambda execution role

Create the trust policy:

```bash
cat > /tmp/weighter-lambda-trust-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
```

Create the role:

```bash
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/weighter-lambda-trust-policy.json
```

Attach the basic Lambda logging policy:

```bash
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Create a policy that allows the Lambda function to read and write the CSV files:

```bash
cat > /tmp/weighter-data-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::$DATA_BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "$DATA_PREFIX",
            "$DATA_PREFIX/*"
          ]
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::$DATA_BUCKET/$DATA_PREFIX/*"
    }
  ]
}
JSON
```

Attach the data policy:

```bash
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name weighter-data-access \
  --policy-document file:///tmp/weighter-data-policy.json
```

Wait a few seconds for IAM role propagation:

```bash
sleep 15
```

## 5. Package the Lambda function

From the project root:

```bash
bash scripts/package_lambda.sh
```

For the split S3 frontend deployment, only `main.py` and Python dependencies are required in `lambda.zip`.

The packaging script installs Python 3.11 manylinux wheels into `build/` and verifies that the Pydantic compiled extension is present in the zip. That avoids Lambda import errors like:

```text
Runtime.ImportModuleError: Unable to import module 'main': No module named 'pydantic_core._pydantic_core'
```

### Pixi alternative

If you use Pixi locally, let Pixi provide the locked Python environment and run the packaging script inside it:

```bash
pixi install --locked
pixi run package-lambda
```

This still invokes `pip`, but only inside Pixi's locked environment. That is the normal packaging shape for a Lambda zip: AWS Lambda needs the dependencies copied into the deployment directory, not a Pixi or Conda environment directory.

To package for an `arm64` Lambda instead, set the architecture before packaging and keep the Lambda function architecture the same:

```bash
export LAMBDA_ARCH="arm64"
pixi run package-lambda
```

Check the zip before upload:

```bash
unzip -l lambda.zip | grep 'pydantic_core/_pydantic_core'
```

## 6. Create or update the Lambda function

Create the function the first time:

```bash
aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime python3.11 \
  --handler main.handler \
  --architectures "$LAMBDA_ARCH" \
  --role "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
  --zip-file fileb://lambda.zip \
  --timeout 15 \
  --memory-size 512 \
  --region "$AWS_REGION" \
  --environment "Variables={AWS_STORAGE_BUCKET=$DATA_BUCKET,AWS_STORAGE_PREFIX=$DATA_PREFIX}"
```

For later deployments, update the code and configuration:

```bash
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://lambda.zip \
  --region "$AWS_REGION"

aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --timeout 15 \
  --memory-size 512 \
  --architectures "$LAMBDA_ARCH" \
  --region "$AWS_REGION" \
  --environment "Variables={AWS_STORAGE_BUCKET=$DATA_BUCKET,AWS_STORAGE_PREFIX=$DATA_PREFIX}"
```

If Lambda is already failing with a Pydantic import error, confirm that the deployed runtime and architecture match the package:

```bash
aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query '{Runtime:Runtime,Architectures:Architectures,Handler:Handler}'
```

For the default package, the result should include `python3.11` and `x86_64`. Rebuild and redeploy with matching settings:

```bash
export LAMBDA_ARCH="x86_64"
pixi run package-lambda

aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --runtime python3.11 \
  --handler main.handler \
  --architectures "$LAMBDA_ARCH" \
  --region "$AWS_REGION" \
  --environment "Variables={AWS_STORAGE_BUCKET=$DATA_BUCKET,AWS_STORAGE_PREFIX=$DATA_PREFIX}"

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION"

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://lambda.zip \
  --region "$AWS_REGION"
```

## 7. Create the Lambda Function URL

Create a public Function URL with CORS enabled:

```bash
aws lambda create-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --auth-type NONE \
  --region "$AWS_REGION" \
  --cors '{
    "AllowOrigins": ["*"],
    "AllowMethods": ["GET", "POST", "DELETE"],
    "AllowHeaders": ["content-type"],
    "MaxAge": 86400
  }'
```

Allow public invocation through the Function URL:

```bash
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id FunctionUrlAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$AWS_REGION"
```

Store the generated URL:

```bash
export API_URL="$(aws lambda get-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query FunctionUrl \
  --output text)"

echo "$API_URL"
```

## 8. Create the S3 website bucket

Create the website bucket:

```bash
aws s3api create-bucket \
  --bucket "$WEB_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

Enable static website hosting:

```bash
aws s3 website "s3://$WEB_BUCKET" \
  --index-document index.html \
  --error-document index.html
```

Allow public website reads:

```bash
aws s3api put-public-access-block \
  --bucket "$WEB_BUCKET" \
  --public-access-block-configuration '{
    "BlockPublicAcls": false,
    "IgnorePublicAcls": false,
    "BlockPublicPolicy": false,
    "RestrictPublicBuckets": false
  }'
```

Create the bucket policy:

```bash
cat > /tmp/weighter-web-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$WEB_BUCKET/*"
    }
  ]
}
JSON

aws s3api put-bucket-policy \
  --bucket "$WEB_BUCKET" \
  --policy file:///tmp/weighter-web-policy.json
```

## 9. Configure and upload the frontend

Generate `config.js` with the deployed API URL:

```bash
printf 'window.WEIGHT_API_BASE_URL = "%s";\n' "$API_URL" > config.js
```

Upload `index.html` to the website root. Upload the other frontend files under `static/` because `index.html` references `/static/styles.css`, `/static/config.js`, and `/static/script.js`.

```bash
aws s3 cp index.html "s3://$WEB_BUCKET/index.html" \
  --content-type "text/html; charset=utf-8"

aws s3 cp styles.css "s3://$WEB_BUCKET/static/styles.css" \
  --content-type "text/css; charset=utf-8"

aws s3 cp config.js "s3://$WEB_BUCKET/static/config.js" \
  --content-type "application/javascript; charset=utf-8"

aws s3 cp script.js "s3://$WEB_BUCKET/static/script.js" \
  --content-type "application/javascript; charset=utf-8"
```

Open the S3 website URL:

```bash
echo "http://$WEB_BUCKET.s3-website.$AWS_REGION.amazonaws.com"
```

## 10. Test the deployment

Test the API directly:

```bash
curl "$API_URL/api/users"
curl "$API_URL/api/weights?user=default"
```

Create a test weight entry:

```bash
curl -X POST "$API_URL/api/weights?user=default" \
  -H "content-type: application/json" \
  -d '{"weight":80.5,"date":"2026-04-18","time":"08:30"}'
```

Delete an entry by row id:

```bash
curl -X DELETE "$API_URL/api/weights/2?user=default"
```

Then open the S3 website URL and confirm that loading, saving, switching users, and deleting all work.

## 11. Redeploy after changes

Backend change:

```bash
bash scripts/package_lambda.sh

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://lambda.zip \
  --region "$AWS_REGION"
```

Frontend change:

```bash
aws s3 cp index.html "s3://$WEB_BUCKET/index.html" \
  --content-type "text/html; charset=utf-8"
aws s3 cp styles.css "s3://$WEB_BUCKET/static/styles.css" \
  --content-type "text/css; charset=utf-8"
aws s3 cp config.js "s3://$WEB_BUCKET/static/config.js" \
  --content-type "application/javascript; charset=utf-8"
aws s3 cp script.js "s3://$WEB_BUCKET/static/script.js" \
  --content-type "application/javascript; charset=utf-8"
```

## Notes

- Lambda does not keep local files between requests, so production storage must use S3.
- The backend automatically uses S3 when `AWS_STORAGE_BUCKET` is set.
- Daily backups are written to the data bucket as files like `weights/data_default_20260418.csv`.
- CSV storage is fine for a small personal tracker. For many users or frequent concurrent writes, DynamoDB would be a stronger long-term storage choice.
- A public Lambda Function URL and public S3 website are simple, but they are not private. Add authentication before storing sensitive personal data for real users.
