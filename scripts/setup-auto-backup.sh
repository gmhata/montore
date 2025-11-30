#!/bin/bash
# ============================================
# MONTORE 自動バックアップ設定スクリプト
# ============================================
# 
# このスクリプトは以下を設定します：
# 1. Cloud Functions（バックアップ実行用）
# 2. Cloud Scheduler（定期実行用）
# 3. 必要なIAM権限
#
# 使い方:
#   chmod +x setup-auto-backup.sh
#   ./setup-auto-backup.sh
#
# ============================================

set -e

# 設定
PROJECT_ID="montore-e35be"
REGION="asia-northeast1"
BACKUP_BUCKET="montore-e35be-backups"
FUNCTION_NAME="backupFirestore"
SCHEDULER_NAME="firestore-daily-backup"

echo "============================================"
echo "MONTORE 自動バックアップ設定"
echo "============================================"
echo ""
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Backup Bucket: ${BACKUP_BUCKET}"
echo ""

# プロジェクト設定
echo "📁 Setting project..."
gcloud config set project ${PROJECT_ID}

# 必要なAPIを有効化
echo ""
echo "🔧 Enabling required APIs..."
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  appengine.googleapis.com \
  --quiet

# App Engine アプリケーション作成（Cloud Scheduler に必要）
echo ""
echo "🌐 Checking App Engine application..."
if ! gcloud app describe --project=${PROJECT_ID} &>/dev/null; then
  echo "Creating App Engine application..."
  gcloud app create --region=${REGION} --quiet || true
else
  echo "App Engine application already exists"
fi

# Cloud Functions デプロイ
echo ""
echo "☁️ Deploying Cloud Function..."
cd "$(dirname "$0")/../functions/backup"

gcloud functions deploy ${FUNCTION_NAME} \
  --gen2 \
  --runtime=nodejs18 \
  --region=${REGION} \
  --source=. \
  --entry-point=backupFirestore \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=540s \
  --set-env-vars="GCP_PROJECT=${PROJECT_ID},BACKUP_BUCKET=${BACKUP_BUCKET}"

# Function URL を取得
FUNCTION_URL=$(gcloud functions describe ${FUNCTION_NAME} \
  --region=${REGION} \
  --format='value(serviceConfig.uri)')

echo ""
echo "✅ Function deployed: ${FUNCTION_URL}"

# サービスアカウントにFirestore権限を付与
echo ""
echo "🔐 Setting up IAM permissions..."
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Firestore Export権限
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/datastore.importExportAdmin" \
  --quiet

# Storage権限
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.admin" \
  --quiet

echo "✅ IAM permissions configured"

# Cloud Scheduler ジョブ作成
echo ""
echo "⏰ Creating Cloud Scheduler job..."

# 既存のジョブがあれば削除
gcloud scheduler jobs delete ${SCHEDULER_NAME} \
  --location=${REGION} \
  --quiet 2>/dev/null || true

# 新しいジョブを作成（毎日午前3時 JST）
gcloud scheduler jobs create http ${SCHEDULER_NAME} \
  --location=${REGION} \
  --schedule="0 3 * * *" \
  --uri="${FUNCTION_URL}" \
  --http-method=POST \
  --time-zone="Asia/Tokyo" \
  --attempt-deadline=540s \
  --description="Daily Firestore backup for MONTORE"

echo "✅ Scheduler job created: Daily at 03:00 JST"

# 完了メッセージ
echo ""
echo "============================================"
echo "✅ 自動バックアップ設定完了!"
echo "============================================"
echo ""
echo "📅 スケジュール: 毎日 午前3:00 (JST)"
echo "📦 バックアップ先: gs://${BACKUP_BUCKET}/"
echo "🔗 Function URL: ${FUNCTION_URL}"
echo ""
echo "📋 確認コマンド:"
echo "  # スケジューラー状態確認"
echo "  gcloud scheduler jobs describe ${SCHEDULER_NAME} --location=${REGION}"
echo ""
echo "  # 手動でバックアップ実行"
echo "  curl -X POST ${FUNCTION_URL}"
echo ""
echo "  # バックアップ一覧確認"
echo "  gsutil ls gs://${BACKUP_BUCKET}/"
echo ""
