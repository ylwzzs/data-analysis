const express = require("express");
const duckdb = require("duckdb");
const AWS = require("aws-sdk");
const { Pool } = require("pg");  // PostgreSQL 连接池

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.DUCKDB_PORT || 9000;

// S3 配置（天翼云 OOS）
const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://xinan-1-internal.zos.ctyun.cn";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
const S3_BUCKET = process.env.S3_BUCKET || "lemeng-datasource";

// PostgreSQL 配置（写入汇总结果）
const PG_HOST = process.env.PG_HOST || "postgres";
const PG_PORT = process.env.PG_PORT || 5432;
const PG_DATABASE = process.env.PG_DATABASE || "insforge";
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASSWORD = process.env.PG_PASSWORD || "";

// PostgreSQL 连接池
let pgPool = null;

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

  // 初始化 PostgreSQL 连接池
  if (PG_HOST && PG_USER) {
    pgPool = new Pool({
      host: PG_HOST,
      port: PG_PORT,
      database: PG_DATABASE,
      user: PG_USER,
      password: PG_PASSWORD,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    console.log("PostgreSQL pool initialized:", PG_HOST);
  } else {
    console.warn("PostgreSQL not configured, /compute will fail");
  }

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

// ===== 计算端点：标准报表 =====
// 架构文档：DuckDB 角色 2 - 计算引擎
// 输入：报表类型 + 日期范围
// 处理：read_parquet(OOS) → 聚合计算
// 输出：写入 PostgreSQL 汇总表
app.post("/compute", async (req, res) => {
  const startTime = Date.now();
  try {
    const { report_type, date_from, date_to, params } = req.body;

    if (!report_type || !date_from || !date_to) {
      return res.status(400).json({ error: "Missing report_type, date_from, or date_to" });
    }

    if (!pgPool) {
      return res.status(500).json({ error: "PostgreSQL not configured" });
    }

    console.log(`[compute] ${report_type}: ${date_from} to ${date_to}`);

    let result;

    switch (report_type) {
      case "daily_sales":
        result = await computeDailySales(date_from, date_to);
        break;
      case "daily_category":
        result = await computeDailyCategory(date_from, date_to);
        break;
      case "weekly_trend":
        result = await computeWeeklyTrend(date_from, date_to);
        break;
      default:
        return res.status(400).json({ error: `Unknown report_type: ${report_type}` });
    }

    const duration = Date.now() - startTime;
    console.log(`[compute] ${report_type} done: ${result.rows_written} rows in ${duration}ms`);

    res.json({
      success: true,
      report_type,
      date_from,
      date_to,
      rows_written: result.rows_written,
      duration_ms: duration
    });

  } catch (err) {
    console.error("[compute] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 计算每日门店销售汇总
async function computeDailySales(dateFrom, dateTo) {
  // 从 OOS 读取 Parquet 并聚合
  const sql = `
    SELECT
      biz_date,
      branch_num,
      MAX(branch_name) as branch_name,
      CAST(COUNT(DISTINCT order_no) AS INTEGER) as total_orders,
      CAST(COUNT(*) AS INTEGER) as total_items,
      CAST(SUM(CAST(sale AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
      CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
    FROM read_parquet('s3://${S3_BUCKET}/lemeng/retail_detail/{${dateFrom},${dateTo}}/*.parquet')
    WHERE biz_date BETWEEN '${dateFrom}' AND '${dateTo}'
    GROUP BY biz_date, branch_num
    ORDER BY biz_date, branch_num
  `;

  const rows = await runQuery(sql);
  console.log(`[compute] daily_sales: ${rows.length} aggregated rows`);

  // 写入 PostgreSQL（upsert）
  let rowsWritten = 0;
  for (const row of rows) {
    const pgSql = `
      INSERT INTO report_daily_sales (biz_date, branch_num, branch_name, total_orders, total_items, total_sale, total_profit)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (biz_date, branch_num) DO UPDATE SET
        branch_name = EXCLUDED.branch_name,
        total_orders = EXCLUDED.total_orders,
        total_items = EXCLUDED.total_items,
        total_sale = EXCLUDED.total_sale,
        total_profit = EXCLUDED.total_profit,
        updated_at = NOW()
    `;
    await pgPool.query(pgSql, [
      row.biz_date,
      row.branch_num,
      row.branch_name,
      row.total_orders,
      row.total_items,
      row.total_sale,
      row.total_profit
    ]);
    rowsWritten++;
  }

  return { rows_written: rowsWritten };
}

// 计算每日品类汇总
async function computeDailyCategory(dateFrom, dateTo) {
  const sql = `
    SELECT
      biz_date,
      branch_num,
      category,
      CAST(COUNT(*) AS INTEGER) as total_items,
      CAST(SUM(CAST(sale AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
      CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
    FROM read_parquet('s3://${S3_BUCKET}/lemeng/retail_detail/{${dateFrom},${dateTo}}/*.parquet')
    WHERE biz_date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND category IS NOT NULL AND category != ''
    GROUP BY biz_date, branch_num, category
    ORDER BY biz_date, branch_num, category
  `;

  const rows = await runQuery(sql);
  console.log(`[compute] daily_category: ${rows.length} aggregated rows`);

  let rowsWritten = 0;
  for (const row of rows) {
    const pgSql = `
      INSERT INTO report_daily_category (biz_date, branch_num, category, total_items, total_sale, total_profit)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (biz_date, branch_num, category) DO UPDATE SET
        total_items = EXCLUDED.total_items,
        total_sale = EXCLUDED.total_sale,
        total_profit = EXCLUDED.total_profit,
        updated_at = NOW()
    `;
    await pgPool.query(pgSql, [
      row.biz_date,
      row.branch_num,
      row.category,
      row.total_items,
      row.total_sale,
      row.total_profit
    ]);
    rowsWritten++;
  }

  return { rows_written: rowsWritten };
}

// 计算周趋势汇总
async function computeWeeklyTrend(dateFrom, dateTo) {
  // 计算周起始日期（周一）
  const sql = `
    SELECT
      DATE_TRUNC('week', biz_date) as week_start,
      branch_num,
      MAX(branch_name) as branch_name,
      CAST(SUM(CAST(sale AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale
    FROM read_parquet('s3://${S3_BUCKET}/lemeng/retail_detail/{${dateFrom},${dateTo}}/*.parquet')
    WHERE biz_date BETWEEN '${dateFrom}' AND '${dateTo}'
    GROUP BY DATE_TRUNC('week', biz_date), branch_num
    ORDER BY week_start, branch_num
  `;

  const rows = await runQuery(sql);
  console.log(`[compute] weekly_trend: ${rows.length} aggregated rows`);

  // 计算环比增长（需要查询上一周数据）
  let rowsWritten = 0;
  for (const row of rows) {
    const prevWeekStart = new Date(row.week_start);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const prevWeekStr = prevWeekStart.toISOString().split('T')[0];

    // 查询上一周销售额
    const prevResult = await pgPool.query(
      `SELECT total_sale FROM report_weekly_trend WHERE week_start = $1 AND branch_num = $2`,
      [prevWeekStr, row.branch_num]
    );
    const prevSale = prevResult.rows[0]?.total_sale || 0;

    // 计算增长率
    const growthRate = prevSale > 0
      ? Math.round(((row.total_sale - prevSale) / prevSale) * 100)
      : 0;

    const pgSql = `
      INSERT INTO report_weekly_trend (week_start, branch_num, branch_name, total_sale, prev_week_sale, growth_rate)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (week_start, branch_num) DO UPDATE SET
        branch_name = EXCLUDED.branch_name,
        total_sale = EXCLUDED.total_sale,
        prev_week_sale = EXCLUDED.prev_week_sale,
        growth_rate = EXCLUDED.growth_rate,
        updated_at = NOW()
    `;
    await pgPool.query(pgSql, [
      row.week_start,
      row.branch_num,
      row.branch_name,
      row.total_sale,
      prevSale,
      growthRate
    ]);
    rowsWritten++;
  }

  return { rows_written: rowsWritten };
}

// 启动
initDuckDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("DuckDB service running on port", PORT);
  });
}).catch(err => {
  console.error("Failed to init:", err);
  process.exit(1);
});