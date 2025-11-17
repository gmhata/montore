# MONTORE デプロイメントガイド

## 📋 前提条件

以下が完了していることを確認してください：

- ✅ Firebase Project作成（montore-e35be）
- ✅ Firestore Database作成（asia-northeast1）
- ✅ Firebase Authentication有効化（メール/パスワード）
- ✅ GCP API有効化（Cloud Run, Cloud Build, Artifact Registry, Secret Manager）
- ✅ GitHub Repository作成（https://github.com/gmhata/montore.git）

---

## 🚀 デプロイ手順

### STEP 1: OpenAI API KeyをSecret Managerに登録

```bash
# GCPプロジェクトを設定
gcloud config set project montore-e35be

# OpenAI API Keyを登録
echo -n "sk-proj-YOUR_API_KEY" | gcloud secrets create OPENAI_API_KEY \
  --data-file=- \
  --replication-policy="automatic"

# 確認
gcloud secrets versions access latest --secret="OPENAI_API_KEY"
```

### STEP 2: Cloud Storage Bucketを作成（録音ファイル用）

```bash
# Bucketを作成
gsutil mb -p montore-e35be -c STANDARD -l asia-northeast1 gs://montore-recordings

# CORS設定（ブラウザからのアップロードを許可）
cat > cors.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "POST", "PUT"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
EOF

gsutil cors set cors.json gs://montore-recordings

# 確認
gsutil ls -p montore-e35be
```

### STEP 3: Cloud Buildトリガーを設定

Google Cloud Console で設定：

1. https://console.cloud.google.com/cloud-build/triggers?project=montore-e35be にアクセス

2. 「トリガーを作成」をクリック

3. 設定値:
   ```
   名前: deploy-montore-production
   説明: MONTORE本番環境デプロイ
   
   イベント: ブランチにプッシュ
   ソース: 第1世代
   リポジトリ: gmhata/montore (GitHub接続が必要)
   ブランチ: ^main$
   
   構成:
   タイプ: Cloud Build構成ファイル（yamlまたはjson）
   場所: リポジトリ
   Cloud Build構成ファイルの場所: cloudbuild-dev.yaml
   
   サービスアカウント: (デフォルト)
   ```

4. 「作成」をクリック

### STEP 4: GitHub連携

Cloud Buildとリポジトリを接続：

1. Cloud Console > Cloud Build > トリガー
2. 「リポジトリを接続」
3. GitHub を選択
4. gmhata/montore を認証・接続

### STEP 5: 初回デプロイ

#### 方法A: GitHubプッシュでデプロイ（推奨）

```bash
cd /home/user/montore

# 変更をコミット
git add .
git commit -m "deploy: 初回デプロイ準備完了"

# GitHubにプッシュ（トリガーが自動実行される）
git push origin main
```

#### 方法B: 手動デプロイ

```bash
cd /home/user/montore

# GCPプロジェクトを設定
gcloud config set project montore-e35be

# Cloud Buildを実行
gcloud builds submit --config=cloudbuild-dev.yaml

# デプロイ完了後、URLを取得
gcloud run services describe montore \
  --region=asia-northeast1 \
  --format='value(status.url)'
```

---

## 🔧 デプロイ後の設定

### 1. Firebase認証ドメインを追加

1. Firebase Console にアクセス
   https://console.firebase.google.com/project/montore-e35be/authentication/settings

2. 「承認済みドメイン」タブ

3. 「ドメインを追加」をクリック

4. Cloud RunのURL（例: `montore-xxxxx-an.a.run.app`）を追加

### 2. 初期管理者ユーザーを作成

1. デプロイしたMONTOREにアクセス

2. 「新規登録」から管理者アカウントを作成
   - メール: gmhata@gmail.com
   - パスワード: （任意）

3. このメールアドレスは `server.js` で自動的に管理者権限が付与されます

### 3. 最初の患者を作成

1. 管理者としてログイン

2. 「管理画面」→「患者設定」

3. 「新規患者を作成」で最初の患者プロフィールを作成

---

## 📊 デプロイ状況の確認

### Cloud Buildログ

```bash
# 最新のビルドログを確認
gcloud builds list --limit=5 --project=montore-e35be

# 特定のビルドの詳細
gcloud builds log [BUILD_ID] --project=montore-e35be
```

### Cloud Runサービス状態

```bash
# サービス情報を取得
gcloud run services describe montore \
  --region=asia-northeast1 \
  --project=montore-e35be

# サービスURL
gcloud run services list --project=montore-e35be
```

### ログ確認

```bash
# Cloud Runのログをストリーム表示
gcloud logs tail --project=montore-e35be \
  --resource-type=cloud_run_revision \
  --log-filter='resource.labels.service_name="montore"'
```

---

## 🔄 更新デプロイ

コード変更後の再デプロイ：

```bash
cd /home/user/montore

# 変更をコミット
git add .
git commit -m "feat: 新機能の説明"

# プッシュ（自動デプロイ）
git push origin main
```

Cloud Buildが自動的にビルド・デプロイを実行します。

---

## 🐛 トラブルシューティング

### デプロイが失敗する

1. **権限エラー**
   ```bash
   # Cloud BuildサービスアカウントにCloud Run管理者権限を付与
   # GCP Console > IAM で確認
   ```

2. **Secret取得エラー**
   ```bash
   # OPENAI_API_KEYが存在するか確認
   gcloud secrets list --project=montore-e35be
   
   # Secret Managerの権限を確認
   # Cloud BuildサービスアカウントにSecret Managerのアクセス権限
   ```

3. **イメージプッシュエラー**
   ```bash
   # Artifact Registry APIが有効か確認
   gcloud services list --enabled --project=montore-e35be | grep artifactregistry
   ```

### 認証エラー

1. **Firebase認証ドメイン**
   - Cloud RunのURLが承認済みドメインに追加されているか確認

2. **firebaseConfig**
   - `public/auth.js` のfirebaseConfigが正しいか確認

### 500エラー

1. **環境変数**
   ```bash
   # Cloud Runの環境変数を確認
   gcloud run services describe montore \
     --region=asia-northeast1 \
     --project=montore-e35be \
     --format='value(spec.template.spec.containers[0].env)'
   ```

2. **Firestoreアクセス**
   - Firebase Consoleでセキュリティルールを確認
   - プロジェクトIDが正しいか確認

---

## 📞 サポート

問題が解決しない場合：

1. Cloud Buildログを確認
2. Cloud Runログを確認
3. GitHub Issuesで報告

---

## 🎯 チェックリスト

デプロイ前の最終確認：

- [ ] Firebase Project作成完了
- [ ] Firestore Database作成完了
- [ ] Authentication設定完了
- [ ] GCP API有効化完了
- [ ] OPENAI_API_KEY登録完了
- [ ] Cloud Storage Bucket作成完了
- [ ] Cloud Buildトリガー設定完了
- [ ] GitHub連携完了
- [ ] 初回デプロイ完了
- [ ] Firebase認証ドメイン追加完了
- [ ] 管理者ユーザー作成完了
- [ ] 動作確認完了

すべてチェックが完了したら、MONTOREの運用開始です！🎉
