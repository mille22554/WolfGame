# Ubuntu 分支動工計畫（無頭多房 Server）

> 來源：@oracle 多房架構策略審查＋ Vulkan／Linux 現況盤點。main 分支（Windows exe 單機單房）不受影響，所有工作只做在 ubuntu 分支。

## 目標

- Ubuntu Server 跑無頭 server：只負責遊戲 server＋LLM 推理、決定用哪個模型（運行中可切換）。
- 開房／加入房全在其他 PC 的瀏覽器：可同時多房並存，每房獨立大廳＋host＋遊戲進度、互不干擾。
- main 保持 Windows 單機單房；ubuntu 長期獨立維護。

## 架構定案

1. **房間層**：`LobbyManager`／`GameEngine`／`game-state` 零改動沿用（每房 new 一份）。重寫 `WebSocketRegistry` 路由層三個單房假設：全員廣播→按房廣播、單一快照→按 client.roomId 解析、訊息 switch 加房間維度。新增 RoomManager（開房／列表／房號加入／回收）＋新訊息型別（CREATE_ROOM／JOIN_ROOM／ROOM_LIST）。token 綁 roomId，跨房隔離。房數上限綁 `--parallel`。
2. **模型權威**：server 全域單模型，不做 per-room 釘選（多模型並載是 VRAM 殺手）。切換用**延遲制**：舊房跑完、新房生效，等無進行中房間才執行；加**強制立即切換**逃生門（force-end 進行中房間＋明確告知）。多房共用一個 llama-server，`--parallel 2-4`，dispatcher 外加全域公平佇列（跨房 round-robin）。
3. **生命週期**：zeroTimer 用設定關掉（不刪除程式碼路徑，main 照用）。空房回收兩條：空大廳閒置超時（30-60 分）、進行中遊戲真人全離場→force-end＋回收＋廣播 ROOM_CLOSED。server 重啟後房間**不恢復**（大廳無持久化），文件寫明重開房。

## 維護規則（壓分歧成本）

- 房間層只動 `server.ts` 的接線（wiring），不碰 `LobbyManager`／`GameEngine`／`game-state`／`llama-server` 的簽名。這樣 main 的修復 cherry-pick 過來幾乎無衝突。
- WS 協定 breaking 不用相容舊客戶端，但加版本欄位（HELLO handshake），舊端連上拿乾淨錯誤。

## Phase 1 — 無頭單房（最小可用，先踩平 Linux）

- zeroTimer 可設定化停用（`zeroClientShutdownMs: 0`）。
- HTTP/WS 綁 `0.0.0.0`（llama 內部保持 127.0.0.1）。
- 停用 openBrowser（ubuntu 預設 false）。
- Linux 下載路徑：ubuntu 資產是 tar.gz（`llama-b10361-bin-ubuntu-x64.tar.gz` 15.8MB／vulkan 31MB），AdmZip 解不了，要換 tar 解壓；二進制名去 `.exe`；驗證 modelsDir／data 預設位置。
- 單房單模型不變。
- **門檻**：既有 187 測試在 Linux 全過＋ubuntu 真機無頭啟動、另一台 PC 瀏覽器連入玩完整局。

## Phase 2 — 房間層

- RoomManager（開／列／房號加入）、per-room LobbyManager＋GameEngine＋host、WS 按房路由、per-room registry adapter、空房回收、token 房內作用域。模型仍全域固定（啟動時選定）。
- **門檻**：多房測試（MockDispatcher：2 房並行、進度獨立、host 轉移 per-room、LEAVE_LOBBY per-room、A 房 token 進 B 房被拒）＋回收測試，187＋新測試全過。

## Phase 3 — 模型切換＋佇列

- 切換 API（延遲佇列＋強制逃生門）、全域 LLM 佇列公平性、房數上限綁 `--parallel`。
- **門檻**：切換語義測試（閒置切→新房生效；運行中切→延遲；強制切→房間乾淨結束）＋佇列公平性測試（注入延遲 fake）＋ubuntu 真模型併發 smoke。

## 運維面（Phase 1 順手給）

- 啟動：Node 18＋、`npm ci`、`npm run build`、`npm start`（＝`node dist/entry.js`），终端只吐日誌。
- 設定：環境變數（LLM_PROVIDER／LLM_MODEL_URI／LLM_MODELS_DIR／LLAMA_BACKEND／LLAMA_GPU_LAYERS／LLAMA_VRAM_MB／LLAMA_INTEGRATED_GPU／LLAMA_SERVER_THREADS）＋ `backend.json`（後端偏好）。模型檔：目錄有任一 `.gguf` 即用，不下載。
- 瀏覽器從別台連 `http://<server-ip>:2639`，防火牆放行 port。
- systemd service 範本（開機自啟＋崩潰重啟）。

## 真機驗證清單（交付門檻，非可選）

- NVIDIA／AMD／Intel 各跑一次 Vulkan 包；4GB 卡跑一次（驗 OOM 回退）；無 Vulkan 老卡跑一次；遠端 PC 完整局；多房並行真模型 smoke（Phase 3）。
