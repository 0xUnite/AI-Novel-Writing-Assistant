#!/usr/bin/env node

const API_BASE = process.env.AI_NOVEL_API_BASE ?? "http://127.0.0.1:3000/api";
const UI_BASE = process.env.AI_NOVEL_UI_BASE ?? "http://127.0.0.1:5173";

const uiRoutes = [
  "/",
  "/novels",
  "/novels/create",
  "/creative-hub",
  "/book-analysis",
  "/tasks",
  "/knowledge",
  "/genres",
  "/story-modes",
  "/titles",
  "/settings/model-routes",
  "/settings",
  "/worlds",
  "/worlds/generator",
  "/style-engine",
  "/base-characters",
];

const apiChecks = [
  { label: "health", path: "/health" },
  { label: "llm providers", path: "/llm/providers" },
  { label: "llm model routes", path: "/llm/model-routes" },
  { label: "llm route connectivity", path: "/llm/model-routes/connectivity", method: "POST" },
  { label: "settings rag", path: "/settings/rag" },
  { label: "settings api keys", path: "/settings/api-keys" },
  { label: "settings api balances", path: "/settings/api-keys/balances" },
  { label: "rag jobs", path: "/rag/jobs" },
  { label: "agent catalog", path: "/agent-catalog" },
  { label: "tasks", path: "/tasks" },
  { label: "knowledge documents", path: "/knowledge/documents?status=enabled" },
  { label: "genres", path: "/genres" },
  { label: "story modes", path: "/story-modes" },
  { label: "worlds", path: "/worlds" },
  { label: "base characters", path: "/base-characters" },
  { label: "title library", path: "/title-library" },
  { label: "creative hub threads", path: "/creative-hub/threads" },
];

const results = [];

function pushResult(ok, label, detail) {
  results.push({ ok, label, detail });
  const prefix = ok ? "[OK]" : "[FAIL]";
  const suffix = detail ? ` - ${detail}` : "";
  console.log(`${prefix} ${label}${suffix}`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const detail = json?.error ?? json?.message ?? raw ?? `HTTP ${response.status}`;
    throw new Error(`${response.status} ${detail}`);
  }

  if (json && typeof json === "object" && "success" in json && json.success === false) {
    throw new Error(json.error ?? json.message ?? "API returned success=false");
  }

  return json;
}

async function check(label, fn) {
  return checkWithRetry(label, fn);
}

function shouldRetrySmokeFailure(detail) {
  const normalized = detail.toLowerCase();
  return [
    "fetch failed",
    "timeout",
    "temporarily unavailable",
    "json repair",
    "json 解析失败",
    "schema 校验",
    "invalid option",
    "章节标题结构过于集中",
  ].some((fragment) => normalized.includes(fragment));
}

async function checkWithRetry(label, fn, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 1);
  let lastDetail = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const detail = await fn();
      pushResult(true, label, attempt > 1 ? `${detail} (retry ${attempt}/${attempts})` : detail);
      return detail;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lastDetail = detail;
      if (attempt < attempts && shouldRetrySmokeFailure(detail)) {
        console.log(`[RETRY] ${label} - attempt ${attempt}/${attempts} failed: ${detail}`);
        continue;
      }
      pushResult(false, label, detail);
      return null;
    }
  }
}

async function persistWorkspaceDocument(novelId, document) {
  const payload = await requestJson(`/novels/${novelId}/volumes`, {
    method: "PUT",
    body: document,
  });
  return payload.data;
}

function extractMinimaxConfig(apiKeysPayload) {
  const minimax = apiKeysPayload?.data?.find?.((item) => item.provider === "minimax");
  if (!minimax?.isConfigured) {
    throw new Error("MiniMax 未配置，无法执行真实创作链 smoke test");
  }
  return {
    provider: "minimax",
    model: minimax.currentModel || minimax.defaultModel || "MiniMax-M2.7",
    temperature: 0.7,
  };
}

