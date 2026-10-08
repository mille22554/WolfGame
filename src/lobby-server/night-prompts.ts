/**
 * night-prompts.ts — 夜間會議（共有者／人狼）prompt 純函式
 *
 * 依 docs/strategy-prompt-variables.md 的逐字模板組出 ChatMessage[]：
 * - system＝身分＋行事風格；user＝遊戲規則 → 進度 →（記憶，非空才帶）→ 任務 → 戰術提點 → 回覆內容要求
 * - 發言 prompt 的 user 段：…進度 →「你剛剛讀完最新發言後想的策略」→ 任務 → 回覆內容要求
 * - judge／記憶合併為單一 user 訊息
 *
 * 本模組不做 I/O（persona 段落由呼叫方傳入 agents.md 原文，經 extractStyle 抽取）。
 * 所有模板文字與 docs/strategy-prompt-variables.md 逐字一致（由 night-prompts.test.ts 驗證）。
 */
import type { ChatMessage } from './llm.js';

export type Meeting = 'mason' | 'wolf' | 'day';

export interface NightPromptCtx {
  meeting: Meeting;
  /** 角色名（p.nickname） */
  nickname: string;
  /** 出身地（PREFECTURE 對照表） */
  prefecture: string;
  /** 陣營：村人｜人狼 */
  faction: string;
  /** 職業：共有者｜人狼 */
  role: string;
  /** 夥伴名單（mason 一人、wolf 其餘狼；以「、」連接） */
  partners: string[];
  /** 行事風格（extractStyle 從 character/<id>/agents.md 的「## 性格與說話方式」抽出） */
  style: string;
  /** 第幾夜 */
  dayNo: number;
  /** 存活名單（「、」連接） */
  alive: string[];
  /** （狼）可刀目標：存活者排除自己／狼隊／狂人 */
  targets?: string[];
  /** （狼）狂人名；缺席時省略該句 */
  madman?: string;
  /** 對話紀錄（會議白板） */
  board: { from: string; text: string }[];
  /** 夜間策略記憶專區（非空才帶入 prompt） */
  memory?: string;
}

/**
 * 出身地對照表（character id → 縣府；15 人局直呼驗證用值）。
 * 來源：外部 harness（Temp/step.mjs）ai-0…ai-14 之 PREFECTURE 表，
 * 依 scripts/external-test-stage2.mjs 的 CHARACTERS 順序對應到 character id。
 */
export const PREFECTURE: Record<string, string> = {
  aoi: '北海道',
  chihiro: '長野縣',
  futa: '大阪府',
  kenta: '福岡縣',
  koharu: '京都府',
  misaki: '愛知縣',
  ren: '宮城縣',
  rin: '沖繩縣',
  ryoko: '東京都',
  sayuki: '新潟縣',
  shinichi: '廣島縣',
  shota: '福岡縣',
  tatuya: '北海道',
  yuko: '京都府',
  yuma: '東京都',
};

/** 遊戲規則（全會議同一份，15 人局專用） */
export const GAME_RULES = `## 遊戲規則
15 人：村民 6／占卜 1／靈能 1／守衛 1／共有者 2／人狼 3／狂人 1。
占卜：每夜查 1 人，結果只有「村人」或「人狼」；狂人驗出來是「村人」。
靈能：被動得知白天被票死者的陣營；無法得知夜殺者身分；無法分辨村民與狂人。
守衛：每夜守 1 人；可連守同一人；第 1 天不可守；不知道任何人身分。
共有者：2 人互認，夜間可私聊（僅限彼此）；夜間不知道當晚死亡資訊；占驗結果為「村人」。
人狼：3 人互認，夜裡共殺 1 人（不是各殺一個）；只能殺村方，不可殺人狼與狂人；知道誰是狂人；不知道其他玩家職業與夜間行動。
狂人：無能力；不知道誰是人狼；占驗結果為「村人」；人狼勝則狂人勝。
村民：無能力，靠討論與投票找狼。
夜間：人狼必殺、占卜必查、守衛必守（第 1 天除外），不可空；夜間無投票。
勝利：村方淘汰全部人狼（所有狼＋狂人都死）即勝；人狼（含狂人）人數 ≥ 村方人數即人狼勝。
白天：討論後投票，多者出局；票死與夜殺身分都不公開，死者無遺言。私頻狼聽不到，只能靠公開資訊推理。`;

