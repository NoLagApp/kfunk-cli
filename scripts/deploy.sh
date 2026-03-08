#!/usr/bin/env bash
set -euo pipefail

# Deploy kFunk worker to Google Cloud Run
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - A GCP project selected (gcloud config set project YOUR_PROJECT)
#   - Artifact Registry API enabled
#   - Cloud Run API enabled

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
REGION="${KFUNK_REGION:-us-central1}"
SERVICE_NAME="${KFUNK_SERVICE_NAME:-kfunk-worker}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/kfunk/$SERVICE_NAME"

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "Error: No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Deploying kFunk worker to Cloud Run"
echo "  Project:  $PROJECT_ID"
echo "  Region:   $REGION"
echo "  Service:  $SERVICE_NAME"
echo ""

# Create Artifact Registry repo if it doesn't exist
gcloud artifacts repositories describe kfunk \
  --location="$REGION" \
  --project="$PROJECT_ID" >/dev/null 2>&1 || \
gcloud artifacts repositories create kfunk \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --description="kFunk container images"

echo "Building and pushing container image..."
gcloud builds submit \
  --tag "$IMAGE" \
  --project "$PROJECT_ID" \
  --quiet

echo "Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 100 \
  --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)")

echo ""
echo "Deployed successfully!"
echo "Service URL: $SERVICE_URL"
echo ""
echo "Run a distributed test:"
echo "  kfunk run-nolag --token YOUR_TOKEN --service-url $SERVICE_URL --workers 10 --duration 30"