async function main() {
  const state = {
    threadId: null,
    novelId: null,
  };

  let liveModel = null;

  try {
    for (const route of uiRoutes) {
      await check(`ui route ${route}`, async () => {
        const response = await fetch(`${UI_BASE}${route}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return `HTTP ${response.status}`;
      });
    }

    let apiKeysPayload = null;
    for (const item of apiChecks) {
      const payload = await check(`api ${item.label}`, async () => {
        const json = await requestJson(item.path, { method: item.method });
        return `success`;
      });
      if (item.path === "/settings/api-keys") {
        apiKeysPayload = await requestJson(item.path);
      }
    }

    liveModel = extractMinimaxConfig(apiKeysPayload);
    pushResult(true, "live model", `${liveModel.provider}/${liveModel.model}`);

    await check("creative hub thread create", async () => {
      const payload = await requestJson("/creative-hub/threads", {
        method: "POST",
        body: { title: `smoke-${Date.now()}` },
      });
      state.threadId = payload.data.id;
      return state.threadId;
    });

    if (state.threadId) {
      await check("creative hub thread state", async () => {
        const payload = await requestJson(`/creative-hub/threads/${state.threadId}/state`);
        return payload.data.thread.id;
      });
      await check("creative hub thread history", async () => {
        const payload = await requestJson(`/creative-hub/threads/${state.threadId}/history`);
        return `items=${payload.data.length}`;
      });
    }

    await check("novel create", async () => {
      const payload = await requestJson("/novels", {
        method: "POST",
        body: {
          title: `Smoke Novel ${Date.now()}`,
          description: "用于自动冒烟检查的临时项目。",
          writingMode: "original",
          projectMode: "co_pilot",
          narrativePov: "third_person",
          pacePreference: "balanced",
          emotionIntensity: "medium",
          aiFreedom: "medium",
          defaultChapterLength: 2500,
          estimatedChapterCount: 12,
        },
      });
      state.novelId = payload.data.id;
      return state.novelId;
    });

    if (!state.novelId) {
      throw new Error("无法创建临时小说，终止后续主链检查");
    }

    await check("novel detail", async () => {
      const payload = await requestJson(`/novels/${state.novelId}`);
      return payload.data.title;
    });

    await check("novel update", async () => {
      const payload = await requestJson(`/novels/${state.novelId}`, {
        method: "PUT",
        body: {
          targetAudience: "女频都市轻喜剧读者",
          bookSellingPoint: "高压同居、租房求生、情感拉扯",
          competingFeel: "现实压力 + 轻快关系推进",
          first30ChapterPromise: "前30章完成租房落脚和关系绑定",
          commercialTags: ["都市", "租房", "轻喜剧"],
          resourceReadyScore: 70,
        },
      });
      return payload.data.bookSellingPoint ?? "updated";
    });

    await check("novel workflow state", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/state`);
      return payload.message ?? "ok";
    });

    await check("novel snapshot create", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/snapshots`, {
        method: "POST",
        body: {
          triggerType: "manual",
          label: "smoke snapshot",
        },
      });
      return payload.data.id;
    });

    await check("novel snapshot list", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/snapshots`);
      return `count=${payload.data.length}`;
    });

    await checkWithRetry("story macro decompose", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/story-macro/decompose`, {
        method: "POST",
        body: {
          ...liveModel,
          storyInput: "女主来到首尔后被房东临时毁约，只能与一个表面冷淡但同样缺钱的男生合租。两人一边处理租房、签证、工作和社交压力，一边在利益捆绑中逐渐建立感情。",
        },
      });
      return payload.data.decomposition?.main_hook ?? "decomposed";
    }, { attempts: 3 });

    await checkWithRetry("story macro build constraint engine", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/story-macro/constraint/build`, {
        method: "POST",
        body: liveModel,
      });
      return payload.data.constraintEngine ? "constraint ready" : "constraint missing";
    }, { attempts: 2 });

    await check("story macro save empty arrays", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/story-macro`, {
        method: "PATCH",
        body: {
          expansion: { setpiece_seeds: [] },
          decomposition: { major_payoffs: [] },
          constraints: [],
        },
      });
      return payload.message ?? "saved";
    });

    await check("story macro state update", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/story-macro/state`, {
        method: "PATCH",
        body: {
          currentPhase: 1,
          progress: 15,
          protagonistState: "刚落地，缺钱且缺安全感。",
        },
      });
      return payload.data.progress ?? "state updated";
    });

    await check("character create", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/characters`, {
        method: "POST",
        body: {
          name: "韩知允",
          role: "主角",
          gender: "female",
          castRole: "protagonist",
          storyFunction: "推动租房求生主线",
          relationToProtagonist: "本人",
          currentGoal: "尽快找到稳定住处并保住工作机会",
        },
      });
      return payload.data.id;
    });

    await check("character list", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/characters`);
      return `count=${payload.data.length}`;
    });

    await check("character relations", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/character-relations`);
      return `count=${payload.data.length}`;
    });

    let workspacePayload = null;

    await checkWithRetry("volume strategy generate", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/generate`, {
        method: "POST",
        body: {
          ...liveModel,
          scope: "strategy",
        },
      });
      workspacePayload = { data: await persistWorkspaceDocument(state.novelId, payload.data) };
      return `recommended=${workspacePayload.data.strategyPlan?.recommendedVolumeCount ?? "?"}`;
    }, { attempts: 3 });

    workspacePayload = await requestJson(`/novels/${state.novelId}/volumes`);
    await check("volume workspace load", async () => `volumes=${workspacePayload.data.volumes.length}`);

    await checkWithRetry("volume skeleton generate", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/generate`, {
        method: "POST",
        body: {
          ...liveModel,
          scope: "skeleton",
        },
      });
      workspacePayload = { data: await persistWorkspaceDocument(state.novelId, payload.data) };
      return `volumes=${workspacePayload.data.volumes.length}`;
    }, { attempts: 3 });

    const firstVolume = workspacePayload?.data?.volumes?.[0];
    if (!firstVolume?.id) {
      throw new Error("卷骨架生成后没有拿到有效 volumeId");
    }

    await checkWithRetry("volume beat sheet generate", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/generate`, {
        method: "POST",
        body: {
          ...liveModel,
          scope: "beat_sheet",
          targetVolumeId: firstVolume.id,
        },
      });
      workspacePayload = { data: await persistWorkspaceDocument(state.novelId, payload.data) };
      return `beats=${workspacePayload.data.beatSheets?.[0]?.beats?.length ?? 0}`;
    }, { attempts: 3 });

    await checkWithRetry("volume chapter list generate", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/generate`, {
        method: "POST",
        body: {
          ...liveModel,
          scope: "chapter_list",
          targetVolumeId: firstVolume.id,
        },
      });
      workspacePayload = { data: await persistWorkspaceDocument(state.novelId, payload.data) };
      const volume = workspacePayload.data.volumes.find((item) => item.id === firstVolume.id);
      return `chapters=${volume?.chapters?.length ?? 0}`;
    }, { attempts: 3 });

    await check("volume draft version create", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/versions/draft`, {
        method: "POST",
        body: {
          volumes: workspacePayload.data.volumes,
          diffSummary: "smoke draft",
        },
      });
      return `version=${payload.data.version}`;
    });

    await check("volume versions list", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/versions`);
      return `count=${payload.data.length}`;
    });

    await check("volume impact analysis", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/impact-analysis`, {
        method: "POST",
        body: {
          volumes: workspacePayload.data.volumes,
        },
      });
      return `affectedVolumes=${payload.data.affectedVolumeCount}`;
    });

    await check("sync structured chapters", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/volumes/sync-chapters`, {
        method: "POST",
        body: {
          volumes: workspacePayload.data.volumes,
          preserveContent: true,
          applyDeletes: false,
        },
      });
      return `create=${payload.data.createCount}, update=${payload.data.updateCount}`;
    });

    let chaptersPayload = null;
    await check("chapter list", async () => {
      chaptersPayload = await requestJson(`/novels/${state.novelId}/chapters`);
      return `count=${chaptersPayload.data.length}`;
    });

    const firstChapter = chaptersPayload?.data?.[0];
    if (firstChapter?.id) {
      await checkWithRetry("book plan generate", async () => {
        const payload = await requestJson(`/novels/${state.novelId}/plans/book/generate`, {
          method: "POST",
          body: liveModel,
        });
        return payload.message ?? "book planned";
      }, { attempts: 3 });

      await checkWithRetry("chapter plan generate", async () => {
        const payload = await requestJson(`/novels/${state.novelId}/chapters/${firstChapter.id}/plan/generate`, {
          method: "POST",
          body: liveModel,
        });
        return payload.data.title ?? "chapter planned";
      }, { attempts: 3 });

      await check("chapter plan load", async () => {
        const payload = await requestJson(`/novels/${state.novelId}/chapters/${firstChapter.id}/plan`);
        return payload.data?.title ?? "loaded";
      });
    }

    await check("quality report", async () => {
      const payload = await requestJson(`/novels/${state.novelId}/quality-report`);
      return `reports=${payload.data.chapterReports?.length ?? 0}`;
    });

    await check("auto director state", async () => {
      const payload = await requestJson(`/novel-workflows/novels/${state.novelId}/auto-director`);
      return payload.message ?? "ok";
    });
  } finally {
    if (state.threadId) {
      try {
        await requestJson(`/creative-hub/threads/${state.threadId}`, { method: "DELETE" });
        pushResult(true, "creative hub thread cleanup", state.threadId);
      } catch (error) {
        pushResult(false, "creative hub thread cleanup", error instanceof Error ? error.message : String(error));
      }
    }

    if (state.novelId) {
      try {
        await requestJson(`/novels/${state.novelId}`, { method: "DELETE" });
        pushResult(true, "novel cleanup", state.novelId);
      } catch (error) {
        pushResult(false, "novel cleanup", error instanceof Error ? error.message : String(error));
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log("");
  console.log(`Smoke summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("Failed checks:");
    for (const item of failed) {
      console.log(`- ${item.label}: ${item.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