/** 戰術提點（全會議同一份）；針對村民陣營的條目以「對於村民陣營」開頭，中性條目不加。 */
export const TACTICAL_TIPS = `## 戰術提點
- 以所有人都專業、不露破綻為前提擬計畫；只處理硬矛盾，沒矛盾就承認沒資訊，不要寫「等對方犯錯」的劇本。
- 對於村民陣營，「安靜」「話多」「急著撇清」「發言最兇」都不能當成狼的證據。首日安靜的可能是謹慎的村民，話多的可能是真心想帶節奏的好人。投人要有可核對的矛盾或狼味，不要用發言量／態度當理由。
- 對於村民陣營，第一天最好投出一張狼票或狂票，但不能亂投。沒有可靠線索時，寧可先觀察、等靈能或占卜資訊，也不要為了出票而出票。
- 靈能者只知道「被票死者」的陣營（不知道夜殺者）；資訊要到下一夜才揭曉；平票＝無人出局＝當天靈能無資訊。第一天還沒人被票，靈能沒有資訊可用。第一夜被狼殺的必定是村方（狼不能殺狼／狂），但身分不公開。
- 被問跟夥伴是不是同一邊時，不要急著否認或解釋，簡短帶過即可，不主動賣弄關係。
- 對於村民陣營，票出來的資訊有延遲，這跟「越早投越虧」沒有因果。
- 對於村民陣營，狂人是狼方同盟，票出他是賺的，不算誤殺；只有村方才是誤殺。
- 對於村民陣營，村民是村民、共有者是共有者，共有者亮村民是假跳。
- 對於村民陣營，亮共有者不代表要兩人一起亮，應視情況而定。
- 對於村民陣營，CO不用過於害怕被狼刀，守衛也會判斷誰可能是狼的目標，然後選人守。
- 對於村民陣營，CO被當狼的可能性要仔細推敲，不要妄下定論。
- 對於村民陣營，狼有可能會假跳，但不會以違反規則的形式跳，狼都是高手
- 第一天占卜與狼都是隨便挑對象（零情報盲選），追究「為什麼查他」沒意義；能力執行過程沒有依據，能分析的只有人選。
- 推論時不要妄下定論，被反問的人也一樣；想到「矛盾」必須同時舉出具體例子（誰何時講了哪兩句、哪裡對不上），舉不出就不要當結論；動機推測只能當並列假設之一，不能單線定論。
- 對於村民陣營，若想從占卜師與被占卜者的發言找疑點，先好好想想有甚麼實例，將自身帶入被占卜者
- 不要以別人會改口為前提來思考
- 不要以別人會不知道遊戲規則為前提來思考
- 不要預設別人會犯很明顯的失誤，還以此為前提擬訂計畫
- 在想提問的內容時要注意合不合乎其他要點的邏輯
- 所有人都知道夜晚共有者與狼各自會開會討論
- 遊戲沒有位置概念，名單順序不代表任何意義
- 當你想寫「他若說Ｘ／他若承認Ｙ」這種等對方先犯錯的句式時，先停下來問自己：狼會這樣說嗎？如果不會，整句刪掉重想
- 不可隨意回答沒思考過的策略。`;

/** 「要有」一行依會議 */
export const STRATEGY_REPLY_MUST: Record<Meeting, string> = {
  mason: '- 要有：明日目標、誰做什麼、對手兩種反應的應對。',
  wolf: '- 要有：今晚刀誰、票怎麼投、明天白天怎麼演。',
  day: '- 要有：今天投誰、依據是什麼、要表態什麼。',
};

