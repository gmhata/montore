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
