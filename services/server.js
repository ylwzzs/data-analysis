const express = require("express");
const duckdb = require("duckdb");
const AWS = require("aws-sdk");

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.DUCKDB_PORT || 9000;

// S3 配置（天翼云 OOS）
const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://xinan-1-internal.zos.ctyun.cn";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
const S3_BUCKET = process.env.S3_BUCKET || "lemeng-datasource";

// DuckDB 连接
let db = null;
let conn = null;

async function initDuckDB() {
  db = new duckdb.Database(":memory:");
  conn = db.connect();

  // 配置 S3
  const endpoint = S3_ENDPOINT.replace("http://", "").replace("https://", "");
  await runQuery("SET s3_endpoint='" + endpoint + "'");
  await runQuery("SET s3_access_key_id='" + S3_ACCESS_KEY + "'");
  await runQuery("SET s3_secret_access_key='" + S3_SECRET_KEY + "'");
  await runQuery("SET s3_use_ssl=false");
  await runQuery("SET s3_region='xinan-1'");

  console.log("DuckDB initialized with S3:", S3_ENDPOINT);
}

function runQuery(sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function escapeSQL(val) {
  if (val == null) return 'NULL';
  // 所有非 NULL 值都用引号包裹（VARCHAR 列）
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function inferType(val) {
  if (typeof val === 'number') return 'DOUBLE';  // 统一用 DOUBLE 避免 BigInt 混用
  if (typeof val === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}

function toSQLValue(val, type) {
  if (val == null) return 'NULL';
  if (type === 'DOUBLE') return parseFloat(val) || 0;
  if (type === 'BOOLEAN') return val ? 'true' : 'false';
  return escapeSQL(val);
}

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "duckdb", s3_endpoint: S3_ENDPOINT });
});

