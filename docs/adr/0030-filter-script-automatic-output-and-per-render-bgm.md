# ADR 0030｜長濾鏡設定檔、自動輸出位置與單次配樂選擇

日期：2026-09-08  
狀態：採用

## 背景

正片自動串接 Intro 或永久嵌入字幕時，FFmpeg filter graph 會隨片段、轉場及字幕濾鏡增加。Windows 建立程序有命令列長度限制，將完整 graph 直接放在 `-filter_complex` 參數可能在 FFmpeg 啟動前由 Node 回報 `spawn ENAMETOOLONG`。此外，每次預覽都要求另選檔名會中斷操作；正片輸出也需要明確決定本次是否混入專案 MP3。

## 決定

- 將完整 filter graph 寫入輸出資料夾內的唯一隱藏暫存檔，FFmpeg 只接收短的 `-filter_complex_script <path>` 參數。
- 暫存 graph 使用 UUID、以 `wx` 建立，成功、失敗或取消後都清除；來源媒體、專案 manifest 與已完成輸出不受影響。
- 開啟輸出頁即依上次 `PREVIEW_OUTPUT` 資料夾準備新檔名；若資料夾失效則退回 Windows Videos。既有檔名會依序產生 `_02` 等名稱，不自動覆寫。
- 使用者仍可按輸出位置另行指定；該次選擇會成為後續自動輸出的預設資料夾。
- 正片與 Intro 輸出各自保存「這次 MP4 嵌入 MP3 配樂」偏好。取消勾選時 Main process 完全排除 BGM inputs；勾選時沿用既有 BGM 時間、淡入淡出、音量、素材原音與 limiter 規則。

## 安全與相容性

- Renderer 只取得一次性 output token 和顯示路徑，不能提交任意寫入路徑。
- 自動路徑 token 禁止覆寫；開始輸出前若檔名已被其他程式占用，阻擋並要求重新產生。
- 自訂儲存位置仍由 Windows 原生 Save dialog 授權並保留覆寫確認。
- 新增偏好欄位有安全預設；舊偏好、manifest、proxy/cache 與 v0.29.0 release 不變。
