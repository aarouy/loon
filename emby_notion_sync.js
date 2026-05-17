/**
 * Emby -> Notion 全自动联动脚本
 * @version v3.2 (终极避坑版)
 * @description 彻底移除双引号，改用 | 竖杠作为分隔符，完美避开 Loon 的逗号解析陷阱！
 */

function getLoonArgs() {
    const args = {};
    if (typeof $argument !== "undefined" && typeof $argument === "string") {
        $argument.split("&").forEach(pair => {
            let parts = pair.split("=");
            if (parts.length >= 2) {
                let key = parts[0].trim();
                let rawValue = parts.slice(1).join("=").trim();
                try {
                    args[key] = decodeURIComponent(rawValue);
                } catch (e) {
                    args[key] = rawValue;
                }
            }
        });
    }
    return args;
}

const parsedArgs = getLoonArgs();

const NOTION_TOKEN = parsedArgs.NotionToken ? parsedArgs.NotionToken.trim() : null;
const DATABASE_ID = parsedArgs.DatabaseID ? parsedArgs.DatabaseID.trim() : null;
const argCoolDownHour = parsedArgs.CoolDownHour ? parseFloat(parsedArgs.CoolDownHour) : 6;
const COOL_DOWN_MS = argCoolDownHour * 60 * 60 * 1000; 
let argServerMap = parsedArgs.ServerMap ? parsedArgs.ServerMap.replace(/["'{}]/g, '') : null;

const COL_NAME = "emby名称"; 
const COL_TIME = "最近播放时间"; 

if (!NOTION_TOKEN || !DATABASE_ID || !argServerMap) {
    console.log(`❌ 致命错误：未能读取到核心参数。当前拿到的是: Token=${NOTION_TOKEN}, ID=${DATABASE_ID}, 列表=${argServerMap}`);
    $done({});
}

const SERVER_MAP = {};
// 【核心修复】改为按 竖杠 | 或 分号 ; 分割，彻底抛弃逗号！
argServerMap.split(/[\n\|;；]+/).forEach(item => {
    let parts = item.split(':');
    if (parts.length >= 2) {
        let embyHost = parts[0].trim();
        let embyName = parts[parts.length - 1].trim(); 
        if (embyHost && embyName) {
            SERVER_MAP[embyHost] = embyName;
        }
    }
});

if (Object.keys(SERVER_MAP).length === 0) {
    console.log(`❌ 致命错误：解析为空！Loon 传过来的原文字符串是: ${argServerMap}`);
    $done({});
}

const url = $request.url;

const hostMatch = url.match(/^https?:\/\/([^/:]+)/);
if (!hostMatch) {
    console.log("❌ 无法提取域名，终止运行。");
    $done({});
}

const hostname = hostMatch[1];
const embyName = SERVER_MAP[hostname];
const lastRunKey = `emby_last_run_${embyName}`;

if (!embyName) {
    console.log(`⚠️ 域名 ${hostname} 未在字典中注册，忽略打卡。`);
    $done({});
}

const lastRunTime = $persistentStore.read(lastRunKey);
const now = Date.now();

if (COOL_DOWN_MS > 0 && lastRunTime && (now - parseInt(lastRunTime)) < COOL_DOWN_MS) {
    console.log(`⏳ [${embyName}] 距离上次打卡不足 ${argCoolDownHour} 小时，触发省电冷却，跳过网络请求。`);
    $done({});
}

console.log(`🚀 [v3.2] 检测到 [${embyName}] 真实播放，准备同步至 Notion...`);
syncToNotion(embyName);

async function syncToNotion(name) {
    try {
        const pageId = await queryNotionPage(name);
        
        if (!pageId) {
            console.log(`⚠️ 在 Notion 中未找到 "${name}"，准备自动新建数据行...`);
            await createNotionPage(name);
        } else {
            console.log(`✅ 找到 "${name}" 的历史记录，准备更新播放时间...`);
            await updateNotionTime(pageId, name);
        }
        
    } catch (err) {
        console.log(`❌ 流程崩溃: ${err}`);
        $done({});
    }
}

function queryNotionPage(name) {
    return new Promise((resolve, reject) => {
        const options = {
            url: `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
            headers: {
                "Authorization": `Bearer ${NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                filter: { property: COL_NAME, title: { equals: name } }
            })
        };
        $httpClient.post(options, (error, response, data) => {
            if (error) reject(`Notion查询异常: ${JSON.stringify(error)}`);
            else {
                try {
                    const res = JSON.parse(data);
                    if (res.results && res.results.length > 0) resolve(res.results[0].id);
                    else resolve(null);
                } catch (e) { reject(`解析查询失败。HTTP状态: ${response.status}`); }
            }
        });
    });
}

function createNotionPage(name) {
    return new Promise((resolve, reject) => {
        const tzOffset = (new Date()).getTimezoneOffset() * 60000; 
        const localISOTime = (new Date(Date.now() - tzOffset)).toISOString().slice(0, -1) + "+08:00";
        const postBody = {
            parent: { database_id: DATABASE_ID },
            properties: {}
        };
        postBody.properties[COL_NAME] = { title: [ { text: { content: name } } ] };
        postBody.properties[COL_TIME] = { date: { start: localISOTime } };

        const options = {
            url: `https://api.notion.com/v1/pages`,
            headers: {
                "Authorization": `Bearer ${NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(postBody)
        };
        $httpClient.post(options, (error, response, data) => {
            if (error) reject(`新建行异常。`);
            else {
                if (response.status === 200) {
                    console.log(`✅ [${name}] 自动新建记录成功！`);
                    $persistentStore.write(Date.now().toString(), lastRunKey);
                    $notification.post("Emby 首次打卡成功 🎬", `新增收录: ${name}`, `已在 Notion 中为您创建新记录。`);
                    resolve();
                } else reject(`新建失败: ${response.status}, ${data}`);
            }
        });
    });
}

function updateNotionTime(pageId, name) {
    return new Promise((resolve, reject) => {
        const tzOffset = (new Date()).getTimezoneOffset() * 60000; 
        const localISOTime = (new Date(Date.now() - tzOffset)).toISOString().slice(0, -1) + "+08:00";
        const patchBody = { properties: {} };
        patchBody.properties[COL_TIME] = { date: { start: localISOTime } };

        const options = {
            url: `https://api.notion.com/v1/pages/${pageId}`,
            headers: {
                "Authorization": `Bearer ${NOTION_TOKEN}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(patchBody)
        };
        $httpClient.patch(options, (error, response, data) => {
            if (error) reject(`更新时间异常。`);
            else {
                if (response.status === 200) {
                    console.log(`✅ [${name}] 历史记录更新成功！`);
                    $persistentStore.write(Date.now().toString(), lastRunKey);
                    $notification.post("Emby 自动打卡成功 🎬", `正常追剧: ${name}`, `Notion 大脑已同步最新时间。`);
                    resolve();
                } else reject(`更新失败: ${response.status}, ${data}`);
            }
        });
    });
}
