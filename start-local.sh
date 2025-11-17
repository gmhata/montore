#!/bin/bash
# MONTORE ローカル開発サーバー起動スクリプト

echo "🚀 MONTORE ローカルサーバーを起動中..."
echo ""
echo "プロジェクト: montore-e35be"
echo "ポート: 4000"
echo ""

# .env.localファイルを読み込み
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '^#' | xargs)
fi

# OpenAI API Keyの確認
if [ -z "$OPENAI_API_KEY" ]; then
  echo "⚠️  警告: OPENAI_API_KEY が設定されていません"
  echo "   環境変数で設定するか、.env.localに追加してください"
  echo ""
fi

# サーバー起動
PORT=4000 node server.js