/** 策略版「回覆內容要求」；`{{要有：依會議}}` 由 buildStrategyMessages 依會議替換 */
export const STRATEGY_REPLY_COMMON = `## 回覆內容要求
- 策略主文 800 字內，條列，不重複。
{{要有：依會議}}
- 不要：空泛標語、重複論點、裝飾性收尾。
- 策略只挑重點講，不要鋪沒意義的廢話。
- 定案用日常說法（就他了、定了），不要用遊戲黑話。
- 講投票對象時直接講人名，不要用「方向」「線」來代指。
- 第一行先寫 \`status: speak|wait|ready\`＋一句理由（看到了什麼、為什麼是這個狀態）。
- \`speak\` 才接策略主文；\`wait\`／\`ready\` 到此為止，不出策略文。
- 要發言一律為speak，wait及ready不會發言`;

/** 策略版「任務」第一行依會議 */
const STRATEGY_TASK_FIRST: Record<Meeting, string> = {
  mason: '你需要擬定你與共有者夥伴於明日白天會議的行動策略，評估CO的利與弊，並推敲狼有可能的行動，試圖使己方陣營獲勝。',
  wolf: '你需要與狼隊擬定今晚的刀人目標，評估各候選的利與弊，並推敲村方下一步可能的行動，試圖使己方陣營獲勝。',
  day: '你需要與全體存活玩家討論並擬定今天的投票方針，評估各候選的利弊，並推敲狼有可能的行動，試圖使己方陣營獲勝。',
};

/** 策略版「任務」的共用行（接在第一行之後） */
const STRATEGY_TASK_COMMON = `會議是當面口頭討論，不是傳訊息；沒出聲的人是在聽，不是還沒回。
請務必仔細熟讀"遊戲規則"、"進度"、"戰術提點"及"回覆內容要求"，好好推敲思緒，不要輕易放棄
若大致覺得討論的內容已經足夠有行動基準了，可以ready，不用為了小事speak
但不可明明資訊不足卻ready，無法擬定行動基準就要speak或wait
狀態要好好想過有沒有符合實際回答，寫完要檢查`;

/** 發言版「任務」 */
const SPEECH_TASK = `## 任務
從你的策略裡挑出發言紀錄上還沒講過的新論點，或對舊論點的補充／修正，轉成一句接續目前局面的話。
發言紀錄上已講過且無新角度的，不要再講，也不要替夥伴說完。`;

/** 發言版「回覆內容要求」（與策略版不同，固定一份） */
export const SPEECH_REPLY = `## 回覆內容要求
- 以在保持對話流暢性的同時不使得內容難以理解且盡可能的簡短為目標。
- 每句話都要有清楚的主詞（誰做什麼、對誰做）；不准省略主詞硬湊簡短，寧可少講一件事，也不要講半句。描述狀況的句子不用硬加人稱主詞。同一句裡用到兩個以上「他」時，要確認指的是同一人；不是同一人就改講名字或講清楚是誰。
- 繁體中文，不用簡體字。
- 不自創機制（走位、站位、夜間見聞、動線），不用「一輪／整段」等結構詞。
- 不要把內部起草過程的編號／計數口氣帶進發言。
- 要注意進度內容，不要捏造歷史。
- 口語、通俗、像真的人會講的話；避免大陸用語、避免書面腔。
- 大陸腔例子（不要用）：「一早一睜眼」「咱」「啥」「站隊」「拉回來」。改用自然的中文。
- 當「對話紀錄」內容為「無」時，代表你正在說第一句話；此時禁止任何不合宜的接續式/收束式表達（如「好，就這些」「再補一個」「你說得對」「我聽完了」），只能是新的第一句。
- 不自創機制或口語上不自然的概念。
- 不要用「兩句話切完」「讓場子去聽占卜」「語氣對不起來」這類不是人話的句子。
- 不要用「給自己找靶子」這類不是人平常會講的比喻，改用自然直白的說法。
- 不要用「硬資訊」「硬線索」這種詞，改成「能說得有理有據的證據」「確定的結論」之類自然的說法。
- 不需要把隱匿策略當成自己的台詞念出來；觀察就講觀察，潛規則自己知道就好。
- 要有對話感，不要自說自話，情境是實際口頭對話，不是筆談。
- 想表達有在聽，用日常簡短的回應語氣帶過；不要說「先記著」「我記下來了」——不要把私下做筆記的動作念成公開台詞。
- 若你的說法跟夥伴上一句的安排不一樣，要把你這樣改的理由一起講出來，不能只丟結論。
- 不要用「硬帶節奏」，用「硬帶風向」。
- 講到人時要分清楚：被占卜驗過的人、被推票的人是兩個不同的人，不能都用「這個人」帶過，要讓聽的人分得出你在講誰。
- 不要用「原話」這種不夠淺顯的詞，想表達「把對方當初講的話重講一次」就直說「他當初是怎麼講的」。
- 不要用人不常講的開場白，如「你那個節奏我跟上」這種。說人話，直接講重點。
- 不要用那種繞口的抽象講法，像「把話題扣在邏輯上」「情緒起來先喊大家慢一步」「還從哪裡找線頭」，改成每天會講的直白方式。
- 若有改寫句子，都要仔細重讀：除了確認是否通順，換詞後還要對照策略原句，確認整句要表達的事沒變。
- 講投票對象時直接講人名，不要用「方向」「線」來代指。
- 不要用遊戲黑話，如「下票」「分開下」，改用日常說法。
- 自己提過的事被別人接受時，不要說「同意」或「照你說的」，那本來就是你的提案。`;

