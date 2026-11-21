// Explicit bounded validation: read-only master, at most 180 seconds of JPEG analysis.
const { app, safeStorage } = require("electron");
const { readFile, mkdir, writeFile, stat } = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { AiModelCatalogService } = require("../dist-electron/main/services/ai-model-catalog");
const { SubtitleFrameExtractor } = require("../dist-electron/main/services/subtitle-frame-extractor");
const { OpenAiSubtitleVisionProvider } = require("../dist-electron/main/services/subtitle-vision-providers");
const { DiskSubtitleVisionCache } = require("../dist-electron/main/services/subtitle-vision-cache");
const { runSubtitleVisionDrafts } = require("../dist-electron/main/services/subtitle-vision-orchestrator");
const { mergeSubtitleVisionDrafts } = require("../dist-electron/main/services/subtitle-draft-merge");
const { StandaloneSubtitleStore } = require("../dist-electron/main/services/standalone-subtitle-store");
const root = path.resolve(__dirname, "../artifacts/v087-live-validation");
// Chromium's local encryption key is profile-specific: copy only the encrypted
// Local State into our isolated profile; never open/write the user's live profile.
const realProfile = path.join(app.getPath("appData"), "SceneryWalker 素材整理");
const isolatedProfile = path.join(root,"isolated-profile");
fs.mkdirSync(isolatedProfile,{recursive:true});
fs.copyFileSync(path.join(realProfile,"Local State"),path.join(isolatedProfile,"Local State"));
app.setPath("userData",isolatedProfile);
const report = { status:"PREPARING", provider:"OPENAI", sampleStartMs:600000,sampleDurationMs:180000,intervalSeconds:2,requests:0,tokens:0,sentFrames:0,masterModified:false };
app.whenReady().then(async () => {
  await mkdir(root, {recursive:true});
  const started = Date.now();
  try {
    const userData = path.join(app.getPath("appData"), "SceneryWalker 素材整理");
    const settings = JSON.parse(await readFile(path.join(userData,"settings/ai-providers.json"),"utf8"));
    const credentials = JSON.parse(await readFile(path.join(userData,"settings/ai-credentials.encrypted.json"),"utf8"));
    if (!safeStorage.isEncryptionAvailable()) throw new Error("SECURE_STORAGE_UNAVAILABLE");
    const encrypted = credentials.encryptedKeys[settings.activeAccountId];
    if (!encrypted) throw new Error("OPENAI_API_NOT_CONFIGURED");
    const key = safeStorage.decryptString(Buffer.from(encrypted,"base64"));
    const catalogService = new AiModelCatalogService(root);
    const catalog = await catalogService.refresh("OPENAI",key,"auto");
    report.availableModels = catalog.models.map(model=>model.id);
    const test = await catalogService.test("OPENAI",key,process.env.V087_TEST_MODEL || "auto");
    report.connectionTest = test;
    if (!test.ok) throw new Error(test.message);
    const model = await catalogService.resolve("OPENAI",key,"auto");
    report.modelId = model;
    const provider = new OpenAiSubtitleVisionProvider(model,key);
    const videoPath = "E:\\大雪山 YT video\\SceneryWalker_preview_20260926_0243.mp4";
    const before = await stat(videoPath);
    const fingerprint = createHash("sha256").update(`${videoPath}\0${before.size}\0${before.mtimeMs}`).digest("hex");
    const drafts = [];
    const cache = new DiskSubtitleVisionCache(path.join(root,"analysis-cache"));
    const extraction = await new SubtitleFrameExtractor().extractBatches({sourcePath:videoPath,cacheRoot:root,projectId:"v087-live-180s",segments:[{type:"MAIN",startMs:600000,endMs:780000}],intervalSeconds:2,detectSceneChanges:true,deduplicateFrames:true},async(items,batchIndex)=>{
      const frames=[];
      for(const item of items){const bytes=await readFile(item.path);frames.push({id:`live-${batchIndex}-${item.timeMs}`,timestampMs:item.timeMs,imageDataUrl:`data:image/jpeg;base64,${bytes.toString("base64")}`,fingerprint:createHash("sha256").update(bytes).digest("hex"),videoFingerprint:fingerprint,videoDurationMs:8970194,contextRevision:"v087-live-v1",segmentType:"MAIN",context:{projectName:"大雪山影片",title:"森林步道旅行",description:"僅描述畫面可見內容，不猜測確切景點或物種。"}});}
      const result=await runSubtitleVisionDrafts(frames,provider,cache,{density:"STANDARD",language:"zh-TW"});
      drafts.push(...result.drafts);report.requests+=result.progress.requests;report.tokens+=result.progress.inputTokens+result.progress.outputTokens;report.sentFrames+=frames.length;
    });
    report.frameCounters=extraction.plan.counters;
    const merged=mergeSubtitleVisionDrafts(drafts,{durationMs:8970194,maxCharsPerLine:60});
    const cues=merged.filter(d=>d.endMs>600000&&d.startMs<780000).map((d,index)=>({id:`live-${index}`,startMs:Math.max(600000,d.startMs),endMs:Math.min(780000,d.endMs),text:d.text,origin:"AI_VISUAL",reviewStatus:"DRAFT",aiConfidence:Math.round(d.confidence*100)}));
    const workspace=await new StandaloneSubtitleStore(path.join(root,"workspaces")).create(videoPath,fingerprint,8970194,cues);
    report.draftCount=cues.length; report.draftPath=workspace.draftPath;
    const after=await stat(videoPath);report.masterModified=before.size!==after.size||before.mtimeMs!==after.mtimeMs;
    report.status=cues.length&&!report.masterModified?"PASS":"NO_DRAFT";
  } catch(error) {report.status="BLOCKED";report.error=error instanceof Error?error.message:"Validation failed";}
  report.elapsedMs=Date.now()-started;
  await writeFile(path.join(root,"report.json"),JSON.stringify(report,null,2),"utf8");
  console.log(JSON.stringify(report)); app.exit(report.status==="PASS"?0:2);
});
