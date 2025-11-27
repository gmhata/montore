# Node.js 20を使用
FROM node:20-slim

# 作業ディレクトリを設定
WORKDIR /app

# 環境変数を先に設定
ENV NODE_ENV=production

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール（本番用のみ）
RUN npm ci --only=production --loglevel=error

# アプリケーションのソースコードをコピー
COPY server.js ./
COPY public ./public

# Firebase設定ファイルを明示的にコピー（.gitignoreの影響を受けない）
# ビルド時に firebase-config.js が存在しない場合はプレースホルダーを作成
RUN if [ ! -f public/firebase-config.js ]; then \
    echo "window.FIREBASE_CONFIG={apiKey:'PLACEHOLDER_WILL_BE_REPLACED',authDomain:'PLACEHOLDER_PROJECT_ID.firebaseapp.com',projectId:'PLACEHOLDER_PROJECT_ID',storageBucket:'PLACEHOLDER_PROJECT_ID.firebasestorage.app',messagingSenderId:'PLACEHOLDER',appId:'PLACEHOLDER'};" > public/firebase-config.js; \
    fi

# 診断: ファイル確認とシンタックスチェック
RUN echo "=== Files in /app ===" && \
    ls -la && \
    echo "=== server.js exists? ===" && \
    test -f server.js && echo "YES" || echo "NO" && \
    echo "=== Syntax check ===" && \
    node --check server.js && echo "PASSED"

# ポート8080を公開
EXPOSE 8080

# アプリケーションを起動
CMD ["node", "server.js"]