// 查询执行
app.post("/query", async (req, res) => {
  try {
    const { sql, user_id, dept_id } = req.body;
    if (!sql) return res.status(400).json({ error: "Missing sql" });

    console.log("[query] user:", user_id, "sql:", sql.substring(0, 100));
    const result = await runQuery(sql);
    res.json({ success: true, data: result, rowCount: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 通用数据转换端点 =====
app.post("/transform", async (req, res) => {
  const startTime = Date.now();
  try {
    const { records, config } = req.body;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: "Missing or empty records" });
    }
    if (!config || !config.date) {
      return res.status(400).json({ error: "Missing config.date" });
    }

    const {
      date,
      source = 'unknown',
      partition_by = [],
      dedupe_key = [],
      required_fields = [],
      output_format = 'parquet',
      compression = 'zstd',
      base_path = null
    } = config;

    const totalRecords = records.length;
    console.log(`[transform] ${totalRecords} records from ${source} for ${date}`);

    // 所有列用 VARCHAR 避免类型推断问题
    const sampleRow = records[0];
    const schema = Object.keys(sampleRow).map(key => ({ name: key, type: 'VARCHAR' }));

    // 创建临时表（全部 VARCHAR）
    const columnsDef = schema.map(c => `"${c.name}" VARCHAR`).join(', ');
    await runQuery(`CREATE OR REPLACE TABLE temp_raw (${columnsDef})`);

    // 批量插入
    const batchSize = 1000;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = batch.map(row => {
        const cols = schema.map(c => escapeSQL(row[c.name]));
        return '(' + cols.join(', ') + ')';
      }).join(', ');
      await runQuery(`INSERT INTO temp_raw VALUES ${values}`);
    }

    // 数据校验（所有列都是 VARCHAR，只检查 NULL 和空字符串）
    let invalidCount = 0;
    if (required_fields.length > 0) {
      const whereClause = required_fields
        .map(f => `"${f}" IS NULL OR "${f}" = ''`)
        .join(' OR ');
      const result = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM temp_raw WHERE ${whereClause}`);
      invalidCount = result[0]?.cnt || 0;
      if (invalidCount > 0) console.warn(`[transform] ${invalidCount} invalid rows`);
    }

    // 去重
    if (dedupe_key.length > 0) {
      const keyCols = dedupe_key.join(', ');
      await runQuery(`
        CREATE OR REPLACE TABLE deduped AS
        SELECT DISTINCT ON (${keyCols}) *
        FROM temp_raw
        ORDER BY ${keyCols}
      `);
    } else {
      await runQuery("CREATE OR REPLACE TABLE deduped AS SELECT * FROM temp_raw");
    }

    const dedupedResult = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped");
    const dedupedCount = dedupedResult[0]?.cnt || totalRecords;
    const duplicatesRemoved = totalRecords - dedupedCount;
    if (duplicatesRemoved > 0) console.log(`[transform] Removed ${duplicatesRemoved} duplicates`);

    // 导出路径
    const basePath = base_path || `${source}/${date}`;
    const exportResults = [];

    // 分片导出
    if (partition_by.length > 0) {
      const partitionValues = await runQuery(
        `SELECT DISTINCT ${partition_by.join(', ')} FROM deduped ORDER BY ${partition_by.join(', ')}`
      );

      for (const pv of partitionValues) {
        const partitionKey = partition_by.map(col => `${col}_${pv[col]}`).join('_');
        const fileName = `${basePath}/${partitionKey}.${output_format}`;
        const s3Path = `s3://${S3_BUCKET}/${fileName}`;
        const whereClause = partition_by.map(col => `${col} = ${pv[col]}`).join(' AND ');

        await runQuery(`
          COPY (SELECT * FROM deduped WHERE ${whereClause})
          TO '${s3Path}' (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})
        `);

        const cntResult = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped WHERE ${whereClause}`);
        exportResults.push({ file: fileName, partition: pv, records: cntResult[0]?.cnt || 0 });
      }
    }

    // 合并文件
    const allFileName = `${basePath}/all.${output_format}`;
    await runQuery(`
      COPY deduped TO 's3://${S3_BUCKET}/${allFileName}'
      (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})
    `);

    // 清理
    await runQuery("DROP TABLE IF EXISTS temp_raw");
    await runQuery("DROP TABLE IF EXISTS deduped");

    const duration = Date.now() - startTime;
    console.log(`[transform] Done: ${exportResults.length + 1} files in ${duration}ms`);

    res.json({
      success: true,
      total_records: totalRecords,
      valid_records: dedupedCount,
      invalid_records: invalidCount,
      duplicates_removed: duplicatesRemoved,
      partition_files: exportResults,
      combined_file: allFileName,
      duration_ms: duration
    });

  } catch (err) {
    console.error("[transform] Error:", err.message);
    try {
      await runQuery("DROP TABLE IF EXISTS temp_raw");
      await runQuery("DROP TABLE IF EXISTS deduped");
    } catch {}
    res.status(500).json({ error: err.message });
  }
});

// 兼容旧的 /import 端点（乐檬专用）
app.post("/import", async (req, res) => {
  const { records, date, source } = req.body;

  // 转换为通用格式调用
  req.body = {
    records,
    config: {
      date,
      source: source || 'lemeng',
      partition_by: ['branch_num'],
      dedupe_key: ['order_no', 'order_detail_num'],
      required_fields: ['order_no', 'item_code', 'branch_num']
    }
  };

  // 调用 transform
  return app._router.handle(req, res, () => {});
});

// Schema 信息
app.get("/schema", async (req, res) => {
  try {
    const s3 = new AWS.S3({
      endpoint: S3_ENDPOINT,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      s3ForcePathStyle: true,
      region: "xinan-1"
    });

    const list = await s3.listObjectsV2({ Bucket: S3_BUCKET }).promise();
    const files = list.Contents?.filter(f => f.Key.endsWith(".parquet") || f.Key.endsWith(".json"))
      .map(f => ({ key: f.Key, size: f.Size, modified: f.LastModified })) || [];

    res.json({ bucket: S3_BUCKET, files, endpoint: S3_ENDPOINT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动
initDuckDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("DuckDB service running on port", PORT);
  });
}).catch(err => {
  console.error("Failed to init:", err);
  process.exit(1);
});