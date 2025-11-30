/**
 * MONTORE Firestore 自動バックアップ Cloud Function
 * 
 * Cloud Schedulerから定期的に呼び出され、Firestoreの全データをバックアップします。
 */

const { Firestore } = require('@google-cloud/firestore');

// 設定
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 'montore-e35be';
const BACKUP_BUCKET = process.env.BACKUP_BUCKET || 'montore-e35be-backups';

/**
 * Firestoreバックアップを実行するCloud Function
 * HTTP トリガーまたはPub/Subトリガーで呼び出し可能
 */
exports.backupFirestore = async (req, res) => {
  console.log('[Backup] Starting Firestore backup...');
  
  try {
    const client = new Firestore.v1.FirestoreAdminClient();
    
    // タイムスタンプ生成（日本時間）
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000; // UTC+9
    const jstDate = new Date(now.getTime() + jstOffset);
    const timestamp = jstDate.toISOString()
      .replace(/T/, '-')
      .replace(/:/g, '')
      .replace(/\..+/, '')
      .substring(0, 15); // YYYYMMDD-HHMMSS形式
    
    const databaseName = client.databasePath(PROJECT_ID, '(default)');
    const outputUri = `gs://${BACKUP_BUCKET}/scheduled-backup-${timestamp}`;
    
    console.log(`[Backup] Project: ${PROJECT_ID}`);
    console.log(`[Backup] Output: ${outputUri}`);
    
    // エクスポート開始
    const [operation] = await client.exportDocuments({
      name: databaseName,
      outputUriPrefix: outputUri,
    });
    
    console.log(`[Backup] Export started: ${operation.name}`);
    
    // レスポンス
    const response = {
      success: true,
      message: 'Backup started successfully',
      operationName: operation.name,
      outputUri: outputUri,
      timestamp: now.toISOString()
    };
    
    console.log('[Backup] Response:', JSON.stringify(response));
    
    if (res) {
      res.status(200).json(response);
    }
    
    return response;
    
  } catch (error) {
    console.error('[Backup] Error:', error);
    
    const errorResponse = {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
    if (res) {
      res.status(500).json(errorResponse);
    }
    
    throw error;
  }
};

/**
 * Pub/Subトリガー用のエントリーポイント
 */
exports.backupFirestorePubSub = async (message, context) => {
  console.log('[Backup] Triggered by Pub/Sub');
  return exports.backupFirestore(null, null);
};

/**
 * 古いバックアップを削除するCloud Function（オプション）
 * 30日以上前のバックアップを自動削除
 */
exports.cleanupOldBackups = async (req, res) => {
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage();
  const bucket = storage.bucket(BACKUP_BUCKET);
  
  const RETENTION_DAYS = 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  
  console.log(`[Cleanup] Deleting backups older than ${cutoffDate.toISOString()}`);
  
  try {
    const [files] = await bucket.getFiles({ prefix: 'scheduled-backup-' });
    
    let deletedCount = 0;
    for (const file of files) {
      const metadata = await file.getMetadata();
      const createdDate = new Date(metadata[0].timeCreated);
      
      if (createdDate < cutoffDate) {
        console.log(`[Cleanup] Deleting: ${file.name}`);
        await file.delete();
        deletedCount++;
      }
    }
    
    const response = {
      success: true,
      message: `Deleted ${deletedCount} old backup files`,
      cutoffDate: cutoffDate.toISOString()
    };
    
    console.log('[Cleanup] Response:', JSON.stringify(response));
    
    if (res) {
      res.status(200).json(response);
    }
    
    return response;
    
  } catch (error) {
    console.error('[Cleanup] Error:', error);
    
    if (res) {
      res.status(500).json({ success: false, error: error.message });
    }
    
    throw error;
  }
};