/** judge 的「任務」＋「回覆內容要求」（全盲評分，只回 JSON） */
const JUDGE_TAIL = `## 任務
你是在評與會者的會議策略（不是發言稿）。評分只看：
① 本次會議的目標是否具體可執行（不是「觀察局勢」這種空話）；
② 分工有沒有重疊；非計畫內的暴露同盟才扣分（計畫中要 CO 的不在此限）；
③ 對手的兩種反應（安靜混／帶風向）各自有沒有對應動作；
④ 事實有沒有錯（靈能只知道票死者的陣營、夜殺者無靈能資訊、平票＝無人出局＝靈能無資料、守衛 Day1 不可守、占驗結果每夜 1 人）；
⑤ 水文扣分（重複、空泛標語、裝飾收尾）；
⑥ 有 rollout 推演（發出去對手／其他人各會怎樣回）的加分，只寫漂亮沒有動作的扣分。
## 回覆內容要求
- 只回 JSON：\`{"scores":[...],"best":最佳篇號（1-based）}\`。
- 分數 0-10，越高越好。
- 不要多餘文字。`;

/** 記憶合併的「任務」 */
const MERGE_TASK = `## 任務
把兩者整合成一份現行策略：保留仍成立的、更新被新策略推翻的、衝突只留一個並捨棄另一個。輸出整合版全文（條列，800 字內），不要解釋合併過程。`;

/** 重問 wait 者時附在最後一則 user 訊息之後的一行 */
export const NO_WAIT_SUFFIX = '本輪不可 wait：請選 speak 或 ready。';

/**
 * 從 character/<id>/agents.md 原文抽出「## 性格與說話方式」段落。
 * 回傳該 heading 之下、下一個 `## ` heading 之前的內容（去 heading、trim）。
 * 找不到該 heading 時回 ''。
 */
export function extractStyle(agentsMd: string): string {
  const lines = agentsMd.split('\n');
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (!inSection && line.trim() === '## 性格與說話方式') {
        inSection = true;
        continue;
      }
      if (inSection) break; // 遇到下一個 ## heading，段落結束
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join('\n').trim();
}

/** 對話紀錄：無則「（無）」；有則每句一行「第 N 句　{name}：「{text}」」（句後為全形空格） */
export function formatBoard(board: { from: string; text: string }[]): string {
  if (board.length === 0) return '（無）';
  return board.map((b, i) => `第 ${i + 1} 句　${b.from}：「${b.text}」`).join('\n');
}

/** system 段：身分＋行事風格（style 為空時省略行事風格段） */
function systemContent(ctx: NightPromptCtx): string {
  const partnerTag = ctx.meeting === 'mason' ? '夥伴' : ctx.meeting === 'wolf' ? '隊友' : '夥伴';
  const partnerClause = ctx.partners.length > 0 ? `${partnerTag}：${ctx.partners.join('、')}。` : '';
  const identity = `## 身分
你是「${ctx.nickname}」（日本${ctx.prefecture}人），${ctx.faction}陣營${ctx.role}。${partnerClause}
出身地只用於說話口吻，與人際關係無關`;
  return ctx.style
    ? `${identity}\n\n## 行事風格\n${ctx.style}`
    : identity;
}

