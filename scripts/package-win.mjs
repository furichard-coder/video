import { packager } from "@electron/packager";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMeta = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const outputRoot = path.join(appRoot, "release", `v${packageMeta.version}`);
const dunesShutterSource = "C:\\草漯沙丘地質公園 YT長片\\camera shutter sound\\freesound_community-camera-shutter-click-14671.mp3";
const dunesShutterHash = "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93";

const shutterBytes = await readFile(dunesShutterSource);
if (createHash("sha256").update(shutterBytes).digest("hex").toUpperCase() !== dunesShutterHash) {
  throw new Error("沙丘前案相機快門音效雜湊不符，已停止封裝。");
}

const appPaths = await packager({
  dir: appRoot,
  name: "SceneryWalkerSourceOrganizer",
  executableName: "SceneryWalkerSourceOrganizer",
  platform: "win32",
  arch: "x64",
  out: outputRoot,
  overwrite: true,
  asar: true,
  prune: true,
  electronZipDir: process.env.ELECTRON_ZIP_DIR?.trim() || undefined,
  ignore: [
    /^\/(?:artifacts|docs|release|scripts|src|tests|\.upload-staging)(?:\/|$)/,
    /^\/(?:tsconfig\..*|vite\.config\..*|vitest\.config\..*|啟動素材整理App\.cmd)$/,
  ],
});

if (appPaths.length !== 1) {
  throw new Error(`預期產生一個 Windows App，實際為 ${appPaths.length} 個。`);
}

