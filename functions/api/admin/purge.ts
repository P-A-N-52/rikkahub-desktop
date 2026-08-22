// 假新用户清理端点(假新用户/假日活专题)。
// 背景:开发态冒烟测试曾无条件上报(见 pc-server/app-config/analytics.ts 的 RIKKAHUB_ANALYTICS
// 门控注释),每次 spawn 都生成全新 device-id + startup ping,把同一台开发机记成 N 个"新用户",
// dashboard 日活暴涨。门控堵住未来之后,本端点清理已落库的历史污染。
//
// 双口径圈定假设备(宁多错杀,见用户决策):
//   1) 高置信口径:版本号命中 version 参数(默认 0.1.0-beta——开发期的构建版本)。
//   2) 通用启发式:存活仅 1 天(MIN(date)=MAX(date))且全程零消息零活跃
//      (msg_count/hb_count/active_minutes 合计为 0)——任何开发冒烟都符合此特征,
//      无需逐个归纳每个开发者的版本号。
// 真用户若被误删,下次上线自然被重新计入,可接受。
//
// 用法(先 dry-run 看会删什么,确认后再 commit):
//   POST /api/admin/purge?token=<AUTH_TOKEN>            → 预览(不写库)
//   POST /api/admin/purge?token=<AUTH_TOKEN>&commit=1   → 真删 + 重建汇总
//   可选参数:version=<版本号>(默认 0.1.0-beta);heuristic=0 关掉通用启发式(只按版本删)。
import { isAuthorized } from "../../_lib";

export const onRequest = async (context) => {
  const url = new URL(context.request.url);
  if (!isAuthorized(context, url)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // 与 rebuild 同纪律:全表删除只允许显式 POST,防地址栏误触 / 预取器带 cookie GET 触发。
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }

  const version = url.searchParams.get("version") ?? "0.1.0-beta";
  const useHeuristic = url.searchParams.get("heuristic") !== "0";
  const commit = url.searchParams.get("commit") === "1";

  const DB = context.env.DB;
  const t0 = Date.now();
  try {
    // 圈定目标设备集合:按版本命中 或 (启发式)存活1天且零活动。UNION 去重 device_id。
    const targetSql = `
      SELECT DISTINCT device_id FROM (
        SELECT device_id FROM pings WHERE version = ?1
        ${useHeuristic ? `
        UNION
        SELECT device_id FROM pings
          GROUP BY device_id
          HAVING MIN(date) = MAX(date)
             AND SUM(msg_count + hb_count + active_minutes) = 0` : ""}
      )`;
    const targets = await DB.prepare(targetSql).bind(version).all();
    const ids = (targets?.results ?? []).map((r) => r.device_id);
    const deviceCount = ids.length;

    if (!commit) {
      // dry-run:只回报将影响的设备数与行数,不动库。给出按日期分布便于人工核对。
      if (deviceCount === 0) {
        return json({ ok: true, dryRun: true, matchedDevices: 0, matchedRows: 0, version, useHeuristic });
      }
      const rows = await countRows(DB, ids);
      const byDate = await breakdownByDate(DB, ids);
      return json({
        ok: true, dryRun: true, version, useHeuristic,
        matchedDevices: deviceCount, matchedRows: rows, byDate,
        hint: "确认无误后加 &commit=1 真删并重建 daily_summary / version_dist",
      });
    }

    if (deviceCount > 0) {
      // 分批删除,D1 单语句变量数有上限;每批 100 个 id。
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const placeholders = chunk.map(() => "?").join(",");
        await DB.prepare(`DELETE FROM pings WHERE device_id IN (${placeholders})`).bind(...chunk).run();
      }
    }

    // 删完重建汇总与版本分布(与 rebuild.ts 同一套 SQL,保持口径一致)。
    await DB.prepare(`DELETE FROM daily_summary`).run();
    await DB.prepare(
      `INSERT INTO daily_summary
         (date, dau, eff_dau, new_users, total_msgs, win_users, linux_users, mac_users)
       SELECT
         date,
         COUNT(*)                                          AS dau,
         SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END)    AS eff_dau,
         SUM(CASE WHEN first_seen THEN 1 ELSE 0 END)       AS new_users,
         SUM(msg_count)                                    AS total_msgs,
         SUM(CASE WHEN os = 'win'   THEN 1 ELSE 0 END)     AS win_users,
         SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END)     AS linux_users,
         SUM(CASE WHEN os = 'mac'   THEN 1 ELSE 0 END)     AS mac_users
       FROM pings GROUP BY date`
    ).run();
    await DB.prepare(`DELETE FROM version_dist`).run();
    await DB.prepare(
      `INSERT INTO version_dist (date, version, count)
       SELECT date, version, COUNT(*) FROM pings GROUP BY date, version`
    ).run();

    return json({
      ok: true, dryRun: false, version, useHeuristic,
      purgedDevices: deviceCount, ms: Date.now() - t0,
    });
  } catch (err) {
    console.error("purge error:", err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

async function countRows(DB, ids) {
  let total = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await DB.prepare(`SELECT COUNT(*) AS c FROM pings WHERE device_id IN (${placeholders})`).bind(...chunk).first();
    total += r?.c ?? 0;
  }
  return total;
}

async function breakdownByDate(DB, ids) {
  const acc = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const r = await DB.prepare(
      `SELECT date, COUNT(*) AS c FROM pings WHERE device_id IN (${placeholders}) GROUP BY date ORDER BY date`
    ).bind(...chunk).all();
    for (const row of r?.results ?? []) acc[row.date] = (acc[row.date] ?? 0) + row.c;
  }
  return acc;
}