/** 進度段：共有者／人狼版本不同；wolf 的狂人句在 madman 缺席時整句省略 */
function progressSection(ctx: NightPromptCtx): string {
  const alive = ctx.alive.join('、');
  const mbt = formatBoard(ctx.board);
  if (ctx.meeting === 'mason') {
    return `## 進度
目前是第 ${ctx.dayNo} 夜的共有者會議。存活：${alive}。對話紀錄：${mbt}`;
  }
  if (ctx.meeting === 'day') {
    return `## 進度
目前是第 ${ctx.dayNo} 天的白天討論。存活：${alive}。對話紀錄：${mbt}`;
  }
  const targets = (ctx.targets ?? []).join('、');
  const madman = ctx.madman ? `狂人：${ctx.madman}（他不知道你們是誰，不可刀他）。` : '';
  return `## 進度
目前是第 ${ctx.dayNo} 夜的人狼會議。存活：${alive}。可刀目標：${targets}（排除自己／狼隊／狂人）。${madman}對話紀錄：${mbt}`;
}

/** 策略 prompt：system（身分＋行事風格）＋ user（規則→進度→[記憶]→任務→戰術提點→回覆要求） */
export function buildStrategyMessages(ctx: NightPromptCtx): ChatMessage[] {
  const sections: string[] = [
    GAME_RULES,
    progressSection(ctx),
  ];
  if (ctx.memory) sections.push(`## 記憶\n${ctx.memory}`);
  sections.push(
    `## 任務\n${STRATEGY_TASK_FIRST[ctx.meeting]}\n${STRATEGY_TASK_COMMON}`,
    TACTICAL_TIPS,
    STRATEGY_REPLY_COMMON.replace('{{要有：依會議}}', STRATEGY_REPLY_MUST[ctx.meeting]),
  );
  return [
    { role: 'system', content: systemContent(ctx) },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/** 發言 prompt：system（身分＋行事風格）＋ user（規則→進度→策略→任務→回覆要求） */
export function buildSpeechMessages(ctx: NightPromptCtx, strategy: string): ChatMessage[] {
  const sections: string[] = [
    GAME_RULES,
    progressSection(ctx),
    `## 你剛剛讀完最新發言後想的策略\n${strategy}`,
    SPEECH_TASK,
    SPEECH_REPLY,
  ];
  return [
    { role: 'system', content: systemContent(ctx) },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/** judge prompt：單一 user 訊息（策略列表→規則→進度→任務→回覆要求）；best 為 1-based */
export function buildJudgeMessages(ctx: NightPromptCtx, strategies: string[]): ChatMessage[] {
  const head = [
    `以下是 ${strategies.length} 篇策略（不標明作者）：`,
    ...strategies.map((s, i) => `[${i + 1}]: ${s}`),
  ].join('\n');
  const content = [head, GAME_RULES, progressSection(ctx), JUDGE_TAIL].join('\n\n');
  return [{ role: 'user', content }];
}

/** 記憶合併 prompt：單一 user 訊息（舊策略〔無則（無）〕＋新策略→任務） */
export function buildMergeMessages(meeting: Meeting, oldMemory: string, strategy: string): ChatMessage[] {
  const title = meeting === 'day'
    ? '## 你既有的白天策略（記憶專區）'
    : `## 你既有的${meeting === 'mason' ? '共有者' : '人狼'}夜間策略（記憶專區）`;
  const content = [
    `${title}\n${oldMemory || '（無）'}`,
    `## 你剛擬的新策略（judge 已選中）\n${strategy}`,
    MERGE_TASK,
  ].join('\n\n');
  return [{ role: 'user', content }];
}

/**
 * 收斂判斷時重問 wait 者：把 NO_WAIT_SUFFIX 一行附在最後一則 user 訊息之後。
 * 回傳新陣列（不改動輸入）；找不到 user 訊息時原樣回傳。
 */
export function withNoWait(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages.map((m, j) =>
        j === i ? { ...m, content: `${m.content}\n${NO_WAIT_SUFFIX}` } : m,
      );
    }
  }
  return messages;
}