const outputPath = appPaths[0];
await mkdir(outputPath, { recursive: true });
const soundAssetDirectory = path.join(outputPath, "resources", "assets");
await mkdir(soundAssetDirectory, { recursive: true });
await copyFile(dunesShutterSource, path.join(soundAssetDirectory, "camera-shutter-click-14671.mp3"));
await writeFile(
  path.join(soundAssetDirectory, "相機快門音效來源與授權.txt"),
  [
    "Camera Shutter Click — Kodack (Freesound) / freesound_community",
    "Source: https://pixabay.com/sound-effects/technology-camera-shutter-click-14671/",
    "License: https://pixabay.com/service/license-summary/",
    "SHA-256: 0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93",
    "",
    "This copy is bundled as a functional sound effect for photo appearances in generated preview videos.",
  ].join("\r\n"),
  "utf8",
);
await writeFile(
  path.join(outputPath, "使用說明.txt"),
  [
    `SceneryWalker 素材整理 v${packageMeta.version}`,
    "",
    "啟動：雙擊 SceneryWalkerSourceOrganizer.exe",
    "",
    "來源安全：",
    "- App 只讀取選取的影片與照片。",
    "- JPG／PNG／HEIC 等照片預設顯示 5 秒，每張可選 3–7 秒，並依原始橫直比例放大預覽。",
    "- 照片設定時長會用於總體預覽與串連 MP4；不裁切、不拉伸來源。",
    "- 每張照片預設套用沙丘前案的相機快門音效，可在照片卡片個別關閉。",
    "- 影片卡片可把專案內照片或其他影片安插到指定保留時段；主影片會非破壞性拆分，插入素材不會重複播放。",
    "- 安插視窗可切換既有來源資料夾，也可直接加入其他資料夾；新素材先留在待決定，確認安插前不會混入正片。",
    "- 插入影片有獨立 IN／OUT 雙把手；同一安插點可接續多張照片／影片並調整先後。",
    "- 安插、排除、片段與音量時間使用分／秒雙欄；起點分鐘按 Enter 會前進到起點秒數，再到終點分鐘。",
    "- 左上角「檔案」可另存命名或開啟 .swproj；專案檔保存全部設定，但不打包來源或 cache。",
    "- 從正片或片頭移除只改專案引用，不會刪除磁碟來源、proxy 或 metadata；最近移除可恢復。",
    "- 縮圖與低解析 preview 位於 App Data cache，不能作正式輸出。",
    "- 依目前排序可產生串連預覽，交接疊化可選 0.3／0.5／0.7 秒。",
    "- 網格內可播放影片，並以雙把手設定每支影片的 IN／OUT。",
    "- 網格影片縮圖左鍵會直接依副檔名設定用外部播放器開啟唯讀意圖原檔；照片縮圖仍在 App 內等比例放大，其他卡片按鍵不變。",
    "- 程式上方「Aa 設定」可調整全介面文字與 75%–150% 整體縮放；也支援 Ctrl＋滑鼠滾輪、Ctrl＋上下鍵／加減號及 Ctrl+0，並在下次開啟時恢復。",
    "- 網格／清單、輸出解析度、疊化、片頭串接、上傳準備、YouTube 可見度及各類選檔資料夾會沿用上次設定。",
    "- 網格卡片可用滑鼠左鍵長按後拖曳；移動中順序數字即時更新，放開後保存。上移／下移按鈕仍可使用。",
    "- 程式上方會顯示版本，並提供復原／重做按鈕；也可使用 Ctrl+Z、Ctrl+Y。",
    "- 放大預覽提供精確播放頭；可設定多個正片排除區段，重疊／相鄰區段保存時自動合併。",
    "- 網格卡片的片段／音量／安插按鈕採精簡單列，上移／下移使用圖示；完整說明仍可由提示與鍵盤讀取。",
    "- 片段、音量或安插已有保存設定時，按鈕會分別以琥珀、青色、綠色及『已設』文字明顯標示。",
    "- 網格詳細資料壓縮為兩行；相鄰素材前綴與日期一致時優先顯示檔名尾端時間／流水號，不一致時優先顯示檔名前端。完整名稱仍可由提示查看。",
    "- 網格的『編碼』標籤固定左右橫排，不會再被 codec 值擠成上下兩字。",
    "- MOV 代理使用 preview-v3：iPhone HEVC MOV 優先走較穩定的軟體解碼，輸出 H.264/AAC MP4；新檔與 cache hit 都會驗證 codec、尺寸與時長，損壞舊代理會局部重建。",
    "- 片段時段編輯整合局部放大、固定時段、片頭加入與 4K 輸出；使用者放大量為 0%–300%，0% 代表不改構圖，另有四組銳利化／消噪預設。",
    "- 新片段時段預設勾選加入片頭；保存後會顯示實際順位，可直接前往片頭確認。也可開啟該時段的 4K MP4 輸出確認頁，真正輸出仍需按 OK。",
    "- 片頭影片的 IN／OUT 拉桿是完整檢看範圍，可超過目前每段最高秒數；超時會顯示橘紅警示，拖回上限內即恢復正常。",
    "- 超時片段仍可完整循環預覽；片頭輸出前會再次詢問，確認後保留 IN 起點並只轉出每段最高秒數。相同規則也套用片頭＋正片與字幕片頭預覽。",
    "- 從網格加入片頭時，片頭目前目標時間會自動增加該片段秒數，避免短目標阻擋。",
    "- 正片排除時間不會輸出黑畫面或靜音占位，也不影響獨立的 Intro 片段。",
    "- 串連與 Intro 預覽可選 360p／480p／720p／4K。",
    "- AI 精彩片頭先採本機短區段抽樣；設定 OpenAI API 後，再以短音訊與低解析故事板比對人物、事件、地點與主題。片段預覽依原素材橫直比例完整顯示。",
    "- 片頭每段最高秒數預設 15 秒，可設 3–22 秒；套用後各段會在來源可用範圍內盡量均分，改動會保存並於下次開啟同一專案時沿用。",
    "- 片頭片段標題列可用滑鼠拖曳重排，順位即時更新，放開後保存；往前／往後按鈕仍保留。",
    "- AI 片頭可加入文字指示並指定一支優先基底影片，再依總片頭時間與每段上限重新分析；4K 預覽實際輸出 3840×2160。",
    "- 字幕工作台可匯入 UTF-8 SRT，之後逐項修改開始、結束與文字；匯入不會改寫來源字幕檔。",
    "- 正片與片頭產出頁底部會顯示曾經輸出的檔案，點選檔名即可依外部播放器設定播放。",
    "- 片頭預覽優先直接播放唯讀原始素材；預設按順位整體循環到最後再回第一段，也可切換單段循環。內建 codec 不支援時才由使用者切換快速短代理或外部播放器。",
    "- 知識型字幕在 OpenAI API 不可用時，會自動嘗試這台電腦已登入的 Codex／ChatGPT；App 不讀取或複製登入 token。",
    "- Codex 備援只送出低解析故事板與故事背景，採唯讀暫存工作；語音辨識與字幕翻譯仍需各自可用的 API。",
    "- 故事／劇本／特色說明等欄位可用麥克風輸入，預設繁體中文並可切換英文；短錄音辨識後不保存。",
    "- AI 測試會先實際檢查 API；失敗時再確認 Codex／ChatGPT 登入備援。API project 額度和 Codex 使用量仍是不同資源。",
    "- 設定頁可指定全域或依副檔名的外部播放器（系統預設／VLC／WMP／MPC-HC／自訂 EXE）。",
    "- 網格影片中央縮圖左鍵會直接開啟唯讀意圖原檔；在中央縮圖按右鍵才顯示 proxy／原檔選項；底部不再重複顯示外部播放按鈕。",
    "- 放大預覽維持素材原始顯示比例，播放與拖曳控制列位於影像外，不遮住畫面。",
    "- 若明確選擇原檔，來源保護仍取決於外部播放器行為。",
    "- 素材原音預設 80%、新配樂預設 35%；兩者及每段 automation 可在 0%–200% 調整。",
    "- 補充素材須逐筆決定安插位置；待決定素材不會進入串連輸出。",
    "- 直式手機素材會保持中央原比例，左右以同來源放大模糊填滿。",
    "- 可依順序加入多首唯讀 MP3，或保存多個 YouTube 來源參考；YouTube 參考必須再指定自有、已授權或由 Audio Library 正式下載的 MP3，App 不會任意下載影片。",
    "- 配樂依清單可連續排列，會套用於正片及片頭；混音輸出使用 peak limiter。",
    "- 可用 AI 建立語音／畫面字幕草稿，逐項同步預覽、修改、確認或排除；只有已確認字幕可匯出 UTF-8 SRT。",
    "- 字幕工作台可複選片頭／正片範圍；兩者使用各自的時間基準，舊專案字幕預設歸入正片。",
    "- 選擇片頭字幕後，AI 完成會自動建立可取消、有進度顯示的 480P 審核代理；有效 cache 會直接重用，不會拿代理當正式輸出來源。",
    "- 片頭字幕會隨代理播放時間動態顯示；可即時修改文字、垂直位置、字級、顏色、陰影與外框，格式會保留為下次預設。",
    "- 串連輸出可將已確認繁中字幕嵌入 MP4，或翻譯為英文／簡中／日文／韓文；最多選兩種，並分別設定位置、字級及自動換行。",
    "- 翻譯先使用 OpenAI API 的全新無狀態請求；失敗才用另行設定並以 Windows 安全儲存加密的 Google Cloud Translation API Key。ChatGPT／Codex 登入與 API 額度分開。",
    "- 每支影片卡有『刪除／排除部分片段』入口；只改專案時間線，不刪除來源、proxy 或 metadata。",
    "- Intro 沒有 3 分鐘硬上限；超過 3 分鐘只顯示紅色警示。最多 50 段、每段 3–22 秒。",
    "- 按下「OK，開始產出」後才會寫入選定的新 MP4；取消時會先要求 FFmpeg 安全寫完 MPEG-4 結尾，已有足夠畫面便保留較短可播放檔，太早取消才清除 partial。",
    "- 完成或取消後保留的 MP4 可直接用 .mp4 播放器設定開啟。",
    "- 正片預覽完成後可經官方 YouTube OAuth 上傳到核對過的目標頻道，預設不公開；Google Chrome 優先、Microsoft Edge 第二。",
    "- YouTube 上傳會自動整合 AI 說明、英文摘要、章節時間與 hashtags；最後確認頁可播放成品、查看縮圖與完整文字，勾選人工檢查後才會送出。",
    "- 平台設定會顯示 YouTube 授權狀態、頻道名稱與 ID；密碼只在 Google 官方頁輸入，App 不收集或保存平台密碼。",
    "- 每次成功輸出的正片、Intro 或取消後有效短片都會加入『預覽檔案庫』，重開 App 後仍可播放、找出或投稿。",
    "- 升級前已轉出的 MP4 可在預覽檔案庫按『加入以前的 MP4』登記；從清單移除紀錄不會刪除磁碟影片。",
    "- 正片預設可把已確認 Intro 自動接在 Main 前方；輸出前可取消勾選而只產出正片。",
    "- 勾選 Intro＋Main 串接時會強制確認 3–7 秒的正片開始提示頁；可輸入兩行文字、調整字級／間距／半透明暗色遮罩，並選柔和疊化、淡至黑或直接切換。設定會沿用到下次開啟。",
    "- 正片開始提示頁可挑選正片開場或任一已確認片頭片段；輸出時重讀唯讀原始素材，不使用 proxy 當背景來源。",
    "- 完整正片完成後預設倒數 60 秒開啟 YouTube 最後確認頁；可取消或事先取消勾選，MP4 仍保留，且不會跳過人工確認。",
    "- 正片預覽完成後也可交接到 BiliBili／TikTok 官方投稿頁；App 會複製路徑並選取 MP4，仍需在平台內確認後發布。",
    "- 關閉 App 時會先顯示第二確認與短提示音；預設焦點在繼續剪輯，確認後才關閉。",
    "",
    "目前需求：本機 FFmpeg 與 ffprobe 必須可從 PATH 執行。",
    "本版不包含完整 Timeline、正式 Master 渲染或 HDR。YouTube 只上傳預覽成品庫中存在且經使用者確認的正片／既有 MP4；需自行設定 Google Desktop OAuth client。BiliBili／TikTok 採官方頁面交接，不宣稱自動 API 發布。",
    "",
  ].join("\r\n"),
  "utf8",
);

process.stdout.write(`${outputPath}\n`);
