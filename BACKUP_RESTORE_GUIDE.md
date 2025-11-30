# MONTORE バックアップ・リストアガイド

**Version**: 4.54  
**最終更新**: 2025-11-30

---

## 目次

1. [概要](#1-概要)
2. [バックアップ対象一覧](#2-バックアップ対象一覧)
3. [Firestoreデータのバックアップ](#3-firestoreデータのバックアップ)
4. [Firestoreデータのリストア](#4-firestoreデータのリストア)
5. [ソースコードのバックアップ](#5-ソースコードのバックアップ)
6. [Cloud Run環境の再構築](#6-cloud-run環境の再構築)
7. [Firebase Authentication の復旧](#7-firebase-authentication-の復旧)
8. [Secret Manager の設定](#8-secret-manager-の設定)
9. [完全リストア手順（ゼロからの復旧）](#9-完全リストア手順ゼロからの復旧)
10. [定期バックアップの自動化](#10-定期バックアップの自動化)

---

## 1. 概要

MONTOREシステムは以下のコンポーネントで構成されています：

| コンポーネント | 保存場所 | バックアップ方法 |
|--------------|---------|----------------|
| ソースコード | GitHub | 自動（git push） |
| ユーザーデータ | Firestore | 手動エクスポート |
| セッションデータ | Firestore | 手動エクスポート |
| システム設定 | Firestore | 手動エクスポート |
| 認証情報 | Firebase Auth | 別途エクスポート |
| APIキー | Secret Manager | 手動記録 |
| 動画/音声 | Cloud Storage | gsutil同期 |

---

## 2. バックアップ対象一覧

### 2.1 Firestore コレクション

| コレクション名 | 内容 | 重要度 |
|--------------|------|--------|
| `users` | ユーザー情報（名前、メール、権限） | ⭐⭐⭐ 高 |
| `sessions` | 学習セッション（会話ログ、評価結果） | ⭐⭐⭐ 高 |
| `test_patients` | 患者設定 | ⭐⭐ 中 |
| `systemConfigs` | ルーブリック、キーワード設定 | ⭐⭐ 中 |
| `generatedPatients` | AI生成患者 | ⭐ 低 |
| `aiAnalysisHistory` | AI分析履歴 | ⭐ 低 |
| `counters` | 自動採番用カウンター | ⭐⭐ 中 |

### 2.2 環境設定

| 項目 | 値 |
|------|-----|
| Firebase Project ID | `montore-e35be` |
| Cloud Run Service | `montore` |
| Region | `asia-northeast1` |
| GitHub Repository | `https://github.com/gmhata/montore.git` |
| Storage Bucket | `montore-e35be-recordings` |

---

## 3. Firestoreデータのバックアップ

### 3.1 前提条件

```bash
# Google Cloud SDKのインストール確認
gcloud --version

# 認証
gcloud auth login

# プロジェクト設定
gcloud config set project montore-e35be
```

### 3.2 全コレクションのエクスポート（推奨）

```bash
# バックアップ先のCloud Storageバケットを作成（初回のみ）
gsutil mb -l asia-northeast1 gs://montore-e35be-backups

# Firestoreの全データをエクスポート
gcloud firestore export gs://montore-e35be-backups/firestore-backup-$(date +%Y%m%d-%H%M%S)
```

### 3.3 特定コレクションのみエクスポート

```bash
# usersコレクションのみ
gcloud firestore export gs://montore-e35be-backups/users-backup-$(date +%Y%m%d) \
  --collection-ids=users

# sessionsコレクションのみ
gcloud firestore export gs://montore-e35be-backups/sessions-backup-$(date +%Y%m%d) \
  --collection-ids=sessions

# systemConfigsコレクションのみ（ルーブリック設定等）
gcloud firestore export gs://montore-e35be-backups/systemConfigs-backup-$(date +%Y%m%d) \
  --collection-ids=systemConfigs

# test_patientsコレクションのみ
gcloud firestore export gs://montore-e35be-backups/patients-backup-$(date +%Y%m%d) \
  --collection-ids=test_patients
```

### 3.4 バックアップ一覧の確認

```bash
# バックアップ一覧を表示
gsutil ls gs://montore-e35be-backups/

# 詳細情報
gsutil ls -l gs://montore-e35be-backups/
```

### 3.5 ローカルへのダウンロード（オプション）

```bash
# バックアップをローカルにダウンロード
mkdir -p ~/montore-backups
gsutil -m cp -r gs://montore-e35be-backups/firestore-backup-YYYYMMDD-HHMMSS ~/montore-backups/
```

---

## 4. Firestoreデータのリストア

### 4.1 全データのリストア

⚠️ **警告**: リストアは既存データを上書きします。本番環境で実行する前に必ずバックアップを取ってください。

```bash
# バックアップからリストア
gcloud firestore import gs://montore-e35be-backups/firestore-backup-YYYYMMDD-HHMMSS
```

### 4.2 特定コレクションのみリストア

```bash
# usersコレクションのみリストア
gcloud firestore import gs://montore-e35be-backups/users-backup-YYYYMMDD \
  --collection-ids=users

# systemConfigsコレクションのみリストア（ルーブリック設定）
gcloud firestore import gs://montore-e35be-backups/systemConfigs-backup-YYYYMMDD \
  --collection-ids=systemConfigs
```

### 4.3 新規プロジェクトへのリストア

別のFirebaseプロジェクトにリストアする場合：

```bash
# 新プロジェクトに切り替え
gcloud config set project NEW_PROJECT_ID

# リストア（バケットへのアクセス権が必要）
gcloud firestore import gs://montore-e35be-backups/firestore-backup-YYYYMMDD-HHMMSS
```

---

## 5. ソースコードのバックアップ

### 5.1 GitHubからのクローン

```bash
# リポジトリをクローン
git clone https://github.com/gmhata/montore.git
cd montore
```

### 5.2 ローカルバックアップ

```bash
# tarアーカイブ作成
cd ~/
tar -czf montore-source-$(date +%Y%m%d).tar.gz montore/

# AI Driveへのバックアップ（推奨）
cp montore-source-$(date +%Y%m%d).tar.gz /mnt/aidrive/backups/
```

---

## 6. Cloud Run環境の再構築

### 6.1 手動デプロイ

```bash
cd ~/montore

# 最新コードを取得
git pull origin main

# Cloud Runにデプロイ
gcloud run deploy montore \
  --source=. \
  --region=asia-northeast1 \
  --project=montore-e35be \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=300 \
  --set-env-vars="FIREBASE_PROJECT_ID=montore-e35be,FIRESTORE_PROJECT_ID=montore-e35be,APP_VERSION=4.54,ASSETS_BUCKET=montore-e35be-recordings" \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest"
```

### 6.2 Cloud Build経由のデプロイ（CI/CD）

```bash
# トリガー設定済みの場合、git pushで自動デプロイ
git push origin main
```

### 6.3 環境変数の確認

```bash
# 現在の環境変数を確認
gcloud run services describe montore \
  --region=asia-northeast1 \
  --format="yaml(spec.template.spec.containers[0].env)"
```

---

## 7. Firebase Authentication の復旧

### 7.1 ユーザー一覧のエクスポート

Firebase CLIを使用：

```bash
# Firebase CLIインストール
npm install -g firebase-tools

# ログイン
firebase login

# プロジェクト選択
firebase use montore-e35be

# ユーザー一覧をJSON形式でエクスポート
firebase auth:export users.json --format=json
```

### 7.2 ユーザーのインポート

```bash
# 新プロジェクトにインポート
firebase auth:import users.json --hash-algo=SCRYPT --project=NEW_PROJECT_ID
```

### 7.3 手動でのユーザー追加（少数の場合）

Firebase Console → Authentication → Users → 「ユーザーを追加」

---

## 8. Secret Manager の設定

### 8.1 シークレットの確認

```bash
# シークレット一覧
gcloud secrets list --project=montore-e35be

# 特定シークレットのバージョン確認
gcloud secrets versions list OPENAI_API_KEY --project=montore-e35be
```

### 8.2 シークレットの作成（新規プロジェクト用）

```bash
# OpenAI API Keyを登録
echo -n "sk-proj-YOUR_API_KEY" | \
gcloud secrets create OPENAI_API_KEY \
  --project=montore-e35be \
  --data-file=-

# Cloud Runサービスアカウントにアクセス権を付与
PROJECT_NUMBER=$(gcloud projects describe montore-e35be --format="value(projectNumber)")

gcloud secrets add-iam-policy-binding OPENAI_API_KEY \
  --project=montore-e35be \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 8.3 シークレット値の更新

```bash
# 新しいバージョンを追加
echo -n "sk-proj-NEW_API_KEY" | \
gcloud secrets versions add OPENAI_API_KEY --data-file=-
```

---

## 9. 完全リストア手順（ゼロからの復旧）

### 9.1 新規プロジェクトでの復旧

#### Step 1: Google Cloud プロジェクト作成

```bash
# プロジェクト作成
gcloud projects create montore-restored --name="MONTORE Restored"

# 課金を有効化（コンソールで実施）
# https://console.cloud.google.com/billing

# 必要なAPIを有効化
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  --project=montore-restored
```

#### Step 2: Firestore データベース作成

```bash
# Firestoreデータベースを作成
gcloud firestore databases create \
  --project=montore-restored \
  --location=asia-northeast1
```

#### Step 3: Firebase プロジェクト設定

1. Firebase Console (https://console.firebase.google.com/) にアクセス
2. 「プロジェクトを追加」→ 既存のGCPプロジェクト「montore-restored」を選択
3. Authentication → 「メール/パスワード」と「Google」を有効化
4. Webアプリを追加してAPIキーを取得

#### Step 4: ソースコードの取得

```bash
git clone https://github.com/gmhata/montore.git
cd montore
```

#### Step 5: 環境設定の更新

`server.js` の Firebase設定エンドポイント（`/firebase-config.js`）で使用されるデフォルト値を必要に応じて更新、または環境変数で上書き。

#### Step 6: Secret Manager 設定

```bash
# OpenAI API Key登録
echo -n "sk-proj-YOUR_KEY" | \
gcloud secrets create OPENAI_API_KEY \
  --project=montore-restored \
  --data-file=-
```

#### Step 7: Firestoreデータのリストア

```bash
# バックアップからリストア
gcloud firestore import gs://montore-e35be-backups/firestore-backup-YYYYMMDD-HHMMSS \
  --project=montore-restored
```

#### Step 8: Cloud Run デプロイ

```bash
gcloud run deploy montore \
  --source=. \
  --region=asia-northeast1 \
  --project=montore-restored \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=300 \
  --set-env-vars="FIREBASE_PROJECT_ID=montore-restored,FIRESTORE_PROJECT_ID=montore-restored,APP_VERSION=4.54,ASSETS_BUCKET=montore-restored-recordings" \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest"
```

#### Step 9: Firebase Authentication 承認ドメイン追加

Firebase Console → Authentication → Settings → 承認済みドメイン
- Cloud RunのURLを追加（例: `montore-xxxxx-an.a.run.app`）

#### Step 10: 動作確認

```bash
# ヘルスチェック
curl https://montore-xxxxx-an.a.run.app/health
```

---

## 10. 定期バックアップの自動化

### 10.1 Cloud Scheduler + Cloud Functions

```bash
# Cloud Functionsを作成（Node.js）
# functions/backup/index.js

const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');

exports.backupFirestore = async (event, context) => {
  const client = new Firestore.v1.FirestoreAdminClient();
  const projectId = 'montore-e35be';
  const bucket = 'gs://montore-e35be-backups';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  const databaseName = client.databasePath(projectId, '(default)');
  
  const [operation] = await client.exportDocuments({
    name: databaseName,
    outputUriPrefix: `${bucket}/scheduled-backup-${timestamp}`,
  });
  
  console.log(`Backup started: ${operation.name}`);
  return operation;
};
```

### 10.2 Cloud Schedulerでの定期実行

```bash
# 毎日午前3時にバックアップ
gcloud scheduler jobs create http firestore-daily-backup \
  --schedule="0 3 * * *" \
  --uri="https://asia-northeast1-montore-e35be.cloudfunctions.net/backupFirestore" \
  --http-method=POST \
  --time-zone="Asia/Tokyo" \
  --project=montore-e35be
```

### 10.3 手動バックアップスクリプト

`backup.sh` として保存：

```bash
#!/bin/bash
# MONTORE 手動バックアップスクリプト

PROJECT_ID="montore-e35be"
BACKUP_BUCKET="gs://montore-e35be-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "🔄 Starting Firestore backup..."
gcloud firestore export ${BACKUP_BUCKET}/manual-backup-${TIMESTAMP} \
  --project=${PROJECT_ID}

echo "✅ Backup completed: ${BACKUP_BUCKET}/manual-backup-${TIMESTAMP}"

# 30日以上前のバックアップを削除（オプション）
echo "🧹 Cleaning up old backups..."
gsutil ls ${BACKUP_BUCKET}/ | while read backup; do
  # 30日以上前のものを削除
  # gsutil rm -r $backup
  echo "Would delete: $backup"
done

echo "✅ Backup process completed!"
```

実行権限を付与して実行：

```bash
chmod +x backup.sh
./backup.sh
```

---

## クイックリファレンス

### よく使うコマンド

```bash
# Firestoreバックアップ（今すぐ実行）
gcloud firestore export gs://montore-e35be-backups/backup-$(date +%Y%m%d-%H%M%S)

# バックアップ一覧
gsutil ls gs://montore-e35be-backups/

# リストア
gcloud firestore import gs://montore-e35be-backups/backup-YYYYMMDD-HHMMSS

# Cloud Runデプロイ
cd ~/montore && git pull && gcloud run deploy montore --source=. --region=asia-northeast1

# サービス状態確認
gcloud run services describe montore --region=asia-northeast1
```

### 緊急連絡先/リソース

| 項目 | URL/値 |
|------|--------|
| Firebase Console | https://console.firebase.google.com/project/montore-e35be |
| Cloud Console | https://console.cloud.google.com/home/dashboard?project=montore-e35be |
| Cloud Run | https://console.cloud.google.com/run?project=montore-e35be |
| GitHub | https://github.com/gmhata/montore |
| 本番URL | https://montore-[hash]-an.a.run.app |

---

**作成者**: AI System  
**最終確認**: 2025-11-30
