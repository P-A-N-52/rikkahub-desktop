// 假新用户清理端点(假新用户/假日活专题)。
// 背景:开发态冒烟测试曾无条件上报(见 pc-server/app-config/analytics.ts 的 RIKKAHUB_ANALYTICS
// 门控注释),每次 spawn 都生成全新 device-id + startup ping,把同一台开发机记成 N 个"新用户",
// dashboard 日活暴涨。门控堵住未来之后,本端点清理已落库的历史污染。
//
// 两条口径,任一命中即视为假设备(并集去重):
//   ① 开发版本号:version 命中 versions= 列表(默认 0.1.0-beta,1.6.0)。这两个值从未出现在
//      任何一次正式发布的 APP_VERSION 里(核对全量 git 历史:1.0.1–1.4.1 / 1.5.0 / 1.5.1 /
//      2.0.0-preview*),所以带它们上报的设备必然是改过版本号的源码构建。版本即铁证,
//      不叠加任何其他条件。
//   ② 一日游零活动设备:全程只出现过一天,且 msg+hb+active_minutes 合计为 0。开发冒烟
//      spawn 一次就走、从不产生消息与活跃分钟,正是这个形状。
//      **不设"距今 N 天"的年龄门槛**(用户决策):今天刚装、还没聊过天的真用户会被一并删掉,
//      但这是一次性的历史清理——他下次上线会重新落库并重新计入新用户,唯一代价是"首次
//      出现日"后移。宁多错杀、别留假日活。若哪天想恢复门槛,minAgeDays=N 即可(默认 0
//      = 关闭);**唯一不能做的是把本端点挂成定时任务** —— 那样每天都会在当日新装用户
//      开口说话之前把他删掉,新用户数会被长期系统性低估。
//      idle=0 可再关掉零活动要求,退化为"只来过一天就算假",会连带删掉试用一次即流失的
//      真人;dry-run 的 extraIfNoIdle 就是这个差量,先看数再决定。
//
// 用法(先 dry-run 看会删什么,确认后再 commit):
//   POST /api/admin/purge?token=<AUTH_TOKEN>            → 预览(不写库),回报按口径的拆分
//   POST /api/admin/purge?token=<AUTH_TOKEN>&commit=1   → 真删 + 重建汇总
//   可选:versions=a,b(逗号分隔;version= 是旧别名)、minAgeDays=0、idle=0、heuristic=0
import { isAuthorized, addDays } from "../../_lib";

const DEFAULT_FAKE_VERSIONS = "0.1.0-beta,1.6.0";
const DEFAULT_MIN_AGE_DAYS = 0; // 0 = 不设年龄门槛,见上方 ② 的决策说明

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

  const versions = (url.searchParams.get("versions") ?? url.searchParams.get("version") ?? DEFAULT_FAKE_VERSIONS)
    .split(",").map((s) => s.trim()).filter((s) => s !== "");
  const rawAge = parseInt(url.searchParams.get("minAgeDays") ?? "", 10);
  const minAgeDays = Number.isFinite(rawAge) && rawAge >= 0 ? Math.min(rawAge, 3650) : DEFAULT_MIN_AGE_DAYS;
  const useHeuristic = url.searchParams.get("heuristic") !== "0";
  const requireIdle = url.searchParams.get("idle") !== "0";
  const commit = url.searchParams.get("commit") === "1";

  const DB = context.env.DB;
  const t0 = Date.now();

  if (versions.length === 0 && !useHeuristic) {
    return new Response(JSON.stringify({ error: "两条口径都被关掉了(versions 为空 + heuristic=0),没有删除依据" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 年龄门槛(minAgeDays>0 时)的参照点取"库里最新一天"而非服务器 UTC 今天:date 是客户端
    // 本地日(服务端只钳制在 UTC ±1 天),且库可能几天没有新上报;用库内最大日期能让"距今
    // N 天"随数据走,避免时区/空档把门槛悄悄放宽一天。默认 minAgeDays=0 时 cutoff 就是最新
    // 一天,条件恒真 = 不筛年龄。空库直接返回。
    const maxRow = await DB.prepare(`SELECT MAX(date) AS d FROM pings`).first();
    const latest = maxRow?.d;
    if (!latest) {
      return json({ ok: true, dryRun: !commit, matchedDevices: 0, matchedRows: 0, note: "pings 表为空" });
    }
    const cutoff = addDays(latest, -minAgeDays);

    // ① 版本口径
    let versionIds = [];
    if (versions.length > 0) {
      const ph = versions.map(() => "?").join(",");
      const r = await DB.prepare(`SELECT DISTINCT device_id FROM pings WHERE version IN (${ph})`).bind(...versions).all();
      versionIds = (r?.results ?? []).map((x) => x.device_id);
    }

    // ② 一日游口径(存活恰好 1 天 + 首见日 ≤ cutoff [+ 零活动])
    const heurSql = (idle) =>
      `SELECT device_id FROM pings GROUP BY device_id
        HAVING COUNT(*) = 1 AND MIN(date) <= ?`
      + (idle ? ` AND SUM(msg_count + hb_count + active_minutes) = 0` : "");
    let heurIds = [];
    if (useHeuristic) {
      const r = await DB.prepare(heurSql(requireIdle)).bind(cutoff).all();
      heurIds = (r?.results ?? []).map((x) => x.device_id);
    }

    const ids = [...new Set([...versionIds, ...heurIds])];
    const deviceCount = ids.length;
    const criteria = { versions, minAgeDays, cutoff, latestDate: latest, useHeuristic, requireIdle };

    if (!commit) {
      // dry-run:只回报会删什么,不动库。按口径拆分 + 按日期分布,便于人工核对。
      if (deviceCount === 0) {
        return json({ ok: true, dryRun: true, matchedDevices: 0, matchedRows: 0, criteria });
      }
      // 关掉零活动要求会多删多少:这批就是"一日游但留下过活动痕迹"的设备,大概率是
      // 真实的试用即流失用户。数值小可以考虑 idle=0 一并清,大就别碰。
      let extraIfNoIdle = null;
      if (useHeuristic && requireIdle) {
        const r = await DB.prepare(heurSql(false)).bind(cutoff).all();
        const loose = new Set((r?.results ?? []).map((x) => x.device_id));
        for (const id of ids) loose.delete(id);
        extraIfNoIdle = loose.size;
      }
      return json({
        ok: true, dryRun: true, criteria,
        matchedDevices: deviceCount,
        matchedRows: await countRows(DB, ids),
        byCriteria: { version: versionIds.length, oneDayOld: heurIds.length },
        byDate: await breakdownByDate(DB, ids),
        extraIfNoIdle,
        sample: ids.slice(0, 10),
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
      ok: true, dryRun: false, criteria,
      purgedDevices: deviceCount,
      byCriteria: { version: versionIds.length, oneDayOld: heurIds.length },
      ms: Date.now() - t0,
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

// 下面两个统计都按 100 个 id 一批 bind,与删除同样受 D1 单语句变量数上限约束。
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
