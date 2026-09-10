# TODO — 待辦事項與分析紀錄

> 本文件記錄尚未實作的規劃與分析，供後續開發參考。
> 狀態：`[ ]` 未開始 / `[~]` 進行中 / `[x]` 已完成

---

## 1. [ ] PARALLEL 1 vs 4 對比（內顯機 runtime benchmark）

- 爭點待實測判定：原調查稱單槽序列化（`PARALLEL=1`）是最大元凶；@oracle 認為四核下平行不增吞吐只加交錯。
- 已定決策：PARALLEL 先維持 1，實測後再定。

## 2. [ ] SPEECH_RETRY_MS 重試秒數確認（現況預設 60s）

- 生產失敗 → 60 秒後重試（env `SPEECH_RETRY_MS` 可調）；秒數待用戶確認。

## 3. [ ] HUMAN_SKIP／跳過按鈕刪除案

- 跳過按鈕（`HUMAN_SKIP`／`allAliveHumansSkipped`）目前保留不動（scheduler 已無依賴）；是否刪除待用戶確認。
